import { afterEach, expect, it, vi } from 'vitest';
import { downloadFile, RunnerApiError } from '../../apps/runner-ui/src/api/client';
import { disclosureFailure, withoutRunContent } from '../../apps/runner-ui/src/run-disclosure';
import type { Run } from '../../apps/runner-ui/src/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

/** Metadata may remain useful after denial; no body-shaped field belongs in the history cache or denied view. */
it('clears run bodies, file paths, waits and future extra content while preserving minimal operational usage', () => {
  const run = { id: 'run', packageHandle: 'package', status: 'succeeded', createdAt: 'now', error: null, usage: { modelCalls: 1, consumedTokens: 20, reservedTokens: 0 }, result: 'private body', files: [{ reference: { filename: 'private.txt' } }], waits: [{ context: 'private question' }], childScopes: [{ error: { message: 'private child' } }], nodes: ['private node'], futureBody: 'private extension', disclosure: { allowed: false, code: 'RAG_DISCLOSURE_CHANGED' } } as unknown as Run;
  const safe = withoutRunContent(run); expect(JSON.stringify(safe)).not.toContain('private'); expect(safe.result).toBeNull(); expect(safe.usage).toEqual(run.usage); expect(safe.status).toBe('succeeded'); expect(safe.disclosure?.allowed).toBe(false); expect(run.result).toBe('private body');
});
it('recognizes the exact disclosure errors without treating unrelated network failures as permission revocation', () => {
  for (const code of ['RAG_DISCLOSURE_CHANGED', 'RAG_DISCLOSURE_UNAVAILABLE', 'RAG_DISCLOSURE_STATE_REQUIRED', 'RAG_DISCLOSURE_SEALED']) expect(disclosureFailure(new RunnerApiError('message', code, 403))).toBe(true);
  expect(disclosureFailure(new RunnerApiError('network', 'NETWORK_ERROR', 500))).toBe(false); expect(disclosureFailure(new Error('RAG_DISCLOSURE_CHANGED'))).toBe(false);
});

/** The server can approve a response before a subsequent UI denial; saving must still honor the latest local generation. */
it('does not create a file download when disclosure changes while its bytes are arriving', async () => {
  let release!: (bytes: Blob) => void; let started!: () => void; let allowed = true;
  const reading = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<Blob>(resolve => { release = resolve; });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: () => { started(); return pending; } })));
  const objectUrl = vi.spyOn(URL, 'createObjectURL');
  const action = downloadFile('/api/runs/run/artifacts/file', 'document.txt', () => allowed);
  await reading; allowed = false; release(new Blob(['private original'])); await action;
  expect(objectUrl).not.toHaveBeenCalled();
});

it('saves the authenticated file once when its current UI generation still allows it', async () => {
  vi.useFakeTimers(); const click = vi.fn(); const anchor = { href: '', download: '', click };
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('allowed original', { status: 200 })));
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-only'); const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  await downloadFile('/api/runs/run/artifacts/file', 'document.txt', () => true);
  expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(anchor.download).toBe('document.txt');
  await vi.runAllTimersAsync(); expect(revoke).toHaveBeenCalledWith('blob:test-only');
});
