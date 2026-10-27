import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { compile } from 'json-schema-to-typescript';
import { fileURLToPath } from 'node:url';

/** Package types are generated from the shared JSON Schema rather than duplicated by hand. */
const schema = JSON.parse(await readFile(new URL('../packages/spec/schemas/package-manifest.schema.json', import.meta.url), 'utf8'));
const output = await compile(schema, 'PackageManifest', {
  bannerComment: '/** Generated from package-manifest.schema.json. Edit the schema, then regenerate. */',
  additionalProperties: false,
});
await mkdir(new URL('../packages/package-kit/src/generated/', import.meta.url), { recursive: true });
await writeFile(new URL('../packages/package-kit/src/generated/manifest.ts', import.meta.url), output);
// Resource descriptors share the same source directory so relative pinned-reference schemas resolve.
const resourceURL = new URL('../packages/spec/schemas/resource-descriptor.schema.json', import.meta.url);
const resource = JSON.parse(await readFile(resourceURL, 'utf8'));
const resourceOutput = await compile(resource, 'ResourceDescriptor', {
  cwd: fileURLToPath(new URL('../packages/spec/schemas/', import.meta.url)),
  bannerComment: '/** Generated from resource-descriptor.schema.json. Edit the schema, then regenerate. */',
  additionalProperties: false,
});
await writeFile(new URL('../packages/package-kit/src/generated/resource.ts', import.meta.url), resourceOutput);
// Runtime requirements are also schema-owned, independently of the per-run resolved local plan.
const runtime = JSON.parse(await readFile(new URL('../packages/spec/schemas/runtime-lock.schema.json', import.meta.url), 'utf8'));
await writeFile(new URL('../packages/package-kit/src/generated/runtime-lock.ts', import.meta.url), await compile(runtime, 'RuntimeRequirementsLock', {
  bannerComment: '/** Generated from runtime-lock.schema.json. Edit the schema, then regenerate. */', additionalProperties: false,
}));
