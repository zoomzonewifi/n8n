import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';

import { bootObservability } from '../observability-boot';
import { OtelSdk } from '../otel-sdk';

const loadSentryHook = vi.fn();

describe('bootObservability', () => {
	const otelSdk = mock<OtelSdk>();
	const logger = mock<Logger>();

	async function bootWithSentry(sentry: { backendDsn: string; tracesSampleRate: number }) {
		Container.set(GlobalConfig, mock<GlobalConfig>({ sentry }));
		Container.set(OtelSdk, otelSdk);
		Container.set(Logger, logger);
		await bootObservability();
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		vi.doMock('@sentry/node/import', () => {
			loadSentryHook();
			return {};
		});
	});

	it('loads the Sentry load hook when a DSN is set and Sentry tracing is on', async () => {
		await bootWithSentry({ backendDsn: 'https://key@sentry.example/1', tracesSampleRate: 0.1 });

		expect(loadSentryHook).toHaveBeenCalledTimes(1);
	});

	it.each([
		['no DSN is set', { backendDsn: '', tracesSampleRate: 0.1 }],
		['Sentry tracing is off', { backendDsn: 'https://key@sentry.example/1', tracesSampleRate: 0 }],
	])('skips the Sentry load hook when %s', async (_case, sentry) => {
		await bootWithSentry(sentry);

		expect(loadSentryHook).not.toHaveBeenCalled();
	});

	it('starts OpenTelemetry when the Sentry load hook fails', async () => {
		loadSentryHook.mockImplementationOnce(() => {
			throw new Error('hook failed');
		});

		await bootWithSentry({ backendDsn: 'https://key@sentry.example/1', tracesSampleRate: 0.1 });

		expect(otelSdk.start).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to load the Sentry load hook, so Sentry traces have no route names',
			{ error: expect.any(String) },
		);
	});

	it('logs the error and lets n8n start when the OTel setup throws', async () => {
		otelSdk.start.mockImplementationOnce(() => {
			throw new Error('setup failed');
		});

		await expect(bootWithSentry({ backendDsn: '', tracesSampleRate: 0 })).resolves.not.toThrow();
		expect(logger.error).toHaveBeenCalledWith(
			'Failed to set up observability at startup, so tracing stays off',
			{ error: 'setup failed' },
		);
	});

	it('starts the OTel setup once', async () => {
		await bootWithSentry({ backendDsn: '', tracesSampleRate: 0 });

		expect(otelSdk.start).toHaveBeenCalledTimes(1);
	});
});
