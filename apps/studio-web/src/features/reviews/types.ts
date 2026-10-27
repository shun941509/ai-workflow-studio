/** Review transport contains only submitted metadata and escaped reports; role labels do not authorize any mutation. */
export interface ReviewFailure { status: number; code: string; message: string }
export interface Submission { id: string; kind: 'project' | 'resource'; status: string; created_at: string }
export interface QueuePage { items: Submission[]; next: { before: string; id: string } | null }
export interface ReviewDetail {
  submission: Submission;
  scan: null | { artifact_sha256: string; manifest_sha256: string | null; passed: boolean; created_at: string; evidence: null | { reportSha256: string; sourceSnapshotSha256: string; scannerVersion: string; policy: { id: string; version: string; sha256: string }; checks: Record<string, string>; findings: { check: string; code: string; status: string; path?: string }[] } };
  review: null | { artifact_sha256: string; decision: string; reason: string; created_at: string };
  readiness: { status: string; artifactSha256: string | null; reportSha256: string | null; canApprove: boolean; canReject: boolean; rights: { state: string; expiresAt: string | null; checkedAt: string }; blockedReasons: string[]; published: boolean };
  notice: string; publicationAvailable: false;
}
export const statusLabels: Record<string, string> = { submitted: '검사 대기', scanned: '검수 대기', changes_requested: '보완 필요', approved: '승인 기록됨', rejected: '반려 기록됨', published: '게시됨', withdrawn: '제출 철회' };

/** Failed responses remain failures, including no configured Auth; no empty successful result is substituted. */
export async function reviewRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, cache: 'no-store' }); const body = await response.json();
  if (!response.ok) throw { status: response.status, code: body.error?.code ?? 'REVIEW_UNAVAILABLE', message: body.error?.message ?? '검수 상태를 확인하지 못했습니다.' } satisfies ReviewFailure;
  return body as T;
}
export function asFailure(value: unknown): ReviewFailure { return value && typeof value === 'object' && 'status' in value && 'message' in value ? value as ReviewFailure : { status: 0, code: 'NETWORK_ERROR', message: '연결 상태를 확인하고 다시 시도해 주세요.' }; }
