import type { Metadata } from '@grpc/grpc-js';
import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { Service } from '@n8n/di';
import { getErrorMessage } from '@n8n/utils/errors/get-error-message';
import { latestWins } from '@n8n/utils/promise/latest-wins';
import type { Tracer } from '@opentelemetry/api';
import { trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	type ReadableSpan,
	type SpanExporter,
	type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-node';
import { InstanceSettings } from 'n8n-core';
import { OperationalError } from 'n8n-workflow';

import { ExecutionIdentitySpanProcessor } from './execution-identity';
import type { OtelConnectionParams } from './otel-settings.service';
import { OtelSettingsService } from './otel-settings.service';
import type { OtelConfig } from './otel.config';
import { ATTR, OTEL_TEST_SPAN_NAME } from './otel.constants';
import { exportOutsideSentryTracing, mergeResourceAttributes } from './otel-span-exporter';

import { N8N_VERSION } from '@/constants';
import { OtelSdk } from '@/observability/otel-sdk';
import {
	TRACING_OFF,
	type ShutdownErrors,
	type TracingPipeline,
} from '@/observability/swappable-pipeline';

export type OtelTestTraceResult = { success: true } | { success: false; error: string };

type ActiveExport = { settings: OtelConfig; spanProcessors: SpanProcessor[] };

type ExportField = Exclude<keyof OtelConnectionParams, 'startupConnectivityTimeoutMs'>;

const EXPORT_FIELDS: ExportField[] = [
	'exporterProtocol',
	'exporterEndpoint',
	'exporterTracingPath',
	'exporterHeaders',
	'exporterServiceName',
];

const hasSameExportFields = (a: OtelConfig, b: OtelConfig) =>
	EXPORT_FIELDS.every((field) => a[field] === b[field]);

const stripEmptyResolutionNote = (message: string) =>
	message.replace(/\s*Resolution note:\s*$/, '');

@Service()
export class OtelService {
	private activeExport?: ActiveExport;

	private readonly pendingFlushes = new Set<Promise<void>>();

	private isShutDown = false;

	constructor(
		private readonly otelSettingsService: OtelSettingsService,
		private readonly instanceSettings: InstanceSettings,
		private readonly logger: Logger,
		private readonly outboundHttp: OutboundHttp,
		private readonly otelSdk: OtelSdk,
	) {}

	async init(): Promise<void> {
		await this.applySavedSettings();
	}

	readonly applySavedSettings = latestWins(async () => {
		if (this.isShutDown) return;

		await this.applySettings(await this.otelSettingsService.loadSettings());
	});

	getTracer(name: string): Tracer {
		return trace.getTracer(name);
	}

	/**
	 * Sends a single `n8n.test_trace` span to the given OTLP endpoint and waits
	 * for the exporter's result. Unlike the export pipeline (which batches spans
	 * fire-and-forget), this uses a throwaway provider/exporter so the collector's
	 * response — success, a rejection (HTTP status or gRPC status code), or a
	 * network error — can be reported back to the caller. Runs independently of
	 * the active OTel configuration.
	 */
	async sendTestTrace(connection: OtelConnectionParams): Promise<OtelTestTraceResult> {
		let provider: BasicTracerProvider | undefined;
		try {
			const exporter = await this.createTraceExporter(
				connection,
				connection.startupConnectivityTimeoutMs,
			);

			try {
				return await new Promise<OtelTestTraceResult>((resolve) => {
					const processor: SpanProcessor = {
						onStart: () => {},
						onEnd: (span: ReadableSpan) =>
							exporter.export([span], (result) =>
								resolve(
									result.error
										? { success: false, error: stripEmptyResolutionNote(result.error.message) }
										: { success: true },
								),
							),
						forceFlush: async () => {},
						shutdown: async () => {},
					};
					provider = new BasicTracerProvider({
						resource: resourceFromAttributes({
							...this.resourceAttributes(connection.exporterServiceName),
							[ATTR.OTEL_SERVICE_VERSION]: N8N_VERSION,
						}),
						sampler: new TraceIdRatioBasedSampler(1),
						spanProcessors: [processor],
					});
					const span = provider
						.getTracer('n8n-otel-test')
						.startSpan(OTEL_TEST_SPAN_NAME, { attributes: { [ATTR.IS_TEST_TRACE]: true } });
					span.end();
				});
			} finally {
				await provider?.shutdown().catch(() => {});
				await exporter.shutdown().catch(() => {});
			}
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async shutdown(): Promise<void> {
		this.isShutDown = true;
		await this.applySavedSettings();
		this.activeExport = undefined;
		this.applyPipeline(TRACING_OFF);
		await Promise.all(this.pendingFlushes);
	}

	private async applySettings(settings: OtelConfig): Promise<void> {
		if (!this.otelSdk.isRunning) return;

		const previousExport = this.activeExport;
		const activeExport = await this.exportFor(settings);
		this.applyPipeline(this.pipelineFor(activeExport, settings));
		this.activeExport = activeExport;

		if (activeExport && activeExport !== previousExport) {
			void this.checkEndpointReachability(activeExport);
		}
	}

	private async exportFor(settings: OtelConfig): Promise<ActiveExport | undefined> {
		if (!settings.enabled) return undefined;
		if (this.activeExport && hasSameExportFields(this.activeExport.settings, settings)) {
			return this.activeExport;
		}

		return await this.buildExport(settings);
	}

	private pipelineFor(
		activeExport: ActiveExport | undefined,
		settings: OtelConfig,
	): TracingPipeline {
		if (!activeExport) return TRACING_OFF;

		return {
			spanProcessors: activeExport.spanProcessors,
			sampler: new TraceIdRatioBasedSampler(settings.tracesSampleRate),
			propagator: settings.injectOutbound
				? new W3CTraceContextPropagator()
				: TRACING_OFF.propagator,
		};
	}

	private applyPipeline(pipeline: TracingPipeline): void {
		const flush = this.otelSdk
			.apply(pipeline)
			.catch((error: unknown) => [error])
			.then((shutdownErrors) => this.warnOnFailedShutdown(shutdownErrors))
			.finally(() => this.pendingFlushes.delete(flush));

		this.pendingFlushes.add(flush);
	}

	private warnOnFailedShutdown(shutdownErrors: ShutdownErrors): void {
		if (shutdownErrors.length === 0) return;

		const [error] = shutdownErrors;
		this.logger.warn(
			'Failed to cleanly shut down the previous OpenTelemetry exporter (its flush may have failed)',
			{ error: getErrorMessage(error) },
		);
	}

	private async buildExport(settings: OtelConfig): Promise<ActiveExport | undefined> {
		try {
			const exporter = mergeResourceAttributes(
				await this.createTraceExporter(settings),
				this.resourceAttributes(settings.exporterServiceName),
			);
			return {
				settings,
				spanProcessors: [
					new ExecutionIdentitySpanProcessor(),
					new BatchSpanProcessor(exportOutsideSentryTracing(exporter)),
				],
			};
		} catch (error) {
			this.logger.error('Failed to start OpenTelemetry tracing, so tracing stays off', {
				error: getErrorMessage(error),
			});
			return undefined;
		}
	}

	private resourceAttributes(serviceName: string) {
		return {
			[ATTR.OTEL_SERVICE_NAME]: serviceName,
			[ATTR.INSTANCE_ID]: this.instanceSettings.instanceId,
			[ATTR.INSTANCE_ROLE]: this.instanceSettings.instanceType,
		};
	}

	private async createTraceExporter(
		connection: OtelConnectionParams,
		timeoutMillis?: number,
	): Promise<SpanExporter> {
		if (connection.exporterProtocol === 'grpc') {
			return await this.createGrpcTraceExporter(connection, timeoutMillis);
		}

		return this.createHttpTraceExporter(connection, timeoutMillis);
	}

	private createHttpTraceExporter(
		connection: OtelConnectionParams,
		timeoutMillis?: number,
	): SpanExporter {
		const headers = this.parseOtlpHeaders(connection.exporterHeaders);
		const url = this.resolveExporterUrl(connection);

		return new OTLPTraceExporter({ url, headers, timeoutMillis });
	}

	private async createGrpcTraceExporter(
		connection: OtelConnectionParams,
		timeoutMillis?: number,
	): Promise<SpanExporter> {
		const headers = this.parseOtlpHeaders(connection.exporterHeaders);
		const url = this.resolveExporterUrl(connection);

		const [{ OTLPTraceExporter: OTLPGrpcTraceExporter }, { Metadata }] = await Promise.all([
			import('@opentelemetry/exporter-trace-otlp-grpc'),
			import('@grpc/grpc-js'),
		]);

		return new OTLPGrpcTraceExporter({
			url,
			metadata: this.toGrpcMetadata(headers, new Metadata()),
			timeoutMillis,
		});
	}

	private resolveExporterUrl(
		connection: Pick<
			OtelConnectionParams,
			'exporterProtocol' | 'exporterEndpoint' | 'exporterTracingPath'
		>,
	): string {
		// The gRPC exporter selects TLS with a raw-string `startsWith('http://')`, so
		// an uppercase scheme silently picks TLS against a plaintext collector.
		const endpoint = connection.exporterEndpoint.replace(/^https?:\/\//i, (scheme) =>
			scheme.toLowerCase(),
		);

		return connection.exporterProtocol === 'grpc'
			? endpoint
			: this.buildOtlpTracesUrl(endpoint, connection.exporterTracingPath);
	}

	private toGrpcMetadata(headers: Record<string, string>, metadata: Metadata): Metadata {
		for (const [key, value] of Object.entries(headers)) {
			try {
				metadata.set(key.toLowerCase(), value);
			} catch {
				this.logger.warn(
					`Skipping invalid OTEL exporter header "${key}": gRPC metadata does not accept this key or its value.`,
				);
			}
		}
		return metadata;
	}

	parseOtlpHeaders(headersToSplit: string): Record<string, string> {
		const headers: Record<string, string> = {};
		for (const [index, pair] of headersToSplit.split(',').entries()) {
			const trimmedPair = pair.trim();
			if (!trimmedPair) continue;

			if (!trimmedPair.includes('=')) {
				this.logger.warn(
					`Skipping invalid OTEL exporter header entry ${index + 1}: missing "=" separator. Expected format: "key=value".`,
				);
				continue;
			}

			const [key, ...rest] = trimmedPair.split('=');
			const trimmedKey = key.trim();
			if (!trimmedKey) {
				this.logger.warn(
					`Skipping invalid OTEL exporter header entry ${index + 1}: empty key. Expected format: "key=value".`,
				);
				continue;
			}

			headers[trimmedKey] = rest.join('=').trim();
		}
		return headers;
	}

	private buildOtlpTracesUrl(endpoint: string, path: string): string {
		const exporterEndpointWithoutTrailingSlash = endpoint.replace(/\/+$/, '');
		return `${exporterEndpointWithoutTrailingSlash}${path}`;
	}

	private async checkEndpointReachability(activeExport: ActiveExport): Promise<void> {
		const { settings } = activeExport;
		const url = this.resolveExporterUrl(settings);
		const timeoutMs = settings.startupConnectivityTimeoutMs;

		try {
			if (settings.exporterProtocol === 'grpc') {
				await this.probeGrpcEndpoint(url, timeoutMs);
			} else {
				await this.probeHttpEndpoint(url, timeoutMs);
			}
		} catch (error) {
			if (this.activeExport !== activeExport) return;

			this.logger.error('Failed to connect to OpenTelemetry OTLP endpoint during startup', {
				endpoint: url,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async probeHttpEndpoint(url: string, timeoutMs: number): Promise<void> {
		// SSRF is disabled: the OTLP endpoint is admin-configured observability
		// infrastructure and is commonly an internal/localhost collector.
		await this.outboundHttp.transport({ useDefaultSsrfPolicy: 'unsafe' }).asCustomFetch()(url, {
			method: 'HEAD',
			signal: AbortSignal.timeout(timeoutMs),
		});
	}

	private async probeGrpcEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
		const { host, port, protocol } = new URL(endpoint);
		const { Client, credentials } = await import('@grpc/grpc-js');
		const client = new Client(
			host,
			protocol === 'https:' ? credentials.createSsl() : credentials.createInsecure(),
			{},
		);

		try {
			await new Promise<void>((resolve, reject) => {
				client.waitForReady(Date.now() + timeoutMs, (error) => {
					if (!error) return resolve();

					const portHint = port
						? ''
						: ' The endpoint has no port, so grpc-js dials its default 443, not 4317.';
					const tlsHint =
						protocol === 'https:'
							? ' This check ignores the OTEL_EXPORTER_OTLP_CERTIFICATE, client key and client certificate variables, so a private-CA or mTLS collector can fail it and still receive spans.'
							: '';

					reject(
						new OperationalError(
							`gRPC channel to "${host}" was not ready after ${timeoutMs}ms (${error.message}): nothing listens there, or it does not speak gRPC, or its TLS mode does not match the "${protocol}" scheme.${portHint}${tlsHint}`,
						),
					);
				});
			});
		} finally {
			client.close();
		}
	}
}
