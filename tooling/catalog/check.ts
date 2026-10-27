import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from 'json-canonicalize';
import { BASIC_CAPABILITIES, createSchemaValidator, parseStrictJson, validateWorkflowShape, type ResourceRef } from '@studio/spec';
import { analyzeWorkflow, collectRequirements } from '@studio/workflow-core';
import { verifyResources } from '@studio/package-kit';
import type { OfficialExample, VerificationRecord } from './contracts.generated.js';
import { parseOfficialBrief, sourceIdentity, type OfficialCatalog } from './inventory.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schemas = createSchemaValidator();
const validateEntry = schemas.compile<OfficialExample>(JSON.parse(await readFile(path.join(repository, 'packages/spec/schemas/official-example.schema.json'), 'utf8')));
const validateRecord = schemas.compile<VerificationRecord>(JSON.parse(await readFile(path.join(repository, 'packages/spec/schemas/verification-record.schema.json'), 'utf8')));
const hosts = ['codex', 'claude-code', 'opencode'] as const;
const maximumFileBytes = 32 * 1024 * 1024;

export interface CatalogIssue { exampleId?: string; code: string; message: string }
export interface CatalogReport {
  valid: boolean; releaseReady: boolean; issues: CatalogIssue[];
  counts: { plannedProjects: number; plannedResources: number; usableProjects: number; usableResources: number; publishedProjects: number; publishedResources: number; verifiedHostCombinations: number };
  releaseGaps: string[];
}
export interface CatalogOptions {
  root: string;
  /** Operator-controlled keys must come from outside the untrusted catalogue or package. */
  trustedVerifierKeys?: Readonly<Record<string, string>>;
  availableCapabilities?: readonly string[];
  requireCompleteInventory?: boolean;
  now?: Date;
  maximumEvidenceAgeDays?: number;
}

/** File identity uses original bytes; canonical hashes identify the declared plan and inventory. */
export const digestBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const digestValue = (value: unknown) => digestBytes(new TextEncoder().encode(canonicalize(value)));
export function artifactDigest(files: NonNullable<OfficialExample['artifact']>['files']) { return digestValue([...files].sort((a, b) => a.path.localeCompare(b.path))); }
export function definitionDigest(entry: OfficialExample) {
  return digestValue(JSON.parse(JSON.stringify({ ...sourceIdentity(entry), blocks: entry.blocks, requiredCapabilities: entry.requiredCapabilities, externalDependencies: entry.externalDependencies, targetHosts: entry.targetHosts })));
}
export function unsignedVerification(record: VerificationRecord) { const { signature: _signature, ...unsigned } = record; return unsigned; }

/** Reject traversal, alternate Windows streams, ambiguous names and symlinks before reading evidence. */
function safeRelative(value: string): void {
  if (!value || value.includes('\\') || value.includes(':') || value.startsWith('/') || /[\u0000-\u001f]/.test(value) || value.split('/').some((segment) => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error(`Unsafe relative path: ${value}`);
}
async function safeRead(root: string, relative: string): Promise<Uint8Array> {
  safeRelative(relative); const actualRoot = await realpath(root); let target = actualRoot;
  for (const segment of relative.split('/')) { target = path.join(target, segment); if ((await lstat(target)).isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${relative}`); }
  const info = await lstat(target); if (!info.isFile() || info.size > maximumFileBytes) throw new Error(`Invalid file size/type: ${relative}`);
  const relation = path.relative(actualRoot, await realpath(target)); if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error(`Path escapes root: ${relative}`);
  const bytes = await readFile(target); if (bytes.length !== info.size) throw new Error(`File changed during verification: ${relative}`); return bytes;
}
async function filesBelow(root: string, relative: string): Promise<string[]> {
  safeRelative(relative); const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are forbidden: ${next}`);
    if (entry.isDirectory()) result.push(...await filesBelow(root, next));
    else if (entry.isFile()) result.push(next);
    else throw new Error(`Special files are forbidden: ${next}`);
  }
  return result;
}
const decodeJson = (bytes: Uint8Array) => parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));

