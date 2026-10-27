import { extname } from 'node:path';
import { verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import { parseStrictJson, type Workflow, type WorkflowNode } from '@studio/spec';
import { readJsonPointer, type NodeOutput } from '@studio/workflow-core';
import { RunnerError } from '../errors.js';
import { createSkillBundle, type SkillBundle } from './skill-bundle.js';

export interface Material { alias: string; descriptor: ResourceDescriptor; text: string; data: unknown; sha256: string; format: 'text' | 'json' | 'skill' }
export interface AIAdditions { instructions: string[]; references: { resource: string; name: string; trust: 'untrusted'; text: string }[] }
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const textExtensions = new Set(['.txt', '.md', '.markdown', '.json']);

/** Only already-verified package bytes become readable data; this layer cannot run a file or open a path. */
export class VerifiedMaterials {
  readonly materials = new Map<string, Material>();
  readonly views: Record<string, NodeOutput> = Object.create(null) as Record<string, NodeOutput>;

  constructor(workflow: Workflow, files: ReadonlyMap<string, Uint8Array>) {
    const descriptors = verifyResources(workflow.resources, files);
    let total = 0;
    for (const [alias, descriptor] of descriptors) {
      if (!['instruction', 'document', 'skill'].includes(descriptor.kind)) throw new RunnerError('RESOURCE_KIND_UNSUPPORTED', `${alias}: MCP 실행 자료는 아직 지원하지 않습니다.`);
      if (descriptor.requiredConnections.length || Object.keys(descriptor.dependencies).length) throw new RunnerError('RESOURCE_DEPENDENCY_UNSUPPORTED', `${alias}: 연결 또는 종속 자료를 필요로 하는 자료는 아직 지원하지 않습니다.`);
      for (const file of descriptor.files) {
        // Documents stay textual. Skill inventories may include binary/code bytes, exposed only by the bounded bundle view below.
        const extension = extname(file.path).toLowerCase();
        if (descriptor.kind !== 'skill' && !textExtensions.has(extension) && !(file.path === descriptor.license.path && extension === '')) throw new RunnerError('RESOURCE_FILE_UNSUPPORTED', `${alias}: 텍스트·Markdown·JSON 자료만 사용할 수 있습니다.`);
        const bytes = files.get(`resources/${alias}/${file.path}`)!;
        total += bytes.length;
        if (bytes.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) throw new RunnerError('RESOURCE_TOO_LARGE', '자료는 파일당 256 KiB, 합계 1 MiB 이하로 구성하세요.');
        if (descriptor.kind !== 'skill') decodeText(bytes, alias);
      }
      if (descriptor.kind === 'skill') {
        const data = createSkillBundle(alias, descriptor, workflow.resources[alias]!.sha256, files);
        const material: Material = { alias, descriptor, text: data.instructions, data, format: 'skill', sha256: workflow.resources[alias]!.sha256 }; this.materials.set(alias, material); this.views[alias] = this.output(material, data); continue;
      }
      if (!textExtensions.has(extname(descriptor.entrypoint).toLowerCase())) throw new RunnerError('RESOURCE_FILE_UNSUPPORTED', `${alias}: 본문 파일은 .txt·.md·.markdown·.json이어야 합니다.`);
      const text = decodeText(files.get(`resources/${alias}/${descriptor.entrypoint}`)!, alias);
      const format = extname(descriptor.entrypoint).toLowerCase() === '.json' ? 'json' : 'text';
      let data: unknown = text;
      if (format === 'json') {
        try { data = parseStrictJson(text); } catch { throw new RunnerError('RESOURCE_JSON_INVALID', `${alias}: 자료 본문이 유효한 JSON이 아닙니다.`); }
      }
      const material: Material = { alias, descriptor, text, data, format, sha256: workflow.resources[alias]!.sha256 };
      this.materials.set(alias, material);
      this.views[alias] = this.output(material, data);
    }
    // Validate every attachment and static pointer before any model reservation or request can start.
    for (const node of [workflow, ...Object.values(workflow.subworkflows)].flatMap((flow) => flow?.nodes ?? [])) {
      this.additions(node);
      if (node.type === 'resource') this.read(node.config.resource, node.config.pointer ?? '');
      if (node.type === 'skill' && node.config.mode === 'instructions') this.skill(node);
    }
  }

  read(alias: string, pointer = ''): NodeOutput {
    const material = this.materials.get(alias);
    if (!material) throw new RunnerError('RESOURCE_NOT_FOUND', `${alias}: 읽을 자료가 없습니다.`);
    const data = readJsonPointer(material.data, pointer);
    if (typeof data === 'symbol') throw new RunnerError('RESOURCE_POINTER_MISSING', `${alias}: 자료에서 지정한 JSON Pointer를 찾을 수 없습니다.`);
    return this.output(material, structuredClone(data));
  }

  /** Instruction mode returns data; optional arguments stay explicit data instead of becoming template code. */
  skill(node: Extract<WorkflowNode, { type: 'skill' }>, inputs: Record<string, unknown> = {}): NodeOutput {
    if (node.config.mode !== 'instructions' || node.config.entrypoint !== undefined || node.config.workerProfile !== undefined || node.config.resultSchema !== undefined) throw new RunnerError('SKILL_EXECUTION_UNSUPPORTED', '지침 모드에서는 실행 항목·worker·결과 스키마를 지정할 수 없습니다.');
    const material = this.materials.get(node.config.resource); if (!material || material.format !== 'skill') throw new RunnerError('SKILL_RESOURCE_REQUIRED', 'Skill 지침 묶음을 명시적으로 선택하세요.');
    const data = structuredClone(material.data as SkillBundle); return this.output(material, { ...data, ...(Object.hasOwn(inputs, 'arguments') ? { arguments: structuredClone(inputs.arguments) } : {}) });
  }

  /** Instructions require an explicit matching role; reference documents stay in lower-trust request data. */
  additions(node: WorkflowNode): AIAdditions {
    const result: AIAdditions = { instructions: [], references: [] };
    const seen = new Set<string>();
    for (const attachment of node.attachments) {
      if (node.type !== 'ai' && node.type !== 'agent') throw new RunnerError('ATTACHMENT_UNSUPPORTED', `${node.label}: 현재 AI 작업·에이전트 블록에서만 자료를 첨부할 수 있습니다.`);
      if (seen.has(attachment.resource)) throw new RunnerError('ATTACHMENT_DUPLICATE', `${node.label}: 같은 자료를 중복 첨부할 수 없습니다.`);
      seen.add(attachment.resource);
      const material = this.materials.get(attachment.resource);
      if (!material) throw new RunnerError('RESOURCE_NOT_FOUND', `${attachment.resource}: 첨부 자료가 없습니다.`);
      if (material.format === 'skill') {
        if (attachment.role !== 'skill') throw new RunnerError('ATTACHMENT_ROLE_MISMATCH', `${attachment.resource}: Skill은 skill 역할로 명시적으로 첨부하세요.`);
        const bundle = material.data as SkillBundle; result.instructions.push(`[명시 첨부 Skill: ${JSON.stringify(bundle.metadata.name)}]\n${bundle.instructions}`);
        for (const file of [...bundle.references, ...bundle.assets]) if (file.content === 'text') result.references.push({ resource: material.alias, name: `${bundle.metadata.name}/${file.path}`, trust: 'untrusted', text: file.text! });
        continue;
      }
      if (material.format !== 'text') throw new RunnerError('ATTACHMENT_FORMAT_UNSUPPORTED', `${attachment.resource}: 첨부 본문은 텍스트 또는 Markdown이어야 합니다. JSON은 자료 읽기 블록으로 연결하세요.`);
      if (attachment.role === 'instructions' && material.descriptor.kind === 'instruction') result.instructions.push(`[첨부 작업 지침: ${JSON.stringify(material.descriptor.name)}]\n${material.text}`);
      else if (attachment.role === 'reference' && material.descriptor.kind === 'document') result.references.push({ resource: material.alias, name: material.descriptor.name, trust: 'untrusted', text: material.text });
      else throw new RunnerError('ATTACHMENT_ROLE_MISMATCH', `${attachment.resource}: 작업 지침은 instructions, 문서는 reference 역할로 첨부하세요.`);
    }
    return result;
  }

  private output(material: Material, data: unknown): NodeOutput {
    return { data, ...(typeof data === 'string' ? { text: data } : {}), sources: [{ resource: material.alias, id: material.descriptor.id, revision: material.descriptor.revision, sha256: material.sha256, path: material.descriptor.entrypoint, trust: 'untrusted' }] };
  }
}

/** Strict UTF-8 and control-byte checks prevent binary payloads from being silently decoded as text. */
function decodeText(bytes: Uint8Array, alias: string): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new RunnerError('RESOURCE_ENCODING_INVALID', `${alias}: UTF-8 텍스트 자료가 필요합니다.`); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) throw new RunnerError('RESOURCE_BINARY_UNSUPPORTED', `${alias}: 이진 데이터가 포함된 자료를 읽을 수 없습니다.`);
  return text;
}
