import { createServer, type Server } from 'node:http';
import { nanoid } from 'nanoid';

import { expect, test } from '../../../fixtures/base';
import { getBackendUrl } from '../../../utils/url-helper';

/**
 * Proof run for the "Couldn't grade" state of agent checks.
 *
 * A fake OpenAI-compatible server stands in for the model. It answers the case
 * drafting and the agent run normally. It answers the judge with whatever
 * `judgeReply` holds, so a test can feed the judge an unreadable reply or a
 * readable verdict.
 *
 * The fake server listens on a free loopback port. The backend must run on this
 * host to reach it, so the suite skips when `N8N_BASE_URL` is not a loopback URL.
 *
 * Run it against an instance that has `N8N_AGENT_EVALS_ENABLED=true`:
 *
 *   N8N_TEST_ENV='{"N8N_AGENT_EVALS_ENABLED":"true","N8N_ENABLED_MODULES":"agents,agent-evals,data-table"}' \
 *     pnpm --filter=n8n-playwright test:local:isolated tests/e2e/agents/agent-evals-not-graded.spec.ts
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
const backendUrl = getBackendUrl();
const backendIsLocal = !!backendUrl && LOOPBACK_HOSTS.has(new URL(backendUrl).hostname);

let fakeLlmPort = 0;

const UNREADABLE_JUDGE_REPLY = "I'm sorry, but I can't help with evaluating this content.";
const FAIL_JUDGE_REPLY = '{"pass": false, "reasoning": "The response breaks the rule."}';

const SAMPLE_CASES = [
	{
		input: 'I was charged twice for my order. Can you refund me?',
		whatToCheck: 'Apologizes and explains how the refund will be handled',
		scenario: 'Refund',
	},
	{
		input: 'Where is my package? It was due last week.',
		whatToCheck: 'Acknowledges the delay and offers a next step',
		scenario: 'Delay',
	},
	{
		input: 'How do I reset my password?',
		whatToCheck: 'Gives clear steps to reset the password',
		scenario: 'Happy path',
	},
];

let judgeReply = UNREADABLE_JUDGE_REPLY;
let fakeLlm: Server;

function messagesText(messages: Array<{ content: unknown }>): string {
	return messages
		.map((message) =>
			typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
		)
		.join('\n');
}

function pickReply(prompt: string): string {
	if (
		prompt.includes('checking an AI assistant response against a rule') ||
		prompt.includes('evaluating an AI assistant response for factual correctness')
	) {
		return judgeReply;
	}
	if (prompt.includes('You generate realistic test cases')) {
		const count = Number(/exactly (\d+) test cases/.exec(prompt)?.[1] ?? 1);
		const cases = Array.from({ length: count }, (_, i) => SAMPLE_CASES[i % SAMPLE_CASES.length]);
		return JSON.stringify({ cases });
	}
	return 'Sorry about that. I have started a fix and you will see it in 3 to 5 days.';
}

test.use({ video: 'on' });

test.describe(
	'Agent checks: ungraded verdicts',
	{ annotation: [{ type: 'owner', description: 'Agent' }] },
	() => {
		test.skip(!backendIsLocal, 'The fake model server is only reachable from a local backend.');

		test.beforeAll(async () => {
			fakeLlm = createServer((request, response) => {
				let raw = '';
				request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
				request.on('end', () => {
					// The OpenAI client probes the Responses API first. Refuse it so it falls back to chat completions.
					if (request.url?.includes('/responses')) {
						response.writeHead(404, { 'content-type': 'application/json' });
						response.end(JSON.stringify({ error: { message: 'not found' } }));
						return;
					}
					const body = JSON.parse(raw || '{}') as {
						model?: string;
						stream?: boolean;
						messages?: Array<{ content: unknown }>;
					};
					const text = pickReply(messagesText(body.messages ?? []));
					const base = { id: 'chatcmpl-fake', created: 0, model: body.model ?? 'fake' };
					const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

					if (body.stream) {
						const chunk = (delta: object, finish: string | null) =>
							`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
						response.writeHead(200, { 'content-type': 'text/event-stream' });
						response.write(chunk({ role: 'assistant', content: text }, null));
						response.write(chunk({}, 'stop'));
						response.write(
							`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [], usage })}\n\n`,
						);
						response.end('data: [DONE]\n\n');
						return;
					}
					response.writeHead(200, { 'content-type': 'application/json' });
					response.end(
						JSON.stringify({
							...base,
							object: 'chat.completion',
							choices: [
								{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
							],
							usage,
						}),
					);
				});
			});
			await new Promise<void>((resolve) => fakeLlm.listen(0, '127.0.0.1', resolve));
			const address = fakeLlm.address();
			if (!address || typeof address === 'string') {
				throw new Error('Fake model server has no TCP address');
			}
			fakeLlmPort = address.port;
		});

		test.afterAll(async () => {
			await new Promise((resolve) => fakeLlm.close(resolve));
		});

		const createAgentAndOpenEvals = async (
			n8n: Parameters<Parameters<typeof test>[2]>[0]['n8n'],
			api: Parameters<Parameters<typeof test>[2]>[0]['api'],
		) => {
			const project = await api.projects.getMyPersonalProject();
			const credential = await api.credentials.createCredential({
				name: `Fake OpenAI ${nanoid(6)}`,
				type: 'openAiApi',
				data: { apiKey: 'sk-fake', url: `http://127.0.0.1:${fakeLlmPort}/v1` },
			});
			const { id: agentId } = await api.agents.create(project.id, {
				name: `Support Bot ${nanoid(6)}`,
				model: 'openai/gpt-4o-mini',
				credential: credential.id,
				instructions: 'You are a polite support assistant. Answer briefly.',
			});

			await n8n.start.fromHome();
			await n8n.agentBuilder.goto(project.id, agentId);
			await n8n.agentBuilder.openEvalsTab();
			// The tab drafts a few checks. Saving them opens the Checks panel and starts a run.
			await n8n.agentBuilder.addDraftedChecks();
			await expect(n8n.agentBuilder.getChecksPanel()).toBeVisible();
		};

		test('shows "Couldn’t grade" when the judge gives no readable verdict', async ({
			n8n,
			api,
		}) => {
			judgeReply = UNREADABLE_JUDGE_REPLY;
			await createAgentAndOpenEvals(n8n, api);

			const notGraded = n8n.agentBuilder.getNotGradedChecks();
			await expect(notGraded.first()).toBeVisible({ timeout: 90_000 });
			await expect(notGraded).toHaveCount(2, { timeout: 90_000 });
			await expect(n8n.agentBuilder.getRunningChecks()).toHaveCount(0);

			// An ungraded check is not the agent's fault: no "Needs work", no proposed fix.
			await expect(n8n.agentBuilder.getNeedsWorkChecks()).toHaveCount(0);
			await expect(n8n.agentBuilder.getFixSuggestions()).toHaveCount(0);
			await n8n.page.screenshot({ path: test.info().outputPath('not-graded.png') });
		});

		test('still shows "Needs work" when the judge gives a readable fail', async ({ n8n, api }) => {
			judgeReply = FAIL_JUDGE_REPLY;
			await createAgentAndOpenEvals(n8n, api);

			await expect(n8n.agentBuilder.getNeedsWorkChecks().first()).toBeVisible({
				timeout: 90_000,
			});
			await expect(n8n.agentBuilder.getRunningChecks()).toHaveCount(0);
			await expect(n8n.agentBuilder.getNotGradedChecks()).toHaveCount(0);
			await n8n.page.screenshot({ path: test.info().outputPath('needs-work.png') });
		});
	},
);
