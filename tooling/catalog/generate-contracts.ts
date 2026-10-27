import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Catalogue runtime types are generated from the same schemas used by the acceptance gate. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputs: string[] = ['/** Generated from canonical catalogue JSON Schemas; do not edit by hand. */'];
for (const name of ['official-example', 'verification-record']) {
  const schema = JSON.parse(await readFile(path.join(root, `packages/spec/schemas/${name}.schema.json`), 'utf8'));
  outputs.push(await compile(schema, schema.title, { bannerComment: '', additionalProperties: false, unknownAny: true, strictIndexSignatures: true, style: { singleQuote: true, semi: true } }));
}
const output = `${outputs.join('\n')}\n`;
const target = path.join(root, 'tooling/catalog/contracts.generated.ts');
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Catalogue contract drift; regenerate from canonical schemas.');
} else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, output); }
