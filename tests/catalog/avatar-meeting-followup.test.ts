import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { validateJsonValue, validateWorkflowShape } from '@studio/spec';
import { analyzeWorkflow, evaluateRules } from '@studio/workflow-core';
import { buildMaterialsPackage, buildPackage, canonicalDigest, inspectPackage, prepareAuthoringImport, verifyResources, type TargetHost } from '@studio/package-kit';
import { createAvatarMeetingProject, avatarMeetingDirectory, meetingSample } from '../../tooling/catalog/materialize-avatar-meeting-followup.js';
import { RunnerService } from '../../apps/runner/src/service.js';
import { RunStore } from '../../apps/runner/src/state/store.js';
import type { CredentialStore } from '../../apps/runner/src/security/credential-store.js';
import type { ModelProvider, ModelRequest } from '../../apps/runner/src/providers/model-provider.js';

// Promoted after the R-01 integration checkpoint; these are operational-control regressions, not live quality evidence.
// The responses below are test-only boundary data, never published examples or actual model/host quality evidence.
function proposedDraft() {
  return {
    status: 'draft_ready', summary: '안내 문구 초안과 작은 글씨 확인을 검토할 후속 업무로 정리했습니다.',
    actions: [
      { id: 'A1', action: '쉬운 제목의 반납 안내 문구 초안 작성', evidenceQuote: '결정 D1: 자료 반납 안내의 제목을 쉬운 말로 바꾼다. 운영 담당 역할이 2026-10-30까지 안내 문구 초안을 작성하기로 했다.', owner: '운영 담당 역할', ownerStatus: 'stated', due: '2026-10-30', dueStatus: 'stated', missing: [] },
      { id: 'A2', action: '안내판의 작은 글씨 문제 확인', evidenceQuote: '결정 D2: 안내판의 작은 글씨 문제를 확인한다. 누가 맡을지와 확인 기한은 정하지 않았다.', owner: null, ownerStatus: 'unknown', due: null, dueStatus: 'unknown', missing: ['owner', 'due'] },
    ], unresolved: ['예약 서비스는 제안이며 도입 결정이 없습니다.'], limits: ['제공된 가상 회의 본문만 사용하며 외부 업무를 수행하지 않았습니다.'],
  };
}
const confirmed = () => ({ evidenceVerified: true, unknownsPreserved: true, notes: '테스트 경계에서 원문 대조 수락 응답을 제출합니다.' });
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const occurrences = (source: string, exact: string) => source.split(exact).length - 1;
function resultData(run: { result?: unknown }): Record<string, unknown> {
  if (!run.result || typeof run.result !== 'object' || !('data' in run.result) || !run.result.data || typeof run.result.data !== 'object' || Array.isArray(run.result.data)) throw new Error('Expected a real object-valued node result');
  return run.result.data as Record<string, unknown>;
}
type Project = Awaited<ReturnType<typeof createAvatarMeetingProject>>;
interface Fixture {
  directory: string; store: RunStore; service: RunnerService; credentials: CredentialStore; provider: ModelProvider;
  project: Project; counts: ModelRequest[]; calls: ModelRequest[];
  request: { packageHandle: string; requestId: string; inputs: unknown; modelBindings: Record<string, string> };
}
const fixtures: Fixture[] = [];

