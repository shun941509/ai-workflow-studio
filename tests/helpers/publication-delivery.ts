import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { unzipSync, zipSync } from 'fflate';
import { createBasicWorkflow, type Workflow } from '@studio/spec';
import { buildPackage, canonicalDigest, type TargetHost } from '@studio/package-kit';
import { collectRequirements } from '@studio/workflow-core';
import { scanPublication, digestBytes } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, rightsKeyFingerprint, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

/** Ephemeral keys and local ZIP bytes belong exclusively to tests, never product trust or live publishing. */
export async function deliveryArtifact(options: { workflow?: Workflow; snapshot?: unknown; host?: TargetHost; signed?: boolean; keyId?: string; resources?: Record<string, Uint8Array>; editor?: object } = {}) {
  const workflow = options.workflow ?? createBasicWorkflow('실제 서명 바이트 전달 시험'); const host = options.host ?? 'codex';
  const snapshot = options.snapshot ?? { workflow, editor: options.editor ?? {}, sha256: canonicalDigest(workflow) };
  const signing = generateKeyPairSync('ed25519'), rights = generateKeyPairSync('ed25519'); const keyId = options.keyId ?? 'package-test';
  const publicKey = signing.publicKey.export({ type: 'spki', format: 'pem' }).toString(); const keyHash = digestBytes(signing.publicKey.export({ type: 'spki', format: 'der' }));
  const built = await buildPackage({ workflow, editor: options.editor ?? {}, host, ...(options.resources ? { resources: options.resources } : {}) }); const files = unzipSync(built.bytes);
  if (options.signed !== false) files['manifest.sig'] = new TextEncoder().encode(JSON.stringify({ algorithm: 'Ed25519', keyId, signature: sign(null, Buffer.from('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(built.manifest)), signing.privateKey).toString('base64url') }));
  const bytes = Uint8Array.from(zipSync(files)); const rightsTrust = { 'rights-test': { purpose: 'redistribution-rights' as const, publicKey: rights.publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: digestBytes(bytes), sourceSnapshotSha256: canonicalDigest(snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'test-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2020-01-01T00:00:00.000Z', expiresAt: '2036-01-01T00:00:00.000Z' };
  const report = await scanPublication({ bytes, source: { kind: 'project', snapshot }, policy: { id: 'delivery-test', version: '1.0.0', supportedCapabilities: collectRequirements(workflow).capabilities }, packageTrust: { [keyId]: publicKey }, rightsTrust, rightsEvidence: { ...body, signature: { keyId: 'rights-test', value: sign(null, rightsEvidenceBytes(body), rights.privateKey).toString('base64url') } } });
  return { workflow, snapshot, bytes, report, keyHash, publicKey, keyId, rightsHash: rightsKeyFingerprint(rightsTrust['rights-test']), host };
}
