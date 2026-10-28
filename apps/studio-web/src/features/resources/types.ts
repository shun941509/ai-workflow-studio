import type { ResourceRef, TextResourceLicense } from '@studio/spec';

/** Browser DTOs contain pinned references, never Node crypto code or authentication secrets. */
export interface TextResourceContent { format: 'text'; name: string; kind: 'instruction' | 'document'; description: string; text: string; license?: TextResourceLicense }
export interface TextResourceVersion { revision: number; content: TextResourceContent; reference: ResourceRef }
export interface PrivateTextResource { id: string; name: string; kind: string; description: string; resource_versions: TextResourceVersion[] }

/** Collection pages carry metadata only; one chosen immutable version is opened before preview/attachment/export. */
export interface ResourceVersionSummary {
  id: string; revision: number;
  content: { format: 'text' | 'archive_v1'; name: string; kind: ResourceRef['kind']; description: string };
}
export interface PrivateResourceSummary { id: string; name: string; kind: ResourceRef['kind']; description: string; resource_versions: ResourceVersionSummary[]; versionsTruncated: boolean }
export interface ArchiveResourcePreview { format: 'archive_v1'; name: string; kind: ResourceRef['kind']; description: string; license: { id: string; path: string }; files: { path: string; bytes: number; sha256: string }[] }
export interface PrivateResourceDetail {
  resource: { id: string; name: string; kind: ResourceRef['kind']; description: string };
  version: { id: string; revision: number; content: TextResourceContent | ArchiveResourcePreview; reference: ResourceRef };
  refs: Record<string, ResourceRef>; resourceBindings: Record<string, string>;
  resourceDependencies: Record<string, string[]>;
  origin: { source: Record<string, unknown>; copied_at: string } | null;
}
