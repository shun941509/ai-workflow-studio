import 'server-only';
import { canonicalDigest, prepareAuthoringImport } from '@studio/package-kit';
import { assertJsonData } from '@studio/spec';
import { verifyCopyRightsEvidence, type CopyRightsEvidence, type CopyRightsTrust } from '../jobs/publication-scan/copy-rights';
import { parseDelivery, preparePublicationDownload, type Delivery, type DeliveryRepository } from './publication-delivery';
import { assertId, HttpError } from './http';

export interface CopySourceRepository {
  /** This lookup is service-only: public delivery eligibility alone never authorizes copying/editing. */
  resolveCopy(releaseId: string, signal: AbortSignal): Promise<unknown>;
  openPublicObject: DeliveryRepository['openObject'];
}
export interface VerifiedCopyAuthority {
  delivery: Delivery;
  copyRights: { evidence: CopyRightsEvidence; evidenceSha256: string; authority: CopyRightsTrust };
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === expected.sort().join(',');
const unavailable = () => new HttpError(409, 'COPY_RIGHTS_INVALID', '현재 원본의 복사·수정 권한을 확인하지 못했습니다.');

/** Both the ZIP signer and the independent reuse attestation come from current operator trust, never the archive. */
export function verifyCurrentCopyAuthority(value: unknown, releaseId: string): VerifiedCopyAuthority {
  try {
    assertJsonData(value);
    if (!object(value) || !keys(value, ['delivery', 'copyRights']) || !object(value.copyRights) || !keys(value.copyRights, ['evidence', 'evidenceSha256', 'authority'])) throw unavailable();
    const delivery = parseDelivery(value.delivery, releaseId), rights = value.copyRights;
    if (!object(rights.evidence) || !object(rights.evidence.signature) || typeof rights.evidence.signature.keyId !== 'string' || !object(rights.authority) || !keys(rights.authority, ['purpose', 'publicKey', 'publicKeySha256', 'notBefore', 'expiresAt', 'revoked'])) throw unavailable();
    if (JSON.stringify(rights).length > 20 * 1024 || canonicalDigest(rights.evidence) !== rights.evidenceSha256) throw unavailable();
    const evidence = verifyCopyRightsEvidence(rights.evidence, delivery.artifactSha256, delivery.sourceSnapshotSha256, { [rights.evidence.signature.keyId]: rights.authority as unknown as CopyRightsTrust }, new Date());
    if (!evidence) throw unavailable();
    return { delivery, copyRights: { evidence, evidenceSha256: rights.evidenceSha256 as string, authority: structuredClone(rights.authority) as unknown as CopyRightsTrust } };
  } catch { throw unavailable(); }
}

/** Copy preparation owns all checked bytes, rechecks live authorization after decoding, and executes no imported content.
 * The following storage transaction must pin these hashes and recheck authorization once more at commit. */
export async function prepareVerifiedCopySource(repository: CopySourceRepository, releaseId: string, parentSignal: AbortSignal = new AbortController().signal) {
  assertId(releaseId);
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30000)]); let pinned: VerifiedCopyAuthority | undefined;
  const resolve = async () => {
    signal.throwIfAborted(); const current = verifyCurrentCopyAuthority(await repository.resolveCopy(releaseId, signal), releaseId); signal.throwIfAborted();
    if (pinned && canonicalDigest(current) !== canonicalDigest(pinned)) throw new HttpError(409, 'COPY_SOURCE_CHANGED', '복사하는 동안 원본이나 이용 권한이 변경되었습니다. 최신 항목을 다시 확인해 주세요.');
    pinned = current; return current;
  };
  const downloaded = await preparePublicationDownload({ resolve: async () => (await resolve()).delivery, openObject: repository.openPublicObject }, releaseId, signal);
  const authority = pinned!;
  const snapshot = await prepareAuthoringImport(downloaded.bytes, { requireSignature: true, trustStore: { [authority.delivery.signingKey.id]: authority.delivery.signingKey.publicKey } });
  if (snapshot.source.artifactSha256 !== authority.delivery.artifactSha256 || snapshot.source.manifestSha256 !== authority.delivery.manifestSha256 || snapshot.source.host !== authority.delivery.targetHost || snapshot.source.trust !== 'verified') throw new HttpError(409, 'COPY_SOURCE_INVALID', '원본 아카이브의 식별 정보가 검증한 공개 파일과 다릅니다.');
  await resolve();
  return { bytes: downloaded.bytes, snapshot, authority };
}
