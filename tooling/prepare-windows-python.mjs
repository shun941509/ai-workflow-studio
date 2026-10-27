// Prepare an exact official embedded runtime inside this workspace; never run an installer or pip.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

export const PYTHON_EMBED = Object.freeze({
  version: '3.14.10', architecture: 'amd64',
  url: 'https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip',
  sha256: '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159',
  release: 'https://www.python.org/downloads/release/python-31410/',
  license: 'PSF-2.0 and included component licenses; preserve the complete LICENSE.txt',
});
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.tools', 'python');
export const pythonRuntimeDirectory = path.join(base, `python-${PYTHON_EMBED.version}-embed-${PYTHON_EMBED.architecture}`);
const archive = path.join(base, `python-${PYTHON_EMBED.version}-embed-${PYTHON_EMBED.architecture}.zip`);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };

/** Refuse linked ancestors so a local path cannot redirect preparation outside the workspace. */
async function checkAncestors(target) {
  for (let current = target; ; current = path.dirname(current)) {
    try { check(!(await fs.lstat(current)).isSymbolicLink(), 'Linked Python staging ancestor is forbidden'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}

/** Existing extraction is reusable only if every file is an ordinary, byte-identical archive member. */
export async function verifyPythonRuntime() {
  await checkAncestors(pythonRuntimeDirectory);
  const archiveStat = await fs.lstat(archive);
  check(archiveStat.isFile() && !archiveStat.isSymbolicLink() && archiveStat.nlink === 1, 'Python archive must be an ordinary file');
  const bytes = await fs.readFile(archive);
  check(hash(bytes) === PYTHON_EMBED.sha256, 'Official Python archive hash mismatch');
  const files = unpack(bytes);
  const entries = await fs.readdir(pythonRuntimeDirectory);
  check(entries.sort().join('\n') === Object.keys(files).sort().join('\n'), 'Embedded runtime file inventory changed');
  for (const [name, original] of Object.entries(files)) {
    const filename = path.join(pythonRuntimeDirectory, name);
    const stat = await fs.lstat(filename);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'Runtime must contain ordinary non-linked files');
    check(hash(await fs.readFile(filename)) === hash(original), `Embedded runtime file changed: ${name}`);
  }
  return { ...PYTHON_EMBED, directory: pythonRuntimeDirectory, files: Object.keys(files).length, licenseSha256: hash(files['LICENSE.txt']) };
}

/** The trusted digest is checked before decompression; flat bounded names prevent path extraction. */
function unpack(bytes) {
  const files = unzipSync(bytes);
  check(Object.keys(files).length < 200, 'Unexpected embedded runtime inventory');
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    check(/^[A-Za-z0-9_.-]+$/.test(name) && !name.includes('..'), 'Unexpected Python archive path');
    total += content.length;
    check(total <= 128 * 1024 * 1024, 'Embedded runtime extraction exceeds size limit');
  }
  for (const name of ['python.exe', 'python314.dll', 'python314.zip', 'python314._pth', 'LICENSE.txt']) check(files[name]?.length, `Missing ${name}`);
  return files;
}

/** This explicit preparation command downloads only the pinned python.org release when absent. */
export async function preparePythonRuntime() {
  check(process.platform === 'win32' && process.arch === 'x64', 'This experiment requires Windows x64');
  await checkAncestors(pythonRuntimeDirectory);
  await fs.mkdir(base, { recursive: true });
  let bytes;
  try { bytes = await fs.readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(PYTHON_EMBED.url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
    check(response.ok && response.body, `Python download failed: ${response.status}`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.byteLength; check(length <= 32 * 1024 * 1024, 'Python download exceeds expected bound'); chunks.push(Buffer.from(chunk));
    }
    bytes = Buffer.concat(chunks);
    check(hash(bytes) === PYTHON_EMBED.sha256, 'Downloaded Python digest differs from the official release');
    await fs.writeFile(archive, bytes, { flag: 'wx' });
  }
  check(hash(bytes) === PYTHON_EMBED.sha256, 'Official Python archive hash mismatch');
  const files = unpack(bytes);
  let created = false;
  try { await fs.mkdir(pythonRuntimeDirectory); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(pythonRuntimeDirectory, name), content, { flag: 'wx' });
  return verifyPythonRuntime();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await preparePythonRuntime(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message })); process.exitCode = 1; }
}
