import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, readSkillMetadata, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import { countRagContextTokens } from '../../apps/runner/src/rag/context-tokenizer.js';
import { checkCatalog } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const root = process.cwd();
const ids = Array.from({ length: 20 }, (_, index) => `ER-${101 + index}`);
const helpers: Record<string, string> = { 'ER-101': 'clean_split.py', 'ER-102': 'section_chunks.py', 'ER-103': 'map_metadata.py', 'ER-104': 'keyword_search.py', 'ER-107': 'assemble_citations.py', 'ER-108': 'rewrite_queries.py', 'ER-109': 'decompose_requirements.py', 'ER-110': 'select_sources.py', 'ER-111': 'check_evidence.py', 'ER-112': 'stop_search.py', 'ER-113': 'fuse_rrf.py', 'ER-115': 'context_budget.mjs', 'ER-116': 'retrieval_metrics.py', 'ER-117': 'extract_entities.py', 'ER-118': 'validate_relations.py', 'ER-119': 'find_evidence_paths.py', 'ER-120': 'community_context.py' };
Object.assign(helpers, { 'ER-105': 'embed_batch.py', 'ER-106': 'vector_search.py', 'ER-114': 'rerank_candidates.py' });
const directory = (id: string) => path.join(root, 'catalog/official/resources', id);
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const catalog = JSON.parse(await readFile(path.join(root, 'catalog/official/catalog.json'), 'utf8')) as OfficialCatalog;
const sample = async (id: string): Promise<any> => JSON.parse(await readFile(path.join(directory(id), 'references/example-input.json'), 'utf8'));
const python = process.env.STUDIO_CATALOG_PYTHON ?? 'python';

/** Execute the actual distributed helper. -B prevents internal verification from adding bytecode to payloads. */
function invoke(id: string, data: unknown) {
  const helper = helpers[id]!;
  return spawnSync(helper.endsWith('.py') ? python : process.execPath, [...(helper.endsWith('.py') ? ['-B'] : []), path.join(directory(id), 'scripts', helper)], { input: JSON.stringify(data), encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, cwd: root });
}
function run(id: string, data: unknown): any { const result = invoke(id, data); expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout); }
function reject(id: string, data: unknown, code: string) { const result = invoke(id, data); expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(JSON.parse(result.stderr).error).toBe(code); }

