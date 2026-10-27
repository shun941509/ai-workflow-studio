import { spawn } from 'node:child_process';
import { mkdir, rename, unlink, open, lstat, realpath } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunnerError } from '../errors.js';

/** Secrets are referenced by opaque IDs; callers never persist their plaintext. */
export interface CredentialStore {
  readonly available: boolean;
  set(id: string, secret: string): Promise<void>;
  get(id: string): Promise<string>;
  has(id: string): Promise<boolean>;
  delete(id: string): Promise<void>;
}

const MAX_SECRET_BYTES = 65536;
const MAX_CIPHERTEXT_BYTES = 131072;
const DPAPI_HEADER = Buffer.from('01000000d08c9ddf0115d1118c7a00c04fc297eb', 'hex');
const validCiphertext = (value: Uint8Array) => value.byteLength >= 64 && value.byteLength <= MAX_CIPHERTEXT_BYTES && Buffer.from(value.subarray(0, DPAPI_HEADER.length)).equals(DPAPI_HEADER);

/** Resolve a rooted OS helper instead of searching PATH or the imported package's current directory. */
export async function windowsPowerShellPath(windowsRoot = process.env.SystemRoot ?? process.env.WINDIR): Promise<string> {
  if (process.platform !== 'win32' || !windowsRoot || !/^[A-Za-z]:[\\/]/.test(windowsRoot) || /[\u0000-\u001f]/.test(windowsRoot)) throw new RunnerError('SECURE_STORE_UNAVAILABLE', 'Windows 시스템 경로를 확인할 수 없습니다.');
  const root = win32.resolve(windowsRoot); const helper = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const rootInfo = await lstat(root); const helperInfo = await lstat(helper);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !helperInfo.isFile() || helperInfo.isSymbolicLink() || (await realpath(root)).toLowerCase() !== root.toLowerCase() || (await realpath(helper)).toLowerCase() !== helper.toLowerCase()) throw new Error('invalid system helper');
  } catch { throw new RunnerError('SECURE_STORE_UNAVAILABLE', 'Windows 시스템 PowerShell을 확인할 수 없습니다.'); }
  return helper;
}

/** Read a fixed-size ciphertext buffer from one ordinary file handle before calling the OS decryptor. */
async function readCiphertext(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 64 || info.size > MAX_CIPHERTEXT_BYTES) throw new RunnerError('CREDENTIAL_INVALID', '저장된 인증정보 형식이 올바르지 않습니다. 다시 설정하세요.');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat(); if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== info.ino || opened.dev !== info.dev || opened.size !== info.size) throw new Error('ciphertext file changed');
    const buffer = Buffer.alloc(MAX_CIPHERTEXT_BYTES + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const value = buffer.subarray(0, bytesRead);
    if (bytesRead !== opened.size || !validCiphertext(value)) throw new Error('invalid ciphertext'); return value;
  } catch { throw new RunnerError('CREDENTIAL_INVALID', '저장된 인증정보 형식이 올바르지 않습니다. 다시 설정하세요.'); }
  finally { await handle.close(); }
}

// The script is constant. Secret bytes travel through stdin, never process arguments.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$request = [Console]::In.ReadToEnd() | ConvertFrom-Json',
  '$bytes = [Convert]::FromBase64String($request.value)',
  "$entropy = [Text.Encoding]::UTF8.GetBytes('AI-Workflow-Studio/credentials/v1')",
  "if ($request.operation -eq 'protect') {",
  '  $result = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '} else {',
  '  $result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '}',
  '[Console]::Out.Write([Convert]::ToBase64String($result))',
].join('\n');

/** Windows DPAPI binds encrypted bytes to the current OS account. No plaintext fallback. */
export async function dpapi(operation: 'protect' | 'unprotect', value: Uint8Array): Promise<Buffer> {
  if (process.platform !== 'win32') throw new RunnerError('SECURE_STORE_UNAVAILABLE', 'Windows 보안 저장소가 필요합니다.');
  if (operation === 'protect' ? !value.byteLength || value.byteLength > MAX_SECRET_BYTES : !validCiphertext(value)) throw new RunnerError('INVALID_CREDENTIAL', '인증정보 크기 또는 암호문 형식이 올바르지 않습니다.');
  const helper = await windowsPowerShellPath();
  return new Promise((resolve, reject) => {
    const child = spawn(helper, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
      cwd: win32.dirname(helper), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let tooLarge = false;
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 262144) { tooLarge = true; child.kill(); }
    });
    // PowerShell errors are consumed without exposing request data in logs.
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new RunnerError('SECURE_STORE_FAILED', '보안 저장소를 사용할 수 없습니다.')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const encoded = output.trim(); const decoded = Buffer.from(encoded, 'base64');
      if (code !== 0 || tooLarge || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || decoded.toString('base64') !== encoded || (operation === 'protect' ? !validCiphertext(decoded) : !decoded.length || decoded.length > MAX_SECRET_BYTES)) {
        reject(new RunnerError('SECURE_STORE_FAILED', '보안 저장소 암호화 또는 복호화에 실패했습니다.'));
      } else resolve(decoded);
    });
    child.stdin.on('error', () => { /* A failed child is handled by its close/error event. */ });
    child.stdin.end(JSON.stringify({ operation, value: Buffer.from(value).toString('base64') }));
  });
}

/** DPAPI files contain ciphertext only and are atomically replaced inside the private data directory. */
export class WindowsCredentialStore implements CredentialStore {
  readonly available = process.platform === 'win32';
  constructor(private readonly directory: string) {}

  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new RunnerError('INVALID_CREDENTIAL_REF', '인증정보 참조가 올바르지 않습니다.');
    return join(this.directory, `${id}.dpapi`);
  }

  async set(id: string, secret: string): Promise<void> {
    if (!secret || Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new RunnerError('INVALID_CREDENTIAL', '인증정보 값이 올바르지 않습니다.');
    const path = this.path(id);
    const encrypted = await dpapi('protect', Buffer.from(secret, 'utf8'));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' }));
    try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  }

  async get(id: string): Promise<string> {
    let encrypted: Buffer;
    try { encrypted = await readCiphertext(this.path(id)); }
    catch (error) { if (error instanceof RunnerError && error.code === 'CREDENTIAL_INVALID') throw error; throw new RunnerError('CREDENTIAL_REQUIRED', '모델 인증정보를 설정하세요.'); }
    const plaintext = await dpapi('unprotect', encrypted);
    try { return plaintext.toString('utf8'); } finally { plaintext.fill(0); }
  }

  async has(id: string): Promise<boolean> {
    if (!this.available) return false;
    try { await readCiphertext(this.path(id)); return true; } catch { return false; }
  }

  async delete(id: string): Promise<void> {
    await unlink(this.path(id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
