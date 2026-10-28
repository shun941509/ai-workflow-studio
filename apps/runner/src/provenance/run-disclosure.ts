import { canonicalDigest } from '@studio/package-kit';
import type { AuthorizationSnapshot } from '@studio/rag-core';
import type { RunStore } from '../state/store.js';
import { RunnerError } from '../errors.js';

/** A conservative root-run fence follows all child scopes and copied strings without claiming field-level lineage. */
export interface DisclosureSnapshot { authority: 'run-rag-v1'; scope: { tenantId: string; projectId: string }; subjectId: string; epoch: number; aclHash: string }
export type DisclosureState = { state: 'legacy' } | { state: 'unobserved' } | { state: 'pinned'; snapshot: DisclosureSnapshot } | { state: 'blocked'; code: string };
export type DisclosureStatus = { allowed: true } | { allowed: false; code: string; message: string };

/** Identity and ACL hash supplement the monotonic epoch, so an empty/recreated authority cannot masquerade as the old scope. */
export function disclosureSnapshot(value: AuthorizationSnapshot): DisclosureSnapshot {
  return { authority: 'run-rag-v1', scope: { ...value.scope }, subjectId: value.subjectId, epoch: value.epoch, aclHash: canonicalDigest(value) };
}
const messages: Record<string, string> = {
  RAG_DISCLOSURE_CHANGED: '이 실행의 자료 접근 권한이 바뀌었습니다. 본문 전송·열람을 중단했습니다. 새 실행을 시작하세요.',
  RAG_DISCLOSURE_UNAVAILABLE: '이 실행의 자료 접근 권한을 확인할 수 없어 본문 전송·열람을 중단했습니다.',
  RAG_DISCLOSURE_STATE_REQUIRED: '이전 실행에는 자료 공개 권한 기록이 없습니다. 새 실행을 시작하세요.',
  RAG_DISCLOSURE_SEALED: '자료 공개 권한을 고정한 뒤에는 새 문서를 추가할 수 없습니다. 필요한 파일을 먼저 선택하고 새 실행을 시작하세요.',
};
export function disclosureError(code: string): RunnerError { return new RunnerError(code, messages[code] ?? messages.RAG_DISCLOSURE_UNAVAILABLE!, code === 'RAG_DISCLOSURE_STATE_REQUIRED' ? 409 : 403); }

/** Checks never create scopes, grant rights, refresh the pin, or resurrect a blocked run. */
export class RunDisclosureGate {
  constructor(private readonly store: RunStore, private readonly readCurrent: (runId: string) => DisclosureSnapshot) {}
  assert(runId: string): void {
    let saved: DisclosureState;
    try { saved = this.store.getDisclosureState(runId); }
    catch (error) {
      if (!(error instanceof RunnerError) || !error.code.startsWith('RAG_DISCLOSURE_')) throw error;
      this.store.blockDisclosure(runId, 'RAG_DISCLOSURE_UNAVAILABLE'); throw disclosureError('RAG_DISCLOSURE_UNAVAILABLE');
    }
    if (saved.state === 'blocked') throw disclosureError(saved.code);
    if (saved.state === 'legacy') {
      if (this.store.requiresRagDisclosure(runId)) { this.store.blockDisclosure(runId, 'RAG_DISCLOSURE_STATE_REQUIRED'); throw disclosureError('RAG_DISCLOSURE_STATE_REQUIRED'); }
      return;
    }
    if (saved.state === 'unobserved') return;
    let current: DisclosureSnapshot;
    try { current = this.readCurrent(runId); }
    catch { this.store.blockDisclosure(runId, 'RAG_DISCLOSURE_UNAVAILABLE'); throw disclosureError('RAG_DISCLOSURE_UNAVAILABLE'); }
    if (canonicalDigest(current) !== canonicalDigest(saved.snapshot)) { this.store.blockDisclosure(runId, 'RAG_DISCLOSURE_CHANGED'); throw disclosureError('RAG_DISCLOSURE_CHANGED'); }
  }
  pin(runId: string, snapshot: DisclosureSnapshot): void { this.store.pinDisclosure(runId, snapshot); this.assert(runId); }
  status(runId: string): DisclosureStatus {
    try { this.assert(runId); return { allowed: true }; }
    catch (error) { if (error instanceof RunnerError && error.code.startsWith('RAG_DISCLOSURE_')) return { allowed: false, code: error.code, message: error.message }; throw error; }
  }
}

/** A caller omitting the trusted gate must not bypass an existing pin or a legacy RAG run. */
export function assertBrokerDisclosure(store: RunStore, runId: string, authorize?: (runId: string) => void): void {
  if (authorize) { authorize(runId); return; }
  const state = store.getDisclosureState(runId);
  if (state.state === 'pinned' || state.state === 'blocked' || store.requiresRagDisclosure(runId)) throw disclosureError('RAG_DISCLOSURE_UNAVAILABLE');
}
