// Prepare an immutable official Wasmtime ZIP for an internal Windows LPAC experiment.
// This does not install a Worker, alter PATH, or grant any production capability.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

export const WASMTIME = Object.freeze({
  version: '50.0.0', architecture: 'x86_64-windows',
  url: 'https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.0/wasmtime-v50.0.0-x86_64-windows.zip',
  sha256: 'cea9ccc700aaccb2b5507e96ac990ba60104bd7ab39284fb2e67cb64d58efcc4',
  digestSource: 'https://api.github.com/repos/bytecodealliance/wasmtime/releases/tags/v50.0.0',
});
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.tools', 'wasmtime');
export const wasmtimeRuntimeDirectory = path.join(base, `wasmtime-v${WASMTIME.version}-${WASMTIME.architecture}`);
const archive = `${wasmtimeRuntimeDirectory}.zip`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
export const WASMTIME_ARCHIVE_LIMIT = 32 * 1024 * 1024;

/** Every mutation stays in an ordinary workspace descendant; existing linked paths are refused. */
export async function ordinaryAncestors(target) {
  check(path.isAbsolute(target), 'Wasmtime path must be absolute');
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    try { check(!(await fs.lstat(cursor)).isSymbolicLink(), 'Linked Wasmtime path is forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(cursor) === cursor) break;
  }
}

/** Bound allocations before hashing. The extra byte detects a file that grows after its initial stat. */
export async function readBoundedHandle(handle, maximum, expectedBytes) {
  check(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 128 * 1024 * 1024, 'Invalid file byte limit');
  const before = await handle.stat();
  check(before.isFile() && before.nlink === 1 && before.size <= maximum && (expectedBytes === undefined || before.size === expectedBytes), 'File size or identity is outside its bounded contract');
  const chunks = []; let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maximum - total + 1));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (!bytesRead) break;
    total += bytesRead; check(total <= maximum, 'File grew beyond its byte limit'); chunks.push(chunk.subarray(0, bytesRead));
  }
  const after = await handle.stat();
  check(after.isFile() && after.nlink === 1 && after.dev === before.dev && after.ino === before.ino && after.size === total && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && (expectedBytes === undefined || total === expectedBytes), 'File changed while reading');
  return Buffer.concat(chunks, total);
}

/** The pathname must still name the same ordinary file after the bounded FileHandle read. */
export async function readBoundedOrdinaryFile(filename, maximum, expectedBytes) {
  await ordinaryAncestors(filename);
  const before = await fs.lstat(filename);
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum && (expectedBytes === undefined || before.size === expectedBytes), 'File must be ordinary and within its byte limit');
  const handle = await fs.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat(); check(opened.dev === before.dev && opened.ino === before.ino, 'File identity changed before open');
    const bytes = await readBoundedHandle(handle, maximum, expectedBytes);
    await ordinaryAncestors(filename); const after = await fs.lstat(filename);
    check(after.isFile() && !after.isSymbolicLink() && after.nlink === 1 && after.dev === opened.dev && after.ino === opened.ino && after.size === bytes.length, 'File identity changed after read');
    return bytes;
  } finally { await handle.close(); }
}

/** Inventory comes from the exact pinned archive, never from a mutable extracted directory. */
export async function wasmtimeRuntimeInventory() {
  const files = unpack(await readBoundedOrdinaryFile(archive, WASMTIME_ARCHIVE_LIMIT));
  return Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha(bytes) }]));
}

/** Decompression follows the separately pinned official asset digest; only its flat inventory is retained. */
function unpack(bytes) {
  check(sha(bytes) === WASMTIME.sha256, 'Official Wasmtime archive hash mismatch');
  const entries = unzipSync(bytes); const files = {}; const prefix = path.basename(wasmtimeRuntimeDirectory) + '/'; let total = 0;
  for (const [name, data] of Object.entries(entries)) {
    check(name.startsWith(prefix), 'Unexpected Wasmtime archive root');
    const relative = name.slice(prefix.length); if (!relative && !data.length) continue;
    check(/^[A-Za-z0-9_.-]+$/.test(relative) && !relative.includes('..'), 'Unexpected Wasmtime archive member');
    total += data.length; check(total <= 128 * 1024 * 1024, 'Wasmtime extraction is too large');
    files[relative] = data;
  }
  check(Object.keys(files).length <= 50 && files['wasmtime.exe']?.length && files.LICENSE?.length, 'Incomplete Wasmtime runtime');
  return files;
}

/** Reuse requires byte equality for every ordinary file, including original license notices. */
export async function verifyWasmtimeRuntime() {
  await ordinaryAncestors(wasmtimeRuntimeDirectory);
  const files = unpack(await readBoundedOrdinaryFile(archive, WASMTIME_ARCHIVE_LIMIT)); const names = await fs.readdir(wasmtimeRuntimeDirectory);
  check(names.sort().join('\n') === Object.keys(files).sort().join('\n'), 'Wasmtime inventory changed');
  for (const [name, bytes] of Object.entries(files)) {
    const filename = path.join(wasmtimeRuntimeDirectory, name);
    check(sha(await readBoundedOrdinaryFile(filename, bytes.length, bytes.length)) === sha(bytes), 'Wasmtime member changed');
  }
  return { ...WASMTIME, directory: wasmtimeRuntimeDirectory, files: Object.keys(files).length, executableSha256: sha(files['wasmtime.exe']), licenseSha256: sha(files.LICENSE) };
}

/** Download only when explicitly invoked. The exact asset hash is checked before any extraction or execution. */
export async function prepareWasmtimeRuntime() {
  check(process.platform === 'win32' && process.arch === 'x64', 'Wasmtime experiment requires Windows x64');
  await ordinaryAncestors(wasmtimeRuntimeDirectory); await fs.mkdir(base, { recursive: true }); let bytes;
  try { bytes = await readBoundedOrdinaryFile(archive, WASMTIME_ARCHIVE_LIMIT); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // GitHub release downloads redirect to its release-assets host. The immutable digest is the trust boundary.
    const response = await fetch(WASMTIME.url, { signal: AbortSignal.timeout(60_000) });
    check(response.ok && response.body, `Wasmtime download failed (${response.status})`); const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; check(length <= WASMTIME_ARCHIVE_LIMIT, 'Wasmtime download exceeds its limit'); chunks.push(Buffer.from(chunk)); }
    bytes = Buffer.concat(chunks); check(sha(bytes) === WASMTIME.sha256, 'Downloaded Wasmtime hash mismatch');
    await fs.writeFile(archive, bytes, { flag: 'wx' });
  }
  const files = unpack(bytes); let created = false;
  try { await fs.mkdir(wasmtimeRuntimeDirectory); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(wasmtimeRuntimeDirectory, name), data, { flag: 'wx' });
  return verifyWasmtimeRuntime();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareWasmtimeRuntime(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
