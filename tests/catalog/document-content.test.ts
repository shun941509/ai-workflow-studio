import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import { checkCatalog } from '../../tooling/catalog/check.js';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';

const root = process.cwd();
const catalog = JSON.parse(await readFile(path.join(root, 'catalog/official/catalog.json'), 'utf8')) as OfficialCatalog;
const ids = Array.from({ length: 20 }, (_, index) => `ER-${String(index + 41).padStart(3, '0')}`);
const directory = (id: string) => path.join(root, 'catalog/official/resources', id);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const loadJson = async <T>(id: string, file: string): Promise<T> => JSON.parse(await readFile(path.join(directory(id), file), 'utf8')) as T;

/** Acceptance inspects real supplied document/database/PDF bytes; no model or external service is fabricated. */
describe('original document resources ER-041 through ER-060', () => {
  test.each(ids)('%s contains substantive original source and makes intact operational archives for three hosts', async (id) => {
    const entry = catalog.entries.find((item) => item.id === id)!;
    expect(entry.state).toBe('implemented'); expect(entry.resourceKind).toBe('document');
    expect(entry.verificationRecords).toEqual([]); expect(entry.review).toBeUndefined();
    const descriptorBytes = new Uint8Array(await readFile(path.join(directory(id), 'resource.json')));
    const descriptor = JSON.parse(decode(descriptorBytes)) as ResourceDescriptor;
    const reference: ResourceRef = { id, revision: descriptor.revision, kind: 'document', sha256: hash(descriptorBytes) };
    const files = new Map<string, Uint8Array>([[`resources/${id}/resource.json`, descriptorBytes]]);
    for (const file of descriptor.files) {
      const bytes = new Uint8Array(await readFile(path.join(directory(id), file.path)));
      expect(bytes.length).toBe(file.bytes); expect(hash(bytes)).toBe(file.sha256);
      files.set(`resources/${id}/${file.path}`, bytes);
    }
    expect(verifyResources({ [id]: reference }, files).get(id)?.kind).toBe('document');
    const document = decode(files.get(`resources/${id}/document.md`)!);
    expect(document).toContain('모두 가상'); expect(document.match(/^## /gm)?.length).toBeGreaterThanOrEqual(2);
    expect(document.length).toBeGreaterThan(600); expect(document).not.toContain('[실제 입력과 관측에 근거하여 작성]');
    const readme = decode(files.get(`resources/${id}/README.md`)!);
    expect(readme).toContain(entry.definition.purpose); expect(readme).toContain(entry.definition.acceptanceCriteria);
    expect(decode(files.get(`resources/${id}/LICENSE.md`)!)).toContain('사용, 복제, 수정, 결합 및 재배포를 허용');
    for (const host of ['codex', 'claude-code', 'opencode'] as const) {
      const built = await buildMaterialsPackage({ host, refs: { [id]: reference }, resources: Object.fromEntries(files), name: entry.name });
      const inspected = await inspectPackage(built.bytes); const archive = unzipSync(built.bytes);
      expect(inspected.manifest.packageKind).toBe('materials'); expect(inspected.manifest.purpose).toBe('production');
      expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      expect(hash(archive[`resources/${id}/${descriptor.entrypoint}`]!)).toBe(hash(files.get(`resources/${id}/${descriptor.entrypoint}`)!));
      expect(archive[host === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md']).toBeDefined();
      expect(Object.keys(archive).some((name) => /(?:^|\/)(?:fixtures|tests|node_modules)(?:\/|$)|verification\.spec|materialize-documents/.test(name))).toBe(false);
    }
  });

  test('the dictionary describes an actual read-only SQLite database with valid relations and meaningful rows', async () => {
    const dictionary = await loadJson<Record<string, { primaryKey: string; fields: Record<string, string> }>>('ER-043', 'dictionary.json');
    const database = new DatabaseSync(path.join(directory('ER-043'), 'sample.sqlite'), { readOnly: true });
    try {
      expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const counts: Record<string, number> = { projects: 3, roles: 4, tasks: 8, reports: 4 };
      for (const [table, expected] of Object.entries(counts)) {
        // Table names come from a fixed test-owned allowlist, not external input.
        const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string; pk: number }[];
        expect(columns.map((column) => column.name).sort()).toEqual(Object.keys(dictionary[table]!.fields).sort());
        expect(columns.find((column) => column.pk)?.name).toBe(dictionary[table]!.primaryKey);
        expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(expected);
      }
      expect(database.prepare("SELECT task_id FROM tasks WHERE owner_role_id IS NULL ORDER BY task_id").all()).toEqual([{ task_id: 'T-003' }, { task_id: 'T-008' }]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id='P-BETA' AND status='done'").get()?.count).toBe(2);
      expect(() => database.exec("UPDATE tasks SET status='done'")).toThrow();
    } finally { database.close(); }
  });

  test('API fields, product FAQ and feature catalogue preserve actual identifiers, types and units', async () => {
    const api = await loadJson<{ openapi: string; servers: { url: string }[]; paths: Record<string, { get: { parameters: { name: string; schema: { maximum?: number } }[]; responses: Record<string, unknown> } }>; components: { schemas: { Report: { required: string[]; properties: Record<string, { type: string | string[] }> } } } }>('ER-042', 'openapi.json');
    expect(api.openapi).toBe('3.1.0'); expect(new URL(api.servers[0]!.url).hostname).toMatch(/\.invalid$/);
    expect(Object.keys(api.paths).sort()).toEqual(['/reports', '/reports/{reportId}']);
    expect(api.paths['/reports']!.get.parameters.find((parameter) => parameter.name === 'limit')?.schema.maximum).toBe(50);
    expect(api.components.schemas.Report.required).not.toContain('summary'); expect(api.components.schemas.Report.properties.summary?.type).toEqual(['string', 'null']);
    const faq = await loadJson<{ id: string; answer: string }[]>('ER-046', 'faq.json');
    const features = await loadJson<{ id: string; unit: string; plans: { Basic: number | boolean; Team: number | boolean } }[]>('ER-047', 'features.json');
    expect(faq).toHaveLength(12); expect(new Set(faq.map((item) => item.id)).size).toBe(12); expect(features).toHaveLength(12);
    expect(faq.find((item) => item.id === 'FAQ-004')?.answer).toContain('20 MiB'); expect(features.find((item) => item.id === 'F-002')).toMatchObject({ unit: 'MiB', plans: { Basic: 20, Team: 100 } });
    expect(features.find((item) => item.id === 'F-005')?.plans).toEqual({ Basic: false, Team: true });
  });

  test('meeting facts and policy revisions preserve missing owners, superseded decisions and effective dates', async () => {
    const meetings = await loadJson<{ id: string; lines: string[] }[]>('ER-048', 'meetings.json');
    expect(meetings).toHaveLength(3);
    expect(meetings[0]!.lines[3]).toContain('담당과 기한은 정하지 않았습니다');
    expect(meetings[2]!.lines[0]).toContain('공개 제안은 보류');
    const revisions = await loadJson<{ id: string; status: string; effectiveFrom: string | null; effectiveTo: string | null; noticeDays: number }[]>('ER-049', 'revisions.json');
    const active = (date: string) => revisions.filter((item) => item.status === 'approved' && item.effectiveFrom && item.effectiveFrom <= date && (!item.effectiveTo || item.effectiveTo >= date));
    expect(active('2026-10-22').map((item) => item.noticeDays)).toEqual([2]);
    expect(active('2026-11-03').map((item) => item.noticeDays)).toEqual([5]);
    const terms = await loadJson<{ id: string; en: string; ko: string; restriction: string }[]>('ER-050', 'glossary.json');
    expect(terms).toHaveLength(24); expect(terms.find((term) => term.en === 'timeout')?.restriction).toContain('실패 확정');
  });

  test('PDF cells match actual extracted text and OCR sources are raster-only with bounded original-image annotations', () => {
    const python = process.env.STUDIO_CATALOG_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const source = String.raw`
import csv,json,os,sys
import pdfplumber
from pypdf import PdfReader
from PIL import Image
r=sys.argv[1]
p=os.path.join(r,'ER-051')
truth=json.load(open(os.path.join(p,'table-cells.json'),encoding='utf-8'))
with pdfplumber.open(os.path.join(p,'report.pdf')) as pdf:
  assert len(pdf.pages)==2
  for cell in truth['cells']:
    page=pdf.pages[cell['page']-1]; x,y,w,h=cell['bboxPoints']
    actual=page.crop((x,page.height-y-h,x+w,page.height-y)).extract_text()
    assert actual==cell['text'],(cell,actual)
  tables=[page.extract_table() for page in pdf.pages]
  assert tables[0][-1]==['Total','28','23','5']
  assert tables[1][-1]==['Total','36','31','5']
rows=list(csv.DictReader(open(os.path.join(p,'expected-tables.csv'),encoding='utf-8')))
assert len(rows)==10
p=os.path.join(r,'ER-052'); scan=PdfReader(os.path.join(p,'scans.pdf'))
assert len(scan.pages)==2 and all(not page.extract_text().strip() for page in scan.pages)
truth=json.load(open(os.path.join(p,'ocr-ground-truth.json'),encoding='utf-8'))
assert truth['scanKind']=='synthetic-raster-document-not-physical-scan'
blanks=0; nonblank=0
for page in truth['pages']:
  image=Image.open(os.path.join(p,page['image'])).convert('L')
  assert image.size==(1200,1600)
  for field in page['fields']:
    x,y,w,h=field['bboxPixels']; assert 0<=x<x+w<=1200 and 0<=y<y+h<=1600
    darkest=image.crop((x,y,x+w,y+h)).getextrema()[0]
    if field['blank']:
      assert field['value'] is None and darkest>180; blanks+=1
    else:
      assert darkest<100 and field['value'] in page['transcript']; nonblank+=1
assert blanks==1 and nonblank==11
print(json.dumps({'reportPages':2,'checkedCells':len(json.load(open(os.path.join(r,'ER-051','table-cells.json')))['cells']),'rasterPages':2,'blankFields':blanks,'nonblankFields':nonblank}))
`;
    const result = JSON.parse(execFileSync(python, ['-c', source, path.join(root, 'catalog/official/resources')], { encoding: 'utf8' }));
    expect(result).toEqual({ reportPages: 2, checkedCells: 48, rasterPages: 2, blankFields: 1, nonblankFields: 11 });
  });

  test('roles, approval stages, entity aliases and graph edges have real referenceable identities', async () => {
    const roles = await loadJson<{ id: string; can: string[]; cannot: string[] }[]>('ER-053', 'roles.json');
    const assignments = await loadJson<{ task: string; owner: string | null }[]>('ER-053', 'assignments.json');
    expect(assignments.find((item) => item.task === '법률 판단')?.owner).toBeNull();
    for (const assignment of assignments) if (assignment.owner) expect(roles.some((role) => role.id === assignment.owner)).toBe(true);
    const flows = await loadJson<{ id: string; stages: string[]; requiredApprovers: string[] }[]>('ER-054', 'approval-flows.json');
    expect(flows.find((item) => item.id === 'AP-02')?.stages).toEqual(['scope-check', 'content-review', 'access-review', 'owner-approval', 'publish', 'read-back']);
    for (const flow of flows) for (const role of flow.requiredApprovers) expect(roles.some((item) => item.id === role)).toBe(true);
    const entities = await loadJson<{ id: string; type: string; aliases: string[] }[]>('ER-056', 'entities.json');
    expect(entities.filter((entity) => entity.aliases.includes('Atlas'))).toHaveLength(2);
    const sources = await loadJson<{ id: string; text: string }[]>('ER-056', 'sources.json');
    const ontology = await loadJson<{ type: string; from: string[]; to: string[] }[]>('ER-056', 'ontology.json');
    const edges = await loadJson<{ id: string; type: string; from: string; to: string; sourceId: string }[]>('ER-056', 'edges.json');
    for (const edge of edges) {
      const rule = ontology.find((item) => item.type === edge.type)!;
      expect(rule.from).toContain(entities.find((item) => item.id === edge.from)?.type);
      expect(rule.to).toContain(entities.find((item) => item.id === edge.to)?.type);
      expect(sources.some((source) => source.id === edge.sourceId && source.text.length > 10)).toBe(true);
    }
  });

  test('access and RAG datasets distinguish actual allowed evidence from unknown and conflicting answers', async () => {
    const documents = await loadJson<{ id: string; tenant: string; scope: string; groups: string[] }[]>('ER-057', 'access-documents.json');
    const principals = await loadJson<{ id: string; tenant: string; groups: string[] }[]>('ER-057', 'principals.json');
    const expected = await loadJson<Record<string, string[]>>('ER-057', 'expected-access.json');
    for (const principal of principals) {
      const allowed = documents.filter((document) => document.tenant === principal.tenant && (document.scope === 'public' || document.scope === 'group' && document.groups.some((group) => principal.groups.includes(group))));
      expect(allowed.map((document) => document.id)).toEqual(expected[principal.id]);
    }
    const corpus = await loadJson<{ id: string; text: string }[]>('ER-058', 'corpus.json');
    const questions = await loadJson<{ id: string; answerable: boolean; relevantIds: string[]; answer: string | null }[]>('ER-058', 'questions.json');
    expect(corpus).toHaveLength(6); expect(questions.filter((item) => item.answerable)).toHaveLength(9); expect(questions.filter((item) => !item.answerable)).toHaveLength(2);
    for (const question of questions) { for (const id of question.relevantIds) expect(corpus.some((item) => item.id === id)).toBe(true); if (!question.answerable) expect(question.answer).toBeNull(); }
    const metric = await loadJson<{ expected: { recall: number; mrr: number; ndcg: number } }>('ER-058', 'metric-example.json');
    expect(metric.expected).toEqual({ recall: 1, mrr: .5, ndcg: 1 / Math.log2(3) });
    const insufficient = await loadJson<{ id: string; decision: string; reason: string }[]>('ER-059', 'cases.json');
    expect(insufficient).toHaveLength(8); expect(insufficient.filter((item) => item.decision === 'partial')).toHaveLength(1);
    const conflicts = await loadJson<{ id: string; decision: string; sourceIds: string[]; selected: string[] }[]>('ER-060', 'cases.json');
    expect(conflicts.find((item) => item.id === 'CF-03')).toMatchObject({ decision: 'abstain-conflict', sourceIds: ['C5', 'C6'], selected: [] });
  });

  test('implemented content remains excluded from actual-use and publication release totals', async () => {
    const report = await checkCatalog(catalog, { root });
    expect(report.issues).toEqual([]); expect(report.releaseReady).toBe(false);
    expect(catalog.entries.filter((entry) => ids.includes(entry.id) && entry.state === 'implemented')).toHaveLength(20);
    expect(report.counts.usableResources).toBe(0); expect(report.counts.publishedResources).toBe(0); expect(report.counts.verifiedHostCombinations).toBe(0);
  });

  test('the document authoring tool refuses to replace existing source bytes on a second run', async () => {
    const sample = path.join(directory('ER-051'), 'report.pdf'); const before = hash(await readFile(sample));
    expect(() => execFileSync(process.execPath, ['--import', 'tsx', 'tooling/catalog/materialize-documents.ts'], { cwd: root, stdio: 'pipe' })).toThrow(/refusing to overwrite/);
    expect(hash(await readFile(sample))).toBe(before);
  });
});
