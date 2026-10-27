import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WindowsCredentialStore, windowsPowerShellPath } from '../../apps/runner/src/security/credential-store.js';

/** Uses a predictable, non-production secret to exercise the actual OS API when running on Windows. */
describe('Windows credential boundary', () => {
  it('roundtrips DPAPI ciphertext without writing plaintext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-runner-credential-test-'));
    try {
      const store = new WindowsCredentialStore(directory);
      if (process.platform !== 'win32') { expect(store.available).toBe(false); await expect(store.set('example', 'test-only-credential')).rejects.toMatchObject({ code: 'SECURE_STORE_UNAVAILABLE' }); return; }
      await store.set('example', 'test-only-credential');
      expect(await store.has('example')).toBe(true);
      expect((await readFile(join(directory, 'example.dpapi'))).includes(Buffer.from('test-only-credential'))).toBe(false);
      expect(await store.get('example')).toBe('test-only-credential');
      expect(await windowsPowerShellPath()).toMatch(/^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
      await expect(store.get('../escape')).rejects.toMatchObject({ code: 'CREDENTIAL_REQUIRED' });
      await store.delete('example'); expect(await store.has('example')).toBe(false);
    } finally {
      const absolute = resolve(directory);
      if (dirname(absolute) !== resolve(tmpdir()) || !absolute.includes('studio-runner-credential-test-')) throw new Error('unsafe cleanup');
      await rm(absolute, { recursive: true, force: true });
    }
  });

  it('rejects relative or network system roots without searching PATH', async () => {
    for (const root of ['.', 'C:Windows', '\\\\server\\Windows', 'C:\\Windows\u0000']) await expect(windowsPowerShellPath(root)).rejects.toMatchObject({ code: 'SECURE_STORE_UNAVAILABLE' });
  });

  it('rejects oversized or malformed ciphertext before requesting decryption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'studio-runner-credential-test-'));
    try {
      const store = new WindowsCredentialStore(directory); const path = join(directory, 'example.dpapi');
      for (const bytes of [Buffer.alloc(131073), Buffer.alloc(64), Buffer.from('not-a-dpapi-value')]) {
        await writeFile(path, bytes); await expect(store.get('example')).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' }); expect(await store.has('example')).toBe(false);
      }
      await expect(store.set('example', '가'.repeat(30000))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' });
    } finally {
      const absolute = resolve(directory); if (dirname(absolute) !== resolve(tmpdir()) || !absolute.includes('studio-runner-credential-test-')) throw new Error('unsafe cleanup'); await rm(absolute, { recursive: true, force: true });
    }
  });
});
