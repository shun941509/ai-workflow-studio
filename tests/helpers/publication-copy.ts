import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalDigest } from '@studio/package-kit';
import { copyRightsEvidenceBytes, type CopyRightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights';
import { deliveryArtifact } from './publication-delivery';

export const COPY_RELEASE_ID = '10000000-0000-4000-8000-000000000001';
const submissionId = '20000000-0000-4000-8000-000000000002';

/** Ephemeral independent keys attest only test artifacts; no fixture creates real publication or account evidence. */
export async function copyArtifact(options: Parameters<typeof deliveryArtifact>[0] = {}) {
  const item = await deliveryArtifact(options), key = generateKeyPairSync('ed25519');
  const authority = { purpose: 'private-authoring-copy' as const, publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeySha256: createHash('sha256').update(key.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), notBefore: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z', revoked: false };
  const body: Omit<CopyRightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: item.report.artifactSha256, sourceSnapshotSha256: item.report.sourceSnapshotSha256, scope: 'whole-package', privateCopy: true, modification: true, reviewerId: 'copy-test-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' };
  const evidence: CopyRightsEvidence = { ...body, signature: { keyId: 'copy-test', value: sign(null, copyRightsEvidenceBytes(body), key.privateKey).toString('base64url') } };
  const delivery = { releaseId: COPY_RELEASE_ID, submissionId, artifactSha256: item.report.artifactSha256, manifestSha256: item.report.manifestSha256, artifactBytes: item.bytes.length, targetHost: item.host, storagePath: `releases/${submissionId}/${item.report.artifactSha256}.zip`, sourceSnapshotSha256: item.report.sourceSnapshotSha256, report: item.report, signingKey: { id: item.keyId, publicKey: item.publicKey, sha256: item.keyHash, notBefore: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' } };
  return { ...item, key, record: { delivery, copyRights: { evidence, evidenceSha256: canonicalDigest(evidence), authority } } };
}
