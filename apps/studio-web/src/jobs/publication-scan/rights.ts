import { createHash, createPublicKey, verify } from 'node:crypto';
import { assertJsonData } from '@studio/spec';
import { canonicalDigest } from '@studio/package-kit';

export interface RightsEvidence {
  schemaVersion: '1.0.0'; artifactSha256: string; sourceSnapshotSha256: string;
  scope: 'whole-package'; redistribution: true; reviewerId: string; evidenceSha256: string;
  reviewedAt: string; expiresAt: string; signature: { keyId: string; value: string };
}
export interface RightsTrust { publicKey: string; purpose: 'redistribution-rights' }
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === keys.sort().join(',');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Domain-separated bytes bind an operator's rights review to one artifact and source; a bundled key grants no trust. */
export function rightsEvidenceBytes(value: Omit<RightsEvidence, 'signature'>): Uint8Array {
  return new TextEncoder().encode(`AI-WORKFLOW-STUDIO/REDISTRIBUTION-RIGHTS/1\n${canonicalDigest(value)}`);
}

/** DER fingerprints ignore PEM formatting while pinning the actual independently supplied verifier key. */
export function rightsKeyFingerprint(authority: RightsTrust): string { const key = createPublicKey(authority.publicKey); if (key.asymmetricKeyType !== 'ed25519') throw new Error('RIGHTS_KEY_TYPE'); return createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex'); }

export function verifyRightsEvidence(value: unknown, artifactSha256: string, sourceSnapshotSha256: string, trust: Readonly<Record<string, RightsTrust>>, now: Date): boolean {
  try {
    assertJsonData(value); if (!value || typeof value !== 'object' || Array.isArray(value)) return false; const record = value as Record<string, unknown>;
    if (!exact(record, ['schemaVersion', 'artifactSha256', 'sourceSnapshotSha256', 'scope', 'redistribution', 'reviewerId', 'evidenceSha256', 'reviewedAt', 'expiresAt', 'signature']) || record.schemaVersion !== '1.0.0' || record.artifactSha256 !== artifactSha256 || record.sourceSnapshotSha256 !== sourceSnapshotSha256 || record.scope !== 'whole-package' || record.redistribution !== true || !hash(record.evidenceSha256) || typeof record.reviewerId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.reviewerId) || typeof record.reviewedAt !== 'string' || typeof record.expiresAt !== 'string') return false;
    const reviewed = Date.parse(record.reviewedAt), expires = Date.parse(record.expiresAt); if (!Number.isFinite(now.getTime()) || !record.reviewedAt.endsWith('Z') || !record.expiresAt.endsWith('Z') || !Number.isFinite(reviewed) || !Number.isFinite(expires) || reviewed > now.getTime() || expires <= now.getTime() || expires <= reviewed) return false;
    const signature = record.signature; if (!signature || typeof signature !== 'object' || Array.isArray(signature)) return false; const envelope = signature as Record<string, unknown>;
    if (!exact(envelope, ['keyId', 'value']) || typeof envelope.keyId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(envelope.keyId) || typeof envelope.value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.value) || !Object.hasOwn(trust, envelope.keyId)) return false;
    const authority = trust[envelope.keyId]!; if (authority.purpose !== 'redistribution-rights') return false; const key = createPublicKey(authority.publicKey); if (key.asymmetricKeyType !== 'ed25519') return false;
    const { signature: _signature, ...body } = record; return verify(null, rightsEvidenceBytes(body as unknown as Omit<RightsEvidence, 'signature'>), key, Buffer.from(envelope.value, 'base64url'));
  } catch { return false; }
}
