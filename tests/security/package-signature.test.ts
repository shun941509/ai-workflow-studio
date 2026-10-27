import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { canonicalize } from 'json-canonicalize';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createBasicWorkflow } from '@studio/spec';
import { buildPackage, inspectPackage, readPackageDirectory } from '@studio/package-kit';

/** Actual asymmetric signatures exercise the external trust boundary, including directory imports. */
describe('package provenance', () => {
  it('rejects a hardlinked manifest before consuming the project directory', async () => {
    const original = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' });
    const directory = await mkdtemp(join(tmpdir(), 'studio-hardlink-'));
    const source = join(directory, 'shared-manifest');
    await writeFile(source, unzipSync(original.bytes)['manifest.json']!);
    await link(source, join(directory, 'manifest.json'));
    await expect(readPackageDirectory(directory)).rejects.toMatchObject({ code: 'ARCHIVE_LIMIT' });
  });
  it('accepts only a key trusted independently of the package', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const original = await buildPackage({ workflow: createBasicWorkflow(), host: 'codex' });
    const files = unzipSync(original.bytes);
    const signature = sign(null, Buffer.from('AI-WORKFLOW-STUDIO/PACKAGE/1\n' + canonicalize(original.manifest)), privateKey).toString('base64url');
    files['manifest.sig'] = strToU8(JSON.stringify({ algorithm: 'Ed25519', keyId: 'test-only-key', signature }));
    const signed = zipSync(files);
    const trustStore = { 'test-only-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() };
    await expect(inspectPackage(signed)).rejects.toMatchObject({ code: 'SIGNATURE_UNTRUSTED' });
    expect((await inspectPackage(signed, { trustStore, requireSignature: true })).trust).toBe('verified');

    const directory = await mkdtemp(join(tmpdir(), 'studio-signature-'));
    for (const [path, bytes] of Object.entries(files)) {
      const target = join(directory, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    // The folder reader preserves signatures and must not silently downgrade signed packages.
    await expect(readPackageDirectory(directory)).rejects.toMatchObject({ code: 'SIGNATURE_UNTRUSTED' });
    const read = await readPackageDirectory(directory, { trustStore });
    expect((await inspectPackage(read, { trustStore })).trust).toBe('verified');

    const altered = { ...original.manifest, packageVersion: '0.0.99' };
    files['manifest.json'] = strToU8(JSON.stringify(altered));
    await expect(inspectPackage(zipSync(files), { trustStore })).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });
  });
});