/** The only provider substitute lives inside this test; actual distributed request/response handling still runs. */
function providerBoundary(id: string, input: unknown, responses: unknown[], configured = true): any {
  const script = String.raw`
import importlib, io, json, os, sys, urllib.error, urllib.request
sys.path.insert(0, sys.argv[1])
data=json.loads(sys.stdin.buffer.read().decode('utf-8')); calls=[]
os.environ['STUDIO_EMBEDDING_API_KEY']='test-boundary-value' if data['configured'] else ''
os.environ['STUDIO_RERANK_API_KEY']='test-boundary-value' if data['configured'] else ''
class Response(io.BytesIO): status=200
class Opener:
    def open(self,request,timeout):
        assert request.full_url in ('https://api.openai.com/v1/embeddings','https://api.cohere.com/v2/rerank')
        assert request.get_method()=='POST' and request.get_header('Authorization')=='Bearer test-boundary-value' and timeout==20
        calls.append({'url':request.full_url,'payload':json.loads(request.data)})
        response=data['responses'][len(calls)-1]
        if 'httpError' in response: raise urllib.error.HTTPError(request.full_url,response['httpError'],'private server body',{},None)
        if 'transportError' in response: raise urllib.error.URLError('private transport detail')
        return Response(json.dumps(response).encode('utf-8'))
def opener(*handlers):
    assert any(isinstance(handler,urllib.request.ProxyHandler) and handler.proxies=={} for handler in handlers)
    assert any(type(handler).__name__=='NoRedirect' and handler.redirect_request(None,None,None,None,None,'https://evil.invalid') is None for handler in handlers)
    return Opener()
urllib.request.build_opener=opener
module=importlib.import_module(sys.argv[2])
from contracts import ContractError
try: result={'value':module.execute(data['input'])}
except ContractError as error: result={'error':error.code,'message':str(error)}
print(json.dumps({**result,'calls':calls}))
`;
  const result = spawnSync(python, ['-B', '-c', script, path.join(directory(id), 'scripts'), helpers[id]!.replace('.py', '')], { input: JSON.stringify({ input, responses, configured }), encoding: 'utf8', timeout: 10000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).not.toContain('test-boundary-value'); return JSON.parse(result.stdout);
}

/** Numeric oracle vectors test exact cosine arithmetic, not actual embedding model quality. */
function embeddingEnvelope(texts: Array<{ id: string; text: string; vector: number[] }>) {
  const profile = { provider: 'openai', endpoint: 'https://api.openai.com/v1/embeddings', model: 'text-embedding-3-small', dimensions: 2, encodingFormat: 'float', inputNormalization: 'none' };
  const sorted = Object.fromEntries(Object.entries(profile).sort(([a], [b]) => a.localeCompare(b)));
  return { profile, profileFingerprint: hash(JSON.stringify(sorted)), records: texts.map(row => ({ id: row.id, textSha256: hash(row.text), vector: row.vector })) };
}

describe('actual embedding/vector/reranker contracts without live account claims', () => {
  test('all bundled connection examples stay offline and declare their external prerequisites', async () => {
    for (const id of ['ER-105', 'ER-106', 'ER-114']) {
      const result = run(id, await sample(id)); expect(result.providerCalled).toBe(false);
      expect(result.status).toBe(id === 'ER-106' ? 'embeddings_required' : 'connection_required');
      const descriptor = JSON.parse(await readFile(path.join(directory(id), 'resource.json'), 'utf8'));
      expect(descriptor.requiredConnections).toEqual([id === 'ER-114' ? 'reranker' : 'embedding']);
    }
  });

  test('ER-105 sends fixed-profile batches, restores index order and uses only provider-confirmed usage', async () => {
    const input = { ...await sample('ER-105'), operation: 'execute', send: true, dimensions: 2 };
    const response = { object: 'list', model: input.model, data: [{ object: 'embedding', index: 1, embedding: [0, 1] }, { object: 'embedding', index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } };
    const result = providerBoundary('ER-105', input, [response]); expect(result.calls).toHaveLength(1);
    expect(result.calls[0].payload).toEqual({ model: input.model, dimensions: 2, encoding_format: 'float', input: input.chunks.map((row: any) => row.text) });
    expect(result.value.records.map((row: any) => row.vector)).toEqual([[1, 0], [0, 1]]); expect(result.value.usage.totalTokens).toBe(7); expect(result.value.modelVersionVerified).toBe(false);
    expect(result.value.records[0].textSha256).toBe(hash(input.chunks[0].text));
  });

  test('ER-105 rejects unauthorized sending, model drift, count/dimension/index errors and partial completion', async () => {
    const input = { ...await sample('ER-105'), operation: 'execute', send: true, dimensions: 2 };
    expect(providerBoundary('ER-105', { ...input, send: false }, []).error).toBe('SEND_APPROVAL_REQUIRED');
    const unconfigured = providerBoundary('ER-105', input, [], false); expect(unconfigured.error).toBe('CONNECTION_REQUIRED'); expect(unconfigured.calls).toHaveLength(0);
    const good = { object: 'list', model: input.model, data: [{ object: 'embedding', index: 0, embedding: [1, 0] }, { object: 'embedding', index: 1, embedding: [0, 1] }], usage: { prompt_tokens: 2, total_tokens: 2 } };
    expect(providerBoundary('ER-105', input, [{ ...good, model: 'different' }]).error).toBe('MODEL_MISMATCH');
    expect(providerBoundary('ER-105', input, [{ ...good, data: good.data.slice(0, 1) }]).error).toBe('EMBEDDING_COUNT');
    expect(providerBoundary('ER-105', input, [{ ...good, data: [good.data[0], good.data[0]] }]).error).toBe('EMBEDDING_INDEX');
    expect(providerBoundary('ER-105', input, [{ ...good, data: [good.data[0], { ...good.data[1], embedding: [1] }] }]).error).toBe('EMBEDDING_DIMENSIONS');
    const partial = providerBoundary('ER-105', { ...input, batchSize: 1 }, [{ ...good, data: [good.data[0]] }, { httpError: 503 }]);
    expect(partial.error).toBe('PROVIDER_TEMPORARY'); expect(partial.message).toContain('validated batches=1'); expect(partial.value).toBeUndefined(); expect(partial.calls).toHaveLength(2);
  });

  test('ER-106 computes cosine and recall after exact source/profile checks and applies current supplied scope', async () => {
    const input = await sample('ER-106'); const index = embeddingEnvelope(input.documents.map((row: any, i: number) => ({ ...row, vector: i === 0 ? [1, 0] : [0, 1] })));
    const queryEmbedding = embeddingEnvelope([{ id: 'question', text: input.query, vector: [1, 0] }]);
    const full = { ...input, operation: 'search', index, queryEmbedding, relevantIds: ['policy'] };
    expect(run('ER-106', full)).toMatchObject({ recallAtK: 1, candidates: [{ id: 'policy', score: 1, distance: 0 }] });
    expect(run('ER-106', { ...full, allowedDocumentIds: ['delivery'], relevantIds: ['delivery'] }).candidates[0].id).toBe('delivery');
    const changed = structuredClone(full); changed.index.records[0]!.textSha256 = hash('edited'); reject('ER-106', changed, 'SOURCE_HASH');
    const dimensions = structuredClone(full); dimensions.queryEmbedding.profile.dimensions = 3; reject('ER-106', dimensions, 'PROFILE_HASH');
    const zero = structuredClone(full); zero.queryEmbedding.records[0]!.vector = [0, 0]; reject('ER-106', zero, 'ZERO_VECTOR');
    reject('ER-106', { ...full, relevantIds: ['outside'] }, 'JUDGMENT_SCOPE');
    const huge = structuredClone(full); huge.index.records[0]!.vector = [1e308, 0]; expect(run('ER-106', huge).candidates[0].score).toBe(1);
  });

  test('ER-114 returns only original candidates and retains real source positions', async () => {
    const input = { ...await sample('ER-114'), operation: 'execute', send: true };
    const result = providerBoundary('ER-114', input, [{ results: [{ index: 1, relevance_score: .9 }, { index: 0, relevance_score: .2 }] }]);
    expect(result.value.candidates.map((row: any) => row.id)).toEqual(['delivery', 'policy']); expect(result.value.candidates[0].source.sha256).toBe(hash(input.candidates[1].text));
    expect(result.calls[0].payload.documents).toEqual(input.candidates.map((row: any) => row.text)); expect(result.value.providerReportedModel).toBeNull(); expect(result.value.modelVersionVerified).toBe(false);
    expect(providerBoundary('ER-114', input, [{ results: [{ index: 2, relevance_score: .9 }, { index: 0, relevance_score: .2 }] }]).error).toBe('INVALID_INTEGER');
    expect(providerBoundary('ER-114', input, [{ results: [{ index: 1, relevance_score: .9 }, { index: 1, relevance_score: .2 }] }]).error).toBe('RERANK_INDEX');
    expect(providerBoundary('ER-114', input, [{ results: [{ index: 1, relevance_score: .9 }] }]).error).toBe('RERANK_COUNT');
  });

  test('ER-114 fallback is explicit, transient-only and never conceals invalid returned indices or missing credentials', async () => {
    const input = { ...await sample('ER-114'), operation: 'execute', send: true, onFailure: 'use_original' };
    const failed = providerBoundary('ER-114', input, [{ httpError: 429 }]); expect(failed.calls).toHaveLength(1);
    expect(failed.value).toMatchObject({ status: 'original_order', reason: 'PROVIDER_TEMPORARY', billingUncertain: true });
    expect(failed.value.candidates.map((row: any) => row.id)).toEqual(['policy', 'delivery']); expect(failed.value.candidates.every((row: any) => row.score === null)).toBe(true);
    expect(providerBoundary('ER-114', input, [{ transportError: true }]).value.status).toBe('original_order');
    expect(providerBoundary('ER-114', input, [{ httpError: 401 }]).error).toBe('PROVIDER_HTTP');
    expect(providerBoundary('ER-114', input, [{ results: [] }]).error).toBe('RERANK_COUNT');
    expect(providerBoundary('ER-114', input, [], false).error).toBe('CONNECTION_REQUIRED');
    expect(providerBoundary('ER-114', { ...input, send: false }, []).error).toBe('SEND_APPROVAL_REQUIRED');
    expect(JSON.stringify(failed)).not.toContain('private server body');
  });
});

describe('original operational RAG Skills', () => {
  test.each(ids)('%s preserves its original brief and all payload bytes in three native host packages', async id => {
    const entry = catalog.entries.find(item => item.id === id)!;
    expect(entry.state).toBe('implemented'); expect(entry.verificationRecords).toEqual([]); expect(entry.review).toBeUndefined();
    const descriptorBytes = new Uint8Array(await readFile(path.join(directory(id), 'resource.json')));
    const descriptor = JSON.parse(new TextDecoder().decode(descriptorBytes)) as ResourceDescriptor;
    const reference: ResourceRef = { id, revision: 1, kind: 'skill', sha256: hash(descriptorBytes) };
    const files: Record<string, Uint8Array> = { [`resources/${id}/resource.json`]: descriptorBytes };
    for (const file of descriptor.files) { const bytes = new Uint8Array(await readFile(path.join(directory(id), file.path))); expect(bytes.length).toBe(file.bytes); expect(hash(bytes)).toBe(file.sha256); files[`resources/${id}/${file.path}`] = bytes; }
    expect(verifyResources({ [id]: reference }, new Map(Object.entries(files))).get(id)?.id).toBe(id);
    const skillBytes = files[`resources/${id}/SKILL.md`]!, skill = new TextDecoder().decode(skillBytes), metadata = readSkillMetadata(skillBytes);
    expect(skill).toContain(entry.definition.purpose); expect(skill).toContain(entry.definition.inputOutput); expect(skill).toContain(entry.definition.acceptanceCriteria);
    expect(skill).toContain('## 필수 입력'); expect(skill).toContain('## 실패·미확인 처리'); expect(skill.match(/^\d+\. /gm)).toHaveLength(5);
    expect((await sample(id)).fictional).toBe(true);
    for (const host of ['codex', 'claude-code', 'opencode'] as const) {
      const built = await buildMaterialsPackage({ host, refs: { [id]: reference }, resources: files, name: entry.name });
      const inspected = await inspectPackage(built.bytes); expect(inspected.manifest.purpose).toBe('production'); expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      const archive = unzipSync(built.bytes), native = host === 'codex' ? '.agents/skills' : host === 'claude-code' ? '.claude/skills' : '.opencode/skills';
      for (const file of descriptor.files) { const original = files[`resources/${id}/${file.path}`]!; expect(hash(archive[`resources/${id}/${file.path}`]!)).toBe(hash(original)); expect(hash(archive[`${native}/${metadata.name}/${file.path}`]!)).toBe(hash(original)); }
      expect(Object.keys(archive).some(name => /(?:^|\/)(?:tests|fixtures|node_modules|__pycache__)(?:\/|$)|requirements-verification|verification\.spec/.test(name))).toBe(false);
    }
  }, 60000);

  test('content and packaging do not create actual-use, host, or publication evidence', async () => {
    const report = await checkCatalog(catalog, { root }); expect(report.issues).toEqual([]); expect(report.releaseReady).toBe(false);
    expect(report.counts.usableResources).toBe(0); expect(report.counts.publishedResources).toBe(0); expect(report.counts.verifiedHostCombinations).toBe(0);
    const procedures = await Promise.all(ids.map(async id => (await readFile(path.join(directory(id), 'SKILL.md'), 'utf8')).split('## 작업 절차')[1]!.split('## 실행과 연결')[0]!));
    expect(new Set(procedures).size).toBe(ids.length);
  });

  test('initial sealing refuses to overwrite a registered or edited original', async () => {
    const before = hash(await readFile(path.join(root, 'catalog/official/catalog.json')));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'tooling/catalog/materialize-rag-resources.ts', 'ER-101'], { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(result.status).toBe(1); expect(result.stderr).toContain('refusing to overwrite'); expect(hash(await readFile(path.join(root, 'catalog/official/catalog.json')))).toBe(before);
  });
});

describe('additional RAG planning and graph helpers', () => {
  test('ER-108 preserves dates, identifiers, exclusions and explicit glossary meanings', async () => {
    const input = await sample('ER-108'), result = run('ER-108', input);
    expect(result.queries).toEqual([input.question + ' | 서비스 수준 협약']); expect(result.semanticReviewRequired).toBe(true);
    reject('ER-108', { ...input, proposedQueries: ['API-204 반품 SLA'] }, 'CONSTRAINT_LOST');
    reject('ER-108', { ...input, glossary: [...input.glossary, { term: 'SLA', canonical: '다른 뜻' }] }, 'GLOSSARY_CONFLICT');
    expect(run('ER-108', { ...input, proposedQueries: [input.question, input.question] }).queries).toHaveLength(1);
  });

  test('ER-109 covers declared requirements and rejects missing mappings or cyclic ordering', async () => {
    const input = await sample('ER-109'), result = run('ER-109', input);
    expect(result.subquestions.map((item: any) => item.question)).toEqual(['반품 기한은?', '교환 비용은?']); expect(result.semanticCoverageVerified).toBe(false);
    reject('ER-109', { ...input, subquestions: [{ id: 'q1', question: '기한?', requirementIds: ['deadline'], dependsOn: [] }] }, 'REQUIREMENT_OMITTED');
    reject('ER-109', { ...input, subquestions: [{ id: 'q1', question: '기한과 비용?', requirementIds: ['deadline', 'cost'], dependsOn: ['q2'] }] }, 'DEPENDENCY_ORDER');
    const changed = structuredClone(input); changed.requirements[0].quote = '바뀐 요구'; reject('ER-109', changed, 'REQUIREMENT_MISMATCH');
  });

  test('ER-110 rejects invented sources and collects only actual supplied responses for the permitted route', async () => {
    const input = await sample('ER-110'), selected = run('ER-110', input);
    expect(selected.calls.map((item: any) => item.sourceId)).toEqual(['policy']); expect(selected.results).toBeNull(); expect(selected.serviceCalled).toBe(false);
    // Internal response data tests the service boundary; no fabricated response is shipped in the Skill.
    expect(run('ER-110', { ...input, responses: [{ sourceId: 'policy', status: 'ok', items: [] }] }).action).toBe('review_results');
    reject('ER-110', { ...input, responses: [{ sourceId: 'private', status: 'ok', items: [] }] }, 'UNAUTHORIZED_RESPONSE');
    reject('ER-110', { ...input, responses: [] }, 'SOURCE_MISSING');
    reject('ER-110', { ...input, responses: [{ sourceId: 'policy', status: 'failed', items: [] }] }, 'SOURCE_FAILED');
  });

  test('ER-111 distinguishes preparation, insufficient evidence, contradiction, and unsupported citations', async () => {
    const input = await sample('ER-111'); expect(run('ER-111', input)).toMatchObject({ action: 'assess', sufficient: null });
    const judgments = [{ claimId: 'deadline', status: 'supported', evidence: [{ candidateId: 'policy', quote: '접수 기한은 7일입니다.' }] }, { claimId: 'fee', status: 'missing', evidence: [] }];
    expect(run('ER-111', { ...input, judgments })).toMatchObject({ sufficient: false, action: 'search_more', missingClaims: ['fee'] });
    expect(run('ER-111', { ...input, judgments, remainingSearches: 0 }).action).toBe('hold');
    expect(run('ER-111', { ...input, judgments: [judgments[0], { ...judgments[1], status: 'conflicting' }] }).action).toBe('hold');
    reject('ER-111', { ...input, judgments: [{ ...judgments[0], evidence: [{ candidateId: 'fake', quote: '없음' }] }, judgments[1]] }, 'EVIDENCE_MISMATCH');
    reject('ER-111', { ...input, judgments: [judgments[0]] }, 'JUDGMENT_MISSING');
  });

  test('ER-112 halts duplicates, exhausted reservations, cancellation and bounded histories', async () => {
    const input = await sample('ER-112'); expect(run('ER-112', input)).toMatchObject({ action: 'retrieve', remainingRounds: 2, remainingTokens: 320, remainingDocumentSlots: 4 });
    expect(run('ER-112', { ...input, nextQuery: '  반품   기한  ' })).toMatchObject({ action: 'clarify', reason: 'duplicate_next_query' });
    expect(run('ER-112', { ...input, nextTokenReservation: 321 }).action).toBe('hold');
    expect(run('ER-112', { ...input, cancelled: true }).action).toBe('stop');
    expect(run('ER-112', { ...input, sufficientEvidence: true }).action).toBe('answer');
    const limited = { ...input, limits: { ...input.limits, rounds: 1 } }; expect(run('ER-112', limited)).toMatchObject({ action: 'hold', reason: 'limit_reached' });
    reject('ER-112', { ...input, history: [{ ...input.history[0], round: true }] }, 'INVALID_INTEGER');
  });

  test('ER-117 extracts exact dictionary entities and verifies UTF-8 offsets without invented discoveries', async () => {
    const input = await sample('ER-117'), result = run('ER-117', input);
    expect(result.mentions).toHaveLength(3); expect(result.entityIds).toEqual(['blue', 'hanbit']); expect(result.unlistedEntityDiscovery).toBe(false);
    const bytes = Buffer.from(input.document.text);
    for (const item of result.mentions) { expect(bytes.subarray(item.source.start, item.source.end).toString('utf8')).toBe(item.surface); expect(item.source.sha256).toBe(hash(bytes)); }
    reject('ER-117', { ...input, dictionary: [...input.dictionary, { id: 'other', type: 'organization', names: ['한빛 연구소'] }] }, 'AMBIGUOUS_ALIAS');
    reject('ER-117', { ...input, allowedTypes: ['organization'] }, 'ENTITY_CONTRACT');
  });

  test('ER-118 preserves alias conflicts and rejects type-reversed or forged relation evidence', async () => {
    const input = await sample('ER-118'), result = run('ER-118', input);
    expect(result.relationCandidates).toHaveLength(1); expect(result.aliasConflicts).toContainEqual({ alias: '한빛', entityIds: ['hanbit', 'other'], action: 'review_without_merge' });
    expect(result.mergedEntities).toEqual([]); expect(result.graphWritten).toBe(false); expect(result.semanticDirectionVerified).toBe(false);
    const reversed = structuredClone(input); reversed.relations[0].from = 'spring'; reversed.relations[0].to = 'hanbit'; reject('ER-118', reversed, 'DIRECTION_TYPE_MISMATCH');
    const forged = structuredClone(input); forged.relations[0].quote = '새로운 관계'; reject('ER-118', forged, 'SOURCE_MISMATCH');
  });

  test('ER-119 traverses actual directed edges, retains each source, and enforces access/depth/work bounds', async () => {
    const input = await sample('ER-119'), result = run('ER-119', input);
    expect(result.paths[0].entities).toEqual(['hanbit', 'blue', 'spring']); expect(result.paths[0].edges.map((item: any) => item.id)).toEqual(['develops', 'belongs']); expect(result.omittedUnauthorizedEdges).toBe(1);
    expect(run('ER-119', { ...input, start: 'spring', target: 'hanbit' }).paths).toEqual([]);
    expect(run('ER-119', { ...input, maxDepth: 1 }).paths).toEqual([]);
    expect(run('ER-119', { ...input, maxExpansions: 1 }).truncated).toBe(true);
    expect(run('ER-119', { ...input, allowedDocumentIds: [] }).paths).toEqual([]);
    const forged = structuredClone(input); forged.edges[0].quote = '없는 근거'; reject('ER-119', forged, 'SOURCE_MISMATCH');
    reject('ER-119', { ...input, target: 'moon' }, 'ENTITY_ACCESS');
  });

  test('ER-120 prepares real graph components and validates multi-level summary provenance without fabricating summaries', async () => {
    const input = await sample('ER-120'), prepared = run('ER-120', input);
    expect(prepared.communities).toHaveLength(2); expect(prepared.summaries).toBeNull(); expect(prepared.modelCalled).toBe(false);
    // Synthetic proposed summaries remain internal to this boundary test, never operational example output.
    const summaries = prepared.communities.map((community: any) => ({ communityId: community.id, claims: community.edges.length ? [{ text: '내부 검증용 요약 주장', edgeIds: [community.edges[0].id] }] : [] }));
    const globalClaims = [{ text: '내부 검증용 전체 주장', references: [{ communityId: summaries[0].communityId, claimIndex: 0 }] }];
    const assembled = run('ER-120', { ...input, operation: 'assemble', summaries, globalClaims });
    expect(assembled.provenanceChecked).toBe(true); expect(assembled.semanticSupportVerified).toBe(false);
    expect(assembled.globalClaims[0].references[0].claim.evidence[0].source.documentId).toBe('graph-document');
    reject('ER-120', { ...input, operation: 'assemble', summaries: [], globalClaims }, 'SUMMARY_MISSING');
    const invalid = structuredClone(summaries); invalid[0].claims[0].edgeIds = ['imagined']; reject('ER-120', { ...input, operation: 'assemble', summaries: invalid, globalClaims }, 'SUMMARY_EVIDENCE');
    reject('ER-120', { ...input, operation: 'assemble', summaries, globalClaims: [{ text: '범위 밖', references: [{ communityId: summaries[0].communityId, claimIndex: 99 }] }] }, 'GLOBAL_EVIDENCE');
  });
});

describe('real RAG helper behavior and failure boundaries', () => {
  test('ER-101 covers every cleaned character exactly once and traces original UTF-8 intervals', async () => {
    const input = await sample('ER-101'), result = run('ER-101', input);
    const expected = input.document.text.replace(/^\ufeff/, '').replaceAll('\r\n', '\n');
    expect(result.cleanedText).toBe(expected); expect(result.chunks.map((item: any) => item.text).join('')).toBe(expected);
    expect(result.originalSha256).toBe(hash(input.document.text)); expect(result.removed).toEqual([{ start: 0, end: 3, reason: 'leading_bom' }]);
    const bytes = Buffer.from(input.document.text);
    for (const item of result.chunks) expect(bytes.subarray(item.originalBytes.start, item.originalBytes.end).toString('utf8').replaceAll('\r\n', '\n')).toBe(item.text);
    reject('ER-101', { ...input, overlap: 1 }, 'OVERLAP_UNSUPPORTED'); reject('ER-101', { ...input, overlap: true }, 'INVALID_INTEGER');
    reject('ER-101', { ...input, document: { ...input.document, text: 'text\u0000' } }, 'CONTROL_CHARACTER');
  });

  test('ER-102 retains table rows, hierarchy, byte ranges, and all original text', async () => {
    const input = await sample('ER-102'), result = run('ER-102', input), tables = result.chunks.filter((item: any) => item.kind === 'table');
    expect(tables).toHaveLength(1); expect(tables[0].headingPath.map((item: any) => item.title)).toEqual(['가상 업무 안내', '승인 기준']);
    expect(tables[0].text).toContain('| 초과 | 담당 책임자 |'); expect(result.chunks.map((item: any) => item.text).join('')).toBe(input.text);
    for (const item of result.chunks) expect(Buffer.from(input.text).subarray(item.source.start, item.source.end).toString('utf8')).toBe(item.text);
    reject('ER-102', { ...input, maxCharacters: 32 }, 'BLOCK_TOO_LARGE'); reject('ER-102', { ...input, text: '# 제목\n```python\nprint(1)\n' }, 'UNCLOSED_FENCE');
  });

  test('ER-103 requires explicit access and timezone and rejects forged source text', async () => {
    const input = await sample('ER-103'), result = run('ER-103', input);
    expect(result.records[0]).toMatchObject({ publishedAt: '2026-01-03T00:00:00Z', category: 'operations', access: { tenantId: 'demo', projectId: 'handbook', subjects: ['reviewer'], groups: [] } });
    expect(result.authorizationEnforced).toBe(false);
    const missing = structuredClone(input); delete missing.chunks[0].metadata.access; reject('ER-103', missing, 'ACCESS_REQUIRED');
    const naive = structuredClone(input); naive.chunks[0].metadata.publishedAt = '2026-01-03T09:00:00'; reject('ER-103', naive, 'DATE_TIMEZONE_REQUIRED');
    const forged = structuredClone(input); forged.chunks[0].text = '다른 원문'; reject('ER-103', forged, 'SOURCE_MISMATCH');
  });

  test('ER-104 retrieves an exact identifier while excluding an unauthorized matching document', async () => {
    const input = await sample('ER-104'), result = run('ER-104', input);
    expect(result.results.map((item: any) => item.id)).toEqual(['manual-a']); expect(result.results[0].matchedTerms).toEqual(['api-204']);
    expect(result.results[0].sourceSha256).toBe(hash(input.documents[0].text)); expect(result.results[0].score).toBeGreaterThan(0);
    expect(run('ER-104', { ...input, query: 'API-999' }).results).toEqual([]);
    reject('ER-104', { ...input, allowedDocumentIds: ['missing'] }, 'UNKNOWN_AUTHORIZED_ID');
    reject('ER-104', { ...input, documents: [...input.documents, input.documents[0]] }, 'DUPLICATE_ID');
  });

  test('ER-107 assembles provided claims and resolves every citation to its original chunk/page', async () => {
    const input = await sample('ER-107'), result = run('ER-107', input);
    expect(result.answerMarkdown).toBe(input.claims[0].text + ' [S1]'); expect(result.citations[0]).toMatchObject({ candidateId: 'c1', quote: '반품 접수 기한은 7일입니다.', source: { documentId: 'policy', page: 2 } });
    expect(result.modelCalled).toBe(false); expect(result.semanticSupportChecked).toBe(false);
    const wrong = structuredClone(input); wrong.claims[0].evidence[0].candidateId = 'unknown'; reject('ER-107', wrong, 'UNKNOWN_CITATION');
    wrong.claims[0].evidence[0] = { candidateId: 'c1', quote: '30일입니다.' }; reject('ER-107', wrong, 'QUOTE_MISMATCH');
  });

  test('ER-113 reproduces RRF fractions and deduplicates document identities', async () => {
    const input = await sample('ER-113'), result = run('ER-113', input);
    expect(result.results.map((item: any) => item.documentId)).toEqual(['B', 'A', 'C']);
    expect(result.results[0].exactScore).toEqual({ numerator: 123, denominator: 3782 });
    expect(result.results[0].score).toBeCloseTo(1 / 61 + 1 / 62, 14);
    const duplicate = structuredClone(input); duplicate.rankings.keyword.push(duplicate.rankings.keyword[0]); expect(run('ER-113', duplicate).results).toEqual(result.results);
    const conflict = structuredClone(input); conflict.rankings.vector[0].sourceSha256 = 'a'.repeat(64); reject('ER-113', conflict, 'SOURCE_CONFLICT');
    const version = structuredClone(input); version.rankings.vector[0].revision = 2; reject('ER-113', version, 'VERSION_CONFLICT');
  });

  test('ER-115 executes a complete bundled tokenizer, tracks deduplication, and enforces exact whole-context boundaries', async () => {
    const input = await sample('ER-115'), full = run('ER-115', { ...input, maxTokens: 1000 });
    expect(full.encoding).toBe('o200k_base'); expect(full.tokenCount).toBe(countRagContextTokens(full.context));
    expect(full.tokenizerFingerprint).toBe('3fc5357b5aef06067489ec0d64f921516f39da2302d5554355cff6b73f44d77d');
    expect(full.excluded).toEqual([{ id: 'c1-copy', reason: 'duplicate_source_range', duplicateOf: 'c1' }]);
    const exact = run('ER-115', { ...input, maxTokens: full.tokenCount }); expect(exact.context).toBe(full.context);
    const below = run('ER-115', { ...input, maxTokens: full.tokenCount - 1 }); expect(below.selected).toHaveLength(1); expect(below.tokenCount).toBeLessThanOrEqual(full.tokenCount - 1); expect(below.excluded.some((item: any) => item.id === 'c2' && item.reason === 'token_budget')).toBe(true);
    reject('ER-115', { ...input, maxTokens: 19 }, 'PREFIX_BUDGET'); reject('ER-115', { ...input, maxTokens: true }, 'INVALID_INTEGER');
    const forged = structuredClone(input); forged.candidates[0].text = '변조'; reject('ER-115', forged, 'SOURCE_MISMATCH');
    const provenance = JSON.parse(await readFile(path.join(directory('ER-115'), 'scripts/vendor/provenance.json'), 'utf8'));
    expect(provenance.packages.map((item: any) => [item.name, item.version])).toEqual([['js-tiktoken', '1.0.21'], ['base64-js', '1.5.1']]);
    expect(provenance.outputSha256).toBe(hash(await readFile(path.join(directory('ER-115'), 'scripts/vendor/tokenizer.mjs'))));
    expect(provenance.staticExecutionSecurityReview).toBe('unverified'); expect(provenance.originalInputs.length).toBeGreaterThanOrEqual(3);
    for (const name of ['LICENSE-js-tiktoken.txt', 'LICENSE-base64-js.txt']) expect(await readFile(path.join(directory('ER-115'), 'scripts/vendor', name), 'utf8')).toContain('Permission is hereby granted');
  }, 20000);

  test('ER-116 matches independent hand calculations and separates no-positive-judgment queries', async () => {
    const input = await sample('ER-116'), result = run('ER-116', input);
    expect(result.evaluatedQueries).toBe(2); expect(result.excludedQueries).toBe(1); expect(result.means.recall).toBe(.75); expect(result.means.reciprocalRank).toBe(.75);
    expect(result.perQuery[0].ndcg).toBeCloseTo((1 + 7 / Math.log2(3)) / (7 + 1 / Math.log2(3)), 14);
    expect(result.perQuery[1].ndcg).toBeCloseTo((3 / Math.log2(3)) / (3 + 1 / Math.log2(3)), 14);
    expect(result.perQuery[2]).toMatchObject({ status: 'excluded_no_relevant_judgment', recall: null, reciprocalRank: null, ndcg: null });
    const duplicate = structuredClone(input); duplicate.queries[0].ranking = ['A', 'A']; reject('ER-116', duplicate, 'DUPLICATE_RESULT');
    const unknown = structuredClone(input); unknown.queries[0].ranking = ['missing']; reject('ER-116', unknown, 'UNJUDGED_RESULT');
    const boolean = structuredClone(input); boolean.queries[0].judgments.A = true; reject('ER-116', boolean, 'INVALID_INTEGER');
  });
});
