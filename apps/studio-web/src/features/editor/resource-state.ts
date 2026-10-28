import { assertJsonData, type ResourceRef, type Workflow } from '@studio/spec';
import { collectRequirements } from '@studio/workflow-core';
import type { PrivateResourceDetail } from '../resources/types';
import { withResourceAttachment } from './resource-links';

export interface ResourceState { resourceBindings?: Record<string, string>; resourceDependencies?: Record<string, string[]> }
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const versionPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail = () => { throw new Error('고정 자료의 별칭·버전·의존 관계를 확인해 주세요. 자동 교체하거나 누락된 자료를 추측하지 않습니다.'); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function sameResource(left: ResourceRef | undefined, right: ResourceRef | undefined): boolean { return Boolean(left && right && left.id === right.id && left.kind === right.kind && left.revision === right.revision && left.sha256 === right.sha256); }

/** Local metadata is not execution authority; the server independently resolves ownership, hashes and immutable descriptors. */
export function validateResourceState(workflow: Workflow, bindings: unknown = {}, dependencies: unknown = {}): Required<ResourceState> {
  assertJsonData(bindings); assertJsonData(dependencies); if (!object(bindings) || !object(dependencies) || Object.keys(bindings).length > 1000 || Object.keys(dependencies).length > 1000) return fail();
  const resourceBindings: Record<string, string> = {}, resourceDependencies: Record<string, string[]> = {};
  for (const [alias, version] of Object.entries(bindings)) { if (!Object.hasOwn(workflow.resources, alias) || !aliasPattern.test(alias) || typeof version !== 'string' || !versionPattern.test(version)) return fail(); resourceBindings[alias] = version.toLowerCase(); }
  for (const [alias, children] of Object.entries(dependencies)) {
    if (!Object.hasOwn(workflow.resources, alias) || !Array.isArray(children) || children.length > 1000 || new Set(children).size !== children.length || children.some(child => typeof child !== 'string' || !Object.hasOwn(workflow.resources, child))) return fail();
    resourceDependencies[alias] = [...children] as string[];
  }
  expand(Object.keys(resourceDependencies), resourceDependencies);
  return { resourceBindings, resourceDependencies };
}
/** The maximum descriptor inventory is bounded; iterative DFS avoids overflowing on a long valid dependency chain. */
function expand(roots: string[], graph: Record<string, string[]>): Set<string> {
  const complete = new Set<string>(), visiting = new Set<string>();
  for (const root of roots) {
    const stack: { alias: string; exit: boolean }[] = [{ alias: root, exit: false }];
    while (stack.length) {
      const item = stack.pop()!;
      if (item.exit) { visiting.delete(item.alias); complete.add(item.alias); continue; }
      if (complete.has(item.alias)) continue; if (visiting.has(item.alias)) return fail();
      visiting.add(item.alias); if (visiting.size + complete.size > 2000) return fail(); stack.push({ alias: item.alias, exit: true });
      for (const child of graph[item.alias] ?? []) stack.push({ alias: child, exit: false });
    }
  }
  return complete;
}

/** The selected account version identifies the root alias; source descriptor IDs and account resource IDs remain independent. */
export function selectedResourceAlias(detail: PrivateResourceDetail): string {
  const roots = Object.entries(detail.resourceBindings).filter(([alias, version]) => version.toLowerCase() === detail.version.id.toLowerCase() && sameResource(detail.refs[alias], detail.version.reference)).map(([alias]) => alias);
  if (roots.length !== 1) return fail(); return roots[0]!;
}
export function attachResourceSelection(workflow: Workflow, nodeId: string, detail: PrivateResourceDetail, state: ResourceState = {}) {
  assertJsonData(detail.refs); if (!object(detail.refs) || !Object.keys(detail.refs).length || Object.keys(detail.refs).length > 1000) return fail();
  for (const [alias, ref] of Object.entries(detail.refs)) if (!aliasPattern.test(alias) || !object(ref) || Object.keys(ref).sort().join(',') !== 'id,kind,revision,sha256' || typeof ref.id !== 'string' || !aliasPattern.test(ref.id) || !['instruction', 'document', 'skill', 'mcp'].includes(String(ref.kind)) || !Number.isSafeInteger(ref.revision) || ref.revision < 1 || !/^[a-f0-9]{64}$/.test(String(ref.sha256))) return fail();
  const source = validateResourceState({ ...workflow, resources: detail.refs }, detail.resourceBindings, detail.resourceDependencies);
  const keys = Object.keys(detail.refs); if (keys.some(alias => !Object.hasOwn(source.resourceBindings, alias) || !Object.hasOwn(source.resourceDependencies, alias))) return fail();
  const alias = selectedResourceAlias(detail); if (expand([alias], source.resourceDependencies).size !== keys.length) return fail();
  const existing = validateResourceState(workflow, state.resourceBindings, state.resourceDependencies);
  for (const id of keys) {
    if (workflow.resources[id] && !sameResource(workflow.resources[id], detail.refs[id])) throw new Error(`자료 별칭 ${id}가 다른 원본 버전과 충돌합니다. 기존 연결을 먼저 확인해 주세요.`);
    if (existing.resourceBindings[id] && existing.resourceBindings[id] !== source.resourceBindings[id]) throw new Error(`자료 별칭 ${id}가 다른 계정 버전에 고정되어 있습니다.`);
    if (existing.resourceDependencies[id] && JSON.stringify([...existing.resourceDependencies[id]!].sort()) !== JSON.stringify([...source.resourceDependencies[id]!].sort())) throw new Error(`자료 별칭 ${id}의 의존 관계가 다릅니다.`);
  }
  const pinned = { ...workflow, resources: { ...workflow.resources, ...detail.refs } };
  return { workflow: withResourceAttachment(pinned, nodeId, detail.version.reference, alias), resourceBindings: { ...existing.resourceBindings, ...source.resourceBindings }, resourceDependencies: { ...existing.resourceDependencies, ...source.resourceDependencies } };
}

/** Explicit JSON edits must not silently restore removed children; inspector cleanup may still restore shared dependencies. */
export function assertPreservedResourceDependencies(previous: Workflow, next: Workflow, state: ResourceState = {}) {
  for (const [parent, children] of Object.entries(state.resourceDependencies ?? {})) {
    if (!sameResource(previous.resources[parent], next.resources[parent])) continue;
    for (const child of children) if (!sameResource(previous.resources[child], next.resources[child])) throw new Error('다른 고정 자료가 사용하는 의존 자료를 삭제하거나 교체할 수 없습니다. 해당 자료 연결을 먼저 해제해 주세요.');
  }
}

/** Remove only the former used closure. Other roots and deliberate unreferenced pins keep their exact dependencies. */
export function pruneResourceState(previous: Workflow, next: Workflow, state: ResourceState = {}) {
  const union = { ...next, resources: { ...previous.resources, ...next.resources } };
  const checked = validateResourceState(union, state.resourceBindings, state.resourceDependencies);
  const before = expand(collectRequirements(previous).resourceAliases, checked.resourceDependencies); const directAfter = new Set(collectRequirements(next).resourceAliases);
  const explicit = Object.keys(previous.resources).filter(alias => !before.has(alias) && Object.hasOwn(next.resources, alias));
  const after = expand([...directAfter, ...explicit], checked.resourceDependencies);
  const resources = { ...next.resources }; const resourceBindings = { ...checked.resourceBindings }; const resourceDependencies = { ...checked.resourceDependencies };
  for (const alias of before) if (!after.has(alias)) delete resources[alias];
  // A legacy direct-pin cleanup may have removed an alias still needed by a different root's dependency edge.
  for (const alias of after) if (!directAfter.has(alias) && !resources[alias] && previous.resources[alias]) resources[alias] = previous.resources[alias]!;
  for (const alias of Object.keys(resourceBindings)) if (!resources[alias] || previous.resources[alias] && !sameResource(previous.resources[alias], resources[alias])) delete resourceBindings[alias];
  for (const alias of Object.keys(resourceDependencies)) if (!resources[alias] || previous.resources[alias] && !sameResource(previous.resources[alias], resources[alias])) delete resourceDependencies[alias];
  // A retained immutable parent cannot point at a replacement child merely because the alias is unchanged.
  for (const children of Object.values(resourceDependencies)) for (const child of children) if (!resources[child] || previous.resources[child] && !sameResource(previous.resources[child], resources[child])) throw new Error('다른 고정 자료가 사용하는 의존 자료를 삭제하거나 교체할 수 없습니다. 해당 자료 연결을 먼저 해제해 주세요.');
  validateResourceState({ ...next, resources }, resourceBindings, resourceDependencies);
  return { workflow: { ...next, resources }, resourceBindings, resourceDependencies };
}
