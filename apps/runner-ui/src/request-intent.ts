/** Browser recovery stores opaque request IDs only. Inputs and connection bindings live solely in this page's memory. */
export const REQUEST_INTENT_PREFIX = 'studio-run-request:v1:';
export const REQUEST_RESPONSE_TIMEOUT_MS = 30000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RUN_ID = /^run_[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_PENDING = 32;

export interface StartIntentInput { packageHandle: string; inputs: unknown; modelBindings: Record<string, string> }
export interface StartIntentBody extends StartIntentInput { requestId: string }
export interface PendingRunRequest { requestId: string; retryAvailable: boolean }
export interface IntentStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface IntentTransport { start(body: StartIntentBody): Promise<unknown>; lookup(requestId: string): Promise<unknown> }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('실행 요청 확인 응답이 올바르지 않습니다. 요청 기록을 유지합니다.');
  return value as Record<string, unknown>;
}
function runId(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID.test(value)) throw new Error('실행 식별값을 확인하지 못했습니다. 요청 기록을 유지합니다.');
  return value;
}

/** Ending the browser wait does not cancel or undo a server-side start. A late response never silently clears the saved intent. */
async function responseWithinDeadline(action: () => Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([action(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('실행 요청의 응답 시간이 초과되었습니다. 서버 작업이 중단되었다는 뜻은 아닙니다. 같은 요청을 확인하세요.')), REQUEST_RESPONSE_TIMEOUT_MS); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** One journal entry per UUID avoids overwriting another tab's unresolved request. No automatic expiry means absence is never treated as success. */
export class RunRequestIntents {
  private readonly bodies = new Map<string, string>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly storage: () => IntentStorage, private readonly transport: IntentTransport, private readonly newId: () => string = () => crypto.randomUUID()) {}

  /** Reread shared storage before each action, because another tab may have created or resolved a request. */
  pending(): PendingRunRequest[] {
    try {
      const storage = this.storage(); const ids: string[] = [];
      if (storage.length > 10000) throw new Error('storage limit');
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index); if (!key?.startsWith('studio-run-request:')) continue;
        if (!key.startsWith(REQUEST_INTENT_PREFIX)) throw new Error('unsupported recovery version');
        const id = key.slice(REQUEST_INTENT_PREFIX.length);
        if (!UUID.test(id) || storage.getItem(key) !== 'pending' || ids.length >= MAX_PENDING) throw new Error('invalid recovery metadata');
        ids.push(id);
      }
      return ids.sort().map(requestId => ({ requestId, retryAvailable: this.bodies.has(requestId) }));
    } catch { throw new Error('실행 요청 기록을 읽을 수 없습니다. 브라우저 저장소를 확인한 뒤 다시 시도하세요. 기존 요청의 상태를 확인하기 전에는 추가 실행을 보내지 마세요.'); }
  }

  /** Persist the opaque ID before any POST. A storage failure must never degrade into an untracked execution. */
  async start(input: StartIntentInput, explicitlySeparate = false): Promise<string> {
    const pending = this.pending();
    if (pending.length && !explicitlySeparate) throw new Error('확인되지 않은 실행 요청이 있습니다. 이전 요청을 확인하거나 별도 실행을 명시적으로 선택하세요.');
    if (pending.length >= MAX_PENDING) throw new Error('확인이 필요한 실행 요청이 너무 많습니다. 기존 요청을 먼저 확인하세요.');
    const requestId = this.newId(); if (!UUID.test(requestId)) throw new Error('실행 요청 식별값을 만들지 못했습니다.');
    // This immutable string is reused verbatim across retries. Later form/object mutations cannot change the logical request.
    const body = JSON.stringify({ packageHandle: input.packageHandle, requestId, inputs: input.inputs, modelBindings: input.modelBindings });
    if (new TextEncoder().encode(body).byteLength > 8 * 1024 * 1024) throw new Error('실행 입력이 8 MiB 한도를 초과했습니다.');
    try {
      const storage = this.storage(), key = REQUEST_INTENT_PREFIX + requestId;
      if (storage.getItem(key) !== null) throw new Error('duplicate request ID');
      storage.setItem(key, 'pending'); if (storage.getItem(key) !== 'pending') throw new Error('recovery write not confirmed');
    } catch { throw new Error('실행 요청 기록을 저장하지 못해 실행을 보내지 않았습니다. 브라우저 저장소를 확인하세요.'); }
    this.bodies.set(requestId, body);
    return this.send(requestId);
  }

  /** Retrying is allowed only while the exact original body remains in memory; a reload never reconstructs it from edited fields. */
  async retry(requestId: string): Promise<string> {
    this.requirePending(requestId);
    if (!this.bodies.has(requestId)) throw new Error('새로고침 후에는 원래 입력이 남아 있지 않습니다. 요청 접수 여부를 확인하세요.');
    return this.send(requestId);
  }

  /** A not_found response is a point-in-time observation, not proof that an earlier in-flight POST cannot still be accepted. */
  async lookup(requestId: string): Promise<string | undefined> {
    this.requirePending(requestId); this.lock(requestId);
    try {
      const response = object(await responseWithinDeadline(() => this.transport.lookup(requestId)));
      if (response.state === 'not_found' && Object.keys(response).length === 1) return undefined;
      if (response.state !== 'found' || Object.keys(response).some(key => !['state', 'runId'].includes(key))) throw new Error('실행 요청 확인 응답이 올바르지 않습니다. 요청 기록을 유지합니다.');
      const id = runId(response.runId); this.confirm(requestId); return id;
    } finally { this.inFlight.delete(requestId); }
  }

  private requirePending(requestId: string): void {
    if (!UUID.test(requestId) || !this.pending().some(item => item.requestId === requestId)) throw new Error('이 요청의 복구 기록이 없습니다. 실행 기록을 확인하세요.');
  }
  private lock(requestId: string): void {
    if (this.inFlight.has(requestId)) throw new Error('이 실행 요청을 이미 확인하고 있습니다.');
    this.inFlight.add(requestId);
  }
  private async send(requestId: string): Promise<string> {
    this.lock(requestId);
    try {
      const response = object(await responseWithinDeadline(() => this.transport.start(JSON.parse(this.bodies.get(requestId)!) as StartIntentBody)));
      const id = runId(response.runId); this.confirm(requestId); return id;
    } finally { this.inFlight.delete(requestId); }
  }
  private confirm(requestId: string): void {
    this.bodies.delete(requestId);
    // A failed cleanup leaves a harmless UUID to query again; it cannot turn a confirmed response into a new POST.
    try { this.storage().removeItem(REQUEST_INTENT_PREFIX + requestId); } catch { /* Keep the durable recovery marker if storage becomes unavailable. */ }
  }
}
