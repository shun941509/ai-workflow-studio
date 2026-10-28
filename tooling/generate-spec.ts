import { readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

/** Bundle only local canonical contracts; runtime validation never resolves a network schema. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaRoot = path.join(root, 'packages/spec/schemas');
const outputRoot = path.join(root, 'packages/spec/src/generated');
const checkOnly = process.argv.includes('--check');

async function listSchemas(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(entries.map(async entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return listSchemas(full);
    // PackageManifest is owned by its independent package-kit generator.
    return entry.name.endsWith('.schema.json') && entry.name !== 'package-manifest.schema.json' ? [full] : [];
  }));
  return paths.flat().sort();
}

const files = await listSchemas(schemaRoot);
const keys = new Map(files.map(file => [file, path.relative(schemaRoot, file).replace(/\.schema\.json$/, '').replace(/[^A-Za-z0-9]/g, '_')]));

/** Resolve relative file references into a self-contained $defs map before type generation. */
function resolveRefs(value: unknown, owner: string): unknown {
  if (Array.isArray(value)) return value.map(item => resolveRefs(item, owner));
  if (value === null || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '$id' || key === '$schema') continue;
    if (key === '$ref' && typeof item === 'string' && !item.startsWith('#')) {
      const target = path.resolve(path.dirname(owner), item);
      const targetKey = keys.get(target);
      if (!targetKey) throw new Error(`Schema reference is not bundled: ${owner} -> ${item}`);
      result[key] = `#/$defs/${targetKey}`;
    } else result[key] = resolveRefs(item, owner);
  }
  return result;
}

const definitions: Record<string, unknown> = {};
for (const file of files) definitions[keys.get(file)!] = resolveRefs(JSON.parse(await readFile(file, 'utf8')), file);
const bundle = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:ai-workflow-studio:schema:workflow:1.0.0',
  ...(definitions.workflow as Record<string, unknown>),
  $defs: definitions,
};
const banner = '/** Generated from canonical JSON Schemas. Run pnpm generate:spec; do not edit by hand. */\n';
// CSP-safe clients consume a compiled validator, not Ajv's runtime compiler/new Function.
// Resolve the existing spec-owned dependencies without adding a second version to the toolchain.
const specRequire = createRequire(new URL('../packages/spec/package.json', import.meta.url));
const StandaloneAjv = specRequire('ajv/dist/2020.js').default;
const addStandaloneFormats = specRequire('ajv-formats').default;
const standaloneCode = specRequire('ajv/dist/standalone/index.js').default;
const standaloneAjv = new StandaloneAjv({ strict: true, allErrors: true, ownProperties: true, coerceTypes: false, useDefaults: false, removeAdditional: false, code: { source: true } });
addStandaloneFormats(standaloneAjv);
const outcomeValidator = standaloneAjv.compile(definitions.run_outcome);
const types = await compile(bundle as Parameters<typeof compile>[0], 'Workflow', {
  bannerComment: banner.trim(),
  additionalProperties: false,
  unknownAny: true,
  strictIndexSignatures: true,
  style: { singleQuote: true, semi: true },
});
const outputs = new Map([
  ['run-outcome-validator.generated.cjs', banner + standaloneCode(standaloneAjv, outcomeValidator) + '\n'],
  ['run-outcome-validator.generated.d.cts', banner + 'declare const validate: (value: unknown) => boolean;\nexport = validate;\n'],
  ['types.generated.ts', types],
  // File references are emitted independently because workflow definitions contain bindings, not run artifacts.
  ['file-ref.generated.ts', await compile(definitions.file_ref as Parameters<typeof compile>[0], 'FileRef', {
    bannerComment: banner.trim(), additionalProperties: false, unknownAny: true,
    style: { singleQuote: true, semi: true },
  })],
  ['text-resource-license.generated.ts', await compile(definitions.text_resource_license as Parameters<typeof compile>[0], 'TextResourceLicense', {
    bannerComment: banner.trim(), additionalProperties: false, unknownAny: true,
    style: { singleQuote: true, semi: true },
  })],
  // Acceptance definitions reference the same user-schema contract; runtime outcomes are independent of Workflow data.
  ['completion.generated.ts', await compile({ ...(definitions.completion as object), $defs: definitions } as Parameters<typeof compile>[0], 'CompletionContract', {
    bannerComment: banner.trim(), additionalProperties: false, unknownAny: true,
    style: { singleQuote: true, semi: true },
  })],
  ['run-outcome.generated.ts', await compile(definitions.run_outcome as Parameters<typeof compile>[0], 'RunOutcome', {
    bannerComment: banner.trim(), additionalProperties: false, unknownAny: true,
    style: { singleQuote: true, semi: true },
  })],
  ['schema-bundle.generated.ts', `${banner}export const schemaBundle: Record<string, unknown> = ${JSON.stringify(bundle, null, 2)};\n`],
]);
await mkdir(outputRoot, { recursive: true });
for (const [name, content] of outputs) {
  const target = path.join(outputRoot, name);
  if (checkOnly) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== content) throw new Error(`Generated contract drift: ${name}`);
  } else if (await readFile(target, 'utf8').catch(() => '') !== content) {
    // Readers/watchers must observe a whole generated module, not a truncated in-place write on Windows.
    // Only this generator owns these exact temporary paths; cleanup never traverses a directory.
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, target); }
    finally { await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
process.stdout.write(checkOnly ? 'Generated contracts match canonical schemas.\n' : 'Generated Studio workflow contracts.\n');
