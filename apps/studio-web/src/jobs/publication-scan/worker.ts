import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { runPublicationScan, type PinnedCandidate, type ScanRepository } from './pipeline';
import type { ScanInput, ScanReport } from './scanner';
import { rightsKeyFingerprint, type RightsTrust } from './rights';

/** Service credentials are accepted only in a server worker, never a reviewer route or browser request. */
export async function scanConfiguredPublication(submissionId: string, options: Pick<ScanInput, 'policy' | 'rightsEvidence' | 'rightsTrust' | 'packageTrust'>): Promise<ScanReport> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SCAN_WORKER_NOT_CONFIGURED');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(submissionId)) throw new Error('SUBMISSION_ID_INVALID');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: (input, init) => fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.timeout(30000) }) } });
  const rightsTrust: Record<string, RightsTrust> = Object.create(null) as Record<string, RightsTrust>;
  if (Object.keys(options.rightsTrust ?? {}).length) {
    const { data, error } = await client.from('publication_rights_authorities').select('key_id,public_key_sha256').is('revoked_at', null).in('key_id', Object.keys(options.rightsTrust!));
    if (error) throw new Error('RIGHTS_TRUST_UNAVAILABLE');
    for (const authority of data ?? []) { const configured = options.rightsTrust![authority.key_id]; if (configured && rightsKeyFingerprint(configured) === authority.public_key_sha256) rightsTrust[authority.key_id] = configured; }
  }
  let path: string | undefined;
  const repository: ScanRepository = {
    async loadCandidate(id) {
      const [candidate, submission] = await Promise.all([client.from('publication_candidates').select('submission_id,artifact_sha256,source_snapshot_sha256,artifact_bytes,storage_path').eq('submission_id', id).single(), client.from('publication_submissions').select('id,kind,source_snapshot').eq('id', id).single()]);
      if (candidate.error || submission.error) throw new Error('SCAN_CANDIDATE_UNAVAILABLE');
      path = `candidates/${id}/${candidate.data.artifact_sha256}.zip`; if (path !== candidate.data.storage_path) throw new Error('CANDIDATE_PATH_MISMATCH');
      return { submissionId: id, artifactSha256: candidate.data.artifact_sha256, sourceSnapshotSha256: candidate.data.source_snapshot_sha256, artifactBytes: candidate.data.artifact_bytes, source: { kind: submission.data.kind, snapshot: submission.data.source_snapshot } } as PinnedCandidate;
    },
    async readCandidate(candidate) {
      if (!path) throw new Error('CANDIDATE_NOT_PINNED'); const { data, error } = await client.storage.from('publication-candidates').download(path);
      if (error || !data || data.size !== candidate.artifactBytes) throw new Error('CANDIDATE_STORAGE_UNAVAILABLE'); return new Uint8Array(await data.arrayBuffer());
    },
    async previousReport(id) { const { data, error } = await client.from('publication_scans').select('evidence').eq('submission_id', id).maybeSingle(); if (error) throw new Error('SCAN_STATE_UNAVAILABLE'); return data?.evidence as ScanReport | undefined ?? null; },
    async recordReport(id, report) {
      const { error } = await client.rpc('record_publication_scan', { p_submission: id, p_artifact_sha: report.artifactSha256, p_manifest_sha: report.manifestSha256, p_passed: report.status === 'passed', p_license: report.checks.rights === 'passed', p_dependencies: report.checks.dependencies === 'passed', p_secrets: report.checks.secrets === 'passed', p_evidence: report });
      if (error) throw new Error('SCAN_REPORT_COMMIT_UNCONFIRMED');
    },
  };
  return runPublicationScan(repository, submissionId, { ...options, rightsTrust });
}
