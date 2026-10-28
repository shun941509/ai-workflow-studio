/** Closed, CSP-safe runtime DTO boundary. This temporary client contract is independent of server imports and contains no bodies. */
export interface ContextFileView { path: string; sha256: string; bytes: number; selected: boolean; purpose: 'instructions' | 'reference' | 'template' | 'skill_reference' | 'skill_asset' | 'excluded'; reason: 'selected' | 'not_selected' | 'license_not_context' | 'binary_metadata_only' | 'execution_not_supported' }
export interface ContextAssetView { alias: string; id: string; revision: number; sha256: string; kind: 'instruction' | 'document' | 'skill'; usage: 'instructions' | 'reference' | 'template'; purpose: string; required: boolean; selected: boolean; reason: 'selected' | 'not_selected'; files: ContextFileView[] }
export interface WorkingContextView {
  id: string; manifestHash: string; countId: string | null; reservationId: string | null;
  countState: 'not_started' | 'invocation_intent' | 'confirmed' | 'failed' | 'unknown';
  generationState: 'not_started' | 'invocation_intent' | 'response_confirmed' | 'failed_confirmed' | 'unknown';
  errorCode: string | null; preparedAt: string; updatedAt: string;
  manifest: { version: 1; runId: string; nodeId: string; nodeInstanceId: string; attemptId: string; planHash: string; workDefinitionHash: string; contextNodeId: string; contextResultHash: string; businessTaskHash: string; maxBytes: number; selectionScope: 'task_fixed_attachments'; assets: ContextAssetView[]; requestHash: string; requestBytes: number; model: string; provider: 'openai' };
}
export type ContextPresentation = { state: 'absent' | 'invalid'; records: []; total: 0 } | { state: 'valid'; records: WorkingContextView[]; total: number };

