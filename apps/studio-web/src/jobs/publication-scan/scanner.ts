import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { assertJsonData, parseStrictJson, type ResourceRef } from '@studio/spec';
import { canonicalDigest, createTextResource, inspectPackage, PackageError, verifyResources } from '@studio/package-kit';
import { verifyRightsEvidence, rightsKeyFingerprint, type RightsTrust, type RightsEvidence } from './rights';

export const MAX_CANDIDATE_BYTES = 32 * 1024 * 1024;
export interface ScanPolicy { id: string; version: string; supportedCapabilities: readonly string[] }
export const CHECK_NAMES = ['archive', 'source', 'files', 'secrets', 'capabilities', 'dependencies', 'rights', 'staticRisks'] as const;
export type ScanCheck = typeof CHECK_NAMES[number];
export type CheckStatus = 'passed' | 'failed' | 'unverified';
export interface ScanFinding { check: ScanCheck; code: string; status: Exclude<CheckStatus, 'passed'>; path?: string }
export interface ScanReport {
  schemaVersion: '1.0.0'; scannerVersion: '1.0.0'; policy: { id: string; version: string; sha256: string };
  artifactSha256: string; artifactBytes: number; manifestSha256: string | null; sourceSnapshotSha256: string;
  observedAt: string; rightsEvidence: RightsEvidence | null; rightsKeySha256: string | null; checks: Record<ScanCheck, CheckStatus>; findings: ScanFinding[];
  status: 'passed' | 'blocked' | 'needs_evidence'; reportSha256: string; releaseAuthorized: false;
}
export interface ScanInput { bytes: Uint8Array; source: { kind: 'project' | 'resource'; snapshot: unknown }; policy: ScanPolicy; rightsEvidence?: unknown; rightsTrust?: Readonly<Record<string, RightsTrust>>; packageTrust?: Readonly<Record<string, string>>; now?: Date }
export const digestBytes = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const SECRET_PATTERNS = [ /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bAKIA[A-Z0-9]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{16,}/, /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/, /(?:password|api[_-]?key|access[_-]?token|authorization)\s*["']?\s*[=:]\s*["']?(?:Bearer\s+)?[A-Za-z0-9_./+=-]{16,}/i ];
const RISK_PATTERNS = [ /<\s*(?:script|iframe|object|embed)\b/i, /javascript\s*:/i, /\b(?:curl|wget)\b[^\r\n]{0,500}\|\s*(?:sh|bash|powershell)\b/i, /\bpowershell(?:\.exe)?\b[^\r\n]{0,200}-(?:enc|encodedcommand)\b/i, /\b(?:eval|exec)\s*\(/, /ignore (?:all )?(?:previous|system) instructions/i ];
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.yaml', '.yml', '.toml']);
const EXECUTABLE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.ps1', '.sh', '.bat', '.cmd', '.exe', '.dll', '.wasm', '.html', '.htm', '.svg']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Rule identities and configured capability inventory belong to the policy hash, including retries of a stored report. */
export function scanPolicyDigest(policy: ScanPolicy): string { return canonicalDigest({ ...policy, scannerVersion: '1.0.0', maxCandidateBytes: MAX_CANDIDATE_BYTES, maxTextBytes: 1024 * 1024, maxFiles: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, secretRules: SECRET_PATTERNS.map(String), riskRules: RISK_PATTERNS.map(String), allowedTextExtensions: [...TEXT_EXTENSIONS], executableExtensions: [...EXECUTABLE_EXTENSIONS] }); }

/** Validate source identity from actual snapshot values; a caller-provided digest cannot substitute another package. */
function sourceMatches(source: ScanInput['source'], inspected: Awaited<ReturnType<typeof inspectPackage>>): boolean {
  const snapshot = source.snapshot; if (!object(snapshot)) return false;
  if (source.kind === 'project') return inspected.manifest.packageKind === 'workflow' && object(snapshot.workflow) && canonicalDigest(snapshot.workflow) === snapshot.sha256 && canonicalDigest(inspected.workflow) === snapshot.sha256 && (!inspected.files.has('editor.json') || canonicalDigest(parseStrictJson(new TextDecoder().decode(inspected.files.get('editor.json')!))) === canonicalDigest(snapshot.editor));
  if (source.kind !== 'resource' || inspected.manifest.packageKind !== 'materials' || !object(snapshot.version)) return false;
  const version = snapshot.version; if (typeof version.resource_id !== 'string' || !Number.isSafeInteger(version.revision) || Number(version.revision) < 1 || !object(version.content) || canonicalDigest(version.content) !== version.sha256) return false;
  const content = version.content;
  // Current private authoring stores text revisions. Other binary/code source formats need their own immutable materializer.
  if (content.format !== 'text' || content.kind !== 'instruction' && content.kind !== 'document' || typeof content.name !== 'string' || typeof content.text !== 'string') return false;
  const material = createTextResource({ id: version.resource_id, revision: Number(version.revision), name: content.name, kind: content.kind, text: content.text });
  const refs = inspected.manifest.resources; return Object.keys(refs).length === 1 && canonicalDigest(refs[version.resource_id]) === canonicalDigest(material.reference);
}

/** Inspect bounded bytes only: no extraction, module imports, subprocesses, network requests or untrusted-code execution. */
export async function scanPublication(input: ScanInput): Promise<ScanReport> {
  if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > MAX_CANDIDATE_BYTES) throw new Error('CANDIDATE_SIZE_INVALID');
  assertJsonData(input.source); assertJsonData(input.policy);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(input.policy.id) || !/^\d+\.\d+\.\d+$/.test(input.policy.version) || input.policy.supportedCapabilities.length > 200 || input.policy.supportedCapabilities.some((value) => !/^[a-z][a-z0-9_.]*@\d+$/.test(value)) || new Set(input.policy.supportedCapabilities).size !== input.policy.supportedCapabilities.length || Buffer.byteLength(JSON.stringify(input.source)) > 4 * 1024 * 1024) throw new Error('SCAN_INPUT_INVALID');
  // Own the bounded inputs before the first await; caller mutation cannot separate a digest from the inspected snapshot.
  input = { ...input, bytes: Uint8Array.from(input.bytes), source: structuredClone(input.source), policy: structuredClone(input.policy), rightsEvidence: structuredClone(input.rightsEvidence), rightsTrust: structuredClone(input.rightsTrust), packageTrust: structuredClone(input.packageTrust) };
  const observed = input.now ?? new Date(); if (!Number.isFinite(observed.getTime())) throw new Error('SCAN_TIME_INVALID');
  const body = { schemaVersion: '1.0.0' as const, scannerVersion: '1.0.0' as const, policy: { id: input.policy.id, version: input.policy.version, sha256: scanPolicyDigest(input.policy) }, artifactSha256: digestBytes(input.bytes), artifactBytes: input.bytes.length, manifestSha256: null as string | null, sourceSnapshotSha256: canonicalDigest(input.source.snapshot), observedAt: observed.toISOString(), rightsEvidence: null as RightsEvidence | null, rightsKeySha256: null as string | null, checks: Object.fromEntries(CHECK_NAMES.map((check) => [check, 'unverified'])) as Record<ScanCheck, CheckStatus>, findings: [] as ScanFinding[], status: 'needs_evidence' as ScanReport['status'], releaseAuthorized: false as const };
  const finding = (check: ScanCheck, code: string, status: 'failed' | 'unverified', path?: string) => { if (body.checks[check] !== 'failed') body.checks[check] = status; body.findings.push({ check, code, status, ...(path ? { path: SECRET_PATTERNS.some((pattern) => pattern.test(path)) ? '[redacted-path]' : path } : {}) }); };
  let inspected: Awaited<ReturnType<typeof inspectPackage>> | undefined;
  try { inspected = await inspectPackage(input.bytes, { limits: { maxFiles: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxManifestBytes: 1024 * 1024 }, trustStore: input.packageTrust }); body.checks.archive = 'passed'; body.manifestSha256 = digestBytes(inspected.files.get('manifest.json')!); }
  catch (error) { finding('archive', error instanceof PackageError ? error.code : 'PACKAGE_INSPECTION_FAILED', 'failed'); if (error instanceof PackageError && error.code === 'SECRET_DETECTED') finding('secrets', 'SECRET_PATTERN', 'failed'); }
  if (inspected) {
    try { body.checks.source = sourceMatches(input.source, inspected) ? 'passed' : 'failed'; if (body.checks.source === 'failed') finding('source', 'SOURCE_SNAPSHOT_MISMATCH_OR_UNSUPPORTED', 'failed'); } catch { finding('source', 'SOURCE_SNAPSHOT_INVALID', 'failed'); }
    body.checks.files = 'passed'; body.checks.secrets = 'passed'; body.checks.staticRisks = 'passed';
    for (const [path, bytes] of inspected.files) {
      if (path === 'manifest.sig') continue;
      const extension = extname(path).toLowerCase();
      if (EXECUTABLE_EXTENSIONS.has(extension)) { finding('files', 'EXECUTABLE_CONTENT_UNVERIFIED', 'unverified', path); finding('staticRisks', 'EXECUTION_ISOLATION_REQUIRED', 'unverified', path); }
      else if (!TEXT_EXTENSIONS.has(extension)) finding('files', 'FILE_TYPE_UNSUPPORTED', 'unverified', path);
      if (bytes.length > 1024 * 1024) { finding('files', 'TEXT_SCAN_LIMIT', 'unverified', path); finding('secrets', 'FILE_NOT_FULLY_SCANNED', 'unverified', path); finding('staticRisks', 'FILE_NOT_FULLY_SCANNED', 'unverified', path); continue; }
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); if (text.includes('\u0000')) throw new Error('binary'); } catch { finding('files', 'BINARY_CONTENT_UNVERIFIED', 'unverified', path); finding('secrets', 'FILE_NOT_FULLY_SCANNED', 'unverified', path); finding('staticRisks', 'FILE_NOT_FULLY_SCANNED', 'unverified', path); continue; }
      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) finding('secrets', 'SECRET_PATTERN', 'failed', path);
      if (RISK_PATTERNS.some((pattern) => pattern.test(text))) finding('staticRisks', 'STATIC_RISK_REVIEW_REQUIRED', 'unverified', path);
    }
    body.checks.capabilities = 'passed'; for (const capability of inspected.manifest.requiredCapabilities) if (!input.policy.supportedCapabilities.includes(capability)) finding('capabilities', 'CAPABILITY_UNAVAILABLE', 'unverified');
    body.checks.dependencies = 'passed'; const resources = verifyResources(inspected.manifest.resources as Record<string, ResourceRef>, inspected.files);
    if (inspected.manifest.requiredConnections.length || inspected.manifest.indexes.length) finding('dependencies', 'EXTERNAL_DEPENDENCY_UNVERIFIED', 'unverified');
    for (const [alias, resource] of resources) if (resource.kind === 'mcp') finding('dependencies', 'MCP_RUNTIME_UNVERIFIED', 'unverified', `resources/${alias}/resource.json`);
    body.checks.rights = verifyRightsEvidence(input.rightsEvidence, body.artifactSha256, body.sourceSnapshotSha256, input.rightsTrust ?? {}, observed) ? 'passed' : 'unverified';
    if (body.checks.rights === 'passed') { body.rightsEvidence = structuredClone(input.rightsEvidence as RightsEvidence); body.rightsKeySha256 = rightsKeyFingerprint(input.rightsTrust![body.rightsEvidence.signature.keyId]!); }
    if (body.checks.rights !== 'passed') finding('rights', 'REDISTRIBUTION_EVIDENCE_REQUIRED', 'unverified');
    for (const [alias, resource] of resources) if (resource.license.id === 'LicenseRef-Proprietary') finding('rights', 'INCLUDED_LICENSE_RESTRICTS_REDISTRIBUTION', 'failed', `resources/${alias}/${resource.license.path}`);
  }
  body.status = Object.values(body.checks).every((value) => value === 'passed') ? 'passed' : Object.values(body.checks).some((value) => value === 'failed') ? 'blocked' : 'needs_evidence';
  return { ...body, reportSha256: canonicalDigest(body) };
}
