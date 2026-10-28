import { createHash } from 'node:crypto';
import { assertJsonData, parseStrictJson, type ResourceRef, type Workflow } from '@studio/spec';
import type { PackageManifest } from './generated/manifest.js';
import { verifyResources, type ResourceDescriptor } from './resources.js';
import { PackageError } from './errors.js';

/** Authoring copies are smaller than arbitrary Runner imports; these limits are service policy, not source declarations. */
export const AUTHORING_IMPORT_LIMITS = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024, maxEditorBytes: 1024 * 1024,
  archive: Object.freeze({ maxFiles: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 100, maxManifestBytes: 1024 * 1024 }),
});

export interface AuthoringImportSnapshot {
  format: 'authoring-source-v1';
  source: { artifactSha256: string; manifestSha256: string; packageId: string; packageVersion: string; kind: PackageManifest['packageKind']; host: PackageManifest['targetHost']; trust: 'unsigned' | 'verified' };
  workflow?: Workflow;
  /** Raw, strictly decoded layout data; the editor must validate its supported layout version before using it. */
  editor?: Record<string, unknown>;
  resources: { alias: string; reference: ResourceRef; descriptor: ResourceDescriptor }[];
  resourceFiles: Record<string, Uint8Array>;
  inventory: { resourceCount: number; fileCount: number; bytes: number };
}
interface InspectedSource { manifest: PackageManifest; workflow?: Workflow; files: ReadonlyMap<string, Uint8Array>; trust: 'unsigned' | 'verified' }
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Internal materialization receives an inspectPackage result, never caller-supplied descriptor metadata.
 * It preserves aliases and original bytes. A valid signature is not a reuse license, publication approval or execution proof. */
export function authoringSnapshot(source: Uint8Array, inspected: InspectedSource): AuthoringImportSnapshot {
  const references = inspected.manifest.resources as Record<string, ResourceRef>;
  const descriptors = verifyResources(references, inspected.files);
  let editor: Record<string, unknown> | undefined;
  const layout = inspected.files.get('editor.json');
  if (layout) {
    try {
      if (layout.length > AUTHORING_IMPORT_LIMITS.maxEditorBytes) throw new Error('limit');
      const value: unknown = parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(layout)); assertJsonData(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
      editor = value as Record<string, unknown>;
    } catch { throw new PackageError('AUTHORING_EDITOR_INVALID', '원본 편집 배치는 1 MiB 이하의 올바른 UTF-8 JSON 객체여야 합니다.'); }
  }
  const resourceFiles: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  let totalBytes = 0;
  for (const [path, bytes] of inspected.files) if (path.startsWith('resources/')) {
    // Owned copies retain binary documents, line endings, licenses and descriptor whitespace without text conversion.
    resourceFiles[path] = new Uint8Array(bytes); totalBytes += bytes.length;
  }
  return {
    format: 'authoring-source-v1',
    source: { artifactSha256: hash(source), manifestSha256: hash(inspected.files.get('manifest.json')!), packageId: inspected.manifest.packageId, packageVersion: inspected.manifest.packageVersion, kind: inspected.manifest.packageKind, host: inspected.manifest.targetHost, trust: inspected.trust },
    ...(inspected.workflow ? { workflow: structuredClone(inspected.workflow) } : {}), ...(editor ? { editor } : {}),
    resources: [...descriptors].map(([alias, descriptor]) => ({ alias, reference: structuredClone(references[alias]!), descriptor: structuredClone(descriptor) })),
    resourceFiles, inventory: { resourceCount: descriptors.size, fileCount: Object.keys(resourceFiles).length, bytes: totalBytes },
  };
}
