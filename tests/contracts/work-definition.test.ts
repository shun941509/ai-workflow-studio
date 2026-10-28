import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { createBasicWorkflow, createNode, validateWorkflowShape, validateWorkDefinitionDeclaration, type WorkDefinition, type Workflow, type ResourceRef } from '@studio/spec';
import { analyzeWorkflow, collectRequirements, validateWorkDefinitionSemantics } from '@studio/workflow-core';
import { buildPackage, canonicalDigest, createTextResource, inspectPackage, prepareAuthoringImport, type ResourceDescriptor } from '@studio/package-kit';

const encode = (text: string) => new TextEncoder().encode(text);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** One fictional selected business task references the existing graph and acceptance contract, not copied schemas. */
function definition(): WorkDefinition {
  return {
    version: 1, id: 'meeting-followup', revision: 1,
    card: { id: 'meeting-partner', title: '회의 업무 파트너', purpose: '주어진 회의 기록에서 확인한 후속 업무를 정리합니다.' },
    role: { id: 'followup-editor', title: '후속 업무 정리 담당', responsibility: '원문에 없는 담당자와 기한은 미확인으로 남깁니다.' },
    task: { id: 'draft-actions', title: '후속 업무 초안', goal: '명시적인 결정과 담당자·기한을 근거와 함께 정리합니다.', criterionIds: ['nonempty-result'], assets: [], skills: [] },
    harness: { context: ['start'], perform: ['work'], accept: ['finish'], deliver: ['finish'], selectedContext: [] },
  };
}
function example(): Workflow {
  const workflow = createBasicWorkflow('가상 회의 후속 업무');
  workflow.completion = { version: 1, criteria: [{ id: 'nonempty-result', label: '후속 업무 초안이 비어 있지 않음', kind: 'result_schema', schema: { type: 'string', minLength: 1 } }] };
  workflow.workDefinition = definition(); return workflow;
}

/** Original test-only Skill bytes exercise real descriptor/native-copy validation; no model result is fabricated. */
function resources(workflow: Workflow) {
  const guide = createTextResource({ id: 'original-guide', revision: 3, name: '출처 보존 지침', kind: 'instruction', text: '확인한 근거만 기록하세요.\r\n' });
  const optional = createTextResource({ id: 'original-reference', revision: 2, name: '선택 참고 문서', kind: 'document', text: '가상 회의 예시의 원문입니다.\r\n' });
  const payload = { 'SKILL.md': encode('---\nname: meeting-followup-test\ndescription: Organize only explicit meeting decisions and leave missing owners or dates unknown.\n---\nKeep source evidence. Never invent missing owners or dates.\n'), 'LICENSE.txt': encode('Original fictional test instructions. CC0-1.0.\n') };
  const descriptor: ResourceDescriptor = { schemaVersion: '1.0.0', id: 'original-skill', revision: 4, name: '회의 후속 절차', kind: 'skill', entrypoint: 'SKILL.md', license: { id: 'CC0-1.0', path: 'LICENSE.txt' }, dependencies: {}, requiredConnections: [], files: Object.entries(payload).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) as ResourceDescriptor['files'] };
  const descriptorBytes = encode(JSON.stringify(descriptor, null, 2) + '\n');
  const skill: ResourceRef = { id: descriptor.id, revision: descriptor.revision, kind: 'skill', sha256: hash(descriptorBytes) };
  const files = { ...Object.fromEntries(Object.entries(guide.files).map(([path, bytes]) => [path.replace('resources/original-guide/', 'resources/guide/'), bytes])), ...Object.fromEntries(Object.entries(optional.files).map(([path, bytes]) => [path.replace('resources/original-reference/', 'resources/reference/'), bytes])), ...Object.fromEntries(Object.entries({ ...payload, 'resource.json': descriptorBytes }).map(([path, bytes]) => [`resources/procedure/${path}`, bytes])) };
  workflow.resources = { guide: guide.reference, reference: optional.reference, procedure: skill };
  workflow.workDefinition!.task.assets = [
    { alias: 'guide', kind: 'instruction', usage: 'instructions', purpose: '원문 보존 규칙', required: true },
    { alias: 'reference', kind: 'document', usage: 'reference', purpose: '필요할 때의 추가 참고', required: false },
  ];
  workflow.workDefinition!.task.skills = [{ alias: 'procedure', kind: 'skill', usage: 'instructions', purpose: '회의 후속 작업 절차', required: true }];
  workflow.workDefinition!.harness.selectedContext = ['guide', 'procedure'];
  workflow.nodes.find(node => node.id === 'work')!.attachments = [{ resource: 'guide', role: 'instructions' }, { resource: 'procedure', role: 'skill' }];
  return files;
}

