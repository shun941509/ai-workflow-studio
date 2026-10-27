import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, inspectPackage, canonicalDigest, type TargetHost } from '@studio/package-kit';

/** Test real archive bytes; mutation checks cannot be replaced by mocking the importer. */
describe('operational ZIP roundtrip', () => {
  it.each<TargetHost>(['codex', 'claude-code', 'opencode'])('exports and verifies %s without claiming live certification', async host => {
    const result = await buildPackage({ workflow: createBasicWorkflow(), host });
    const inspected = await inspectPackage(result.bytes);
    expect(inspected.workflow?.nodes.map(n => n.type)).toEqual(['input', 'ai', 'output']);
    expect(inspected.manifest.targetHost).toBe(host);
    expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
    expect(inspected.trust).toBe('unsigned');
    expect([...inspected.files.keys()].some(p => p.endsWith('SKILL.md'))).toBe(true);
  });
  it('rejects a modified file and an extra file', async () => {
    const original = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' });
    const changed = unzipSync(original.bytes); changed['README.ko.md'] = strToU8('modified');
    await expect(inspectPackage(zipSync(changed))).rejects.toMatchObject({ code: 'FILE_INTEGRITY' });
    const extra = unzipSync(original.bytes); extra['unlisted.txt'] = strToU8('extra');
    await expect(inspectPackage(zipSync(extra))).rejects.toMatchObject({ code: 'UNLISTED_FILE' });
  });
  it('rejects unsigned packages when the caller requires official provenance', async () => {
    const original = await buildPackage({ workflow: createBasicWorkflow(), host: 'claude-code' });
    await expect(inspectPackage(original.bytes, { requireSignature: true })).rejects.toMatchObject({ code: 'SIGNATURE_REQUIRED' });
  });
  it('canonicalizes property order without changing values', () => { expect(canonicalDigest({ b: 2, a: 1 })).toBe(canonicalDigest({ a: 1, b: 2 })); expect(canonicalDigest({ a: 1 })).not.toBe(canonicalDigest({ a: '1' })); });
});