/** Exercise the operational definition and real SQLite/managed files, replacing only credentials and model I/O in tests. */
async function setup(options: { host?: TargetHost; response?: unknown; configured?: boolean; malformed?: boolean } = {}): Promise<Fixture> {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No external requests are permitted in the supplemental regression'); }));
  const project = await createAvatarMeetingProject(), directory = await mkdtemp(join(tmpdir(), 'studio-avatar-meeting-test-'));
  const store = new RunStore(join(directory, 'state.sqlite')), secrets = new Map<string, string>();
  const credentials: CredentialStore = { available: options.configured !== false, async set(id, value) { secrets.set(id, value); }, async get(id) { const secret = secrets.get(id); if (!secret) throw new Error('No test credential'); return secret; }, async has(id) { return secrets.has(id); }, async delete(id) { secrets.delete(id); } };
  const counts: ModelRequest[] = [], calls: ModelRequest[] = [];
  const provider: ModelProvider = {
    async countInputTokens(request) { counts.push(structuredClone(request)); if (options.configured === false) throw new Error('Unconfigured model must never count'); return 100; },
    async generate(request) { calls.push(structuredClone(request)); if (options.configured === false) throw new Error('Unconfigured model must never generate'); return { text: options.malformed ? '{' : JSON.stringify({ resultJson: JSON.stringify(options.response ?? proposedDraft()) }), usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } }; },
  };
  const service = new RunnerService(store, credentials, directory, provider);
  const fixture: Fixture = { directory, store, service, credentials, provider, project, counts, calls, request: { packageHandle: '', requestId: 'meeting-once', inputs: structuredClone(meetingSample), modelBindings: {} } };
  fixtures.push(fixture);
  if (options.configured !== false) {
    const profile = await service.createProfile({ name: 'test-only-meeting-profile', model: 'contract-model', apiKey: 'test-only-fixed-secret' });
    fixture.request.modelBindings.meeting_model = profile.id;
  }
  const archive = await buildPackage({ host: options.host ?? 'codex', workflow: project.workflow, resources: project.resourceFiles });
  fixture.request.packageHandle = (await service.importPackage(archive.bytes)).packageHandle;
  return fixture;
}
async function start(fixture: Fixture) {
  const started = await fixture.service.start(fixture.request); await fixture.service.waitForIdle(); return fixture.service.status(started.runId);
}
async function review(fixture: Fixture, runId: string, waitId: string, decision: 'accepted' | 'rejected', response = confirmed(), requestId = 'meeting-review') {
  fixture.service.respondWait(runId, waitId, { requestId, response, decision }); await fixture.service.waitForIdle(); return fixture.service.status(runId);
}
/** Reopen the actual durable state with the same test credential store; restoring a wait cannot rerun the model. */
async function restart(fixture: Fixture) {
  await fixture.service.shutdown(); fixture.store.close(); fixture.store = new RunStore(join(fixture.directory, 'state.sqlite'));
  fixture.store.recoverInterruptedRuns(); fixture.service = new RunnerService(fixture.store, fixture.credentials, fixture.directory, fixture.provider); await fixture.service.restoreWaitingRuns();
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.service.shutdown(); fixture.store.close();
    const path = resolve(fixture.directory);
    if (dirname(path) !== resolve(tmpdir()) || !path.includes('studio-avatar-meeting-test-')) throw new Error('Unsafe cleanup path');
    await rm(path, { recursive: true, force: true });
  }
  vi.unstubAllGlobals();
});

