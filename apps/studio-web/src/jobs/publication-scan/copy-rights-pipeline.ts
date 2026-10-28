import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';
import { verifyCopyRightsEvidence, type CopyRightsEvidence, type CopyRightsTrust } from './copy-rights';

export interface CopyRightsRepository {
  /** Both lookups are operator-owned sources; neither accepts a URL or a public key from the requesting browser. */
  source(releaseId: string): Promise<{ artifactSha256: string; sourceSnapshotSha256: string }>;
  authority(keyId: string): Promise<CopyRightsTrust | null>;
  /** Implementation calls register_publication_copy_rights, which rechecks current DB state inside its transaction. */
  record(releaseId: string, evidence: CopyRightsEvidence, canonicalEvidenceSha256: string): Promise<void>;
}

/** A verified, owned attestation is recorded once; lookup/expiry/revocation failures never degrade to download permission.
 * SQL is responsible for current-state transaction checks. This boundary performs the real cryptographic verification. */
export async function recordReviewedCopyRights(repository: CopyRightsRepository, releaseId: string, value: unknown): Promise<{ evidenceSha256: string }> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(releaseId)) throw new Error('COPY_RELEASE_INVALID');
  let owned: unknown;
  try { assertJsonData(value); owned = structuredClone(value); if (Buffer.byteLength(JSON.stringify(owned)) > 16384) throw new Error('limit'); }
  catch { throw new Error('COPY_RIGHTS_INVALID'); }
  const signature = owned && typeof owned === 'object' && !Array.isArray(owned) ? (owned as Record<string, unknown>).signature : undefined;
  const keyId = signature && typeof signature === 'object' && !Array.isArray(signature) ? (signature as Record<string, unknown>).keyId : undefined;
  if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(keyId)) throw new Error('COPY_RIGHTS_INVALID');
  const source = await repository.source(releaseId); const authority = await repository.authority(keyId);
  const checked = authority ? verifyCopyRightsEvidence(owned, source.artifactSha256, source.sourceSnapshotSha256, { [keyId]: authority }, new Date()) : null;
  if (!checked) throw new Error('COPY_RIGHTS_UNAVAILABLE');
  const evidenceSha256 = canonicalDigest(checked);
  await repository.record(releaseId, checked, evidenceSha256);
  return { evidenceSha256 };
}
