import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkReleaseGates, releaseEvidenceBytes, RELEASE_CHECKS, type ReleaseEvidence, type ReleaseGate, type ReleaseGateInput } from '../../tooling/release/check-gates.js';

// All signing keys and observations in this file are test-only; no generated proof is saved or shipped.
const pair = generateKeyPairSync('ed25519'); const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
const now = new Date('2026-10-28T00:00:00.000Z');
const bytes = Buffer.from('Internal gate-verifier contract test; not a release report.');
const base: ReleaseGateInput = {
  releaseId: 'candidate_1', subject: { sourceSha256: '1'.repeat(64), runnerSha256: '2'.repeat(64), webSha256: '3'.repeat(64), catalogSha256: '4'.repeat(64) },
  evidence: [], trustedKeys: { test: { publicKey, gates: Object.keys(RELEASE_CHECKS) as ReleaseGate[] } }, reportBytes: new Map([['checks/report.json', bytes]]), now,
  catalog: { valid: true, releaseReady: true, issues: [], counts: { plannedProjects: 0, plannedResources: 0, usableProjects: 120, usableResources: 120, publishedProjects: 120, publishedResources: 120, verifiedHostCombinations: 720 }, releaseGaps: [] },
};
function record(gate: ReleaseGate, patch: Partial<Omit<ReleaseEvidence, 'signature'>> = {}): ReleaseEvidence {
  const unsigned: Omit<ReleaseEvidence, 'signature'> = {
    schemaVersion: '1.0.0', releaseId: base.releaseId, subject: base.subject, gate,
    observedAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-10T00:00:00.000Z', environment: { os: 'test-verifier-contract-only' },
    checks: RELEASE_CHECKS[gate].map(id => ({ id, outcome: 'passed', method: 'actual' })),
    reports: [{ path: 'checks/report.json', sha256: createHash('sha256').update(bytes).digest('hex') }], ...patch,
  };
  return { ...unsigned, signature: { keyId: 'test', value: sign(null, releaseEvidenceBytes(unsigned), pair.privateKey).toString('base64') } };
}
const all = () => (Object.keys(RELEASE_CHECKS) as ReleaseGate[]).map(gate => record(gate));
describe('complete product release gate', () => {
  it('cannot certify a product from catalogue counts alone', () => {
    const result = checkReleaseGates(base); expect(result.valid).toBe(true); expect(result.releaseReady).toBe(false); expect(result.missingGates).toHaveLength(13);
  });
  it('accepts an exact complete set of trusted signed observations in verifier contract tests', () => {
    expect(checkReleaseGates({ ...base, evidence: all() }).releaseReady).toBe(true);
  });
  it('requires catalogue publication even when every engineering gate has evidence', () => {
    expect(checkReleaseGates({ ...base, evidence: all(), catalog: { ...base.catalog, releaseReady: false } }).releaseReady).toBe(false);
  });
  it.each(['model', 'isolation', 'opencode', 'blocks'] as ReleaseGate[])('blocks missing %s observations despite a signature', gate => {
    expect(checkReleaseGates({ ...base, evidence: [record(gate, { checks: [] })] }).issues).toHaveLength(1);
  });
  it('rejects simulated checks, tampered reports and mismatched artifact digests', () => {
    const sample = record('model'); sample.checks[0]!.method = 'test_double';
    expect(checkReleaseGates({ ...base, evidence: [sample] }).valid).toBe(false);
    expect(checkReleaseGates({ ...base, evidence: [record('model')], reportBytes: new Map([['checks/report.json', Buffer.from('changed')]]) }).valid).toBe(false);
    expect(checkReleaseGates({ ...base, evidence: [record('model')], subject: { ...base.subject, runnerSha256: 'f'.repeat(64) } }).valid).toBe(false);
  });
  it('rejects untrusted keys and a verifier authorized for a different gate', () => {
    expect(checkReleaseGates({ ...base, evidence: [record('model')], trustedKeys: {} }).valid).toBe(false);
    expect(checkReleaseGates({ ...base, evidence: [record('model')], trustedKeys: { test: { publicKey, gates: ['account'] } } }).valid).toBe(false);
  });
  it('rejects expired, future and duplicate reports', () => {
    for (const item of [record('model', { expiresAt: now.toISOString() }), record('model', { observedAt: '2026-10-29T00:00:00.000Z' })]) expect(checkReleaseGates({ ...base, evidence: [item] }).valid).toBe(false);
    expect(checkReleaseGates({ ...base, evidence: [record('model'), record('model')] }).valid).toBe(false);
  });
  it('rejects a signed envelope that was mutated after signing', () => {
    const item = record('model'); item.environment = { os: 'changed' };
    expect(checkReleaseGates({ ...base, evidence: [item] }).valid).toBe(false);
  });
});
