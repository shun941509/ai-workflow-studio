import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const execute = promisify(execFile);
const version = value => /^\d+(?:\.\d+){2,3}$/.test(value);

/** Discover the installed Microsoft build tools without changing PATH, installing software, or invoking a shell. */
export async function compileWindowsProbe({ source, object, output, libraries }) {
  if (process.platform !== 'win32') throw new Error('Native Windows probe compilation requires Windows.');
  const programFilesX86 = process.env['ProgramFiles(x86)']; if (!programFilesX86) throw new Error('Windows build tools directory is unavailable.');
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const { stdout } = await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, timeout: 10000 });
  const installation = stdout.trim(); if (!path.isAbsolute(installation) || /[\r\n]/.test(installation)) throw new Error('Visual C++ build tools were not found.');
  const toolset = (await fs.readFile(path.join(installation, 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), 'utf8')).trim();
  if (!version(toolset)) throw new Error('Unexpected MSVC version metadata.');
  const vc = path.join(installation, 'VC', 'Tools', 'MSVC', toolset); const compiler = path.join(vc, 'bin', 'Hostx64', 'x64', 'cl.exe');
  const sdk = path.join(programFilesX86, 'Windows Kits', '10');
  const versions = (await fs.readdir(path.join(sdk, 'Include'))).filter(version).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  let sdkVersion;
  for (const item of versions) {
    try { await Promise.all(['um', 'shared', 'ucrt'].map(part => fs.stat(path.join(sdk, 'Include', item, part)))); await fs.stat(path.join(sdk, 'Lib', item, 'um', 'x64', 'kernel32.lib')); sdkVersion = item; break; } catch { /* An incomplete SDK is not a usable compiler input. */ }
  }
  if (!sdkVersion) throw new Error('A complete Windows SDK was not found.');
  await execute(compiler, ['/nologo', '/GS-', '/Zl', '/O1', `/I${path.join(vc, 'include')}`, ...['um', 'shared', 'ucrt'].map(part => `/I${path.join(sdk, 'Include', sdkVersion, part)}`), `/Fo${object}`, source, '/link', '/NODEFAULTLIB', '/ENTRY:ProbeEntry', '/SUBSYSTEM:WINDOWS', `/OUT:${output}`, `/LIBPATH:${path.join(sdk, 'Lib', sdkVersion, 'um', 'x64')}`, ...libraries], { windowsHide: true, timeout: 30000 });
  return { toolset, sdkVersion, compilerSha256: createHash('sha256').update(await fs.readFile(compiler)).digest('hex') };
}
