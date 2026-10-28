import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { copyRightsEvidenceBytes, verifyCopyRightsEvidence, type CopyRightsEvidence, type CopyRightsTrust } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights';
import { rightsEvidenceBytes, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

const now = new Date('2026-10-28T00:00:00.000Z');
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const body: Omit<CopyRightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: 'a'.repeat(64), sourceSnapshotSha256: 'b'.repeat(64), scope: 'whole-package', privateCopy: true, modification: true, reviewerId: 'reviewer-copy-test', evidenceSha256: 'c'.repeat(64), reviewedAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-28T00:00:00.000Z' };
  const authority: CopyRightsTrust = { purpose: 'private-authoring-copy', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicKeySha256: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), notBefore: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z', revoked: false };
  const signed = (value = body, signatureData = copyRightsEvidenceBytes(value)): CopyRightsEvidence => ({ ...value, signature: { keyId: 'copy-test-key', value: sign(null, signatureData, privateKey).toString('base64url') } });
  const evidence = signed(), trust = { 'copy-test-key': authority };
  return { body, authority, evidence, trust, signed, validate: (value: unknown = evidence) => verifyCopyRightsEvidence(value, body.artifactSha256, body.sourceSnapshotSha256, trust, now) };
}

/** Real ephemeral Ed25519 signatures exercise permission separation; no production keys or publish actions are used. */
describe('whole-package private-copy and modification review evidence', () => {
  it('accepts only an active source-bound grant and returns an owned record', () => {
    const item = fixture(); const result = item.validate(); expect(result).toEqual(item.evidence); result!.reviewerId = 'changed'; expect(item.evidence.reviewerId).toBe('reviewer-copy-test');
  });
  it('does not substitute a valid redistribution attestation or its signature domain', () => {
    const item = fixture(); const distribution: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: item.body.artifactSha256, sourceSnapshotSha256: item.body.sourceSnapshotSha256, scope: 'whole-package', redistribution: true, reviewerId: item.body.reviewerId, evidenceSha256: item.body.evidenceSha256, reviewedAt: item.body.reviewedAt, expiresAt: item.body.expiresAt };
    const wrongDomain = item.signed(item.body, rightsEvidenceBytes(distribution)); expect(item.validate(wrongDomain)).toBeNull(); expect(item.validate({ ...distribution, signature: wrongDomain.signature })).toBeNull();
  });
  it.each([{ privateCopy: false }, { modification: false }, { scope: 'workflow-only' }, { artifactSha256: 'd'.repeat(64) }, { sourceSnapshotSha256: 'e'.repeat(64) }, { extra: true }, { evidenceSha256: 'invalid' }])('rejects altered or incomplete grants %#', patch => {
    const item = fixture(); expect(item.validate({ ...item.evidence, ...patch })).toBeNull();
  });
  it.each([{ reviewedAt: '2026-10-29T00:00:00Z' }, { expiresAt: '2026-10-28T00:00:00Z' }, { reviewedAt: '2026-02-30T00:00:00Z' }, { expiresAt: '2027-02-01T00:00:00Z' }, { reviewedAt: '2026-10-27T09:00:00+09:00' }])('rejects signed invalid, future or expired time ranges %#', patch => {
    const item = fixture(); expect(item.validate(item.signed({ ...item.body, ...patch }))).toBeNull();
  });
  it.each([{ revoked: true }, { publicKeySha256: 'd'.repeat(64) }, { notBefore: '2026-10-28T00:00:00Z' }, { expiresAt: '2026-10-28T00:00:00Z' }, { purpose: 'redistribution-rights' }])('rejects current trust changes %#', patch => {
    const item = fixture(); Object.assign(item.authority, patch); expect(item.validate()).toBeNull();
  });
  it('rejects missing trust, invalid dates and misleading signature fields', () => {
    const item = fixture(); expect(verifyCopyRightsEvidence(item.evidence, item.body.artifactSha256, item.body.sourceSnapshotSha256, {}, now)).toBeNull();
    expect(verifyCopyRightsEvidence(item.evidence, item.body.artifactSha256, item.body.sourceSnapshotSha256, item.trust, new Date('invalid'))).toBeNull();
    expect(item.validate({ ...item.evidence, signature: { ...item.evidence.signature, publicKey: item.authority.publicKey } })).toBeNull();
    expect(item.validate({ ...item.evidence, signature: { ...item.evidence.signature, value: 'a'.repeat(86) } })).toBeNull();
  });
});
