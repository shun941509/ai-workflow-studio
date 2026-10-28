import type { ResourceRef, Workflow } from '@studio/spec';
import { collectRequirements } from '@studio/workflow-core';

/** Deleting a read block or data binding must not leave its last private material in a later download. */
export function releaseUnusedResourcePins(previous: Workflow, next: Workflow): Workflow {
  const used = new Set(collectRequirements(next).resourceAliases);
  const resources = { ...next.resources };
  for (const alias of collectRequirements(previous).resourceAliases) if (!used.has(alias)) delete resources[alias];
  return { ...next, resources };
}

/** A resource alias has one immutable version throughout a workflow; attaching never silently upgrades another node. */
export function withResourceAttachment(workflow: Workflow, nodeId: string, reference: ResourceRef, alias = reference.id): Workflow {
  const node = workflow.nodes.find((item) => item.id === nodeId);
  if (!node || !['ai', 'agent', 'resource'].includes(node.type) || !['instruction', 'document'].includes(reference.kind)) throw new Error('AI 작업·에이전트 또는 자료 읽기 블록에 작업 지침·문서를 연결할 수 있습니다.');
  // The callback rechecks the current workflow so a delayed detail request cannot attach after a strategy change.
  if (node.type === 'agent' && node.config.strategy === 'agentic_rag') throw new Error('검색 에이전트에는 직접 자료를 첨부할 수 없습니다. 현재 실행의 키워드 색인 목록을 연결하세요.');
  const existing = workflow.resources[alias];
  if (existing && (existing.id !== reference.id || existing.revision !== reference.revision || existing.sha256 !== reference.sha256 || existing.kind !== reference.kind)) throw new Error('이 프로젝트에서 이미 다른 버전을 사용하고 있습니다. 기존 연결을 해제한 뒤 변경해 주세요.');
  const role = reference.kind === 'instruction' ? 'instructions' as const : 'reference' as const;
  if (node.type === 'resource') {
    const next = { ...workflow, resources: { ...workflow.resources, [alias]: reference }, nodes: workflow.nodes.map((item) => item.id === nodeId && item.type === 'resource' ? { ...item, config: { ...item.config, resource: alias } } : item) as Workflow['nodes'] };
    // Replacing a read dependency releases its old pin only when no other binding or attachment needs it.
    if (!collectRequirements(next).resourceAliases.includes(node.config.resource)) delete next.resources[node.config.resource];
    return next;
  }
  return { ...workflow, resources: { ...workflow.resources, [alias]: reference }, nodes: workflow.nodes.map((item) => item.id === nodeId ? { ...item, attachments: [...item.attachments.filter((attachment) => attachment.resource !== alias), { resource: alias, role }] } : item) as Workflow['nodes'] };
}

/** Removing the final use drops the export dependency; shared references stay pinned for the other nodes. */
export function withoutResourceAttachment(workflow: Workflow, nodeId: string, resourceId: string): Workflow {
  const next = { ...workflow, nodes: workflow.nodes.map((node) => node.id === nodeId ? { ...node, ...(node.type === 'resource' && node.config.resource === resourceId ? { config: { ...node.config, resource: 'pending-resource' } } : {}), attachments: node.attachments.filter((attachment) => attachment.resource !== resourceId) } : node) as Workflow['nodes'], resources: { ...workflow.resources } };
  if (!collectRequirements(next).resourceAliases.includes(resourceId)) delete next.resources[resourceId];
  return next;
}