describe('supplemental meeting task originals and package boundary', () => {
  it('preserves every authored byte, one task, all completion criteria and original MIT resources', async () => {
    const project = await createAvatarMeetingProject();
    for (const [path, expected] of Object.entries(project.files)) expect(new Uint8Array(await readFile(join(avatarMeetingDirectory, path)))).toEqual(expected);
    expect(validateWorkflowShape(project.workflow).valid).toBe(true); expect(analyzeWorkflow(project.workflow)).toEqual([]);
    expect(validateJsonValue(project.workflow.inputs, project.sample).valid).toBe(true);
    expect(project.workflow.workDefinition!.task.criterionIds).toEqual(project.workflow.completion!.criteria.map(criterion => criterion.id));
    expect(project.workflow.workDefinition!.harness.selectedContext).toEqual(['judgment', 'template', 'procedure']);
    const descriptors = verifyResources(project.workflow.resources, new Map(Object.entries(project.resourceFiles)));
    expect(descriptors.size).toBe(3); for (const descriptor of descriptors.values()) { expect(descriptor.license.id).toBe('MIT'); expect(descriptor.requiredConnections).toEqual([]); expect(descriptor.dependencies).toEqual({}); }
    expect(project.readme).toContain('partial'); expect(project.readme).toContain('unverified');
    expect(Object.keys(project.files).some(path => /(?:^|\/)(?:node_modules|tests|fixtures|\.env)(?:\/|$)/.test(path))).toBe(false);
    expect(Object.values(project.files).some(value => decode(value).includes('test-only-fixed-secret'))).toBe(false);
  });

  it.each(['codex', 'claude-code', 'opencode'] as const)('preserves %s workflow pins and separate native materials without host verification claims', async host => {
    const project = await createAvatarMeetingProject(), built = await buildPackage({ host, workflow: project.workflow, resources: project.resourceFiles });
    const inspected = await inspectPackage(built.bytes), snapshot = await prepareAuthoringImport(built.bytes);
    expect(inspected.workflow).toEqual(project.workflow); expect(snapshot.resourceFiles).toEqual(project.resourceFiles);
    expect(inspected.manifest.requiredCapabilities).toEqual(expect.arrayContaining(['workflow.completion@1', 'workflow.work_definition@1', 'agent.task@1', 'file_output.json@1']));
    // Workflow ZIPs expose Studio Bridge and keep task Skills in canonical resources. Only materials ZIPs
    // install a host-native Skill copy, preventing the host from bypassing the Runner's review/file graph.
    expect(inspected.files.get('resources/procedure/SKILL.md')).toEqual(project.resourceFiles['resources/procedure/SKILL.md']);
    const prefix = host === 'codex' ? '.agents' : host === 'claude-code' ? '.claude' : '.opencode';
    expect(inspected.files.has(`${prefix}/skills/meeting-followup-partner/SKILL.md`)).toBe(false);
    const refs = Object.fromEntries(Object.entries(project.workflow.resources).map(([alias, reference]) => { if (!reference) throw new Error('Expected a pinned original resource'); return [alias, reference]; }));
    const materials = await inspectPackage((await buildMaterialsPackage({ host, refs, resources: project.resourceFiles, name: '회의 후속 원작 자료' })).bytes);
    expect(materials.files.get(`${prefix}/skills/meeting-followup-partner/SKILL.md`)).toEqual(project.resourceFiles['resources/procedure/SKILL.md']);
    expect(materials.manifest.compatibility.host.verification).toBe('unverified'); expect(materials.workflow).toBeUndefined();
    expect(inspected.manifest.compatibility.host.verification).toBe('unverified'); expect(inspected.trust).toBe('unsigned');
    const lock = JSON.parse(decode(inspected.files.get('runtime.lock.json')!)); expect(lock.workflowSha256).toBe(canonicalDigest(project.workflow));
  });

  it('documents the rule limit and rejects absent action evidence in the result schema', async () => {
    const project = await createAvatarMeetingProject(), agent = project.workflow.nodes.find(node => node.type === 'agent')!, checks = project.workflow.nodes.find(node => node.type === 'evaluate')!;
    const missingEvidence = proposedDraft(); missingEvidence.actions[0]!.evidenceQuote = '';
    expect(validateJsonValue(agent.config.resultSchema, missingEvidence).valid).toBe(false);
    // This assertion records the honest boundary: the pure rules do not perform a semantic source comparison.
    const wrongQuote = proposedDraft(); wrongQuote.actions[0]!.evidenceQuote = '원문에 없는 가상의 인용';
    expect(evaluateRules(wrongQuote, checks.config.rules!, checks.config.passRule, checks.config.resultSchema).passed).toBe(true);
    expect(project.readme).toContain('인용의 진실성'); expect(project.readme).toContain('사람이 수행');
  });
});

