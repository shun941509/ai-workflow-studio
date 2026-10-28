import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import { assertJsonData } from '@studio/spec';
import type { CatalogReport } from '../catalog/check.js';

/** Required observations are versioned here; an empty or generic 'passed' report cannot open a release gate. */
export const RELEASE_CHECKS = Object.freeze({
  blocks: ['input', 'form', 'trigger', 'agent', 'ai', 'classify', 'output', 'tool', 'retrieval', 'knowledge', 'resource', 'skill', 'memory', 'compensate', 'transform', 'program', 'candidate_search', 'merge', 'condition', 'guardrail', 'evaluate', 'error', 'review', 'file_input', 'document_extract', 'file_output', 'parallel', 'agent_team', 'orchestrator', 'subworkflow', 'loop', 'all-published-modes', 'cancel-recover'],
  rag: ['keyword-vector', 'agentic-budget', 'hybrid-rerank', 'graph-local-global', 'citation-quality', 'current-acl-tombstones'],
  isolation: ['worker-start', 'filesystem', 'network', 'children', 'cpu-memory-time', 'no-private-registry'],
  account: ['real-auth', 'two-user-db', 'private-storage', 'revision-conflict', 'delete-retention'],
  install: ['clean-windows-no-dev-runtime', 'unicode-space-path', 'restart', 'update-rollback'],
  codex: ['real-host-version', 'inspect-without-execution', 'start-result', 'reconnect-cancel'],
  'claude-code': ['real-host-version', 'inspect-without-execution', 'start-result', 'reconnect-cancel'],
  opencode: ['real-host-version', 'inspect-without-execution', 'start-result', 'reconnect-cancel'],
  model: ['real-text', 'real-structured-output', 'usage-accounting', 'auth-rate-limit', 'unknown-no-replay'],
  packages: ['three-host-archives', 'path-link-bomb', 'original-byte-hashes', 'signature-trust-root', 'no-secret-dev-files'],
  operations: ['review-publish-exact-hash', 'report-revoke', 'db-storage-restore', 'monitor-queue-recovery'],
  signing: ['installer-signature', 'package-signature', 'key-rotation-revocation', 'sbom-vulnerabilities', 'license-notices-complete'],
  usability: ['keyboard-workflow', 'accessible-errors', 'save-recover', 'real-material-consumption'],
} as const);
export type ReleaseGate = keyof typeof RELEASE_CHECKS;
export interface ReleaseSubject { sourceSha256: string; runnerSha256: string; webSha256: string; catalogSha256: string }
export interface ReleaseEvidence {
  schemaVersion: '1.0.0'; releaseId: string; gate: ReleaseGate; subject: ReleaseSubject;
  observedAt: string; expiresAt: string; environment: Record<string, string>;
  checks: { id: string; outcome: 'passed' | 'failed'; method: 'actual' | 'test_double' }[];
  reports: { path: string; sha256: string }[];
  signature: { keyId: string; value: string };
}
export interface ReleaseTrust { publicKey: string; gates: readonly (ReleaseGate | 'catalog')[] }
export interface ReleaseGateInput {
  releaseId: string; subject: ReleaseSubject; evidence: readonly unknown[]; catalog: CatalogReport;
  trustedKeys: Readonly<Record<string, ReleaseTrust>>; reportBytes: ReadonlyMap<string, Uint8Array>; now?: Date;
}
const PREFIX = 'AI-WORKFLOW-STUDIO/RELEASE-EVIDENCE/1\n';
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));

/** Signature bytes exclude only the signature envelope; every observation and subject hash remains bound. */
export function releaseEvidenceBytes(record: Omit<ReleaseEvidence, 'signature'>): Uint8Array {
  return new TextEncoder().encode(PREFIX + canonicalize(record));
}