export const countLabels: Record<WorkingContextView['countState'], string> = { not_started: '계량 시작 전', invocation_intent: '계량 호출 의도 기록', confirmed: '계량 응답 확인', failed: '계량 실패', unknown: '계량 결과 확인 불가' };
export const generationLabels: Record<WorkingContextView['generationState'], string> = { not_started: '생성 시작 전', invocation_intent: '생성 호출 의도 기록', response_confirmed: '생성 응답·사용량 확인', failed_confirmed: '생성 실패 확인', unknown: '생성 결과 확인 불가' };
export const fileReasons: Record<ContextFileView['reason'], string> = { selected: '문맥에 포함', not_selected: '선택하지 않음', license_not_context: '이용 조건은 모델 문맥에서 제외', binary_metadata_only: '바이너리 본문 제외 · 메타데이터만 참조', execution_not_supported: '실행 코드 제외 · 실행하지 않음' };
export const usageLabels: Record<ContextAssetView['usage'], string> = { instructions: '작업 지침', reference: '참고 자료', template: '출력 양식' };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const member = (value: unknown, values: readonly string[]): boolean => typeof value === 'string' && values.includes(value);
const nullableId = (value: unknown) => value === null || text(value, 100);
const stamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const closed = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Reject accessors, hidden properties, cycles and excessive data before reading or serializing unknown HTTP values. */
function boundedJson(value: unknown): void {
  let nodes = 0, characters = 0; const seen = new Set<object>();
  const walk = (current: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 10) throw new Error('Context shape limit');
    if (typeof current === 'string') {
      characters += current.length; if (characters > 524288) throw new Error('Context text limit');
      for (let index = 0; index < current.length; index++) {
        const code = current.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) { const next = current.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Context Unicode'); }
        else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Context Unicode');
      }
      return;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || seen.has(current)) throw new Error('Context must be JSON');
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !(Array.isArray(current) && prototype === Array.prototype)) throw new Error('Context prototype');
    if (Object.getOwnPropertySymbols(current).length) throw new Error('Context symbol');
    const keys = Object.getOwnPropertyNames(current);
    if (Array.isArray(current) && (keys.length !== current.length + 1 || current.length > 10000 || keys.some(key => key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)))) throw new Error('Context array');
    seen.add(current);
    for (const key of keys) {
      if (Array.isArray(current) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Context property');
      walk(descriptor.value, depth + 1);
    }
    seen.delete(current);
  };
  walk(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 524288) throw new Error('Context response limit');
}
function validFile(value: unknown): value is ContextFileView {
  if (!closed(value, ['path', 'sha256', 'bytes', 'selected', 'purpose', 'reason'])) return false;
  return text(value.path, 1024) && !/[:\\]/.test(value.path) && value.path.split('/').every(part => part !== '' && part !== '.' && part !== '..') && hash(value.sha256) && integer(value.bytes, 0, 262144)
    && typeof value.selected === 'boolean' && member(value.purpose, ['instructions', 'reference', 'template', 'skill_reference', 'skill_asset', 'excluded']) && member(value.reason, Object.keys(fileReasons))
    && value.selected === (value.reason === 'selected') && value.selected === (value.purpose !== 'excluded');
}
function validAsset(value: unknown): value is ContextAssetView {
  if (!closed(value, ['alias', 'id', 'revision', 'sha256', 'kind', 'usage', 'purpose', 'required', 'selected', 'reason', 'files'])) return false;
  return text(value.alias, 64) && text(value.id, 64) && integer(value.revision, 1) && hash(value.sha256) && member(value.kind, ['instruction', 'document', 'skill']) && member(value.usage, Object.keys(usageLabels)) && text(value.purpose, 1000)
    && typeof value.required === 'boolean' && typeof value.selected === 'boolean' && member(value.reason, ['selected', 'not_selected']) && value.selected === (value.reason === 'selected')
    && Array.isArray(value.files) && value.files.length >= 1 && value.files.length <= 10000 && value.files.every(validFile) && new Set(value.files.map(file => file.path)).size === value.files.length && (value.selected || value.files.every(file => !file.selected));
}
function validRecord(value: unknown, runId: string): value is WorkingContextView {
  if (!closed(value, ['id', 'manifest', 'manifestHash', 'countId', 'reservationId', 'countState', 'generationState', 'errorCode', 'preparedAt', 'updatedAt'])) return false;
  const manifest = value.manifest;
  if (!closed(manifest, ['version', 'runId', 'nodeId', 'nodeInstanceId', 'attemptId', 'planHash', 'workDefinitionHash', 'contextNodeId', 'contextResultHash', 'businessTaskHash', 'maxBytes', 'selectionScope', 'assets', 'requestHash', 'requestBytes', 'model', 'provider'])) return false;
  if (!text(value.id, 100) || !/^context_[a-f0-9]{64}$/.test(value.id) || !hash(value.manifestHash) || !nullableId(value.countId) || !nullableId(value.reservationId) || !member(value.countState, Object.keys(countLabels)) || !member(value.generationState, Object.keys(generationLabels)) || !(value.errorCode === null || typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.errorCode)) || !stamp(value.preparedAt) || !stamp(value.updatedAt) || value.updatedAt < value.preparedAt) return false;
  if (manifest.version !== 1 || manifest.runId !== runId || !text(manifest.runId, 100) || !text(manifest.nodeId, 64) || manifest.nodeInstanceId !== `${runId}:${manifest.nodeId}` || !text(manifest.attemptId, 100) || !text(manifest.contextNodeId, 64) || !['planHash', 'workDefinitionHash', 'contextResultHash', 'businessTaskHash', 'requestHash'].every(key => hash(manifest[key])) || !integer(manifest.maxBytes, 1024, 1048576) || !integer(manifest.requestBytes, 1, manifest.maxBytes) || !text(manifest.model, 120) || manifest.provider !== 'openai' || manifest.selectionScope !== 'task_fixed_attachments') return false;
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 80 || !manifest.assets.every(validAsset) || new Set(manifest.assets.map(asset => asset.alias)).size !== manifest.assets.length || new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 262144) return false;
  // Local states cannot be promoted to delivery proof: unknown and intent remain separate from confirmed responses.
  if (value.countId === null && (value.countState !== 'not_started' || value.reservationId !== null || value.generationState !== 'not_started') || value.countId !== null && value.countState === 'not_started' || value.reservationId !== null && value.countState !== 'confirmed' || value.generationState !== 'not_started' && value.reservationId === null) return false;
  return true;
}

/** Validate every record before any metadata is rendered; a partial or malformed response is never silently presented as verified. */
export function presentWorkingContexts(records: unknown, total: unknown, runId: string): ContextPresentation {
  if (records === undefined && total === undefined) return { state: 'absent', records: [], total: 0 };
  try {
    boundedJson(records);
    if (!Array.isArray(records) || records.length > 100 || !integer(total, records.length) || !records.every(value => validRecord(value, runId)) || new Set(records.map(record => record.id)).size !== records.length || new Set(records.map(record => record.manifest.attemptId)).size !== records.length) throw new Error('Context response');
    return { state: 'valid', records, total };
  } catch { return { state: 'invalid', records: [], total: 0 }; }
}
