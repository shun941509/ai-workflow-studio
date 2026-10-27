import { canonicalDigest } from '@studio/package-kit';
import { assertJsonData } from '@studio/spec';
import { scanPublication, digestBytes, scanPolicyDigest, MAX_CANDIDATE_BYTES, type ScanInput, type ScanReport } from './scanner';
import { verifyRightsEvidence } from './rights';

export interface PinnedCandidate { submissionId: string; artifactSha256: string; sourceSnapshotSha256: string; artifactBytes: number; source: ScanInput['source'] }
export interface ScanRepository {
  loadCandidate(submissionId: string): Promise<PinnedCandidate>;
  readCandidate(candidate: PinnedCandidate): Promise<Uint8Array>;
  previousReport(submissionId: string): Promise<ScanReport | null>;
  recordReport(submissionId: string, report: ScanReport): Promise<void>;
}

/** Only trusted worker adapters supply immutable candidates. Report commits happen after every actual-byte/source check. */
export async function runPublicationScan(repository: ScanRepository, submissionId: string, options: Pick<ScanInput, 'policy' | 'rightsEvidence' | 'rightsTrust' | 'packageTrust' | 'now'>): Promise<ScanReport> {
  const loaded = await repository.loadCandidate(submissionId); assertJsonData(loaded); const candidate = structuredClone(loaded);
  if (candidate.submissionId !== submissionId || !/^[a-f0-9]{64}$/.test(candidate.artifactSha256) || !/^[a-f0-9]{64}$/.test(candidate.sourceSnapshotSha256) || !Number.isSafeInteger(candidate.artifactBytes) || candidate.artifactBytes < 1 || candidate.artifactBytes > MAX_CANDIDATE_BYTES || canonicalDigest(candidate.source.snapshot) !== candidate.sourceSnapshotSha256) throw new Error('CANDIDATE_PIN_MISMATCH');
  const downloaded = await repository.readCandidate(candidate); const bytes = Uint8Array.from(downloaded);
  if (bytes.length !== candidate.artifactBytes || digestBytes(bytes) !== candidate.artifactSha256) throw new Error('CANDIDATE_BYTES_MISMATCH');
  const previous = await repository.previousReport(submissionId);
  if (previous) {
    const { reportSha256, ...body } = previous;
    if (canonicalDigest(body) !== reportSha256 || previous.artifactSha256 !== candidate.artifactSha256 || previous.sourceSnapshotSha256 !== candidate.sourceSnapshotSha256 || previous.policy.sha256 !== scanPolicyDigest(options.policy)) throw new Error('SCAN_REPLAY_CONFLICT');
    if (previous.status === 'passed' && !verifyRightsEvidence(previous.rightsEvidence, previous.artifactSha256, previous.sourceSnapshotSha256, options.rightsTrust ?? {}, options.now ?? new Date())) throw new Error('SCAN_RIGHTS_RECHECK_REQUIRED');
    return previous;
  }
  const report = await scanPublication({ ...options, bytes, source: candidate.source });
  await repository.recordReport(submissionId, report); return report;
}