describe('actual meeting workflow control with explicit test-only model boundary', () => {
  it('blocks a missing model before token counting, generation or run creation', async () => {
    const fixture = await setup({ configured: false }), readiness = await fixture.service.validate(fixture.request.packageHandle, {});
    expect(readiness.ready).toBe(false); expect(readiness.issues.map(issue => issue.code)).toContain('MODEL_PROFILE_REQUIRED');
    await expect(fixture.service.start(fixture.request)).rejects.toMatchObject({ code: 'WORKFLOW_NOT_READY' });
    expect(fixture.counts).toHaveLength(0); expect(fixture.calls).toHaveLength(0); expect(fixture.service.listRuns()).toEqual([]);
  });

  it('passes the actual source and each declared attachment once, then creates one exact file only after confirmation', async () => {
    const fixture = await setup(), waiting = await start(fixture);
    expect(waiting).toMatchObject({ status: 'waiting', outcome: { status: 'unassessed' } }); expect(waiting.files).toEqual([]); expect(waiting.waits).toHaveLength(1);
    expect(waiting.waits[0]).toMatchObject({ kind: 'review', nodeId: 'review' }); expect(fixture.counts).toHaveLength(1); expect(fixture.calls).toHaveLength(1);
    const request = fixture.calls[0]!; expect(fixture.counts[0]).toEqual(request); expect(request).not.toHaveProperty('tools');
    const judgment = decode(fixture.project.resourceFiles['resources/judgment/instructions.md']!), template = decode(fixture.project.resourceFiles['resources/template/output-template.md']!);
    expect(occurrences(request.instructions, judgment)).toBe(1); expect(occurrences(request.instructions, '# 회의 후속 정리 Skill')).toBe(1);
    expect(request.instructions).not.toContain(template);
    expect(request.content).toMatchObject({ context: meetingSample, untrustedReferences: [{ resource: 'template', trust: 'untrusted', text: template }] });
    const result = await review(fixture, waiting.id, waiting.waits[0]!.id, 'accepted');
    expect(result).toMatchObject({ status: 'succeeded', outcome: { status: 'complete' }, usage: { modelCalls: 1 } }); expect(result.files).toHaveLength(1);
    expect(result.result).toMatchObject({ data: { draft: proposedDraft(), checks: { passed: true }, review: { decision: 'accepted', feedback: confirmed() }, file: result.files[0]!.reference } });
    const actual = fixture.service.readArtifact(result.id, result.files[0]!.reference.id);
    expect(JSON.parse(decode(actual.bytes))).toEqual({ draft: proposedDraft(), checks: resultData(result).checks, review: { decision: 'accepted', feedback: confirmed() } });
    expect(fixture.calls).toHaveLength(1); expect(result.outcome!.checks.map(check => check.status)).toEqual(['passed', 'passed', 'passed']);
  });

  it('preserves a rejected draft but never creates a file or claims business completion', async () => {
    const fixture = await setup(), waiting = await start(fixture), result = await review(fixture, waiting.id, waiting.waits[0]!.id, 'rejected', { evidenceVerified: false, unknownsPreserved: false, notes: '원문 대응을 확인할 수 없어 반려' });
    expect(result).toMatchObject({ status: 'succeeded', outcome: { status: 'incomplete' }, result: { data: { draft: proposedDraft(), review: { decision: 'rejected' } } } });
    expect(result.files).toEqual([]); expect(resultData(result)).not.toHaveProperty('file');
    expect(result.outcome!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ criterionId: 'source_review', reason: 'review_rejected' }), expect.objectContaining({ criterionId: 'confirmed_delivery', reason: 'schema_mismatch' })]));
  });

  it('keeps insufficient evidence incomplete even if the review response says accepted', async () => {
    const draft = { status: 'insufficient_evidence', summary: '확인된 후속 업무 없음', actions: [], unresolved: ['원문에 결정된 후속 업무가 없습니다.'], limits: ['추정으로 업무를 만들지 않습니다.'] };
    const fixture = await setup({ response: draft }), waiting = await start(fixture), result = await review(fixture, waiting.id, waiting.waits[0]!.id, 'accepted');
    expect(result).toMatchObject({ status: 'succeeded', outcome: { status: 'incomplete' }, result: { data: { draft, checks: { passed: false, scores: { draft_ready: 0, has_actions: 0 } }, review: { decision: 'accepted' } } } });
    expect(result.files).toEqual([]); expect(resultData(result)).not.toHaveProperty('file'); expect(fixture.calls).toHaveLength(1);
    expect(result.outcome!.checks).toContainEqual(expect.objectContaining({ criterionId: 'draft_checks', reason: 'evaluation_failed' }));
  });

  it.each(['evidenceVerified', 'unknownsPreserved'] as const)('does not deliver when accepted review has %s=false', async field => {
    const fixture = await setup(), waiting = await start(fixture), response = { ...confirmed(), [field]: false };
    const result = await review(fixture, waiting.id, waiting.waits[0]!.id, 'accepted', response);
    expect(result).toMatchObject({ status: 'succeeded', outcome: { status: 'incomplete' } }); expect(result.files).toEqual([]);
    expect(result.outcome!.checks).toContainEqual(expect.objectContaining({ criterionId: 'confirmed_delivery', reason: 'schema_mismatch' }));
  });

  it('cancels an unanswered review without approving or replaying it after restart', async () => {
    const fixture = await setup(), waiting = await start(fixture), cancelled = fixture.service.cancel(waiting.id); await fixture.service.waitForIdle();
    expect(cancelled).toMatchObject({ status: 'cancelled', outcome: { status: 'incomplete', reason: 'execution_incomplete' } });
    await restart(fixture); expect(fixture.service.status(waiting.id)).toMatchObject({ status: 'cancelled', outcome: cancelled.outcome, files: [] });
    expect(() => fixture.service.respondWait(waiting.id, waiting.waits[0]!.id, { requestId: 'after-cancel', response: confirmed(), decision: 'accepted' })).toThrow();
    expect(fixture.calls).toHaveLength(1); expect(fixture.service.status(waiting.id).files).toEqual([]);
  });

  it('deduplicates the exact review response and rejects changed reuse without a second file or model call', async () => {
    const fixture = await setup(), waiting = await start(fixture), waitId = waiting.waits[0]!.id;
    const first = await review(fixture, waiting.id, waitId, 'accepted'); const originalFile = fixture.service.readArtifact(first.id, first.files[0]!.reference.id);
    const repeat = await review(fixture, waiting.id, waitId, 'accepted');
    expect(repeat.files).toEqual(first.files); expect(repeat.outcome).toEqual(first.outcome); expect(fixture.service.readArtifact(first.id, first.files[0]!.reference.id)).toEqual(originalFile);
    expect(() => fixture.service.respondWait(first.id, waitId, { requestId: 'meeting-review', response: { ...confirmed(), notes: '다른 응답' }, decision: 'accepted' })).toThrow(expect.objectContaining({ code: 'RESPONSE_CONFLICT' }));
    expect(fixture.service.events(first.id).filter(event => event.type === 'artifact.registered')).toHaveLength(1); expect(fixture.calls).toHaveLength(1);
  });

  it('restores the same pending review and completed artifact without regenerating the model response', async () => {
    const fixture = await setup(), waiting = await start(fixture), waitId = waiting.waits[0]!.id;
    await restart(fixture); expect(fixture.service.status(waiting.id).waits[0]!.id).toBe(waitId); expect(fixture.calls).toHaveLength(1);
    const completed = await review(fixture, waiting.id, waitId, 'accepted'), file = fixture.service.readArtifact(completed.id, completed.files[0]!.reference.id);
    await restart(fixture); expect(fixture.service.status(completed.id).outcome).toEqual(completed.outcome); expect(fixture.service.readArtifact(completed.id, completed.files[0]!.reference.id)).toEqual(file);
    expect((await start(fixture)).id).toBe(completed.id); expect(fixture.calls).toHaveLength(1); expect(fixture.service.events(completed.id).filter(event => event.type === 'outcome.assessed')).toHaveLength(1);
  });

  it.each(['empty-source', 'source-path'] as const)('rejects %s input before model I/O', async variant => {
    const fixture = await setup(); fixture.request.inputs = variant === 'empty-source' ? { ...meetingSample, sourceText: '' } : { meetingTitle: meetingSample.meetingTitle, sourceFormat: 'markdown', sourcePath: 'C:/private/meeting.md' };
    await expect(fixture.service.start(fixture.request)).rejects.toThrow(); expect(fixture.counts).toHaveLength(0); expect(fixture.calls).toHaveLength(0);
  });

  it.each(['malformed-json', 'missing-evidence'] as const)('keeps %s model output failed and creates no review or file', async variant => {
    const draft = proposedDraft(); draft.actions[0]!.evidenceQuote = '';
    const fixture = await setup(variant === 'malformed-json' ? { malformed: true } : { response: draft }), result = await start(fixture);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'MODEL_OUTPUT_INVALID' }, outcome: { status: 'incomplete', reason: 'execution_incomplete' } });
    expect(result.waits).toEqual([]); expect(result.files).toEqual([]); expect(fixture.calls).toHaveLength(1);
  });
});