/** Validation produces a report only. It never runs a workflow, uploads content or changes publication state. */
export async function checkCatalog(value: unknown, options: CatalogOptions): Promise<CatalogReport> {
  const issues: CatalogIssue[] = [];
  const counts: CatalogReport['counts'] = { plannedProjects: 0, plannedResources: 0, usableProjects: 0, usableResources: 0, publishedProjects: 0, publishedResources: 0, verifiedHostCombinations: 0 };
  const issue = (code: string, message: string, exampleId?: string) => issues.push({ code, message, ...(exampleId ? { exampleId } : {}) });
  const raw = value as Partial<OfficialCatalog> | null;
  if (!raw || raw.schemaVersion !== '1.0.0' || !Array.isArray(raw.entries) || raw.releaseTargets?.projects !== 120 || raw.releaseTargets?.resources !== 120 || Object.keys(raw).some((key) => !['schemaVersion', 'releaseTargets', 'entries'].includes(key))) return { valid: false, releaseReady: false, issues: [{ code: 'CATALOG_SCHEMA', message: 'Expected the canonical 120+120 catalogue envelope.' }], counts, releaseGaps: ['Catalogue is invalid.'] };
  const entries: OfficialExample[] = [];
  const ids = new Set<string>(); const duplicateIds = new Set<string>();
  for (const entry of raw.entries as unknown[]) {
    if (!validateEntry(entry)) { const identity = (entry as { id?: unknown } | null)?.id; issue('ENTRY_SCHEMA', schemas.errorsText(validateEntry.errors), typeof identity === 'string' ? identity : undefined); continue; }
    if (ids.has(entry.id)) { duplicateIds.add(entry.id); issue('DUPLICATE_ID', 'An example ID must occur only once.', entry.id); } ids.add(entry.id); entries.push(entry);
  }
  const expected = parseOfficialBrief(await readFile(path.join(repository, 'docs/specifications/official-catalog-design.md'), 'utf8'));
  const briefs = new Map(expected.map((entry) => [entry.id, entry]));
  if (options.requireCompleteInventory !== false) for (const brief of expected) if (!ids.has(brief.id)) issue('MISSING_EXAMPLE', 'An agreed example is absent from the inventory.', brief.id);
  const candidates: { entry: OfficialExample; artifactFingerprint: string; hostCount: number }[] = [];
  for (const entry of entries) {
    const before = issues.length;
    const brief = briefs.get(entry.id);
    if (!brief || canonicalize(sourceIdentity(entry)) !== canonicalize(sourceIdentity(brief))) issue('SOURCE_DRIFT', 'Name, purpose, connections, input/output or acceptance criteria differ from the agreed brief.', entry.id);
    if (brief && canonicalize([...entry.blocks].sort()) !== canonicalize([...brief.blocks].sort())) issue('BLOCK_DRIFT', 'Required core blocks differ from the agreed brief.', entry.id);
    if (brief && brief.externalDependencies.some((required) => !entry.externalDependencies.some((dependency) => dependency.id === required.id && dependency.kind === required.kind))) issue('MISSING_EXTERNAL_DEPENDENCY', 'The brief requires an external dependency that is not declared.', entry.id);
    if (brief && brief.requiredCapabilities.some((required) => !entry.requiredCapabilities.includes(required))) issue('MISSING_CAPABILITY', 'The brief requires a capability absent from this entry.', entry.id);
    if (new Set(entry.externalDependencies.map((dependency) => dependency.id)).size !== entry.externalDependencies.length) issue('DUPLICATE_DEPENDENCY', 'Dependency identities must be unique.', entry.id);
    if (entry.kind === 'project' && (!entry.id.startsWith('EP-') || entry.resourceKind) || entry.kind === 'resource' && (!entry.id.startsWith('ER-') || !entry.resourceKind)) issue('KIND_MISMATCH', 'ID prefix and resource kind do not match.', entry.id);
    if (entry.state === 'planned') {
      counts[entry.kind === 'project' ? 'plannedProjects' : 'plannedResources']++;
      if (entry.artifact || entry.review || entry.verificationRecords.length) issue('PLANNED_WITH_EVIDENCE', 'Planned entries cannot claim content or successful verification.', entry.id);
      continue;
    }
    if (!entry.artifact) { issue('MISSING_ARTIFACT', 'Implemented or published entries require actual pinned files.', entry.id); continue; }
    const artifact = entry.artifact;
    let fingerprint = '';
    try {
      safeRelative(artifact.rootPath);
      if (artifact.sha256 !== artifactDigest(artifact.files)) throw new Error('Declared artifact digest differs from its file inventory.');
      const files = new Map<string, Uint8Array>(); const names = new Set<string>();
      for (const file of artifact.files) {
        safeRelative(file.path); const normalized = file.path.normalize('NFC').toLocaleLowerCase('en-US');
        if (names.has(normalized)) throw new Error(`Duplicate or case-colliding artifact path: ${file.path}`); names.add(normalized);
        if (/(?:^|\/)(?:node_modules|tests|__tests__|fixtures|\.git)(?:\/|$)/i.test(file.path) || /(?:^|\/)\.env(?:\.|$)/i.test(file.path)) throw new Error(`Internal or secret file in production content: ${file.path}`);
        const bytes = await safeRead(options.root, `${artifact.rootPath}/${file.path}`);
        if (!bytes.length || digestBytes(bytes) !== file.sha256) throw new Error(`Artifact bytes are empty or do not match the pinned hash: ${file.path}`);
        files.set(file.path, bytes);
      }
      const actualPaths = (await filesBelow(options.root, artifact.rootPath)).map((file) => file.slice(artifact.rootPath.length + 1)).sort();
      if (canonicalize(actualPaths) !== canonicalize([...files.keys()].sort())) throw new Error('The artifact directory contains unlisted or missing files.');
      for (const role of ['entrypoint', 'readme', 'license']) if (!artifact.files.some((file) => file.role === role)) throw new Error(`Missing required file role: ${role}`);
      if (!artifact.files.some((file) => file.path === artifact.entrypoint && file.role === 'entrypoint')) throw new Error('Entrypoint is not pinned as an entrypoint file.');
      if (entry.kind === 'project') {
        if (artifact.entrypoint !== 'workflow.json') throw new Error('Projects must provide workflow.json.');
        const checked = validateWorkflowShape(decodeJson(files.get(artifact.entrypoint)!));
        if (!checked.valid || analyzeWorkflow(checked.value).some((result) => result.severity === 'error')) throw new Error('Project workflow fails shared structural or semantic validation.');
        const requirements = collectRequirements(checked.value);
        const actualBlocks = new Set([checked.value, ...Object.values(checked.value.subworkflows)].flatMap((flow) => flow?.nodes.map((node) => node.type) ?? []));
        if (entry.blocks.some((block) => !actualBlocks.has(block as typeof checked.value.nodes[number]['type']))) throw new Error('The project does not actually contain the core blocks promised by its brief.');
        for (const capability of requirements.capabilities) if (!entry.requiredCapabilities.includes(capability)) throw new Error(`Workflow capability is not declared: ${capability}`);
        verifyResources(checked.value.resources, files);
        // Names and workflow IDs cannot turn the same operational design into multiple official examples.
        const { id: _id, name: _name, revision: _revision, ...content } = checked.value;
        fingerprint = digestValue(content);
      } else {
        if (artifact.entrypoint !== 'resource.json') throw new Error('Resources must provide resource.json.');
        const descriptor = decodeJson(files.get('resource.json')!) as Record<string, unknown>;
        const reference = { id: descriptor.id, kind: descriptor.kind, revision: descriptor.revision, sha256: digestBytes(files.get('resource.json')!) } as ResourceRef;
        const refs = { main: reference, ...(descriptor.dependencies as Record<string, ResourceRef> ?? {}) };
        const resourceFiles = new Map([...files].map(([name, bytes]) => [name.startsWith('resources/') ? name : `resources/main/${name}`, bytes]));
        const checked = verifyResources(refs, resourceFiles).get('main');
        if (!checked || checked.kind !== entry.resourceKind) throw new Error('Resource descriptor does not match the catalogue kind.');
        for (const connection of checked.requiredConnections) if (!entry.externalDependencies.some((dependency) => dependency.id === connection)) throw new Error(`Resource connection is not declared: ${connection}`);
        const presentationFiles = new Set(artifact.files.filter((file) => file.role === 'readme' || file.role === 'license').map((file) => file.path));
        fingerprint = digestValue(checked.files.filter((file) => !presentationFiles.has(file.path)).map((file) => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
      }
    } catch (error) { issue('ARTIFACT_INVALID', error instanceof Error ? error.message : 'Unable to read artifact.', entry.id); }
    if (entry.state === 'implemented' || entry.state === 'suspended') continue;
    const available = options.availableCapabilities ?? BASIC_CAPABILITIES;
    for (const capability of entry.requiredCapabilities) if (!available.includes(capability)) issue('CAPABILITY_UNAVAILABLE', `Installed release has not verified ${capability}.`, entry.id);
    if (!hosts.every((host) => entry.targetHosts.includes(host))) issue('HOST_COVERAGE', 'Official release requires all three target hosts.', entry.id);
    const verifiedHosts = new Set<string>(); const recordIds = new Set<string>();
    for (const pointer of entry.verificationRecords) {
      try {
        const recordBytes = await safeRead(options.root, pointer.path);
        if (digestBytes(recordBytes) !== pointer.sha256) throw new Error('Verification record hash mismatch.');
        const record = decodeJson(recordBytes);
        if (!validateRecord(record)) throw new Error(`Not an actual-run verification record: ${schemas.errorsText(validateRecord.errors)}`);
        if (recordIds.has(record.id)) throw new Error('Duplicate verification record identity.'); recordIds.add(record.id);
        if (record.exampleId !== entry.id || record.artifactSha256 !== artifact.sha256 || record.definitionSha256 !== definitionDigest(entry) || record.acceptanceCriteria !== entry.definition.acceptanceCriteria) throw new Error('Verification does not attest this exact artifact and acceptance contract.');
        const key = options.trustedVerifierKeys?.[record.signature.keyId]; if (!key) throw new Error('Verification key is not trusted by the operator.');
        const publicKey = createPublicKey(key); if (publicKey.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalize(unsignedVerification(record))), publicKey, Buffer.from(record.signature.value, 'base64'))) throw new Error('Verification signature is invalid.');
        const started = Date.parse(record.startedAt), finished = Date.parse(record.finishedAt), now = (options.now ?? new Date()).valueOf();
        if (finished < started || finished > now + 300000 || now - finished > (options.maximumEvidenceAgeDays ?? 90) * 86400000) throw new Error('Verification timing is invalid or evidence is expired.');
        if (entry.requiredCapabilities.some((capability) => !record.capabilities.includes(capability))) throw new Error('Actual run lacks required capabilities.');
        const evidencePaths = new Set<string>();
        for (const evidence of record.evidence) {
          if (evidencePaths.has(evidence.path)) throw new Error('Duplicate evidence path.'); evidencePaths.add(evidence.path);
          const bytes = await safeRead(options.root, evidence.path); if (!bytes.length || digestBytes(bytes) !== evidence.sha256) throw new Error(`Evidence hash mismatch: ${evidence.path}`);
        }
        const expectedSteps = entry.kind === 'project' ? ['host-entry', 'runner-start', 'result-received', 'acceptance-check'] : ['host-entry', 'resource-use', 'acceptance-check'];
        if (expectedSteps.some((kind) => !record.steps.some((step) => step.kind === kind))) throw new Error('Host entry, actual usage/result or acceptance evidence is missing.');
        if (record.steps.some((step) => !evidencePaths.has(step.evidencePath))) throw new Error('A verification step points to unpinned evidence.');
        const observed = new Set<string>();
        for (const dependency of record.dependencies) {
          if (observed.has(dependency.id) || !entry.externalDependencies.some((declared) => declared.id === dependency.id) || !evidencePaths.has(dependency.evidencePath)) throw new Error('Actual dependency is duplicate, undeclared or has no pinned receipt.');
          observed.add(dependency.id);
        }
        if (entry.externalDependencies.some((dependency) => !observed.has(dependency.id))) throw new Error('A required external service was not actually exercised.');
        verifiedHosts.add(record.host);
      } catch (error) { issue('VERIFICATION_INVALID', error instanceof Error ? error.message : 'Invalid verification evidence.', entry.id); }
    }
    for (const host of entry.targetHosts) if (!verifiedHosts.has(host)) issue('HOST_UNVERIFIED', `No valid actual-use record for ${host}.`, entry.id);
    if (entry.state === 'published' && (!entry.review || entry.review.artifactSha256 !== artifact.sha256 || !entry.review.distinctPurposeConfirmed || Date.parse(entry.review.reviewedAt) > (options.now ?? new Date()).valueOf() + 300000)) issue('REVIEW_MISSING', 'Publication requires a current review of this exact artifact and distinct purpose.', entry.id);
    if (before === issues.length && !duplicateIds.has(entry.id)) candidates.push({ entry, artifactFingerprint: fingerprint, hostCount: verifiedHosts.size });
  }
  const fingerprints = new Map<string, string[]>();
  for (const candidate of candidates) { const key = `${candidate.entry.kind}:${candidate.artifactFingerprint}`; fingerprints.set(key, [...(fingerprints.get(key) ?? []), candidate.entry.id]); }
  for (const candidate of candidates) {
    if ((fingerprints.get(`${candidate.entry.kind}:${candidate.artifactFingerprint}`)?.length ?? 0) > 1) { issue('DUPLICATE_CONTENT', 'Content reused under another name does not count as another usable example.', candidate.entry.id); continue; }
    counts[candidate.entry.kind === 'project' ? 'usableProjects' : 'usableResources']++;
    if (candidate.entry.state === 'published') counts[candidate.entry.kind === 'project' ? 'publishedProjects' : 'publishedResources']++;
    if (candidate.entry.kind === 'project') counts.verifiedHostCombinations += candidate.hostCount;
  }
  const releaseGaps: string[] = [];
  if (counts.publishedProjects < 120) releaseGaps.push(`Published, verified projects: ${counts.publishedProjects}/120.`);
  if (counts.publishedResources < 120) releaseGaps.push(`Published, verified resources: ${counts.publishedResources}/120.`);
  if (counts.verifiedHostCombinations < 360) releaseGaps.push(`Actual project-host combinations: ${counts.verifiedHostCombinations}/360.`);
  if (issues.length) releaseGaps.push(`${issues.length} catalogue integrity or verification error(s).`);
  return { valid: !issues.length, releaseReady: !issues.length && !releaseGaps.length, issues, counts, releaseGaps };
}
