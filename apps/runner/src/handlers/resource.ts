import type { NodeOutput } from '@studio/workflow-core';
import type { VerifiedMaterials } from '../resources/verified-materials.js';

/** Resource nodes read an immutable package view; they grant no filesystem, network, or execution permission. */
export function executeResource(materials: VerifiedMaterials, resource: string, pointer = ''): NodeOutput {
  return materials.read(resource, pointer);
}