describe('single selected business definition declaration', () => {
  it('returns owned data and keeps Card, Role, Task, Skill and execution settings separate', () => {
    const input = definition(), result = validateWorkDefinitionDeclaration(input);
    expect(result.valid).toBe(true); if (!result.valid) throw new Error('Expected declaration');
    expect(result.value).toEqual(input); expect(result.value).not.toBe(input);
    result.value.task.goal = '변경'; expect(input.task.goal).not.toBe('변경');
  });

  it.each([
    ['version', (value: Record<string, unknown>) => { value.version = 2; }],
    ['second card', (value: Record<string, unknown>) => { value.cards = [value.card]; }],
    ['personal model bindings', (value: Record<string, unknown>) => { value.modelBindings = {}; }],
    ['session manifest', (value: Record<string, unknown>) => { value.contextManifest = {}; }],
    ['copied inputs', (value: Record<string, unknown>) => { value.inputs = {}; }],
    ['copied policy', (value: Record<string, unknown>) => { value.policy = {}; }],
    ['declared capabilities', (value: Record<string, unknown>) => { value.capabilities = ['tool.mcp@1']; }],
  ] as const)('rejects %s outside the selected business declaration', (_label, mutate) => {
    const value = { ...definition() } as Record<string, unknown>; mutate(value);
    expect(validateWorkDefinitionDeclaration(value).valid).toBe(false);
  });

  it('rejects blank business purpose, duplicate aliases, invalid resource usage and authority fields', () => {
    const blank = definition(); blank.role.responsibility = ' \n '; expect(validateWorkDefinitionDeclaration(blank).valid).toBe(false);
    const duplicate = example(); resources(duplicate); duplicate.workDefinition!.task.skills[0]!.alias = 'guide'; expect(validateWorkDefinitionDeclaration(duplicate.workDefinition).valid).toBe(false);
    const unsafe = example(); resources(unsafe);
    const raw = unsafe.workDefinition! as unknown as { task: { skills: Record<string, unknown>[] } };
    raw.task.skills[0]!.permissions = ['network']; expect(validateWorkDefinitionDeclaration(raw).valid).toBe(false);
    delete raw.task.skills[0]!.permissions; raw.task.skills[0]!.usage = 'execute'; expect(validateWorkDefinitionDeclaration(raw).valid).toBe(false);
  });

  it('rejects accessor side effects before reading declaration fields', () => {
    let reads = 0; const value = { ...definition(), get card() { reads++; return {}; } };
    expect(validateWorkDefinitionDeclaration(value).valid).toBe(false); expect(reads).toBe(0);
  });
});

describe('business definition cross-reference semantics', () => {
  it('accepts a complete declaration and preserves legacy workflows without opting them in', () => {
    expect(validateWorkDefinitionSemantics(example())).toEqual([]); expect(analyzeWorkflow(example())).toEqual([]);
    const legacy = createBasicWorkflow(); expect(validateWorkDefinitionSemantics(legacy)).toEqual([]);
    expect(collectRequirements(legacy).capabilities).not.toContain('workflow.work_definition@1');
    expect(collectRequirements(example()).capabilities).toEqual(expect.arrayContaining(['workflow.work_definition@1', 'workflow.completion@1']));
    expect(legacy).not.toHaveProperty('workDefinition');
  });

  it('requires all completion criteria exactly and maps every acceptance source including root output', () => {
    const workflow = example(); delete workflow.completion;
    expect(validateWorkDefinitionSemantics(workflow)).toContainEqual(expect.objectContaining({ code: 'WORK_COMPLETION_REQUIRED' }));
    const full = example(), review = { ...createNode('review'), id: 'approval' }; full.nodes.push(review);
    full.completion!.criteria.push({ id: 'accepted', label: '사용자 수락', kind: 'review_accepted', nodeId: 'approval' });
    expect(validateWorkDefinitionSemantics(full).map(issue => issue.code)).toEqual(expect.arrayContaining(['WORK_CRITERIA_MISMATCH', 'WORK_ACCEPTANCE_MAPPING_MISMATCH']));
    full.workDefinition!.task.criterionIds.push('accepted'); full.workDefinition!.harness.accept.push('approval');
    expect(validateWorkDefinitionSemantics(full)).toEqual([]);
    full.workDefinition!.task.criterionIds.push('invented'); expect(validateWorkDefinitionSemantics(full)).toContainEqual(expect.objectContaining({ code: 'WORK_CRITERIA_MISMATCH' }));
  });

  it('resolves aliases rather than original resource IDs and preserves excluded optional context', () => {
    const workflow = example(); resources(workflow);
    expect(validateWorkDefinitionSemantics(workflow)).toEqual([]); expect(workflow.workDefinition!.harness.selectedContext).not.toContain('reference');
    workflow.workDefinition!.task.assets[0]!.alias = 'original-guide';
    expect(validateWorkDefinitionSemantics(workflow)).toContainEqual(expect.objectContaining({ code: 'WORK_ASSET_REFERENCE_INVALID' }));
  });

  it.each(['missing', 'wrong-kind', 'wrong-usage', 'required-excluded', 'undeclared-selected'] as const)('rejects %s context without mutating resource pins', mutation => {
    const workflow = example(); resources(workflow); const original = structuredClone(workflow.resources);
    if (mutation === 'missing') delete workflow.resources.guide;
    else if (mutation === 'wrong-kind') workflow.workDefinition!.task.assets[0]!.kind = 'document';
    else if (mutation === 'wrong-usage') workflow.workDefinition!.task.assets[0]!.usage = 'reference';
    else if (mutation === 'required-excluded') workflow.workDefinition!.harness.selectedContext = ['procedure'];
    else workflow.workDefinition!.harness.selectedContext.push('other');
    expect(validateWorkDefinitionSemantics(workflow).length).toBeGreaterThan(0);
    if (mutation !== 'missing') expect(workflow.resources).toEqual(original);
  });

  it('rejects missing, child-only, wrong-role and ambiguous root mappings', () => {
    const workflow = example(), child = createBasicWorkflow(); child.nodes.find(node => node.id === 'work')!.id = 'child_work';
    workflow.subworkflows.child = { entryNodeId: child.entryNodeId, inputs: child.inputs, outputs: child.outputs, nodes: child.nodes, edges: child.edges };
    workflow.workDefinition!.harness.perform = ['child_work']; expect(validateWorkDefinitionSemantics(workflow)).toContainEqual(expect.objectContaining({ code: 'WORK_HARNESS_NODE_MISSING' }));
    workflow.workDefinition!.harness.perform = [workflow.entryNodeId]; expect(validateWorkDefinitionSemantics(workflow)).toContainEqual(expect.objectContaining({ code: 'WORK_HARNESS_ROLE_INVALID' }));
    workflow.workDefinition!.harness.perform = ['work']; workflow.nodes.push(structuredClone(workflow.nodes.find(node => node.id === 'work')!)); expect(validateWorkDefinitionSemantics(workflow)).toContainEqual(expect.objectContaining({ code: 'WORK_HARNESS_NODE_MISSING' }));
  });

  it('cannot replace the final delivery with another root block or weaken normal graph checks', () => {
    const workflow = example(); workflow.workDefinition!.harness.deliver = [workflow.entryNodeId];
    expect(validateWorkDefinitionSemantics(workflow).map(issue => issue.code)).toEqual(expect.arrayContaining(['WORK_HARNESS_ROLE_INVALID', 'WORK_DELIVERY_OUTPUT_MISSING']));
    const broken = example(); broken.edges = [];
    expect(validateWorkDefinitionSemantics(broken)).toEqual([]); expect(analyzeWorkflow(broken).length).toBeGreaterThan(0);
  });
});

