import { Config, Env, sampleRateSchema } from '@n8n/config';

@Config
export class SentryConfig {
	/** Sentry DSN (data source name) */
	@Env('N8N_SENTRY_DSN')
	dsn: string = '';

	/**
	 * Share of n8n processes that record Sentry profiles, from 0.0 to 1.0. Each
	 * process decides once at startup and then profiles the traces it sends, so
	 * also set `N8N_SENTRY_TRACES_SAMPLE_RATE` above 0. Set to 0 to turn off
	 * profiling.
	 */
	@Env('N8N_SENTRY_PROFILES_SAMPLE_RATE', sampleRateSchema)
	profilesSampleRate: number = 0;

	/**
	 * Sample rate for Sentry traces (0.0 to 1.0).
	 * This determines what percentage of transactions are profiled.
	 *
	 * @default 0 (disabled)
	 */
	@Env('N8N_SENTRY_TRACES_SAMPLE_RATE', sampleRateSchema)
	tracesSampleRate: number = 0;

	//#region Metadata about the environment

	@Env('N8N_VERSION')
	n8nVersion: string = '';

	@Env('ENVIRONMENT')
	environment: string = '';

	@Env('DEPLOYMENT_NAME')
	deploymentName: string = '';

	//#endregion
}
