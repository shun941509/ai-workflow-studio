import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { BASIC_CAPABILITIES, validateWorkflowShape, validateJsonValue, type Workflow, type WorkflowNode, type ValidationIssue, type FileRef } from '@studio/spec';
import fileRefSchema from '../../../packages/spec/schemas/file-ref.schema.json' with { type: 'json' };
import { analyzeWorkflow, collectRequirements, createResolvedPlan, resolveBindings, ContractError, validateTextExtraction, type NodeOutput } from '@studio/workflow-core';
import { canonicalDigest, inspectPackage, verifyResources } from '@studio/package-kit';
import { RunStore, scopedKey, type ModelProfile, type RunRecord, type WaitRecord, type ChildScopeRecord } from './state/store.js';
import type { CredentialStore } from './security/credential-store.js';
import { ModelError, type ModelProvider } from './providers/model-provider.js';
import { OpenAIResponsesProvider } from './providers/openai.js';
import { ModelBroker } from './providers/model-broker.js';
import { RunnerError, objectValue, publicError, stringValue } from './errors.js';
import { executeInput } from './handlers/input.js';
import { executeAI } from './handlers/ai.js';
import { executeOutput } from './handlers/output.js';
import { executeResource } from './handlers/resource.js';
import { VerifiedMaterials } from './resources/verified-materials.js';
import { validateGuardrail, executeGuardrail } from './handlers/guardrail.js';
import { executePure, isRecoverableFailure, type RecoverableFailure } from './handlers/pure.js';
import { DurableGraph } from './execution/durable-graph.js';
import { executeModelDecision } from './handlers/model-decisions.js';
import { ChildScopeExecutor, compositeNode, ROOT_SCOPE, type ExecutionScope } from './execution/child-scopes.js';
import { interruption } from './execution/concurrency.js';
import { ArtifactStore } from './artifacts/store.js';
import { executeManagedFileOutput, executeManagedFileInput, validateManagedOutput } from './artifacts/file-handlers.js';
import { executeTextExtraction } from './artifacts/document-extract.js';
import { executeTaskAgent, proposePlan, validateTaskAgent, validateFixedTeam, validatePlanOnly } from './handlers/bounded-agents.js';
import { RunRagRuntime, type RunContextBuilder } from './rag/run-runtime.js';
import { RUN_RAG_CAPABILITIES, validateRunRagNode } from './rag/run-contract.js';
import { buildRunRagContext } from './rag/context-tokenizer.js';

export interface StartRequest { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> }
type Imported = Awaited<ReturnType<typeof inspectPackage>>;
interface MaterialSummary { alias: string; name: string; kind: string; revision: number; entrypoint: string; sha256: string; uses: string[] }
// Generic wait validation intentionally disallows all regex. ArtifactStore performs the full trusted FileRef validation.
const fileSelectionSchema = { ...fileRefSchema, properties: Object.fromEntries(Object.entries(fileRefSchema.properties).map(([key, schema]) => [key, Object.fromEntries(Object.entries(schema).filter(([name]) => name !== 'pattern'))])) };

/** Both HTTP and MCP use this service so their validation, identity, and execution semantics cannot diverge. */
export class RunnerService {
  readonly capabilities: string[] = [...BASIC_CAPABILITIES, 'node.resource@1', 'node.transform@1', 'node.condition@1', 'node.merge@1', 'node.evaluate@1', 'evaluate.rules@1', 'node.guardrail@1', 'node.error@1', 'node.form@1', 'node.review@1', 'node.classify@1', 'evaluate.model@1', 'node.subworkflow@1', 'node.loop@1', 'node.parallel@1', 'flow.local@1', 'loop.foreach@1', 'loop.until@1', 'parallel.all@1', 'node.file_input@1', 'node.file_output@1', 'file_output.text@1', 'file_output.markdown@1', 'file_output.json@1', 'file_output.csv@1', 'file_output.copy@1', 'node.memory@1', 'memory.run@1', 'node.skill@1', 'skill.instructions@1', 'node.agent@1', 'agent.task@1', 'agent.single_step@1', 'node.agent_team@1', 'agent_team.sequential@1', 'agent_team.parallel@1', 'node.orchestrator@1', 'orchestrator.plan@1'];
  private readonly packages = new Map<string, Imported>();
  private readonly active = new Map<string, AbortController>();
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly resumptions = new Map<string, Promise<void>>();
  private readonly waitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  private readonly broker: ModelBroker;
  private readonly artifacts: ArtifactStore;
  private rag?: RunRagRuntime;

  constructor(readonly store: RunStore, readonly credentials: CredentialStore, private readonly dataDirectory: string, provider: ModelProvider = new OpenAIResponsesProvider(), private readonly ragContextBuilder: RunContextBuilder = buildRunRagContext) {
    this.broker = new ModelBroker(store, credentials, provider);
    this.artifacts = new ArtifactStore(join(dataDirectory, 'artifacts'));
    this.capabilities.push('node.document_extract@1', 'document_extract.text@1', 'document_extract.builtin_utf8@1');
    this.capabilities.push(...RUN_RAG_CAPABILITIES.filter(capability => !capability.includes('retrieval') || ragContextBuilder !== undefined));
  }

