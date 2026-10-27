import 'server-only';
import { canonicalDigest } from '@studio/package-kit';
import { assertId, HttpError } from './http';
import { reviewerClient } from './review-roles';

const STATUSES = ['submitted', 'scanned', 'changes_requested', 'approved', 'rejected', 'published', 'withdrawn'];

/** Legacy/custom scan payloads are not blindly forwarded; only the current hash-checked report metadata is projected. */
function reportView(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>; const { reportSha256, ...body } = report;
  if (report.schemaVersion !== '1.0.0' || report.scannerVersion !== '1.0.0' || canonicalDigest(body) !== reportSha256) return null;
  return { schemaVersion: report.schemaVersion, scannerVersion: report.scannerVersion, artifactSha256: report.artifactSha256, manifestSha256: report.manifestSha256, sourceSnapshotSha256: report.sourceSnapshotSha256, policy: report.policy, observedAt: report.observedAt, status: report.status, checks: report.checks, findings: report.findings, rightsKeySha256: report.rightsKeySha256, reportSha256, releaseAuthorized: false };
}

/** The queue is bounded and excludes private originals and worker Storage paths. */
export async function listReviews(params: URLSearchParams) {
  for (const key of params.keys()) if (!['status', 'before', 'id'].includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, 'REVIEW_QUERY_INVALID', '검수 목록 조건을 확인해 주세요.');
  const status = params.get('status') ?? 'scanned'; const before = params.get('before'), id = params.get('id');
  if (!STATUSES.includes(status) || Boolean(before) !== Boolean(id)) throw new HttpError(400, 'REVIEW_QUERY_INVALID', '검수 상태와 페이지를 확인해 주세요.');
  if (before && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(before) || !Number.isFinite(Date.parse(before)))) throw new HttpError(400, 'REVIEW_QUERY_INVALID', '검수 페이지 시각이 올바르지 않습니다.');
  if (id) assertId(id);
  const { client } = await reviewerClient(); let query = client.from('publication_submissions').select('id,kind,status,created_at').eq('status', status).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(26);
  if (before && id) query = query.or(`created_at.lt.${before},and(created_at.eq.${before},id.lt.${id})`);
  const { data, error } = await query; if (error) throw new HttpError(503, 'REVIEW_QUEUE_UNAVAILABLE', '검수 목록을 확인하지 못했습니다.');
  const items = (data ?? []).slice(0, 25); const last = items.at(-1); return { items, next: data && data.length > 25 && last ? { before: last.created_at, id: last.id } : null };
}

/** Review evidence names static limitations; it never embeds source files or executable preview HTML. */
export async function getReview(id: string) {
  assertId(id); const { client } = await reviewerClient();
  const [submission, scan, review, readiness] = await Promise.all([client.from('publication_submissions').select('id,kind,status,created_at').eq('id', id).maybeSingle(), client.from('publication_scans').select('artifact_sha256,manifest_sha256,passed,license_checked,dependencies_checked,secrets_checked,evidence,created_at').eq('submission_id', id).maybeSingle(), client.from('publication_reviews').select('artifact_sha256,decision,reason,created_at').eq('submission_id', id).maybeSingle(), client.rpc('publication_review_readiness', { p_submission: id })]);
  if (submission.error || scan.error || review.error) throw new HttpError(503, 'REVIEW_UNAVAILABLE', '검수 대상과 검사 보고서를 확인하지 못했습니다.');
  if (!submission.data) throw new HttpError(404, 'REVIEW_NOT_FOUND', '검수 대상을 찾을 수 없습니다.');
  if (readiness.error) throw new HttpError(503, 'REVIEW_READINESS_UNAVAILABLE', '현재 권리와 검수 상태를 확인하지 못했습니다. 최신 설정을 확인해 주세요.');
  return { submission: submission.data, scan: scan.data ? { ...scan.data, evidence: reportView(scan.data.evidence) } : null, review: review.data, readiness: readiness.data, publicationAvailable: false, notice: '정적 검사는 완전한 안전성이나 실제 사용 성공을 보장하지 않습니다. 승인해도 서명·게시하지 않습니다.' };
}

/** A reviewer decides only the already-scanned hash; scan attestations and release signing have separate service authority. */
export async function decideReview(id: string, body: Record<string, unknown>) {
  assertId(id);
  if (Object.keys(body).sort().join(',') !== 'artifactSha256,decision,reason' || body.decision !== 'approved' && body.decision !== 'rejected' || typeof body.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(body.artifactSha256) || typeof body.reason !== 'string' || !body.reason.trim() || Array.from(body.reason.trim()).length > 4000) throw new HttpError(400, 'REVIEW_DECISION_INVALID', '검수한 파일 해시·승인 또는 반려·판단 사유가 필요합니다.');
  const { client } = await reviewerClient(); const { error } = await client.rpc('review_publication', { p_submission: id, p_artifact_sha: body.artifactSha256, p_decision: body.decision, p_reason: body.reason.trim() });
  if (error?.code === '42501') throw new HttpError(403, 'REVIEW_ROLE_REQUIRED', '검수 권한을 확인해 주세요.');
  if (error && ['INVALID_PUBLICATION_STATE', 'REVIEW_HASH_MISMATCH', 'REVIEW_EVIDENCE_EXPIRED'].includes(error.message)) throw new HttpError(409, 'REVIEW_CONFLICT', '검사 상태나 파일 해시가 변경되었습니다. 최신 검수 내용을 확인해 주세요.');
  if (error) throw new HttpError(503, 'REVIEW_COMMIT_UNCONFIRMED', '검수 결정 저장을 확인하지 못했습니다. 최신 기록을 확인한 뒤 다시 시도해 주세요.');
  return { saved: true, decision: body.decision, artifactSha256: body.artifactSha256, published: false };
}
