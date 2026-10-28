import { canonicalDigest } from '@studio/package-kit';
import { validateWorkingContextSemantics, workingTaskContext } from '@studio/workflow-core';
import type { Workflow, WorkflowNode } from '@studio/spec';
import type { ModelRequest } from '../providers/model-provider.js';
import type { VerifiedMaterials } from '../resources/verified-materials.js';
import type { SkillBundle } from '../resources/skill-bundle.js';
import { RunnerError } from '../errors.js';

export interface ContextFile { path: string; sha256: string; bytes: number; selected: boolean; purpose: 'instructions' | 'reference' | 'template' | 'skill_reference' | 'skill_asset' | 'excluded'; reason: 'selected' | 'not_selected' | 'license_not_context' | 'binary_metadata_only' | 'execution_not_supported' }
export interface ContextAsset { alias: string; id: string; revision: number; sha256: string; kind: string; usage: string; purpose: string; required: boolean; selected: boolean; reason: 'selected' | 'not_selected'; files: ContextFile[] }
/** Runtime evidence is deliberately separate from Workflow types and contains hashes/metadata, never material bodies or credentials. */
export interface WorkingContextDraft { version: 1; runId: string; nodeId: string; nodeInstanceId: string; attemptId: string; planHash: string; workDefinitionHash: string; contextNodeId: string; contextResultHash: string; businessTaskHash: string; maxBytes: number; selectionScope: 'task_fixed_attachments'; assets: ContextAsset[] }
export interface WorkingContextAudit { draft: WorkingContextDraft; verify(request: ModelRequest): void }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new RunnerError('WORK_CONTEXT_CHANGED', '고정 업무 문맥·선택 자료와 실제 모델 입력이 일치하지 않습니다.'); };

/** Pin the actual verified descriptor/file inventory in the immutable plan without storing resource bodies. */
export function workingContextAssets(workflow: Workflow, materials: VerifiedMaterials): ContextAsset[] {
  const definition = workflow.workDefinition; if (!definition) return fail();
  const selected = new Set(definition!.harness.selectedContext);
  const assets: ContextAsset[] = [...definition!.task.assets, ...definition!.task.skills].map(link => {
    const material = materials.materials.get(link.alias); const ref = workflow.resources[link.alias];
    if (!material || !ref || material.sha256 !== ref.sha256 || material.descriptor.id !== ref.id || material.descriptor.revision !== ref.revision || material.descriptor.kind !== link.kind) return fail();
    const included = selected.has(link.alias); const bundle = material.format === 'skill' ? material.data as SkillBundle : undefined;
    const files: ContextFile[] = material.descriptor.files.map(file => {
      let purpose: ContextFile['purpose'] = 'excluded', reason: ContextFile['reason'] = 'not_selected';
      if (included) {
        if (file.path === material.descriptor.entrypoint) { purpose = link.kind === 'skill' || link.kind === 'instruction' ? 'instructions' : link.usage === 'template' ? 'template' : 'reference'; reason = 'selected'; }
        else if (file.path === material.descriptor.license.path) reason = 'license_not_context';
        else if (bundle) {
          const reference = bundle.references.find(value => value.path === file.path), asset = bundle.assets.find(value => value.path === file.path), view = reference ?? asset;
          if (view?.content === 'text') { purpose = reference ? 'skill_reference' : 'skill_asset'; reason = 'selected'; }
          else if (view) reason = 'binary_metadata_only';
          else reason = bundle.excludedFiles.find(value => value.path === file.path)?.reason ?? 'not_selected';
        }
      }
      return { ...file, purpose, reason, selected: reason === 'selected' };
    });
    return { alias: link.alias, id: ref.id, revision: ref.revision, sha256: ref.sha256, kind: link.kind, usage: link.usage, purpose: link.purpose, required: link.required, selected: included, reason: included ? 'selected' : 'not_selected', files };
  });
  return assets;
}

/** Root opt-in only: preserve existing request context as data and reuse explicit attachment roles without injecting new authority. */
export function workingContextAudit(input: { workflow: Workflow; node: WorkflowNode; inputs: Record<string, unknown>; materials: VerifiedMaterials; runId: string; attemptId: string; planHash: string; scopeId: string }): WorkingContextAudit | undefined {
  const { workflow, node, materials } = input; const definition = workflow.workDefinition, spec = definition?.harness.workingContext;
  if (!spec || input.scopeId !== 'main') return undefined;
  const binding = spec.bindings.find(value => value.nodeId === node.id); if (!binding) return undefined;
  if (validateWorkingContextSemantics(workflow).length) fail();
  const context = input.inputs.context, metadata = workingTaskContext(workflow);
  if (!object(context) || Object.keys(context).sort().join(',') !== 'businessTask,request' || canonicalDigest(context.businessTask) !== canonicalDigest(metadata)) fail();
  const assets = workingContextAssets(workflow, materials);
  const additions = materials.additions(node); const contextHash = canonicalDigest(context);
  const draft: WorkingContextDraft = { version: 1, runId: input.runId, nodeId: node.id, nodeInstanceId: `${input.runId}:${node.id}`, attemptId: input.attemptId, planHash: input.planHash, workDefinitionHash: canonicalDigest(definition), contextNodeId: binding.contextNodeId, contextResultHash: canonicalDigest({ data: context }), businessTaskHash: canonicalDigest(metadata), maxBytes: spec.maxBytes, selectionScope: 'task_fixed_attachments', assets };
  return { draft, verify(request) {
    // The handler has already assembled the actual request. Match its data and attachment bytes before any credentials/network await.
    const content = request.content;
    if (!object(content) || !Object.hasOwn(content, 'context') || canonicalDigest(content.context) !== contextHash || canonicalDigest(content.untrustedReferences ?? []) !== canonicalDigest(additions.references) || additions.instructions.some(instruction => !request.instructions.includes(instruction))) fail();
  } };
}
