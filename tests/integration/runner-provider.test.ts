import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesProvider } from '../../apps/runner/src/providers/openai.js';

afterEach(() => vi.unstubAllGlobals());

/** The HTTP boundary is replaced only in tests; this does not claim a successful real API call. */
describe('OpenAI Responses wire contract', () => {
  it('counts identical instructions/content/schema while excluding unsupported generation-only settings', async () => {
    const sent: { url: string; body: Record<string, unknown>; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { sent.push({ url, body: JSON.parse(String(options.body)), options }); return new Response(JSON.stringify(url.endsWith('/input_tokens') ? { object: 'response.input_tokens', input_tokens: 17 } : { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }], usage: { input_tokens: 17, output_tokens: 1, total_tokens: 18 } })); });
    const request = { model: 'contract-model', instructions: '규칙', content: { nested: { text: '원문' } }, maxOutputTokens: 100, responseFormat: { mode: 'json' as const, schema: { type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false } } };
    const provider = new OpenAIResponsesProvider(); const context = { apiKey: 'test-only-key', signal: new AbortController().signal };
    expect(await provider.countInputTokens(request, context)).toBe(17); await provider.generate(request, context);
    expect(sent[0]!.url).toBe('https://api.openai.com/v1/responses/input_tokens'); expect(sent[0]!.body).toEqual(Object.fromEntries(Object.entries(sent[1]!.body).filter(([key]) => !['store', 'max_output_tokens'].includes(key)))); expect(sent[0]!.body.text).toEqual(sent[1]!.body.text); expect(sent[0]!.options.redirect).toBe('error');
  });

  it.each([401, 403, 429, 500])('fails closed on count HTTP %s with no upstream text disclosure', async status => {
    vi.stubGlobal('fetch', async () => new Response('secret-key private payload', { status }));
    await expect(new OpenAIResponsesProvider().countInputTokens({ model: 'contract-model', content: 'private payload', instructions: '', maxOutputTokens: 100, responseFormat: { mode: 'text' } }, { apiKey: 'test-only-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: status === 401 || status === 403 ? 'MODEL_COUNT_AUTH_FAILED' : 'MODEL_COUNT_REJECTED', outcome: 'not_started', retryable: false });
  });

  it.each(['{"object":"response.input_tokens","input_tokens":1,"input_tokens":2}', 'not-json', ' '.repeat(65537)])('rejects ambiguous or unbounded count responses', async body => {
    vi.stubGlobal('fetch', async () => new Response(body));
    await expect(new OpenAIResponsesProvider().countInputTokens({ model: 'contract-model', content: 'text', instructions: '', maxOutputTokens: 100, responseFormat: { mode: 'text' } }, { apiKey: 'test-only-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_COUNT_INVALID', outcome: 'not_started' });
  });

  it('does not fetch after cancellation and fails closed on a count network error', async () => {
    const fetcher = vi.fn(async () => { throw new Error('private server detail'); }); vi.stubGlobal('fetch', fetcher); const request = { model: 'contract-model', content: 'text', instructions: '', maxOutputTokens: 100, responseFormat: { mode: 'text' as const } };
    await expect(new OpenAIResponsesProvider().countInputTokens(request, { apiKey: 'test-only-key', signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'MODEL_COUNT_CANCELLED', outcome: 'not_started' }); expect(fetcher).not.toHaveBeenCalled();
    await expect(new OpenAIResponsesProvider().countInputTokens(request, { apiKey: 'test-only-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_COUNT_UNAVAILABLE', outcome: 'not_started' });
  });

  it('uses the fixed origin, disables storage, and requests strict JSON output', async () => {
    let sent: { url: string; options: RequestInit } | undefined;
    vi.stubGlobal('fetch', async (url: string, options: RequestInit) => { sent = { url, options }; return new Response(JSON.stringify({ id: 'response_test', model: 'contract-model', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"완료"}' }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }), { status: 200 }); });
    const response = await new OpenAIResponsesProvider().generate({ model: 'contract-model', content: '요약할 내용', instructions: '요약', maxOutputTokens: 100, responseFormat: { mode: 'json', schema: { type: 'object' } } }, { apiKey: 'test-only-key', signal: new AbortController().signal });
    expect(sent?.url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(String(sent?.options.body));
    expect(body.store).toBe(false); expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
    expect(response).toMatchObject({ text: '{"summary":"완료"}', usage: { totalTokens: 5 } });
  });

  it('does not expose raw upstream messages or secrets in authentication failures', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'test-only-key private request text' } }), { status: 401 }));
    await expect(new OpenAIResponsesProvider().generate({ model: 'contract-model', content: 'private request text', instructions: '', maxOutputTokens: 100, responseFormat: { mode: 'text' } }, { apiKey: 'test-only-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_AUTH_FAILED', outcome: 'not_started' });
  });

  it('rejects truncated output instead of treating partial text as completed', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ status: 'incomplete', output: [{ content: [{ type: 'output_text', text: 'partial' }] }] }), { status: 200 }));
    await expect(new OpenAIResponsesProvider().generate({ model: 'contract-model', content: 'text', instructions: '', maxOutputTokens: 100, responseFormat: { mode: 'text' } }, { apiKey: 'test-only-key', signal: new AbortController().signal })).rejects.toMatchObject({ code: 'MODEL_INCOMPLETE' });
  });
});
