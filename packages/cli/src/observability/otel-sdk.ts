import { Logger } from '@n8n/backend-common';
import { ExpressionEngineConfig } from '@n8n/config';
import { Service } from '@n8n/di';
import { DiagLogLevel, diag, type DiagLogger } from '@opentelemetry/api';
import { getBooleanFromEnv } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

import {
	SwappablePropagator,
	SwappableSampler,
	SwappableSpanProcessor,
	type ShutdownErrors,
	type TracingPipeline,
} from './swappable-pipeline';
import {
	applyTracerConfigurator,
	createTracerConfigurator,
	isTracerProviderRegistered,
} from './tracer-gate';
import {
	AGENTS_TRACER_NAME,
	DAYTONA_TRACER_NAME,
	MICROSOFT_AGENT_365_TRACER_NAME,
	MICROSOFT_AGENTS_TRACER_NAME,
	WORKFLOW_TRACER_NAME,
} from './tracer-names';
import { TracingSourcesConfig } from './tracing-sources.config';

import { N8N_VERSION } from '@/constants';
import { TRACER_NAME as EXPRESSION_TRACER_NAME } from '@/expression-observability/expression-observability.constants';

type TracerSource = { tracerNames: string[]; enabled: boolean };

@Service()
export class OtelSdk {
	private readonly spanProcessor = new SwappableSpanProcessor();

	private readonly sampler = new SwappableSampler();

	private readonly propagator = new SwappablePropagator();

	private running = false;

	constructor(
		private readonly logger: Logger,
		private readonly expressionEngineConfig: ExpressionEngineConfig,
		private readonly tracingSourcesConfig: TracingSourcesConfig,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	start(): void {
		diag.setLogger(this.diagnosticsLogger(), DiagLogLevel.WARN);

		if (getBooleanFromEnv('OTEL_SDK_DISABLED')) {
			this.logger.warn('OTEL_SDK_DISABLED is true, so n8n sends no OpenTelemetry spans');
			return;
		}

		if (isTracerProviderRegistered()) {
			this.logger.warn(
				'Another OpenTelemetry setup is already registered, so n8n sends its spans there and ignores its own OpenTelemetry settings',
			);
			return;
		}

		new NodeSDK({
			resource: resourceFromAttributes({ [ATTR_SERVICE_VERSION]: N8N_VERSION }),
			sampler: this.sampler,
			textMapPropagator: this.propagator,
			spanProcessors: [this.spanProcessor],
			metricReaders: [],
			logRecordProcessors: [],
		}).start();

		applyTracerConfigurator(createTracerConfigurator(this.enabledTracerNames()));
		this.running = true;
	}

	async apply({ spanProcessors, sampler, propagator }: TracingPipeline): Promise<ShutdownErrors> {
		if (!this.running) return [];

		this.sampler.replace(sampler);
		this.propagator.replace(propagator);
		return await this.spanProcessor.replace(spanProcessors);
	}

	private enabledTracerNames(): Set<string> {
		const sources: TracerSource[] = [
			{ tracerNames: [WORKFLOW_TRACER_NAME, AGENTS_TRACER_NAME], enabled: true },
			{
				tracerNames: [EXPRESSION_TRACER_NAME],
				enabled: this.expressionEngineConfig.tracesEnabled,
			},
			{
				tracerNames: [DAYTONA_TRACER_NAME],
				enabled: this.tracingSourcesConfig.daytonaTracingEnabled,
			},
			{
				tracerNames: [MICROSOFT_AGENTS_TRACER_NAME, MICROSOFT_AGENT_365_TRACER_NAME],
				enabled: this.tracingSourcesConfig.microsoftAgent365TracingEnabled,
			},
		];

		return new Set(
			sources.filter(({ enabled }) => enabled).flatMap(({ tracerNames }) => tracerNames),
		);
	}

	private diagnosticsLogger(): DiagLogger {
		return {
			error: (...args: unknown[]) => this.logger.error('OpenTelemetry diagnostics error', { args }),
			warn: (...args: unknown[]) => this.logger.warn('OpenTelemetry diagnostics warning', { args }),
			info: (...args: unknown[]) => this.logger.info('OpenTelemetry diagnostics info', { args }),
			debug: (...args: unknown[]) => this.logger.debug('OpenTelemetry diagnostics debug', { args }),
			verbose: (...args: unknown[]) =>
				this.logger.debug('OpenTelemetry diagnostics verbose', { args }),
		};
	}
}
