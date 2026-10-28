import { describe, expect, it } from 'vitest';
import { countLabels, generationLabels, presentWorkingContexts, type WorkingContextView } from '../../apps/runner-ui/src/working-context-presentation';
import { withoutRunContent } from '../../apps/runner-ui/src/run-disclosure';
import type { Run } from '../../apps/runner-ui/src/types';

const digest = 'a'.repeat(64);
/** These runtime records are test-only input. Product rendering cannot fabricate a preparation or delivery record. */
function record(): WorkingContextView {
  return { id: `context_${digest}`, manifestHash: digest, countId: 'count_1', reservationId: 'reservation_1', countState: 'confirmed', generationState: 'response_confirmed', errorCode: null, preparedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:01.000Z', manifest: { version: 1, runId: 'run_1', nodeId: 'work', nodeInstanceId: 'run_1:work', attemptId: 'attempt_1', planHash: digest, workDefinitionHash: digest, contextNodeId: 'working_context', contextResultHash: digest, businessTaskHash: digest, maxBytes: 262144, requestHash: digest, requestBytes: 4096, provider: 'openai', model: 'test-only-model', selectionScope: 'task_fixed_attachments', assets: [
    { alias: 'guide', id: 'guide', revision: 3, sha256: digest, kind: 'instruction', usage: 'instructions', purpose: '필수 원문 판단', required: true, selected: true, reason: 'selected', files: [{ path: 'instructions.md', sha256: digest, bytes: 200, selected: true, purpose: 'instructions', reason: 'selected' }, { path: 'LICENSE.txt', sha256: digest, bytes: 100, selected: false, purpose: 'excluded', reason: 'license_not_context' }] },
    { alias: 'excluded', id: 'excluded', revision: 1, sha256: digest, kind: 'document', usage: 'reference', purpose: '이번 요청에서 제외한 참고문서', required: false, selected: false, reason: 'not_selected', files: [{ path: 'document.md', sha256: digest, bytes: 500, selected: false, purpose: 'excluded', reason: 'not_selected' }] },
  ] } };
}
const present = (value: unknown, total: unknown = 1) => presentWorkingContexts(value, total, 'run_1');
describe('Runner working context metadata boundary', () => {
  it('distinguishes an older response, no prepared records and a bounded truncated response', () => {
    expect(presentWorkingContexts(undefined, undefined, 'run_1').state).toBe('absent');
    expect(present([], 0)).toEqual({ state: 'valid', records: [], total: 0 });
    expect(present([record()], 101)).toMatchObject({ state: 'valid', total: 101 });
    for (const [records, total] of [[undefined, 0], [[], undefined], [null, 0], [[record()], 0], [[], -1], [[], 0.5], [[], Number.MAX_SAFE_INTEGER + 1]]) expect(presentWorkingContexts(records, total, 'run_1').state).toBe('invalid');
  });
  it('retains selected and excluded fixed versions, source hashes and file reasons without modifying the input', () => {
    const input = record(), original = structuredClone(input), view = present([input]);
    expect(view.state).toBe('valid'); expect(view.records[0]?.manifest.assets).toEqual(original.manifest.assets); expect(input).toEqual(original);
  });
  it.each(['not_started', 'invocation_intent', 'confirmed', 'failed', 'unknown'] as const)('keeps count state %s distinct from generation', state => {
    const input = record(); input.countState = state; input.countId = state === 'not_started' ? null : 'count_1'; input.reservationId = null; input.generationState = 'not_started';
    expect(present([input]).state).toBe('valid'); expect(new Set(Object.values(countLabels)).size).toBe(5);
  });
  it.each(['not_started', 'invocation_intent', 'response_confirmed', 'failed_confirmed', 'unknown'] as const)('keeps generation state %s distinct from business success', state => {
    const input = record(); input.generationState = state; expect(present([input]).state).toBe('valid'); expect(generationLabels[state]).not.toContain('업무 완료'); expect(generationLabels[state]).not.toContain('전달 완료');
  });
  it.each(['record', 'manifest', 'asset', 'file'] as const)('rejects unexpected body/secret fields at the %s level instead of rendering raw JSON', level => {
    const input = record(); const target = level === 'record' ? input : level === 'manifest' ? input.manifest : level === 'asset' ? input.manifest.assets[0]! : input.manifest.assets[0]!.files[0]!;
    Object.assign(target, { privateInput: 'must-never-render-personal-body' }); const view = present([input]); expect(view).toEqual({ state: 'invalid', records: [], total: 0 }); expect(JSON.stringify(view)).not.toContain('must-never');
  });
  it.each(['run', 'instance', 'bytes', 'hash', 'version', 'futureState', 'countLink', 'reservationLink', 'timestamp', 'selection', 'fileSelection', 'path'] as const)('rejects inconsistent %s metadata', change => {
    const input = record();
    if (change === 'run') input.manifest.runId = 'other_run';
    if (change === 'instance') input.manifest.nodeInstanceId = 'run_1:other_node';
    if (change === 'bytes') input.manifest.requestBytes = 1048576;
    if (change === 'hash') input.manifest.requestHash = 'not-a-hash';
    if (change === 'version') Object.assign(input.manifest, { version: 2 });
    if (change === 'futureState') Object.assign(input, { generationState: 'delivered' });
    if (change === 'countLink') input.countId = null;
    if (change === 'reservationLink') input.reservationId = null;
    if (change === 'timestamp') input.updatedAt = '2026-02-31T00:00:00.000Z';
    if (change === 'selection') input.manifest.assets[0]!.selected = false;
    if (change === 'fileSelection') input.manifest.assets[0]!.files[0]!.reason = 'not_selected';
    if (change === 'path') input.manifest.assets[0]!.files[0]!.path = '../private.txt';
    expect(present([input]).state).toBe('invalid');
  });
  it('rejects duplicate records, attempt IDs, aliases and file paths rather than double-counting selections', () => {
    expect(present([record(), record()], 2).state).toBe('invalid');
    const second = record(); second.id = `context_${'b'.repeat(64)}`; expect(present([record(), second], 2).state).toBe('invalid');
    const alias = record(); alias.manifest.assets.push(structuredClone(alias.manifest.assets[0]!)); expect(present([alias]).state).toBe('invalid');
    const path = record(); path.manifest.assets[0]!.files.push(structuredClone(path.manifest.assets[0]!.files[0]!)); expect(present([path]).state).toBe('invalid');
  });
  it('rejects getters, sparse/decorated arrays, hidden fields and cycles without invoking getters', () => {
    let reads = 0; const getter = record(); Object.defineProperty(getter, 'manifest', { enumerable: true, get() { reads++; return record().manifest; } }); expect(present([getter]).state).toBe('invalid'); expect(reads).toBe(0);
    const sparse = new Array(1); Object.assign(sparse, { extension: record() }); expect(present(sparse).state).toBe('invalid');
    const hidden = record(); Object.defineProperty(hidden, 'secret', { value: 'hidden' }); expect(present([hidden]).state).toBe('invalid');
    const cyclic = record(); Object.assign(cyclic, { cycle: cyclic }); expect(present([cyclic]).state).toBe('invalid');
  });
  it('enforces record, manifest and combined byte limits before displaying even the first record', () => {
    expect(present(Array.from({ length: 101 }, record), 101).state).toBe('invalid');
    const item = record(), originalFile = item.manifest.assets[0]!.files[0]!;
    item.manifest.assets[0]!.files = Array.from({ length: 300 }, (_, i) => ({ ...originalFile, path: `${i}/${'한'.repeat(300)}.md` })); expect(present([item]).state).toBe('invalid');
    const a = record(); a.manifest.assets[0]!.files = Array.from({ length: 700 }, (_, i) => ({ ...originalFile, path: `${i}/${'a'.repeat(100)}.md` }));
    const records = [a, structuredClone(a), structuredClone(a)]; records.forEach((value, i) => { value.id = `context_${String(i).repeat(64)}`; value.manifest.attemptId = `attempt_${i}`; }); expect(present(records, 3).state).toBe('invalid');
  });
  it('drops all context records from history and denied caches while leaving the original immutable', () => {
    const original: Run = { id: 'run_1', packageHandle: 'package_1', status: 'succeeded', createdAt: 'now', error: null, result: 'private result', usage: { modelCalls: 1, consumedTokens: 10, reservedTokens: 0 }, workingContexts: [record()], workingContextCount: 1 };
    const cleared = withoutRunContent(original); expect(cleared.workingContexts).toEqual([]); expect(cleared.workingContextCount).toBe(0); expect(JSON.stringify(cleared)).not.toContain('필수 원문 판단'); expect(original.workingContextCount).toBe(1);
  });
});
