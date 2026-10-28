import { createHash, createPublicKey, verify } from 'node:crypto';
import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';

export interface CopyRightsEvidence {
  schemaVersion: '1.0.0'; artifactSha256: string; sourceSnapshotSha256: string;
  scope: 'whole-package'; privateCopy: true; modification: true;
  reviewerId: string; evidenceSha256: string; reviewedAt: string; expiresAt: string;
  signature: { keyId: string; value: string };
}
export interface CopyRightsTrust {
  purpose: 'private-authoring-copy'; publicKey: string; publicKeySha256: string;
  notBefore: string; expiresAt: string; revoked: boolean;
}
const exact = (record: Record<string, unknown>, keys: readonly string[]) => Object.keys(record).sort().join(',') === [...keys].sort().join(',');
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Only exact UTC seconds/milliseconds are admitted; Date.parse's invalid-calendar normalization is not authority. */
function timestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return;
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== (value.includes('.') ? value : value.replace('Z', '.000Z'))) return;
  return time;
}

/** Copy/edit permission is a separate reviewed purpose; a distribution signature or redistribution grant cannot substitute. */
export function copyRightsEvidenceBytes(body: Omit<CopyRightsEvidence, 'signature'>): Uint8Array {
  return new TextEncoder().encode(`AI-WORKFLOW-STUDIO/PRIVATE-AUTHORING-COPY/1\n${canonicalDigest(body)}`);
}

/** The caller supplies current operator trust, never keys bundled inside the ZIP or selected by the downloading user.
 * This verifies the review attestation, not a legal conclusion inferred from a filename or SPDX label. */
export function verifyCopyRightsEvidence(value: unknown, artifactSha256: string, sourceSnapshotSha256: string, trust: Readonly<Record<string, CopyRightsTrust>>, now: Date): CopyRightsEvidence | null {
  try {
    assertJsonData(value); if (!value || typeof value !== 'object' || Array.isArray(value) || !digest(artifactSha256) || !digest(sourceSnapshotSha256)) return null;
    const record = value as Record<string, unknown>;
    if (!exact(record, ['schemaVersion', 'artifactSha256', 'sourceSnapshotSha256', 'scope', 'privateCopy', 'modification', 'reviewerId', 'evidenceSha256', 'reviewedAt', 'expiresAt', 'signature']) || record.schemaVersion !== '1.0.0' || record.artifactSha256 !== artifactSha256 || record.sourceSnapshotSha256 !== sourceSnapshotSha256 || record.scope !== 'whole-package' || record.privateCopy !== true || record.modification !== true || !digest(record.evidenceSha256) || typeof record.reviewerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.reviewerId)) return null;
    const reviewed = timestamp(record.reviewedAt), expires = timestamp(record.expiresAt), current = now.getTime();
    if (reviewed === undefined || expires === undefined || !Number.isFinite(current) || reviewed > current || expires <= current || expires <= reviewed) return null;
    const signature = record.signature; if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return null;
    const envelope = signature as Record<string, unknown>;
    if (!exact(envelope, ['keyId', 'value']) || typeof envelope.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(envelope.keyId) || typeof envelope.value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.value) || !Object.hasOwn(trust, envelope.keyId)) return null;
    const authority = trust[envelope.keyId]!; const active = timestamp(authority.notBefore), until = timestamp(authority.expiresAt);
    if (authority.purpose !== 'private-authoring-copy' || authority.revoked !== false || !digest(authority.publicKeySha256) || active === undefined || until === undefined || active > reviewed || active > current || until <= current || until <= active || expires > until) return null;
    const key = createPublicKey(authority.publicKey);
    if (key.asymmetricKeyType !== 'ed25519' || createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') !== authority.publicKeySha256) return null;
    const signatureBytes = Buffer.from(envelope.value, 'base64url'); if (signatureBytes.toString('base64url') !== envelope.value) return null;
    const { signature: _signature, ...body } = record;
    return verify(null, copyRightsEvidenceBytes(body as unknown as Omit<CopyRightsEvidence, 'signature'>), key, signatureBytes) ? structuredClone(value) as CopyRightsEvidence : null;
  } catch { return null; }
}
