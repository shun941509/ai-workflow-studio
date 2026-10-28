import { RunnerApiError } from './api/client';
import type { Run } from './types';

export const DISCLOSURE_MESSAGE = '자료 권한이 변경되었거나 현재 권한을 확인할 수 없어 내용 표시를 중단했습니다. 권한을 확인한 뒤 새 실행을 시작하세요.';
export function disclosureFailure(error: unknown): boolean {
  return error instanceof RunnerApiError && ['RAG_DISCLOSURE_CHANGED', 'RAG_DISCLOSURE_UNAVAILABLE', 'RAG_DISCLOSURE_STATE_REQUIRED', 'RAG_DISCLOSURE_SEALED'].includes(error.code ?? '');
}

/** History never needs body fields. Denied detail responses cannot retain a prior run's sensitive UI state. */
export function withoutRunContent(run: Run): Run {
  return { id: run.id, packageHandle: run.packageHandle, status: run.status, createdAt: run.createdAt, error: run.error, usage: run.usage, activeMs: run.activeMs, disclosure: run.disclosure, result: null, outcome: null, waits: [], files: [], childScopes: [], childScopeCount: 0, workingContexts: [], workingContextCount: 0 };
}
