import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalize } from 'json-canonicalize';
import { unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createBasicWorkflow, type ResourceRef } from '@studio/spec';
import { buildMaterialsPackage, canonicalDigest, createTextResource, prepareAuthoringImport } from '@studio/package-kit';
import { asUser, createPolicyDatabase } from './postgres-harness';
import { deliveryArtifact } from '../helpers/publication-delivery';
import { copyRightsEvidenceBytes, type CopyRightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/copy-rights';
import { scanPublication } from '../../apps/studio-web/src/jobs/publication-scan/scanner';
import { rightsEvidenceBytes, type RightsEvidence } from '../../apps/studio-web/src/jobs/publication-scan/rights';

interface Receipt { importId: string; projectId: string | null; resources: { alias: string; resourceId: string; versionId: string; revision: number }[] }
interface Envelope { importId: string; requestId: string; releaseId: string; state: string; receipt: Receipt | null; storage: { bucket: string; path: string; bytes: number; sha256: string }; resolution: unknown }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** These original fictional test documents grant reuse explicitly; private user exports do not. */
function originalText(options: Parameters<typeof createTextResource>[0]) {
  const item = createTextResource(options), license = new TextEncoder().encode('Original fictional test content. CC0-1.0. Use, modification and redistribution are permitted.\n');
  item.files[`resources/${options.id}/LICENSE.txt`] = license;
  item.descriptor.license.id = 'CC0-1.0';
  item.descriptor.files = item.descriptor.files.map(file => file.path === 'LICENSE.txt' ? { ...file, bytes: license.length, sha256: hash(license) } : file) as typeof item.descriptor.files;
  const bytes = new TextEncoder().encode(JSON.stringify(item.descriptor)); item.files[`resources/${options.id}/resource.json`] = bytes; item.reference.sha256 = hash(bytes);
  return item;
}

/** PostgreSQL executes all ten migrations unchanged. Auth identities, the operator and Storage
 * readback are test boundaries; no test claims a real Supabase transaction or blob deletion. */
describe('private authoring import database', () => {
  const owner = '10000000-0000-4000-8000-000000000001', reviewer = '20000000-0000-4000-8000-000000000002', recipient = '30000000-0000-4000-8000-000000000003';
  let db: PGlite; let serial = 0; let oldProject: string; let oldRevision: string; let oldVersion: string;
  const service = () => db.exec('reset role; set role service_role');
  const root = () => db.exec('reset role');
  const rpc = async <T = Envelope>(sql: string, args: unknown[] = []) => (await db.query<{ value: T }>(`select public.${sql} as value`, args)).rows[0]!.value;
  beforeAll(async () => {
    db = await createPolicyDatabase([owner, reviewer, recipient]);
    for (const name of ['002-publications.sql', '003-public-release-metadata.sql', '004-public-release-search.sql', '005-publication-candidates.sql', '006-review-readiness.sql', '007-release-lifecycle.sql', '008-publication-delivery.sql', '009-publication-copy-rights.sql']) await db.exec(await readFile(new URL(`../../infrastructure/supabase/migrations/${name}`, import.meta.url), 'utf8'));
    // Exercise the upgrade path with real pre-010 RPCs, not post-migration rows that happen to look old.
    await asUser(db, recipient); const existing = await rpc<{ resource: { id: string }; version: { id: string } }>('create_private_resource($1,$2,$3,$4,$5)', ['이전 자료', 'instruction', '', { format: 'text', text: '이전 내용' }, 'a'.repeat(64)]); oldVersion = existing.version.id;
    const oldWorkflow = { resources: { [existing.resource.id]: { id: existing.resource.id, kind: 'instruction', revision: 1, sha256: 'b'.repeat(64) } } };
    oldProject = (await rpc<{ project: { id: string } }>('create_private_project($1,$2,$3)', ['이전 프로젝트', oldWorkflow, {}])).project.id;
    oldRevision = (await rpc<{ id: string }>('snapshot_private_project($1,1,$2)', [oldProject, canonicalDigest(oldWorkflow)])).id;
    await root(); await db.exec(await readFile(new URL('../../infrastructure/supabase/migrations/010-private-imports.sql', import.meta.url), 'utf8'));
    await db.query("insert into public.studio_roles values($1,'reviewer'),($1,'moderator')", [reviewer]);
  }, 30000);
  afterAll(async () => { await db?.close(); });

  it('backfills existing text draft and revision bindings without rewriting snapshots', async () => {
    await asUser(db, recipient);
    expect((await db.query<{ version_id: string }>('select version_id from public.private_resource_bindings where project_id=$1', [oldProject])).rows).toEqual([{ version_id: oldVersion }]);
    expect((await db.query<{ version_id: string }>('select version_id from public.private_revision_resource_bindings where revision_id=$1', [oldRevision])).rows).toEqual([{ version_id: oldVersion }]);
    const row = (await db.query<{ workflow: unknown; sha256: string }>('select workflow,sha256 from public.project_revisions where id=$1', [oldRevision])).rows[0]!; expect(row.sha256).toBe(canonicalDigest(row.workflow));
  });

  async function fixture(options: { resources?: boolean; expiresAt?: string } = {}) {
    const sequence = ++serial, workflow = createBasicWorkflow(`독립 복사 ${sequence}`); workflow.revision = 7;
    const guide = originalText({ id: 'original-guide', revision: 3, name: '확인된 내용 기록', kind: 'instruction', text: '직접 인용과 해석을 구분합니다.\r\n' });
    const note = originalText({ id: 'original-note', revision: 9, name: '가상 기관 문서', kind: 'document', text: '이 자료는 실제 사람이 없는 가상 기관 안내입니다.\r\n' });
    const noteDescriptor = { ...note.descriptor, dependencies: { 'guide-alias': guide.reference } }, noteBytes = new TextEncoder().encode(JSON.stringify(noteDescriptor, null, 2) + '\r\n');
    const noteRef: ResourceRef = { ...note.reference, sha256: hash(noteBytes) };
    const files = Object.fromEntries([...Object.entries(guide.files).map(([path, bytes]) => [path.replace('resources/original-guide/', 'resources/guide-alias/'), bytes]), ...Object.entries(note.files).map(([path, bytes]) => [path.replace('resources/original-note/', 'resources/note-alias/'), path.endsWith('/resource.json') ? noteBytes : bytes])]) as Record<string, Uint8Array>;
    if (options.resources) workflow.resources = { 'guide-alias': guide.reference, 'note-alias': noteRef };
    // A pre-existing signed public source is a fixture, not a bypass available to account users.
    await root(); const project = (await db.query<{ id: string }>('insert into public.projects(owner_id,name) values($1,$2) returning id', [owner, workflow.name])).rows[0]!.id;
    const revision = (await db.query<{ id: string }>('insert into public.project_revisions(project_id,revision,workflow,editor,sha256) values($1,1,$2,$3,$4) returning id', [project, workflow, {}, canonicalDigest(workflow)])).rows[0]!.id;
    await asUser(db, owner); const submission = await rpc<string>("submit_publication('project',$1)", [revision]);
    const snapshot = (await db.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [submission])).rows[0]!.source_snapshot;
    const artifact = await deliveryArtifact({ workflow, snapshot, keyId: `import-package-${sequence}`, ...(options.resources ? { resources: files } : {}) }); expect(artifact.report.status, JSON.stringify(artifact.report)).toBe('passed');
    await service(); await db.query("insert into public.publication_rights_authorities(key_id,public_key_sha256) values('rights-test',$1) on conflict(key_id) do update set public_key_sha256=$1,revoked_at=null", [artifact.rightsHash]);
    await rpc('register_publication_candidate($1,$2,$3,$4)', [submission, artifact.report.artifactSha256, artifact.report.sourceSnapshotSha256, artifact.bytes.length]);
    await rpc('record_publication_scan($1,$2,$3,true,true,true,true,$4)', [submission, artifact.report.artifactSha256, artifact.report.manifestSha256, artifact.report]);
    await asUser(db, reviewer); await rpc("review_publication($1,$2,'approved','시험 원본의 배포 권리 검수를 확인했습니다')", [submission, artifact.report.artifactSha256]); await service();
    const release = await rpc<string>('publish_reviewed_release($1,$2,$3,$4,$5,false)', [submission, artifact.report.artifactSha256, workflow.name, '내 계정 복사 경계 시험', `releases/${submission}/${artifact.report.artifactSha256}.zip`]);
    await db.query('insert into public.publication_signing_keys(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [artifact.keyId, artifact.publicKey, artifact.keyHash, '2020-01-01T00:00:00Z', '2036-01-01T00:00:00Z']);
    await rpc('register_publication_delivery($1,$2,$3,$4,$5,$6,$7)', [release, artifact.report.artifactSha256, artifact.report.manifestSha256, artifact.bytes.length, artifact.keyId, artifact.keyHash, artifact.host]);
    const pair = generateKeyPairSync('ed25519'), keyId = `import-copy-${sequence}`, publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), publicHash = hash(pair.publicKey.export({ type: 'spki', format: 'der' }));
    await db.query('insert into public.publication_copy_authorities(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [keyId, publicKey, publicHash, '2020-01-01T00:00:00Z', '2036-01-01T00:00:00Z']);
    const body: Omit<CopyRightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: artifact.report.artifactSha256, sourceSnapshotSha256: artifact.report.sourceSnapshotSha256, scope: 'whole-package', privateCopy: true, modification: true, reviewerId: 'import-test-reviewer', evidenceSha256: 'e'.repeat(64), reviewedAt: '2021-01-01T00:00:00Z', expiresAt: options.expiresAt ?? '2035-01-01T00:00:00Z' };
    const evidence = { ...body, signature: { keyId, value: sign(null, copyRightsEvidenceBytes(body), pair.privateKey).toString('base64url') } }; await rpc('register_publication_copy_rights($1,$2,$3)', [release, evidence, canonicalDigest(evidence)]);
    const source = await prepareAuthoringImport(artifact.bytes, { requireSignature: true, trustStore: { [artifact.keyId]: artifact.publicKey } });
    const request = randomUUID(), begun = await rpc('begin_private_import($1,$2,$3)', [recipient, request, release]);
    const preparation = { format: 'private-authoring-v1', source: source.source, name: workflow.name, workflow: source.workflow!, editor: source.editor ?? {}, inventory: source.inventory,
      resources: source.resources.map(item => ({ ...item, contentSha256: canonicalDigest({ format: 'archive_v1', importId: begun.importId, sourceAlias: item.alias, reference: item.reference, descriptorSha256: item.reference.sha256, name: item.descriptor.name, kind: item.descriptor.kind, description: '' }) })) };
    const stage = (value = preparation) => rpc('stage_private_import($1,$2,$3,$4,$5)', [begun.importId, value, canonicalDigest(value), artifact.bytes.length, artifact.report.artifactSha256]);
    const commit = () => rpc('commit_private_import($1,$2)', [begun.importId, canonicalDigest(preparation)]);
    return { release, artifact, keyId, evidence, source, request, begun, preparation, stage, commit, workflow, copyPair: pair };
  }

  it('stages once, commits all resources and preserves original identities and canonical content pins', async () => {
    const item = await fixture({ resources: true }); expect(item.begun.storage.path).toBe(`${recipient}/${item.begun.importId}/${item.artifact.report.artifactSha256}.zip`);
    expect(await item.stage()).toEqual(await item.stage()); const committed = await item.commit(); expect(committed.state).toBe('committed'); expect(committed.receipt!.resources).toHaveLength(2);
    expect(await item.commit()).toEqual(committed); expect(await rpc('begin_private_import($1,$2,$3)', [recipient, item.request, item.release])).toEqual(committed);
    await asUser(db, recipient); const draft = (await db.query<{ workflow: typeof item.workflow }>('select workflow from public.project_drafts where project_id=$1', [committed.receipt!.projectId])).rows[0]!.workflow;
    expect(draft).toEqual({ ...item.workflow, id: expect.any(String), revision: 1 }); expect(draft.id).not.toBe(item.workflow.id);
    const versions = (await db.query<{ content: unknown; sha256: string; revision: number }>('select v.content,v.sha256,v.revision from public.resource_versions v join public.resource_archive_versions a on a.version_id=v.id where a.import_id=$1', [item.begun.importId])).rows;
    for (const version of versions) { expect(version.revision).toBe(1); expect(version.sha256).toBe(canonicalDigest(version.content)); }
    expect((await db.query('select * from public.private_resource_bindings where project_id=$1', [committed.receipt!.projectId])).rows).toHaveLength(2);
    expect((await db.query('select * from public.resource_origins where import_id=$1', [item.begun.importId])).rows).toHaveLength(2);
    await service(); expect((await db.query<{ count: number }>("select count(*)::int as count from public.publication_audit where release_id=$1 and action='private_copy_committed'", [item.release])).rows[0]!.count).toBe(1);
  });
  it('enforces owner/request idempotency and keeps existing committed receipts after later revocation', async () => {
    const item = await fixture(); await item.stage(); const committed = await item.commit();
    await db.query('update public.publication_copy_authorities set revoked_at=clock_timestamp() where key_id=$1', [item.keyId]);
    expect(await item.commit()).toEqual(committed); expect(await rpc('begin_private_import($1,$2,$3)', [recipient, item.request, item.release])).toEqual(committed);
    await expect(rpc('begin_private_import($1,$2,$3)', [recipient, randomUUID(), item.release])).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE');
    await expect(rpc('begin_private_import($1,$2,$3)', [recipient, item.request, randomUUID()])).rejects.toThrow('IMPORT_REQUEST_CONFLICT');
  });
  it('rejects tampered readback, changed preparation and omitted or substituted transitive dependencies', async () => {
    const item = await fixture({ resources: true });
    await expect(rpc('stage_private_import($1,$2,$3,$4,$5)', [item.begun.importId, item.preparation, canonicalDigest(item.preparation), item.artifact.bytes.length + 1, item.begun.storage.sha256])).rejects.toThrow('IMPORT_STORAGE_MISMATCH');
    const missing = structuredClone(item.preparation); missing.resources = missing.resources.filter(resource => resource.alias !== 'guide-alias'); missing.inventory.resourceCount = 1;
    await expect(item.stage(missing)).rejects.toThrow('IMPORT_DEPENDENCY_INVALID');
    const duplicate = structuredClone(item.preparation); duplicate.resources.push(duplicate.resources[0]!); duplicate.inventory.resourceCount = 3; await expect(item.stage(duplicate)).rejects.toThrow('IMPORT_RESOURCE_INVALID');
    const source = structuredClone(item.preparation); source.source.trust = 'unsigned'; await expect(item.stage(source)).rejects.toThrow('IMPORT_PREPARATION_INVALID');
    await item.stage(); await expect(item.stage({ ...item.preparation, name: '변경된 준비' })).rejects.toThrow('IMPORT_PREPARATION_CONFLICT');
    await expect(rpc('commit_private_import($1,$2)', [item.begun.importId, 'f'.repeat(64)])).rejects.toThrow('IMPORT_PREPARATION_CONFLICT');
  });
  it.each(['copy-grant', 'copy-authority', 'signing-key', 'distribution-authority', 'moderation'] as const)('rechecks %s at final commit and leaves no partially copied rows', async boundary => {
    const item = await fixture({ resources: true }); await item.stage();
    if (boundary === 'copy-grant') await db.query('update public.publication_copy_rights set revoked_at=clock_timestamp() where evidence_sha256=$1', [canonicalDigest(item.evidence)]);
    if (boundary === 'copy-authority') await db.query('update public.publication_copy_authorities set revoked_at=clock_timestamp() where key_id=$1', [item.keyId]);
    if (boundary === 'signing-key') await db.query('update public.publication_signing_keys set revoked_at=clock_timestamp() where key_id=$1', [item.artifact.keyId]);
    if (boundary === 'distribution-authority') await db.query("update public.publication_rights_authorities set revoked_at=clock_timestamp() where key_id='rights-test'");
    if (boundary === 'moderation') { await asUser(db, reviewer); await rpc("moderate_release($1,'suspended','내 계정 복사 전 배포 상태를 중단합니다')", [item.release]); await service(); }
    await expect(item.commit()).rejects.toThrow(/COPY_RIGHTS_UNAVAILABLE|DELIVERY_NOT_AVAILABLE/);
    expect((await db.query('select * from public.resource_archive_versions where import_id=$1', [item.begun.importId])).rows).toHaveLength(0);
    expect((await db.query('select * from public.project_origins where import_id=$1', [item.begun.importId])).rows).toHaveLength(0);
  });
  it('uses wall time for grant and staging expiry even in an older transaction', async () => {
    const item = await fixture({ expiresAt: new Date(Date.now() + 2500).toISOString() }); await item.stage(); await db.exec('begin');
    try { await delay(2600); await expect(item.commit()).rejects.toThrow('COPY_RIGHTS_UNAVAILABLE'); } finally { await db.exec('rollback'); }
    const next = await fixture(); await next.stage(); await root(); await db.query("update public.private_imports set expires_at=clock_timestamp()+interval '0.15 seconds' where id=$1", [next.begun.importId]); await service(); await db.exec('begin');
    try { await delay(200); await expect(next.commit()).rejects.toThrow('IMPORT_NOT_AVAILABLE'); } finally { await db.exec('rollback'); }
  });
  it('blocks browser draft/revision/archive/origin/Storage writes and hides other owners', async () => {
    const item = await fixture({ resources: true }); await item.stage(); const result = await item.commit(); const receipt = result.receipt!;
    await asUser(db, recipient);
    for (const table of ['private_imports', 'private_import_cleanup']) await expect(db.query(`select * from public.${table}`)).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("update public.project_drafts set workflow='{}' where project_id=$1", [receipt.projectId])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("insert into public.project_drafts(project_id,workflow) values($1,'{}')", [receipt.projectId])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("insert into public.project_revisions(project_id,revision,workflow,editor,sha256) values($1,9,'{}','{}',$2)", [receipt.projectId, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("insert into public.resource_versions(resource_id,revision,content,sha256) values($1,2,'{\"format\":\"archive_v1\"}',$2)", [receipt.resources[0]!.resourceId, 'a'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("update public.project_origins set source='{}' where project_id=$1", [receipt.projectId])).rejects.toMatchObject({ code: '42501' });
    await expect(db.query("insert into storage.objects(bucket_id,name) values('authoring-imports',$1)", [result.storage.path])).rejects.toMatchObject({ code: '42501' });
    expect(await rpc('get_private_import_status($1)', [item.request])).toEqual({ importId: result.importId, requestId: item.request, releaseId: item.release, state: 'committed', receipt, failureCode: null });
    await asUser(db, owner); expect(await rpc('get_private_import_status($1)', [item.request])).toBeNull(); expect((await db.query('select * from public.resource_archive_versions where import_id=$1', [result.importId])).rows).toHaveLength(0);
    await expect(rpc('begin_private_import($1,$2,$3)', [owner, randomUUID(), item.release])).rejects.toMatchObject({ code: '42501' });
    await expect(rpc('stage_private_import($1,$2,$3,$4,$5)', [result.importId, item.preparation, canonicalDigest(item.preparation), result.storage.bytes, result.storage.sha256])).rejects.toMatchObject({ code: '42501' });
    await expect(rpc('commit_private_import($1,$2)', [result.importId, canonicalDigest(item.preparation)])).rejects.toMatchObject({ code: '42501' });
  });
  it('preserves archive mappings in legacy saves and freezes revision bindings before draft changes', async () => {
    const item = await fixture({ resources: true }); await item.stage(); const receipt = (await item.commit()).receipt!; await asUser(db, recipient);
    const draft = (await db.query<{ workflow: typeof item.workflow }>('select workflow from public.project_drafts where project_id=$1', [receipt.projectId])).rows[0]!.workflow;
    const saved = await rpc<{ version: number }>('save_private_draft($1,1,$2,$3,$4)', [receipt.projectId, '수정한 이름', draft, {}]); expect(saved.version).toBe(2);
    const revision = await rpc<{ id: string }>('snapshot_private_project($1,2,$2)', [receipt.projectId, canonicalDigest(draft)]);
    await rpc('save_private_draft_with_resources($1,2,$2,$3,$4,$5)', [receipt.projectId, '자료 없는 초안', { ...draft, resources: {} }, {}, {}]);
    expect((await db.query('select * from public.private_resource_bindings where project_id=$1', [receipt.projectId])).rows).toHaveLength(0);
    expect((await db.query('select * from public.private_revision_resource_bindings where revision_id=$1', [revision.id])).rows).toHaveLength(2);
    await expect(db.query('delete from public.resources where id=$1', [receipt.resources[0]!.resourceId])).rejects.toMatchObject({ code: '23503' });
    const reused = await rpc<{ project: { id: string } }>('create_private_project_with_resources($1,$2,$3,$4)', ['다른 내 프로젝트', draft, {}, Object.fromEntries(receipt.resources.map(resource => [resource.alias, resource.versionId]))]);
    expect((await db.query('select * from public.private_resource_bindings where project_id=$1', [reused.project.id])).rows).toHaveLength(2);
  });
  it('atomically rejects missing dependencies, forged references and another owner versions', async () => {
    const item = await fixture({ resources: true }); await item.stage(); const receipt = (await item.commit()).receipt!; await asUser(db, recipient);
    const draft = (await db.query<{ workflow: typeof item.workflow }>('select workflow from public.project_drafts where project_id=$1', [receipt.projectId])).rows[0]!.workflow;
    const bindings = Object.fromEntries(receipt.resources.map(resource => [resource.alias, resource.versionId]));
    const altered = structuredClone(draft); altered.resources['note-alias']!.sha256 = 'f'.repeat(64);
    await expect(rpc('save_private_draft_with_resources($1,1,$2,$3,$4,$5)', [receipt.projectId, '실패', altered, {}, bindings])).rejects.toThrow('RESOURCE_BINDINGS_INVALID');
    const missing = structuredClone(draft); delete missing.resources['guide-alias'];
    await expect(rpc('save_private_draft_with_resources($1,1,$2,$3,$4,$5)', [receipt.projectId, '실패', missing, {}, { 'note-alias': bindings['note-alias'] }])).rejects.toThrow('RESOURCE_DEPENDENCY_INVALID');
    await asUser(db, owner); const foreign = await rpc<{ version: { id: string } }>('create_private_resource($1,$2,$3,$4,$5)', ['다른 사용자 자료', 'instruction', '', {}, 'a'.repeat(64)]);
    await asUser(db, recipient); await expect(rpc('save_private_draft_with_resources($1,1,$2,$3,$4,$5)', [receipt.projectId, '실패', draft, {}, { ...bindings, 'guide-alias': foreign.version.id }])).rejects.toThrow('RESOURCE_BINDINGS_INVALID');
    expect((await db.query<{ version: number }>('select version from public.project_drafts where project_id=$1', [receipt.projectId])).rows[0]!.version).toBe(1);
    expect((await db.query('select * from public.private_resource_bindings where project_id=$1', [receipt.projectId])).rows).toHaveLength(2);
  });
  it('keeps old text creation/save/snapshot contracts with optimistic locking and explicit owner checks', async () => {
    await asUser(db, recipient); const project = await rpc<{ project: { id: string }; draft: { version: number } }>('create_private_project($1,$2,$3)', ['기존 초안', {}, {}]);
    const resource = await rpc<{ resource: { id: string }; version: { id: string } }>('create_private_resource($1,$2,$3,$4,$5)', ['기존 지침', 'instruction', '', { format: 'text', text: '기존 문장' }, 'b'.repeat(64)]);
    const ref = { id: resource.resource.id, revision: 1, kind: 'instruction', sha256: 'c'.repeat(64) };
    const workflow = { resources: { [resource.resource.id]: ref } };
    expect((await rpc<{ version: number }>('save_private_draft($1,1,$2,$3,$4)', [project.project.id, '저장한 초안', workflow, {}])).version).toBe(2);
    expect(await rpc('snapshot_private_project($1,2,$2)', [project.project.id, canonicalDigest(workflow)])).toHaveProperty('revision', 1);
    await expect(rpc('save_private_draft($1,1,$2,$3,$4)', [project.project.id, '오래된 초안', {}, {}])).rejects.toMatchObject({ code: '40001' });
    await asUser(db, owner); await expect(rpc('save_private_draft($1,2,$2,$3,$4)', [project.project.id, '타인 수정', {}, {}])).rejects.toMatchObject({ code: '40001' });
    await expect(rpc('snapshot_private_project($1,2,$2)', [project.project.id, 'a'.repeat(64)])).rejects.toMatchObject({ code: '40001' });
  });
  it('makes failure terminal and cleans only an exact object after retention, with fenced retry leases', async () => {
    const item = await fixture(); await item.stage(); await rpc('fail_private_import($1,$2)', [item.begun.importId, 'UPLOAD_RECHECK_FAILED']);
    await expect(item.commit()).rejects.toThrow('IMPORT_NOT_AVAILABLE'); expect(await rpc('claim_private_import_cleanup(100)')).toEqual([]);
    const unclaimed = (await db.query<{ id: string }>('select id from public.private_import_cleanup where import_id=$1', [item.begun.importId])).rows[0]!.id;
    await expect(rpc('finish_private_import_cleanup($1,$2,$3)', [unclaimed, null, 'deleted'])).rejects.toThrow('CLEANUP_LEASE_INVALID');
    await root(); await db.query("update public.private_import_cleanup set not_before=clock_timestamp()-interval '1 second' where import_id=$1", [item.begun.importId]); await service();
    type Job = { jobId: string; importId: string; leaseId: string; path: string; expectedSha256: string; attempts: number };
    const first = (await rpc<Job[]>('claim_private_import_cleanup(100)')).find(job => job.importId === item.begun.importId)!;
    expect(first).toMatchObject({ path: item.begun.storage.path, expectedSha256: item.begun.storage.sha256, attempts: 1 });
    expect(await rpc('claim_private_import_cleanup(100)')).toEqual([]);
    await expect(rpc('finish_private_import_cleanup($1,$2,$3)', [first.jobId, randomUUID(), 'deleted'])).rejects.toThrow('CLEANUP_LEASE_INVALID');
    await rpc('finish_private_import_cleanup($1,$2,$3)', [first.jobId, first.leaseId, 'retry']);
    await root(); await db.query("update public.private_import_cleanup set not_before=clock_timestamp()-interval '1 second' where id=$1", [first.jobId]); await service();
    const second = (await rpc<Job[]>('claim_private_import_cleanup(100)')).find(job => job.importId === item.begun.importId)!; expect(second.attempts).toBe(2); expect(second.leaseId).not.toBe(first.leaseId);
    await expect(rpc('finish_private_import_cleanup($1,$2,$3)', [first.jobId, first.leaseId, 'deleted'])).rejects.toThrow('CLEANUP_LEASE_INVALID');
    await rpc('finish_private_import_cleanup($1,$2,$3)', [second.jobId, second.leaseId, 'not_found']);
    await root(); await db.query("update public.private_import_cleanup set lease_until=clock_timestamp()-interval '1 second' where id=$1", [second.jobId]); await service();
    await rpc('finish_private_import_cleanup($1,$2,$3)', [second.jobId, second.leaseId, 'not_found']);
    expect((await db.query<{ storage_deleted_at: unknown }>('select storage_deleted_at from public.private_imports where id=$1', [item.begun.importId])).rows[0]!.storage_deleted_at).not.toBeNull();
  });
  it('expires abandoned staging before cleanup and retains a committed archive while bindings survive', async () => {
    const item = await fixture({ resources: true }); await item.stage(); const receipt = (await item.commit()).receipt!;
    const abandoned = await fixture(); await root(); await db.query("update public.private_imports set expires_at=clock_timestamp()-interval '1 second' where id=$1", [abandoned.begun.importId]); await service(); await rpc('claim_private_import_cleanup(100)');
    expect((await db.query<{ state: string }>('select state from public.private_imports where id=$1', [abandoned.begun.importId])).rows[0]!.state).toBe('failed'); await expect(abandoned.commit()).rejects.toThrow('IMPORT_PREPARATION_CONFLICT');
    expect((await db.query('select * from public.private_import_cleanup where import_id=$1', [item.begun.importId])).rows).toHaveLength(0);
    await asUser(db, recipient); await db.query('delete from public.projects where id=$1', [receipt.projectId]); await service(); await rpc('claim_private_import_cleanup(100)');
    expect((await db.query('select * from public.private_import_cleanup where import_id=$1', [item.begun.importId])).rows).toHaveLength(0);
    await asUser(db, recipient); for (const resource of receipt.resources) await db.query('delete from public.resources where id=$1', [resource.resourceId]); await service(); await rpc('claim_private_import_cleanup(100)');
    expect((await db.query('select * from public.private_import_cleanup where import_id=$1', [item.begun.importId])).rows).toHaveLength(1);
  });
  it('retains cleanup provenance when a recipient account disappears and never exposes service helpers to anonymous callers', async () => {
    const item = await fixture(), disposable = randomUUID(); await root(); await db.query('insert into auth.users(id) values($1)', [disposable]); await service();
    const pending = await rpc('begin_private_import($1,$2,$3)', [disposable, randomUUID(), item.release]); await root(); await db.query('delete from auth.users where id=$1', [disposable]); await service(); await rpc('claim_private_import_cleanup(100)');
    expect((await db.query<{ storage_path: string }>('select storage_path from public.private_import_cleanup where import_id=$1', [pending.importId])).rows[0]!.storage_path).toBe(pending.storage.path);
    await db.exec('reset role; set role anon'); await expect(rpc('get_private_import_status($1)', [item.request])).rejects.toMatchObject({ code: '42501' }); await expect(rpc('claim_private_import_cleanup(1)')).rejects.toMatchObject({ code: '42501' });
    await expect(rpc('create_private_project($1,$2,$3)', ['익명 초안', {}, {}])).rejects.toMatchObject({ code: '42501' });
  });
  it('rolls back all account rows when a later resource insertion fails inside commit', async () => {
    const item = await fixture({ resources: true }); await item.stage(); await root();
    // Fault injection exists only in this isolated test database and is removed even after failure.
    await db.exec("create function public.test_import_failure() returns trigger language plpgsql as $$ begin if new.source_alias='note-alias' then raise exception 'TEST_INSERT_FAILURE'; end if; return new; end $$; create trigger test_import_failure before insert on public.resource_archive_versions for each row execute function public.test_import_failure()");
    try {
      await service(); await expect(item.commit()).rejects.toThrow('TEST_INSERT_FAILURE');
      expect((await db.query('select * from public.resource_archive_versions where import_id=$1', [item.begun.importId])).rows).toHaveLength(0);
      await root(); expect((await db.query("select * from public.resource_versions where content->>'importId'=$1", [item.begun.importId])).rows).toHaveLength(0);
      expect((await db.query<{ state: string }>('select state from public.private_imports where id=$1', [item.begun.importId])).rows[0]!.state).toBe('staging');
    } finally { await root(); await db.exec('drop trigger test_import_failure on public.resource_archive_versions; drop function public.test_import_failure()'); }
    await service(); expect((await item.commit()).state).toBe('committed');
  });
  it('publishes a real copied archive resource closure and imports materials without inventing a project', async () => {
    const item = await fixture({ resources: true }); await item.stage(); const copied = (await item.commit()).receipt!, note = copied.resources.find(resource => resource.alias === 'note-alias')!;
    await asUser(db, recipient); const submission = await rpc<string>("submit_publication('resource',$1)", [note.versionId]);
    const snapshot = (await db.query<{ source_snapshot: unknown }>('select source_snapshot from public.publication_submissions where id=$1', [submission])).rows[0]!.source_snapshot;
    const refs = Object.fromEntries(Object.entries(item.workflow.resources).map(([alias, reference]) => { if (!reference) throw new Error('Fixture resource reference is missing'); return [alias, reference]; }));
    const built = await buildMaterialsPackage({ host: 'codex', name: '복사한 문서와 지침', refs, resources: item.source.resourceFiles });
    const signer = generateKeyPairSync('ed25519'), rights = generateKeyPairSync('ed25519'), signerId = `materials-package-${serial}`, rightsId = `materials-rights-${serial}`;
    const files = unzipSync(built.bytes); files['manifest.sig'] = new TextEncoder().encode(JSON.stringify({ algorithm: 'Ed25519', keyId: signerId, signature: sign(null, Buffer.from('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(built.manifest)), signer.privateKey).toString('base64url') }));
    const bytes = Uint8Array.from(zipSync(files)), publicKey = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(), signerHash = hash(signer.publicKey.export({ type: 'spki', format: 'der' }));
    const body: Omit<RightsEvidence, 'signature'> = { schemaVersion: '1.0.0', artifactSha256: hash(bytes), sourceSnapshotSha256: canonicalDigest(snapshot), scope: 'whole-package', redistribution: true, reviewerId: 'materials-reuse-test', evidenceSha256: 'a'.repeat(64), reviewedAt: '2021-01-01T00:00:00.000Z', expiresAt: '2035-01-01T00:00:00.000Z' };
    const report = await scanPublication({ bytes, source: { kind: 'resource', snapshot }, policy: { id: 'materials-db-test', version: '1.0.0', supportedCapabilities: [] }, packageTrust: { [signerId]: publicKey }, rightsTrust: { [rightsId]: { purpose: 'redistribution-rights', publicKey: rights.publicKey.export({ type: 'spki', format: 'pem' }).toString() } }, rightsEvidence: { ...body, signature: { keyId: rightsId, value: sign(null, rightsEvidenceBytes(body), rights.privateKey).toString('base64url') } } });
    // The public scan is computed from actual package/source/rights bytes; never insert a fabricated passed report.
    expect(report.status).toBe('passed'); await service(); await db.query('insert into public.publication_rights_authorities(key_id,public_key_sha256) values($1,$2)', [rightsId, report.rightsKeySha256]);
    await rpc('register_publication_candidate($1,$2,$3,$4)', [submission, report.artifactSha256, report.sourceSnapshotSha256, bytes.length]);
    await rpc('record_publication_scan($1,$2,$3,true,true,true,true,$4)', [submission, report.artifactSha256, report.manifestSha256, report]);
    await asUser(db, reviewer); await rpc("review_publication($1,$2,'approved','실제 복사 자료의 원본과 새 배포 권리를 검수합니다')", [submission, report.artifactSha256]); await service();
    const release = await rpc<string>('publish_reviewed_release($1,$2,$3,$4,$5,false)', [submission, report.artifactSha256, '복사 자료 재배포 시험', '별도 권리 검수를 거친 시험 자료입니다.', `releases/${submission}/${report.artifactSha256}.zip`]);
    await db.query('insert into public.publication_signing_keys(key_id,public_key_pem,public_key_sha256,not_before,expires_at) values($1,$2,$3,$4,$5)', [signerId, publicKey, signerHash, '2020-01-01T00:00:00Z', '2036-01-01T00:00:00Z']);
    await rpc('register_publication_delivery($1,$2,$3,$4,$5,$6,$7)', [release, report.artifactSha256, report.manifestSha256, bytes.length, signerId, signerHash, 'codex']);
    const { signature: _, ...originalCopy } = item.evidence;
    const copyBody = { ...originalCopy, artifactSha256: report.artifactSha256, sourceSnapshotSha256: report.sourceSnapshotSha256 };
    const copyEvidence = { ...copyBody, signature: { keyId: item.keyId, value: sign(null, copyRightsEvidenceBytes(copyBody), item.copyPair.privateKey).toString('base64url') } };
    await rpc('register_publication_copy_rights($1,$2,$3)', [release, copyEvidence, canonicalDigest(copyEvidence)]);
    const begun = await rpc('begin_private_import($1,$2,$3)', [owner, randomUUID(), release]);
    const source = await prepareAuthoringImport(bytes, { requireSignature: true, trustStore: { [signerId]: publicKey } });
    const preparation = { format: 'private-authoring-v1', source: source.source, name: '내 자료로 다시 복사', inventory: source.inventory, resources: source.resources.map(resource => ({ ...resource, contentSha256: canonicalDigest({ format: 'archive_v1', importId: begun.importId, sourceAlias: resource.alias, reference: resource.reference, descriptorSha256: resource.reference.sha256, name: resource.descriptor.name, kind: resource.descriptor.kind, description: '' }) })) };
    await rpc('stage_private_import($1,$2,$3,$4,$5)', [begun.importId, preparation, canonicalDigest(preparation), bytes.length, hash(bytes)]);
    const result = await rpc('commit_private_import($1,$2)', [begun.importId, canonicalDigest(preparation)]);
    expect(result.receipt!.projectId).toBeNull(); expect(result.receipt!.resources).toHaveLength(2); expect(result.state).toBe('committed');
    await asUser(db, owner); const versions = (await db.query<{ content: { reference: ResourceRef }; sha256: string }>('select v.content,v.sha256 from public.resource_versions v join public.resource_archive_versions a on a.version_id=v.id where a.import_id=$1', [begun.importId])).rows;
    expect(versions).toHaveLength(2); for (const version of versions) expect(version.sha256).toBe(canonicalDigest(version.content));
    expect(versions.map(version => version.content.reference.revision).sort()).toEqual([3, 9]);
  });
});
