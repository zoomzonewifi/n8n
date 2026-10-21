import { Container } from '@n8n/di';

import { TracingSourcesConfig } from '../tracing-sources.config';

describe('TracingSourcesConfig', () => {
	beforeEach(() => {
		Container.reset();
	});

	afterEach(() => {
		delete process.env.N8N_DAYTONA_TRACING_ENABLED;
		delete process.env.N8N_MICROSOFT_AGENT_365_TRACING_ENABLED;
	});

	it('keeps every opt-in off by default', () => {
		expect(Container.get(TracingSourcesConfig)).toEqual({
			daytonaTracingEnabled: false,
			microsoftAgent365TracingEnabled: false,
		});
	});

	it('reads each opt-in from its env var', () => {
		process.env.N8N_DAYTONA_TRACING_ENABLED = 'true';
		process.env.N8N_MICROSOFT_AGENT_365_TRACING_ENABLED = 'true';

		expect(Container.get(TracingSourcesConfig)).toEqual({
			daytonaTracingEnabled: true,
			microsoftAgent365TracingEnabled: true,
		});
	});
});
