import type { ResourceRef } from '@studio/spec';

/** Browser DTOs contain pinned references, never Node crypto code or authentication secrets. */
export interface TextResourceContent { format: 'text'; name: string; kind: 'instruction' | 'document'; description: string; text: string }
export interface TextResourceVersion { revision: number; content: TextResourceContent; reference: ResourceRef }
export interface PrivateTextResource { id: string; name: string; kind: string; description: string; resource_versions: TextResourceVersion[] }