describe('operational ZIP preserves the single business definition', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves %s definitions, criteria, exact assets and required capability through re-import', async host => {
    const workflow = example(), files = resources(workflow), before = structuredClone(workflow);
    const built = await buildPackage({ host, workflow, resources: files }); const inspected = await inspectPackage(built.bytes);
    expect(inspected.workflow).toEqual(before); expect(workflow).toEqual(before);
    expect(inspected.manifest.requiredCapabilities).toContain('workflow.work_definition@1');
    const lock = JSON.parse(new TextDecoder().decode(inspected.files.get('runtime.lock.json')!)); expect(lock.workflowSha256).toBe(canonicalDigest(workflow));
    const snapshot = await prepareAuthoringImport(built.bytes); expect(snapshot.workflow?.workDefinition).toEqual(workflow.workDefinition); expect(snapshot.resourceFiles).toEqual(files);
    const rebuilt = await buildPackage({ host, workflow: snapshot.workflow!, resources: snapshot.resourceFiles });
    expect((await inspectPackage(rebuilt.bytes)).workflow).toEqual(workflow);
    expect(inspected.trust).toBe('unsigned'); expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
    expect(snapshot).not.toHaveProperty('contextManifest'); expect(snapshot).not.toHaveProperty('published');
  });

  it('rejects a changed business goal even when the transport hash is repaired but runtime lock is stale', async () => {
    const built = await buildPackage({ host: 'codex', workflow: example() }), files = unzipSync(built.bytes);
    const workflow = JSON.parse(new TextDecoder().decode(files['workflow.json']!)); workflow.workDefinition.task.goal = '다른 업무 목적'; files['workflow.json'] = encode(JSON.stringify(workflow));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']!)); const item = manifest.files.find((entry: { path: string }) => entry.path === 'workflow.json'); item.bytes = files['workflow.json']!.length; item.sha256 = hash(files['workflow.json']!); files['manifest.json'] = encode(JSON.stringify(manifest));
    await expect(inspectPackage(zipSync(files, { level: 0 }))).rejects.toMatchObject({ code: 'RUNTIME_LOCK_INVALID' });
  });

  it('rejects unknown versions and unresolved semantics at the normal package boundary', async () => {
    const future = example() as unknown as { workDefinition: { version: number } }; future.workDefinition.version = 2;
    expect(validateWorkflowShape(future).valid).toBe(false);
    const mismatched = example(); mismatched.workDefinition!.task.criterionIds = ['unknown'];
    await expect(buildPackage({ host: 'codex', workflow: mismatched })).rejects.toMatchObject({ code: 'WORKFLOW_INVALID' });
  });
});
