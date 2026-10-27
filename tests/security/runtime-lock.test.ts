import { createHash } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, canonicalDigest, inspectPackage } from '@studio/package-kit';

/** Recomputing unsigned inventory hashes cannot make a contradictory runtime requirement valid. */
describe('portable runtime requirements', () => {
  it('pins the workflow and distinguishes requirements from locally verified execution identities', async () => {
    const workflow = createBasicWorkflow(); const built = await buildPackage({ workflow, host: 'codex' });
    const imported = await inspectPackage(built.bytes);
    const lock = JSON.parse(new TextDecoder().decode(imported.files.get('runtime.lock.json')));
    expect(lock).toMatchObject({ kind: 'requirements', workflowSha256: canonicalDigest(workflow), host: { name: 'codex', verification: 'unverified' }, modelVerification: 'unverified' });
    expect(lock.requiredCapabilities).toEqual(built.manifest.requiredCapabilities);
  });
  it.each(['workflowSha256', 'host', 'capabilities', 'runner', 'extra'])('rejects a rewritten %s requirement even after manifest rehash', async field => {
    const built = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' }); const files = unzipSync(built.bytes);
    const lock = JSON.parse(new TextDecoder().decode(files['runtime.lock.json']));
    if (field === 'workflowSha256') lock.workflowSha256 = '0'.repeat(64);
    if (field === 'host') lock.host.name = 'opencode';
    if (field === 'capabilities') lock.requiredCapabilities = [];
    if (field === 'runner') lock.runner.node = '26.5.0';
    if (field === 'extra') lock.installCommand = 'untrusted installer';
    const bytes = strToU8(JSON.stringify(lock)); files['runtime.lock.json'] = bytes;
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    const record = manifest.files.find((item: { path: string }) => item.path === 'runtime.lock.json');
    record.bytes = bytes.length; record.sha256 = createHash('sha256').update(bytes).digest('hex');
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    await expect(inspectPackage(zipSync(files))).rejects.toMatchObject({ code: 'RUNTIME_LOCK_INVALID' });
  });
});
