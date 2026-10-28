import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunRequestIntents, REQUEST_INTENT_PREFIX, REQUEST_RESPONSE_TIMEOUT_MS, type IntentStorage, type IntentTransport, type StartIntentBody } from '../../apps/runner-ui/src/request-intent';

const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', runId = 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const input = () => ({ packageHandle: 'pkg_private', inputs: { privateText: '민감한 본문', nested: { number: 1 } }, modelBindings: { privateAlias: 'private-profile' } });
class MemoryStorage implements IntentStorage {
  readonly values = new Map<string, string>(); get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
function setup(start: IntentTransport['start'] = async () => { throw new TypeError('lost response'); }) {
  const storage = new MemoryStorage(), transport = { start: vi.fn(start), lookup: vi.fn<IntentTransport['lookup']>(async () => ({ state: 'not_found' })) };
  let count = 0; const journal = new RunRequestIntents(() => storage, transport, () => ++count === 1 ? first : second);
  return { storage, transport, journal };
}
afterEach(() => vi.useRealTimers());

/** Faults replace only browser storage/HTTP boundaries. Assertions cover privacy and state transitions, not source text. */
describe('run request intent journal', () => {
  it('records only an opaque ID before POST and reuses the original body after caller mutation', async () => {
    const item = setup(); const value = input(); await expect(item.journal.start(value)).rejects.toThrow('lost response');
    const serialized = JSON.stringify([...item.storage.values]);
    expect(serialized).toBe(JSON.stringify([[REQUEST_INTENT_PREFIX + first, 'pending']]));
    for (const secret of ['민감한 본문', 'pkg_private', 'privateAlias', 'private-profile', 'inputs', 'modelBindings']) expect(serialized).not.toContain(secret);
    value.inputs.privateText = 'edited'; value.inputs.nested.number = 2; value.modelBindings.privateAlias = 'changed';
    item.transport.start.mockResolvedValue({ runId }); await expect(item.journal.retry(first)).resolves.toBe(runId);
    expect(item.transport.start.mock.calls[1]![0]).toEqual(item.transport.start.mock.calls[0]![0]); expect(item.journal.pending()).toEqual([]);
  });
  it('has durable metadata already present when the first transport is entered', async () => {
    const item = setup(); item.transport.start.mockImplementation(async body => { expect(item.storage.getItem(REQUEST_INTENT_PREFIX + body.requestId)).toBe('pending'); return { runId }; });
    await item.journal.start(input()); expect(item.storage.length).toBe(0);
  });
  it('does not send if storage is unavailable, throws on write, or fails to persist', async () => {
    for (const mode of ['get', 'write', 'discard'] as const) {
      const item = setup(); const storage = mode === 'get' ? () => { throw new Error('blocked'); } : () => item.storage;
      if (mode === 'write') item.storage.setItem = () => { throw new Error('quota'); };
      if (mode === 'discard') item.storage.setItem = () => {};
      const journal = new RunRequestIntents(storage, item.transport, () => first);
      await expect(journal.start(input())).rejects.toThrow(/저장|기록/); expect(item.transport.start).not.toHaveBeenCalled();
    }
  });
  it('never recreates the input on reload and not_found does not delete or resubmit the request', async () => {
    const item = setup(); await expect(item.journal.start(input())).rejects.toThrow(); const reloaded = new RunRequestIntents(() => item.storage, item.transport);
    expect(reloaded.pending()).toEqual([{ requestId: first, retryAvailable: false }]); await expect(reloaded.lookup(first)).resolves.toBeUndefined();
    await expect(reloaded.retry(first)).rejects.toThrow(/원래 입력/); expect(item.transport.start).toHaveBeenCalledTimes(1); expect(item.storage.length).toBe(1);
  });
  it('only clears a stored ID after a valid exact lookup and exposes the run ID without body fields', async () => {
    const item = setup(); await expect(item.journal.start(input())).rejects.toThrow(); item.transport.lookup.mockResolvedValue({ state: 'found', runId });
    await expect(item.journal.lookup(first)).resolves.toBe(runId); expect(item.journal.pending()).toEqual([]); await expect(item.journal.retry(first)).rejects.toThrow();
  });
  it.each([null, {}, { state: 'found', runId: '../unsafe' }, { state: 'not_found', input: 'unexpected' }, { state: 'found', runId, inputs: 'unexpected' }])('preserves recovery metadata on malformed lookup %j', async response => {
    const item = setup(); await expect(item.journal.start(input())).rejects.toThrow(); item.transport.lookup.mockResolvedValue(response);
    await expect(item.journal.lookup(first)).rejects.toThrow(); expect(item.storage.length).toBe(1);
  });
  it('preserves both requests only when a separate execution is explicitly selected', async () => {
    const item = setup(); await expect(item.journal.start(input())).rejects.toThrow();
    await expect(item.journal.start({ ...input(), inputs: { changed: true } })).rejects.toThrow(/확인되지/); expect(item.transport.start).toHaveBeenCalledTimes(1);
    await expect(item.journal.start({ ...input(), inputs: { changed: true } }, true)).rejects.toThrow('lost response');
    expect(item.journal.pending().map(value => value.requestId)).toEqual([first, second]); expect(item.transport.start.mock.calls[1]![0].requestId).toBe(second);
  });
  it('serializes repeated clicks before React renders and refuses a concurrent lookup or retry', async () => {
    let release!: (value: unknown) => void; const item = setup(() => new Promise(resolve => { release = resolve; }));
    const action = item.journal.start(input()); await expect(item.journal.start(input())).rejects.toThrow(/확인되지/);
    await expect(item.journal.retry(first)).rejects.toThrow(/이미 확인/); await expect(item.journal.lookup(first)).rejects.toThrow(/이미 확인/);
    release({ runId }); await action; expect(item.transport.start).toHaveBeenCalledTimes(1);
  });
  it('rejects corrupt or over-limit owned records rather than silently replacing them', async () => {
    const item = setup(); item.storage.setItem(REQUEST_INTENT_PREFIX + '../bad', 'pending');
    await expect(item.journal.start(input(), true)).rejects.toThrow(/읽을 수/); expect(item.transport.start).not.toHaveBeenCalled();
    item.storage.values.clear(); for (let index = 0; index < 32; index++) item.storage.setItem(REQUEST_INTENT_PREFIX + `${index.toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, 'pending');
    await expect(item.journal.start(input(), true)).rejects.toThrow(/너무 많/); expect(item.transport.start).not.toHaveBeenCalled();
  });
  it('preserves a successful run response if storage cleanup fails without preserving a retry body', async () => {
    const item = setup(async () => ({ runId })); item.storage.removeItem = () => { throw new Error('storage blocked'); };
    await expect(item.journal.start(input())).resolves.toBe(runId); expect(item.journal.pending()).toEqual([{ requestId: first, retryAvailable: false }]);
  });
  it('blocks a future journal version and preserves a malformed success response for recovery', async () => {
    const item = setup(); item.storage.setItem('studio-run-request:v2:' + first, 'pending');
    await expect(item.journal.start(input())).rejects.toThrow(/읽을 수/); expect(item.transport.start).not.toHaveBeenCalled();
    item.storage.values.clear(); item.transport.start.mockResolvedValue({ runId: '../../wrong' });
    await expect(item.journal.start(input())).rejects.toThrow(/식별값/); expect(item.journal.pending()).toHaveLength(1);
  });
  it('retries a fresh deserialized copy even if an HTTP boundary mutated its earlier argument', async () => {
    const received: StartIntentBody[] = []; const item = setup(async body => { received.push(structuredClone(body)); body.modelBindings.privateAlias = 'mutated-by-transport'; throw new Error('lost'); });
    await expect(item.journal.start(input())).rejects.toThrow(); await expect(item.journal.retry(first)).rejects.toThrow(); expect(received[0]).toEqual(received[1]);
  });
  it('bounds the browser wait without treating the timeout or a late response as a cancelled server operation', async () => {
    vi.useFakeTimers(); let release!: (value: unknown) => void;
    const item = setup(() => new Promise(resolve => { release = resolve; })); const request = item.journal.start(input());
    const failure = expect(request).rejects.toThrow(/중단되었다는 뜻은 아닙니다/); await vi.advanceTimersByTimeAsync(REQUEST_RESPONSE_TIMEOUT_MS); await failure;
    release({ runId }); await Promise.resolve(); expect(item.journal.pending()).toEqual([{ requestId: first, retryAvailable: true }]);
    item.transport.start.mockResolvedValue({ runId }); await expect(item.journal.retry(first)).resolves.toBe(runId);
    expect(item.transport.start.mock.calls[1]![0]).toEqual(item.transport.start.mock.calls[0]![0]);
  });
});