/** Validate signed evidence against operator-supplied trust, exact release bytes and complete real observations. */
export function checkReleaseGates(input: ReleaseGateInput) {
  const issues: { code: string; gate?: string; message: string }[] = [];
  const accepted = new Set<ReleaseGate>(); const seen = new Set<string>();
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || !input.releaseId || !object(input.subject) || !exact(input.subject as unknown as Record<string, unknown>, ['sourceSha256', 'runnerSha256', 'webSha256', 'catalogSha256']) || Object.values(input.subject).some(value => !hash(value))) throw new Error('A complete pinned release subject is required.');
  for (const raw of input.evidence) {
    let gate: string | undefined;
    try {
      assertJsonData(raw);
      if (!object(raw) || !exact(raw, ['schemaVersion', 'releaseId', 'gate', 'subject', 'observedAt', 'expiresAt', 'environment', 'checks', 'reports', 'signature'])) throw new Error('Unexpected evidence structure.');
      gate = typeof raw.gate === 'string' ? raw.gate : undefined;
      if (!gate || !Object.hasOwn(RELEASE_CHECKS, gate) || seen.has(gate)) throw new Error('Unknown or duplicate release gate.');
      seen.add(gate);
      if (raw.schemaVersion !== '1.0.0' || raw.releaseId !== input.releaseId || canonicalize(raw.subject) !== canonicalize(input.subject)) throw new Error('Evidence belongs to different release bytes.');
      const observed = typeof raw.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.observedAt) ? Date.parse(raw.observedAt) : NaN;
      const expires = typeof raw.expiresAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.expiresAt) ? Date.parse(raw.expiresAt) : NaN;
      if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now || expires <= now || expires <= observed || now - observed > 30 * 86400000 || expires - observed > 30 * 86400000) throw new Error('Evidence is stale, future-dated or has an invalid lifetime.');
      if (!object(raw.environment) || !Object.keys(raw.environment).length || Object.keys(raw.environment).length > 32 || Object.values(raw.environment).some(value => typeof value !== 'string' || !value || value.length > 300)) throw new Error('Actual environment versions are required.');
      if (!Array.isArray(raw.checks) || raw.checks.length > 128) throw new Error('Missing bounded observations.');
      const checks = new Set<string>();
      for (const item of raw.checks) {
        if (!object(item) || !exact(item, ['id', 'outcome', 'method']) || typeof item.id !== 'string' || checks.has(item.id) || item.outcome !== 'passed' || item.method !== 'actual') throw new Error('Failed, duplicate or simulated observations cannot certify a release.');
        checks.add(item.id);
      }
      if (RELEASE_CHECKS[gate as ReleaseGate].some(required => !checks.has(required))) throw new Error('Required real observations are missing.');
      if (!Array.isArray(raw.reports) || !raw.reports.length || raw.reports.length > 100) throw new Error('Pinned verification reports are required.');
      const paths = new Set<string>();
      for (const report of raw.reports) {
        if (!object(report) || !exact(report, ['path', 'sha256']) || !safePath(report.path) || !hash(report.sha256) || paths.has(report.path)) throw new Error('Invalid report inventory.');
        paths.add(report.path); const bytes = input.reportBytes.get(report.path);
        if (!bytes?.length || bytes.length > 16 * 1024 * 1024 || digest(bytes) !== report.sha256) throw new Error('Verification report is absent or changed.');
      }
      if (!object(raw.signature) || !exact(raw.signature, ['keyId', 'value']) || typeof raw.signature.keyId !== 'string' || typeof raw.signature.value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(raw.signature.value)) throw new Error('An Ed25519 signature is required.');
      const trust = Object.hasOwn(input.trustedKeys, raw.signature.keyId) ? input.trustedKeys[raw.signature.keyId] : undefined;
      if (!trust || !trust.gates.includes(gate as ReleaseGate)) throw new Error('Verifier key is not authorized for this gate.');
      const key = createPublicKey(trust.publicKey); const { signature: _signature, ...unsigned } = raw;
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, releaseEvidenceBytes(unsigned as unknown as Omit<ReleaseEvidence, 'signature'>), key, Buffer.from(raw.signature.value, 'base64'))) throw new Error('Release signature verification failed.');
      accepted.add(gate as ReleaseGate);
    } catch (error) { issues.push({ code: 'RELEASE_EVIDENCE_INVALID', ...(gate ? { gate } : {}), message: error instanceof Error ? error.message : 'Invalid release evidence.' }); }
  }
  const missing = (Object.keys(RELEASE_CHECKS) as ReleaseGate[]).filter(gate => !accepted.has(gate));
  return {
    valid: input.catalog.valid && issues.length === 0,
    releaseReady: input.catalog.valid && input.catalog.releaseReady && issues.length === 0 && missing.length === 0,
    acceptedGates: [...accepted].sort(), missingGates: missing,
    catalog: { releaseReady: input.catalog.releaseReady, counts: input.catalog.counts, gaps: input.catalog.releaseGaps }, issues,
  };
}