  async importPackage(bytes: Uint8Array): Promise<{ packageHandle: string; name: string; manifest: unknown; trust: string; warnings: string[]; inputs: unknown; modelProfiles: string[]; materials: MaterialSummary[] }> {
    const inspected = await inspectPackage(bytes);
    const handle = `pkg_${randomUUID()}`;
    const directory = join(this.dataDirectory, 'packages');
    const filename = `${handle}.zip`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 });
    const name = inspected.workflow?.name ?? '자료 패키지';
    try {
      this.store.savePackage({ handle, filename, sha256: createHash('sha256').update(bytes).digest('hex'), name, createdAt: new Date().toISOString() });
    } catch (error) { await unlink(join(directory, filename)).catch(() => undefined); throw error; }
    this.packages.set(handle, inspected);
    return { packageHandle: handle, name, manifest: inspected.manifest, trust: inspected.trust, warnings: inspected.warnings, inputs: inspected.workflow?.inputs ?? {}, modelProfiles: Object.keys(inspected.workflow?.modelProfiles ?? {}), materials: this.materialSummaries(inspected) };
  }

  private async imported(handle: string): Promise<Imported> {
    const cached = this.packages.get(handle);
    if (cached) return cached;
    const record = this.store.getPackage(handle);
    // The filename originates in our import transaction, never in an incoming MCP path.
    if (!/^pkg_[a-f0-9-]+\.zip$/.test(record.filename)) throw new RunnerError('PACKAGE_RECORD_INVALID', '패키지 저장 기록이 올바르지 않습니다.');
    const bytes = await readFile(join(this.dataDirectory, 'packages', record.filename));
    if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new RunnerError('PACKAGE_CHANGED', '가져온 패키지가 변경되었습니다.');
    const inspected = await inspectPackage(bytes);
    this.packages.set(handle, inspected);
    return inspected;
  }

  async inspect(handle: string): Promise<unknown> {
    const imported = await this.imported(handle);
    return { packageHandle: handle, name: imported.workflow?.name ?? '자료 패키지', manifest: imported.manifest, trust: imported.trust, warnings: imported.warnings, inputs: imported.workflow?.inputs ?? {}, modelProfiles: Object.keys(imported.workflow?.modelProfiles ?? {}), materials: this.materialSummaries(imported) };
  }

  /** Inspection lists verified material identity and explicit consumers without executing or decoding payloads. */
  private materialSummaries(imported: Imported): MaterialSummary[] {
    const workflow = imported.workflow;
    if (!workflow) return [];
    return [...verifyResources(workflow.resources, imported.files)].map(([alias, descriptor]) => ({
      alias, name: descriptor.name, kind: descriptor.kind, revision: descriptor.revision, entrypoint: descriptor.entrypoint, sha256: workflow.resources[alias]!.sha256,
      uses: [workflow, ...Object.values(workflow.subworkflows)].flatMap((flow) => flow?.nodes ?? []).flatMap((node) => [
        ...node.attachments.filter((attachment) => attachment.resource === alias).map((attachment) => `${node.label}: ${attachment.role === 'instructions' ? '작업 지침' : attachment.role === 'reference' ? '참고 문서' : attachment.role === 'skill' ? 'Skill 지침' : attachment.role}`),
        ...(node.type === 'resource' && node.config.resource === alias ? [`${node.label}: 자료 읽기`] : []),
        ...(node.type === 'skill' && node.config.resource === alias ? [`${node.label}: ${node.config.mode === 'instructions' ? 'Skill 지침 묶음' : 'Skill 실행'}`] : []),
        ...Object.entries(node.inputBindings).filter(([, binding]) => binding?.from === 'resource' && binding.resource === alias).map(([name]) => `${node.label}: ${name} 입력`),
      ]),
    }));
  }

  /** Prepared means locally configured, not that a network call has been silently performed. */
  async validate(handle: string, modelBindings: Record<string, string>): Promise<{ ready: boolean; issues: ValidationIssue[] }> {
    const imported = await this.imported(handle);
    const shape = validateWorkflowShape(imported.workflow);
    if (!shape.valid) return { ready: false, issues: shape.issues };
    const workflow = shape.value;
    const issues = [...analyzeWorkflow(workflow)];
    const add = (code: string, message: string, instancePath = '') => issues.push({ severity: 'error', stage: 'readiness', code, message, instancePath });
    const needed = collectRequirements(workflow);
    for (const capability of needed.capabilities) if (!(this.capabilities as string[]).includes(capability)) add('CAPABILITY_MISSING', `이 Runner는 ${capability} 기능을 아직 지원하지 않습니다.`);
    try { new VerifiedMaterials(workflow, imported.files); }
    catch (error) { const detail = error instanceof ContractError ? error : publicError(error); add(detail.code, detail.message, '/resources'); }
    for (const [flowId, flow] of [['main', workflow], ...Object.entries(workflow.subworkflows)] as const) for (const node of flow?.nodes ?? []) {
      if (flowId !== 'main' && (node.type === 'review' || node.type === 'form' && node.config.mode === 'request')) add('CHILD_WAIT_UNSUPPORTED', '하위 흐름 안의 사용자 입력·검토 대기는 아직 지원하지 않습니다.', `/subworkflows/${flowId}/nodes/${node.id}`);
      if (flowId !== 'main' && node.type === 'file_input' && node.inputBindings.files?.from === 'literal' && Array.isArray(node.inputBindings.files.value) && !node.inputBindings.files.value.length) add('CHILD_WAIT_UNSUPPORTED', '파일을 루트 흐름에서 먼저 선택한 뒤 하위 흐름에 전달하세요.', `/subworkflows/${flowId}/nodes/${node.id}`);
      if (node.type === 'parallel' && new Set(node.config.branches.map((branch) => branch.id)).size !== node.config.branches.length) add('PARALLEL_BRANCH_DUPLICATE', '병렬 분기의 ID는 서로 달라야 합니다.', `/nodes/${node.id}/config/branches`);
      if (node.type === 'evaluate' && node.config.mode === 'rules' && !node.config.rules?.length) add('EVALUATION_RULES_REQUIRED', '규칙 평가에는 최소 하나의 규칙이 필요합니다.', `/nodes/${node.id}/config/rules`);
      if (node.type === 'classify' && node.config.labels.length > 100) add('CLASSIFICATION_LIMIT', '분류 라벨은 최대 100개까지 지원합니다.', `/nodes/${node.id}/config/labels`);
      if (node.type === 'guardrail') { try { validateGuardrail(node.config); } catch (error) { const detail = publicError(error); add(detail.code, detail.message, `/nodes/${node.id}/config`); } }
      if (node.type === 'knowledge' || node.type === 'retrieval') { try { validateRunRagNode(node); } catch (error) { const detail = publicError(error); add(detail.code, detail.message, `/nodes/${node.id}/config`); } }
      if (node.type === 'document_extract') { try { validateTextExtraction(node); } catch (error) { const detail = publicError(error); add(detail.code, detail.message, `/nodes/${node.id}/config`); } }
      if (node.type === 'agent' || node.type === 'agent_team' || node.type === 'orchestrator') {
        try { if (node.type === 'agent') validateTaskAgent(node); else if (node.type === 'agent_team') validateFixedTeam(node); else validatePlanOnly(node); }
        catch (error) { const detail = publicError(error); add(detail.code, detail.message, `/nodes/${node.id}/config`); }
      }
      if (node.type === 'file_output') {
        try { validateManagedOutput(node.config); } catch (error) { const detail = publicError(error); add(detail.code, detail.message, `/nodes/${node.id}/config`); }
        if (!Object.hasOwn(node.inputBindings, node.config.format === 'copy' ? 'file' : 'content')) add('FILE_BINDING_REQUIRED', '파일 내용 또는 복사할 파일을 연결하세요.', `/nodes/${node.id}/inputBindings`);
      }
      if (node.type === 'file_input' && (node.config.maxFiles > this.artifacts.limits.maxFilesPerRun || node.config.maxBytesPerFile > this.artifacts.limits.maxBytesPerFile)) add('FILE_LIMIT_UNSUPPORTED', '현재 Runner는 파일당 16 MiB, 실행당 100개 이하의 파일 입력을 지원합니다.', `/nodes/${node.id}/config`);
      if (node.type === 'memory') {
        if (node.config.scope !== 'run') add('MEMORY_SCOPE_UNSUPPORTED', '프로젝트 기억은 신뢰된 작업 공간 권한을 설정하기 전까지 지원하지 않습니다.', `/nodes/${node.id}/config/scope`);
        if (node.config.ttlMs !== undefined && (node.config.operation !== 'put' || !Number.isSafeInteger(node.config.ttlMs) || node.config.ttlMs > 2592000000)) add('MEMORY_TTL_INVALID', 'TTL은 저장 작업에서만 최대 30일로 지정할 수 있습니다.', `/nodes/${node.id}/config/ttlMs`);
        if (node.config.operation === 'put' && !Object.hasOwn(node.inputBindings, 'value')) add('MEMORY_VALUE_REQUIRED', '기억에 저장할 값을 연결하세요.', `/nodes/${node.id}/inputBindings`);
      }
      if (node.type === 'error') {
        if (node.inputBindings.error?.from !== 'error' || flow!.edges.some((edge) => edge.to.nodeId === node.id && edge.from.port !== 'error')) add('INVALID_ERROR_ROUTE', '오류 처리 블록은 오류 경로와 실제 오류 컨텍스트에 연결해야 합니다.', `/nodes/${node.id}`);
        if (node.config.mode === 'recover' && !Object.hasOwn(node.inputBindings, 'fallback')) add('ERROR_FALLBACK_REQUIRED', '오류 복구에는 명시적인 대체 결과가 필요합니다.', `/nodes/${node.id}/inputBindings`);
      }
    }
    for (const alias of needed.modelProfiles) {
      const declaration = workflow.modelProfiles[alias];
      if (!declaration || declaration.kind !== 'chat' || declaration.requiredFeatures.some((feature) => !['text', 'json', 'json_schema'].includes(feature))) {
        add('MODEL_CAPABILITY_MISSING', `${alias} 모델 요구 기능은 이 Runner에서 지원하지 않습니다.`, `/modelProfiles/${alias}`);
      }
      const profileId = modelBindings[alias];
      if (!profileId) { add('MODEL_PROFILE_REQUIRED', `${alias} 모델 연결을 선택하세요.`, `/modelProfiles/${alias}`); continue; }
      try { const profile = this.store.getProfile(profileId); if (!await this.credentials.has(profile.credentialRef)) add('CREDENTIAL_REQUIRED', `${alias} 인증정보를 설정하세요.`); }
      catch { add('MODEL_PROFILE_REQUIRED', `${alias} 모델 연결을 찾을 수 없습니다.`); }
    }
    return { ready: !issues.some((issue) => issue.severity === 'error'), issues };
  }

  listProfiles(): Omit<ModelProfile, 'credentialRef'>[] {
    return this.store.listProfiles().map(({ credentialRef: _reference, ...profile }) => profile);
  }

  async createProfile(value: unknown): Promise<Omit<ModelProfile, 'credentialRef'>> {
    const input = objectValue(value);
    const name = stringValue(input.name, '연결 이름', 120);
    const model = stringValue(input.model, '모델 ID', 120);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) throw new RunnerError('INVALID_MODEL', '모델 ID 형식이 올바르지 않습니다.');
    const apiKey = stringValue(input.apiKey, 'API 키', 65536);
    if (!this.credentials.available) throw new RunnerError('SECURE_STORE_UNAVAILABLE', '이 환경에서는 보안 저장소를 사용할 수 없습니다.');
    const id = `model_${randomUUID()}`;
    const credentialRef = `credential_${randomUUID()}`;
    await this.credentials.set(credentialRef, apiKey);
    try { this.store.saveProfile({ id, name, provider: 'openai', model, credentialRef }); }
    catch (error) { await this.credentials.delete(credentialRef); throw error; }
    return { id, name, provider: 'openai', model };
  }

  /** Duplicate requests are checked before network readiness to preserve idempotency after credential changes. */
  async start(request: StartRequest): Promise<{ runId: string; status: string }> {
    stringValue(request.requestId, '요청 ID', 128);
    const packageManifest = (await this.imported(request.packageHandle)).manifest;
    const requestHash = canonicalDigest({ packageDigest: canonicalDigest(packageManifest), inputs: request.inputs, modelBindings: request.modelBindings });
    const existing = this.store.findRequest(request.requestId, requestHash);
    if (existing) return { runId: existing.id, status: existing.status };
    const readiness = await this.validate(request.packageHandle, request.modelBindings);
    if (!readiness.ready) throw new RunnerError('WORKFLOW_NOT_READY', readiness.issues.find((issue) => issue.severity === 'error')?.message ?? '실행 준비가 필요합니다.');
    const workflow = (await this.imported(request.packageHandle)).workflow as Workflow;
    const materials = new VerifiedMaterials(workflow, (await this.imported(request.packageHandle)).files);
    if (!validateJsonValue(workflow.inputs, request.inputs).valid) throw new RunnerError('INPUT_INVALID', '입력이 프로젝트의 입력 형식과 일치하지 않습니다.');
    const modelProfiles: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [alias, id] of Object.entries(request.modelBindings)) {
      const profile = this.store.getProfile(id);
      modelProfiles[alias] = { id: profile.id, provider: profile.provider, model: profile.model };
    }
    const record = this.store.getPackage(request.packageHandle);
    const resolved = await createResolvedPlan(workflow, { packageHash: record.sha256 }, { modelProfiles });
    const plan = { resolved, workflow, modelProfiles };
    const planHash = canonicalDigest(plan);
    const limits = objectValue(objectValue(workflow.policy).limits);
    const run = this.store.createRun({ requestId: request.requestId, requestHash, packageHandle: request.packageHandle, planHash, plan, inputs: request.inputs, modelBindings: request.modelBindings, nodeIds: workflow.nodes.map((node) => node.id), edges: workflow.edges, maxModelCalls: Number(limits.maxModelCalls), maxTotalTokens: Number(limits.maxTotalTokens) });
    if (run.status === 'created') this.launch(run.id, workflow, request, materials);
    return { runId: run.id, status: run.status };
  }

  private launch(runId: string, workflow: Workflow, request: StartRequest, materials: VerifiedMaterials): void {
    if (this.active.has(runId) || this.closing) return;
    const controller = new AbortController(); this.active.set(runId, controller);
    const task = Promise.resolve().then(() => this.execute(runId, workflow, request, controller, materials)).finally(() => { this.active.delete(runId); this.tasks.delete(runId); });
    this.tasks.set(runId, task);
  }

  status(runId: string): RunRecord & { nodes: { nodeId: string; status: string }[]; edges: ReturnType<RunStore['graphState']>['edges']; waits: WaitRecord[]; childScopes: Omit<ChildScopeRecord, 'input' | 'result'>[]; childScopeCount: number; files: ReturnType<RunStore['listArtifacts']> } {
    const graph = this.store.graphState(runId);
    const children = this.store.childScopeSummary(runId);
    return { ...this.store.getRun(runId), nodes: graph.nodes.map(({ nodeId, status }) => ({ nodeId, status })), edges: graph.edges, waits: this.store.listWaits(runId).filter((wait) => ['pending', 'responded'].includes(wait.state)), childScopes: children.scopes, childScopeCount: children.total, files: this.store.listArtifacts(runId) };
  }
  events(runId: string, after = 0) { return this.store.listEvents(runId, after); }
  results(runId: string): { runId: string; status: string; result: unknown; usage: RunRecord['usage']; files: ReturnType<RunStore['listArtifacts']> } {
    const run = this.store.getRun(runId);
    return { runId, status: run.status, result: run.result, usage: run.usage, files: this.store.listArtifacts(runId) };
  }

  /** A download resolves a registered current-run identity, never a relativePath supplied by a client. */
  readArtifact(runId: string, fileId: string) {
    this.store.getRun(runId); const registered = this.store.getArtifact(runId, fileId);
    this.artifacts.resolve(runId, registered.reference); return this.artifacts.read(runId, fileId);
  }

  /** File selection is tied to a durable wait and immutable node config; browser metadata never grants an OS path. */
  private fileWaitNode(runId: string, waitId: string): Extract<WorkflowNode, { type: 'file_input' }> {
    const wait = this.store.getWait(waitId); if (wait.runId !== runId || wait.kind !== 'files') throw new RunnerError('WAIT_SCOPE_DENIED', '이 실행의 파일 선택 대기가 아닙니다.', 403);
    const saved = this.store.getExecution(runId); const plan = objectValue(saved.plan);
    if (wait.planHash !== saved.planHash || canonicalDigest(plan) !== saved.planHash) throw new RunnerError('PLAN_CHANGED', '파일 선택의 실행 계획이 변경되었습니다.');
    const checked = validateWorkflowShape(plan.workflow); const node = checked.valid ? checked.value.nodes.find((value) => value.id === wait.nodeId) : undefined;
    if (!node || node.type !== 'file_input') throw new RunnerError('WAIT_NODE_INVALID', '파일 선택 블록을 확인하지 못했습니다.'); return node;
  }

  fileUploadLimit(runId: string, waitId: string): number {
    this.store.expireWait(waitId); const node = this.fileWaitNode(runId, waitId); const wait = this.store.getWait(waitId);
    if (wait.state !== 'pending' || this.store.getRun(runId).status !== 'waiting') throw new RunnerError('WAIT_NOT_PENDING', '파일 선택 대기가 종료되었습니다.', 409);
    return Math.min(node.config.maxBytesPerFile, this.artifacts.limits.maxBytesPerFile);
  }

  /** Only the cookie+CSRF browser endpoint calls this method, after an explicit user file selection. */
  uploadWaitFile(runId: string, waitId: string, requestId: string, filename: string, mimeType: string, bytes: Uint8Array): FileRef {
    const limit = this.fileUploadLimit(runId, waitId); const node = this.fileWaitNode(runId, waitId);
    stringValue(requestId, '파일 업로드 ID', 128);
    if (!node.config.mimeTypes.includes(mimeType) || bytes.length > limit) throw new RunnerError('FILE_FILTER_REJECTED', '파일 형식 또는 크기가 이 작업의 허용 범위와 다릅니다.');
    const operationId = `upload_${canonicalDigest({ waitId, requestId })}`;
    const uploaded = this.store.listArtifacts(runId).filter((record) => record.waitId === waitId && record.source === 'user_upload');
    if (!uploaded.some((record) => record.operationId === operationId) && uploaded.length >= node.config.maxFiles) throw new RunnerError('FILE_COUNT_INVALID', '이 작업에서 선택할 수 있는 파일 개수를 초과했습니다.');
    const reference = this.artifacts.put(runId, { operationId, filename, mimeType, bytes });
    this.store.registerArtifact(runId, { reference, operationId, source: 'user_upload', waitId }); return reference;
  }
  cancel(runId: string): RunRecord {
    const run = this.store.requestCancel(runId);
    if (run.cancelRequested) this.active.get(runId)?.abort();
    for (const wait of this.store.listWaits(runId)) { clearTimeout(this.waitTimers.get(wait.id)); this.waitTimers.delete(wait.id); }
    return run;
  }

  /** Only the authenticated local browser response route calls this method; MCP has no answering tool. */
  respondWait(runId: string, waitId: string, value: unknown): { waitId: string; state: string; runId: string } {
    const input = objectValue(value);
    if (Object.keys(input).some((key) => !['requestId', 'response', 'decision'].includes(key)) || !Object.hasOwn(input, 'response')) throw new RunnerError('INVALID_WAIT_RESPONSE', '응답 ID·응답 본문·검토 결정만 전달할 수 있습니다.');
    const requestId = stringValue(input.requestId, '응답 ID', 128);
    if (this.store.getWait(waitId).kind === 'files') {
      const node = this.fileWaitNode(runId, waitId);
      if (!Array.isArray(input.response)) throw new RunnerError('FILE_COUNT_INVALID', '선택한 파일 목록이 필요합니다.');
      for (const reference of input.response) { const id = stringValue(objectValue(reference).id, '파일 ID', 100); const record = this.store.getArtifact(runId, id); if (record.source !== 'user_upload' || record.waitId !== waitId) throw new RunnerError('FILE_SELECTION_DENIED', '이 대기에서 사용자가 업로드한 파일만 선택할 수 있습니다.', 403); }
      executeManagedFileInput(node, { files: input.response }, { store: this.artifacts, runId });
    }
    if (input.decision !== undefined && input.decision !== 'accepted' && input.decision !== 'rejected') throw new RunnerError('REVIEW_DECISION_INVALID', '수락 또는 거절을 선택하세요.');
    const wait = this.store.acceptWaitResponse(runId, waitId, requestId, input.response, input.decision);
    clearTimeout(this.waitTimers.get(waitId)); this.waitTimers.delete(waitId);
    if (wait.state === 'responded') this.queueResume(wait);
    return { waitId, state: wait.state, runId };
  }

  /** Reopening a daemon restores the same unanswered waits; only an already committed response may continue. */
  async restoreWaitingRuns(): Promise<void> {
    for (const wait of this.store.listWaits()) {
      if (this.store.getRun(wait.runId).status !== 'waiting') continue;
      if (wait.state === 'responded') this.queueResume(wait); else this.scheduleWait(wait);
    }
  }

  private scheduleWait(wait: WaitRecord): void {
    if (this.closing) return;
    clearTimeout(this.waitTimers.get(wait.id));
    const timer = setTimeout(() => {
      this.waitTimers.delete(wait.id);
      if (this.closing) return;
      if (!this.store.expireWait(wait.id)) { const current = this.store.getWait(wait.id); if (current.state === 'pending') this.scheduleWait(current); }
    }, Math.max(1, Math.min(60000, Date.parse(wait.expiresAt) - Date.now())));
    timer.unref(); this.waitTimers.set(wait.id, timer);
  }

  private queueResume(wait: WaitRecord): void {
    if (this.resumptions.has(wait.runId) || this.closing) return;
    const work = (async () => {
      const run = this.store.getRun(wait.runId); if (run.status !== 'waiting') return;
      const saved = this.store.getExecution(run.id); const plan = objectValue(saved.plan);
      if (canonicalDigest(plan) !== saved.planHash || wait.planHash !== saved.planHash) throw new RunnerError('PLAN_CHANGED', '고정한 실행 계획과 대기 정보가 다릅니다.');
      const checked = validateWorkflowShape(plan.workflow); if (!checked.valid) throw new RunnerError('PLAN_CHANGED', '저장된 실행 계획을 검사하지 못했습니다.');
      const imported = await this.imported(run.packageHandle);
      if (canonicalDigest(imported.workflow) !== canonicalDigest(checked.value)) throw new RunnerError('PLAN_CHANGED', '저장된 계획과 운영 패키지가 다릅니다.');
      const materials = new VerifiedMaterials(checked.value, imported.files);
      if (this.closing || this.store.getRun(run.id).status !== 'waiting') return;
      const current = this.store.getWait(wait.id); if (current.state !== 'responded') return;
      const node = checked.value.nodes.find((node) => node.id === wait.nodeId);
      if (!node || (node.type !== 'form' && node.type !== 'review' && node.type !== 'file_input')) throw new RunnerError('WAIT_NODE_INVALID', '대기 중인 블록을 찾을 수 없습니다.');
      const output: NodeOutput = node.type === 'file_input' ? executeManagedFileInput(node, { files: current.response }, { store: this.artifacts, runId: run.id }) : { data: current.kind === 'review' ? { decision: current.decision, feedback: current.response } : current.response };
      // Response consumption and its outgoing edge decision are atomic, so completed nodes never rerun after restart.
      new DurableGraph(run.id, checked.value, this.store).complete(node, current.kind === 'review' ? current.decision! : 'next', output, 'succeeded', current.id);
      this.launch(run.id, checked.value, { packageHandle: run.packageHandle, requestId: run.requestId, inputs: saved.inputs, modelBindings: saved.modelBindings }, materials);
    })().catch((error: unknown) => {
      const run = this.store.getRun(wait.runId);
      if (run.status === 'waiting' || run.status === 'running') { this.store.stopPendingNodes(run.id, 'blocked'); this.store.transitionRun(run.id, 'failed', { error: publicError(error) }); }
    }).finally(() => { this.resumptions.delete(wait.runId); });
    this.resumptions.set(wait.runId, work);
  }

  /** Shutdown drains in-flight calls; interruption never turns into an automatic replay. */
  async shutdown(): Promise<void> {
    this.closing = true; for (const timer of this.waitTimers.values()) clearTimeout(timer); this.waitTimers.clear();
    for (const [id, controller] of this.active) { if (this.store.getRun(id).status !== 'waiting') { this.store.requestCancel(id); controller.abort(); } }
    await this.waitForIdle();
    this.rag?.close();
  }

  async waitForIdle(): Promise<void> { while (this.tasks.size || this.resumptions.size) await Promise.allSettled([...this.tasks.values(), ...this.resumptions.values()]); }

  private async execute(runId: string, workflow: Workflow, request: StartRequest, controller: AbortController, materials: VerifiedMaterials): Promise<void> {
    const outputs: Record<string, NodeOutput> = Object.create(null) as Record<string, NodeOutput>;
    const persisted = this.store.graphState(runId);
    for (const record of persisted.nodes) if (record.status === 'succeeded' && record.result !== null) outputs[record.nodeId] = record.result as NodeOutput;
    const errors = new Map<string, RecoverableFailure>();
    const graph = new DurableGraph(runId, workflow, this.store);
    const limits = workflow.policy.limits;
    const remainingMs = Math.max(0, limits.maxActiveMs - this.store.getRun(runId).activeMs);
    const expiresAt = performance.now() + remainingMs;
    const deadline = setTimeout(() => controller.abort(new RunnerError('BUDGET_EXCEEDED', '활성 실행 시간 한도를 초과했습니다.')), remainingMs);
    // Children retain the root budget and resources, but input/output schemas and node identities belong to their flow.
    const children: ChildScopeExecutor = new ChildScopeExecutor({ runId, workflow, store: this.store, resources: materials.views, expiresAt,
      runNode: (node, inputs, flow, flowInput, scope, signal, failure) => this.attemptNode(runId, node, inputs, { ...request, inputs: flowInput }, { ...workflow, ...flow }, signal, materials, expiresAt, children, scope, failure),
    });
    let current: WorkflowNode | undefined;
    let checkpoint = performance.now(); let segmentActive = false;
    const account = (stop = false) => { const point = performance.now(); this.store.checkpointActiveTime(runId, Math.max(0, point - checkpoint), stop); checkpoint = point; if (stop) segmentActive = false; };
    try {
      if (this.store.getRun(runId).cancelRequested) { this.store.stopPendingNodes(runId, 'cancelled'); this.store.transitionRun(runId, 'cancelled'); return; }
      if (this.store.getRun(runId).status !== 'running') this.store.transitionRun(runId, 'running');
      this.store.beginActiveSegment(runId); checkpoint = performance.now(); segmentActive = true;
      while ((current = graph.next())) {
        const node = current;
        if (controller.signal.aborted || this.store.getRun(runId).cancelRequested) {
          if (controller.signal.reason instanceof RunnerError) throw controller.signal.reason;
          throw new RunnerError('RUN_CANCELLED', '실행이 취소되었습니다.');
        }
        if (performance.now() >= expiresAt) throw new RunnerError('BUDGET_EXCEEDED', '활성 실행 시간 한도를 초과했습니다.');
        this.store.claimNode(runId, node.id, limits.maxNodeInstances);
        this.store.transitionNode(runId, node.id, 'ready');
        try {
          const inputs = resolveBindings(node, { workflowInput: request.inputs, nodeOutputs: outputs, resources: materials.views, ...(errors.has(node.id) ? { error: errors.get(node.id) } : {}) });
          if ((node.type === 'form' && node.config.mode === 'request') || node.type === 'review' || node.type === 'file_input' && Array.isArray(inputs.files) && !inputs.files.length) {
            if (performance.now() >= expiresAt) throw new RunnerError('BUDGET_EXCEEDED', '활성 실행 시간 한도를 초과하여 대기를 시작할 수 없습니다.');
            const attemptId = this.store.beginAttempt(runId, node.id);
            const fileSelection = node.type === 'file_input';
            const wait = this.store.createWait({ runId, nodeId: node.id, attemptId, kind: fileSelection ? 'files' : node.type === 'review' ? 'review' : 'input', title: fileSelection ? node.label : node.type === 'review' ? node.config.question : node.config.title, schema: fileSelection ? { type: 'array', items: fileSelectionSchema, minItems: 1, maxItems: node.config.maxFiles } : node.type === 'review' ? node.config.responseSchema : node.config.mode === 'request' ? node.config.schema : workflow.inputs, context: fileSelection ? { ...node.config, maxBytesPerFile: Math.min(node.config.maxBytesPerFile, this.artifacts.limits.maxBytesPerFile) } : inputs, ttlMs: node.execution.waitTtlMs ?? 86400000, activeMs: Math.max(0, performance.now() - checkpoint) });
            segmentActive = false; this.scheduleWait(wait); return;
          }
          const { output, port } = await this.attemptNode(runId, node, inputs, request, workflow, controller.signal, materials, expiresAt, children, ROOT_SCOPE, errors.get(node.id));
          outputs[node.id] = output;
          graph.complete(node, node.type === 'output' ? undefined : port, output);
          account();
          if (this.store.getRun(runId).activeMs > limits.maxActiveMs) throw new RunnerError('BUDGET_EXCEEDED', '누적 활성 실행 시간 한도를 초과했습니다.');
          if (node.type === 'output') {
            if (this.store.getRun(runId).cancelRequested) this.store.transitionRun(runId, 'cancelled');
            else this.store.transitionRun(runId, 'succeeded', { result: output });
            return;
          }
        } catch (error) {
          const detail = error instanceof ModelError ? { code: error.code, message: error.message } : publicError(error);
          const unknown = error instanceof ModelError && error.outcome === 'unknown' || detail.code === 'RAG_RECONCILIATION_REQUIRED';
          // Only confirmed data failures may use error edges; protected stops cannot be recovered by graph wiring.
          if (node.execution.onError !== 'route' || !isRecoverableFailure(detail.code) || unknown || controller.signal.aborted || this.store.getRun(runId).cancelRequested) throw error;
          const target = workflow.edges.find((edge) => edge.from.nodeId === node.id && edge.from.port === 'error')!.to.nodeId;
          errors.set(target, { ...detail, nodeId: node.id, recoverable: true });
          graph.complete(node, 'error', undefined, 'handled_error');
          account();
        }
      }
      throw new RunnerError('CONTROL_STALLED', '활성 경로가 최종 결과에 도달하지 못했습니다.');
    } catch (error) {
      const detail = error instanceof ModelError ? { code: error.code, message: error.message } : publicError(error);
      const unknown = error instanceof ModelError && error.outcome === 'unknown' || detail.code === 'RAG_RECONCILIATION_REQUIRED';
      const cancelled = !unknown && this.store.getRun(runId).cancelRequested;
      const blocked = ['BUDGET_EXCEEDED', 'GUARDRAIL_BLOCKED', 'UPSTREAM_BLOCKED', 'TRANSFORM_LIMIT', 'EXPRESSION_LIMIT', 'LOOP_LIMIT', 'CHILD_RESULT_LIMIT', 'FLOW_RECURSION', 'FLOW_DEPTH_EXCEEDED', 'MEMORY_QUOTA_EXCEEDED', 'PLAN_SIZE_LIMIT', 'RAG_BUDGET_EXCEEDED', 'RAG_INPUT_LIMIT', 'RAG_STORE_QUOTA', 'RAG_GENERATION_LIMIT', 'CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_TEXT_LIMIT'].includes(detail.code);
      if (current) this.store.transitionNode(runId, current.id, unknown ? 'reconciling' : cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed');
      this.store.stopPendingNodes(runId, cancelled ? 'cancelled' : 'blocked');
      this.store.transitionRun(runId, unknown ? 'attention_required' : cancelled ? 'cancelled' : blocked ? 'blocked' : 'failed', { error: detail });
    } finally { clearTimeout(deadline); if (segmentActive) account(true); }
  }

  /** Attempts retain provider retry, reservation and cancellation boundaries while adding pure handlers. */
  private async attemptNode(runId: string, node: WorkflowNode, inputs: Record<string, unknown>, request: StartRequest, workflow: Workflow, parentSignal: AbortSignal, materials: VerifiedMaterials, expiresAt: number, children: ChildScopeExecutor, scope: ExecutionScope, failure?: RecoverableFailure): Promise<{ output: NodeOutput; port: string }> {
    const storedId = scopedKey(scope.id, node.id); const composite = compositeNode(node);
    for (let attempt = 1; attempt <= node.execution.retry.maxAttempts; attempt++) {
      if (parentSignal.aborted) throw interruption(parentSignal);
      // Queueing consumes global active time but no leaf execution permit or model reservation.
      const release = composite ? () => undefined : await children.concurrency.acquire(parentSignal);
      const attemptId = this.store.beginAttempt(runId, storedId); const started = performance.now();
      const timeout = AbortSignal.timeout(node.execution.timeoutMs); const signal = AbortSignal.any([parentSignal, timeout]);
      let retry = false;
      try {
        this.store.transitionNode(runId, storedId, composite ? 'waiting_children' : 'running');
        let output: NodeOutput; let port = 'next';
        if (composite) output = await children.execute(node, inputs, scope, signal);
        else if (node.type === 'input') output = executeInput(request.inputs);
        else if (node.type === 'form' && node.config.mode === 'initial') output = executeInput(request.inputs);
        else if (node.type === 'output') output = executeOutput(inputs.result, workflow.outputs);
        else if (node.type === 'resource') output = executeResource(materials, node.config.resource, node.config.pointer);
        else if (node.type === 'skill') output = materials.skill(node, inputs);
        else if (node.type === 'memory') {
          if (node.config.scope !== 'run') throw new RunnerError('MEMORY_SCOPE_UNSUPPORTED', '현재 실행의 기억만 사용할 수 있습니다.');
          output = { data: this.store.runMemory(runId, { operationId: `memory_${canonicalDigest({ nodeInstance: `${runId}:${storedId}`, operation: node.config.operation })}`, operation: node.config.operation, key: stringValue(inputs.key, '기억 키', 256), ...(node.config.operation === 'put' ? { value: inputs.value } : {}), ...(node.config.ttlMs === undefined ? {} : { ttlMs: node.config.ttlMs }) }) };
        }
        else if (node.type === 'file_output') {
          if (node.config.format === 'copy') { const value = objectValue(inputs.file); this.readArtifact(runId, stringValue(value.id, '파일 ID', 100)); }
          const operationId = `node_${canonicalDigest({ nodeInstance: `${runId}:${storedId}`, operation: 'file_output' })}`;
          output = executeManagedFileOutput(node, inputs, { store: this.artifacts, runId, operationId });
          for (const reference of output.files ?? []) this.store.registerArtifact(runId, { reference, operationId, source: 'node_output', waitId: null });
        }
        else if (node.type === 'file_input') {
          if (!Array.isArray(inputs.files) || !inputs.files.length) throw new RunnerError('CHILD_WAIT_UNSUPPORTED', '파일을 루트 흐름에서 먼저 선택하세요.');
          for (const reference of inputs.files) this.readArtifact(runId, stringValue(objectValue(reference).id, '파일 ID', 100));
          output = executeManagedFileInput(node, inputs, { store: this.artifacts, runId });
        }
        else if (node.type === 'document_extract') {
          // Managed bytes must also be registered to this run; a well-shaped FileRef is never authority.
          this.readArtifact(runId, stringValue(objectValue(inputs.file).id, '파일 ID', 100));
          output = executeTextExtraction(node, inputs, { store: this.artifacts, runId });
        }
        else if (node.type === 'knowledge' || node.type === 'retrieval') {
          // FileRef resolution checks both the immutable artifact bytes and this run's durable registration.
          this.rag ??= new RunRagRuntime(join(this.dataDirectory, 'rag'), (id, reference) => {
            const resolved = this.artifacts.resolve(id, reference); return this.readArtifact(id, resolved.id);
          }, this.ragContextBuilder);
          output = await this.rag.execute(runId, storedId, node, inputs, { signal, checkpoint: () => {
            if (signal.aborted) throw interruption(signal);
            if (this.store.getRun(runId).cancelRequested) throw new RunnerError('RUN_CANCELLED', '실행이 취소되었습니다.');
            if (performance.now() >= expiresAt || performance.now() - started > node.execution.timeoutMs) throw new RunnerError('BUDGET_EXCEEDED', '지식·검색 작업의 실행 시간 한도를 초과했습니다.');
          } });
        }
        else if (node.type === 'guardrail') output = executeGuardrail(inputs.value, node.config);
        else if (node.type === 'agent') output = await executeTaskAgent(node, inputs, async (alias, modelRequest) => {
          const profileId = request.modelBindings[alias]; if (!profileId) throw new RunnerError('MODEL_PROFILE_REQUIRED', '모델 연결이 필요합니다.');
          return this.broker.invoke(runId, storedId, this.store.getProfile(profileId), modelRequest, signal);
        }, materials.additions(node));
        else if (node.type === 'orchestrator') {
          const tasks = await proposePlan(node, inputs, workflow, async (alias, modelRequest) => {
            const profileId = request.modelBindings[alias]; if (!profileId) throw new RunnerError('MODEL_PROFILE_REQUIRED', '모델 연결이 필요합니다.');
            return this.broker.invoke(runId, storedId, this.store.getProfile(profileId), modelRequest, signal);
          });
          if (signal.aborted) throw interruption(signal);
          output = { data: { planHistory: [this.store.savePlanProposal(runId, storedId, tasks)], taskResults: [], stopReason: 'planned' } };
        }
        else if (node.type === 'ai') output = await executeAI(inputs, objectValue(node.config), async (alias, modelRequest) => {
          const profileId = request.modelBindings[alias];
          if (!profileId) throw new RunnerError('MODEL_PROFILE_REQUIRED', '모델 연결이 필요합니다.');
          return this.broker.invoke(runId, storedId, this.store.getProfile(profileId), modelRequest, signal);
        }, materials.additions(node));
        else if (node.type === 'classify' || node.type === 'evaluate' && node.config.mode === 'model') ({ output, port } = await executeModelDecision(node, inputs, async (alias, modelRequest) => {
          const profileId = request.modelBindings[alias];
          if (!profileId) throw new RunnerError('MODEL_PROFILE_REQUIRED', '모델 연결이 필요합니다.');
          return this.broker.invoke(runId, storedId, this.store.getProfile(profileId), modelRequest, signal);
        }));
        else ({ output, port } = executePure(node, inputs, failure));
        if (signal.aborted) throw interruption(signal);
        // Monotonic elapsed checks also cover synchronous work that cannot yield to the timeout timer.
        if (performance.now() >= expiresAt || performance.now() - started > node.execution.timeoutMs) throw new RunnerError('BUDGET_EXCEEDED', '실행 시간 한도를 초과하여 후속 작업을 차단했습니다.');
        if (this.store.getRun(runId).usage.consumedTokens > workflow.policy.limits.maxTotalTokens) throw new RunnerError('BUDGET_EXCEEDED', '확인된 실제 사용량이 토큰 한도를 초과하여 후속 작업을 차단했습니다.');
        this.store.finishAttempt(runId, attemptId, 'succeeded'); return { output, port };
      } catch (error) {
        const detail = error instanceof ModelError ? { code: error.code, message: error.message } : publicError(error);
        this.store.finishAttempt(runId, attemptId, 'failed', detail);
        const allowed = (node.execution.retry.retryOn as readonly string[]).includes(detail.code);
        // A whole child graph is never replayed because a descendant happened to report a retryable failure.
        if (composite || !(error instanceof ModelError && error.outcome === 'not_started' && error.retryable && allowed && attempt < node.execution.retry.maxAttempts) || parentSignal.aborted) throw error;
        retry = true;
      } finally { release(); }
      if (retry) {
        this.store.transitionNode(runId, storedId, 'retry_wait');
        await new Promise<void>((resolveWait, reject) => {
          const abort = () => { clearTimeout(timer); parentSignal.removeEventListener('abort', abort); reject(interruption(parentSignal)); };
          const timer = setTimeout(() => { parentSignal.removeEventListener('abort', abort); resolveWait(); }, node.execution.retry.backoffMs);
          parentSignal.addEventListener('abort', abort, { once: true });
          if (parentSignal.aborted) abort();
        });
      }
    }
    throw new RunnerError('OUTPUT_INVALID', '노드 결과를 생성하지 못했습니다.');
  }
}
