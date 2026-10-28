import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { createCorpusGeneration, buildLocalSearchIndex, openLocalSearchProvider, LOCAL_SEARCH_FORMAT } from '@studio/rag-core';
import { parseStrictJson } from '@studio/spec';

export interface QueryJudgment { id: string; category: string; query: string; judgments: Record<string, number> }
interface Dataset { version: string; description: string; documents: { id: string; text: string }[]; queries: QueryJudgment[] }
const datasetPath = new URL('../../tests/fixtures/rag/keyword-ko.json', import.meta.url);

/** Document-level metrics use independent relevance judgments; no-answer queries have separate false-hit accounting. */
export function queryMetrics(ranking: readonly string[], judgments: Record<string, number>, k: number) {
  if (!Number.isSafeInteger(k) || k < 1 || k > 100 || new Set(ranking).size !== ranking.length || Object.values(judgments).some(grade => !Number.isInteger(grade) || grade < 0 || grade > 3)) throw new Error('Invalid benchmark judgments or ranking');
  const results = ranking.slice(0, k); const relevant = Object.entries(judgments).filter(([, grade]) => grade > 0);
  if (!relevant.length) return { recall: null, reciprocalRank: null, ndcg: null, falseHit: results.length > 0 };
  const found = results.filter(id => (judgments[id] ?? 0) > 0); const first = results.findIndex(id => (judgments[id] ?? 0) > 0);
  const dcg = (grades: number[]) => grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
  const ideal = dcg(relevant.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k));
  return { recall: found.length / relevant.length, reciprocalRank: first === -1 ? 0 : 1 / (first + 1), ndcg: dcg(results.map(id => judgments[id] ?? 0)) / ideal, falseHit: false };
}

/** Run the production BM25 implementation on a fixed fictional corpus, without a model, network or prerecorded hits. */
export async function benchmarkKeywordSearch(k = 3) {
  const bytes = await readFile(datasetPath); const dataset = parseStrictJson(bytes.toString('utf8')) as unknown as Dataset;
  const encoder = new TextEncoder(); const scope = { tenantId: 'evaluation', projectId: 'keyword-ko' };
  const documents = dataset.documents.map(document => ({ documentId: document.id, revision: 1, originalBytes: encoder.encode(document.text), extractedText: document.text, sourceUri: `urn:studio:evaluation:${document.id}`, extraction: { id: 'verbatim-utf8', version: '1', options: {} } }));
  const corpus = await createCorpusGeneration({ scope, corpusId: 'ko-policies', generationId: dataset.version, documents, chunks: documents.map(document => ({ chunkId: `chunk_${document.documentId}`, documentId: document.documentId, start: 0, end: document.originalBytes.length })) });
  const bundle = await buildLocalSearchIndex({ corpus, indexId: 'ko-keyword', generationId: dataset.version, kind: 'keyword' });
  const provider = await openLocalSearchProvider(bundle); const rows: (QueryJudgment & { ranking: string[] } & ReturnType<typeof queryMetrics>)[] = [];
  for (const query of dataset.queries) {
    const response = await provider.search({ index: bundle.index.ref, query: query.query, channel: 'keyword', allowedDocumentIds: documents.map(document => document.documentId), authorizationEpoch: 1, limit: k }, new AbortController().signal);
    if (response.status !== 'ok') throw new Error(`Search failed for ${query.id}: ${response.code}`);
    const ranking = response.hits.map(hit => corpus.chunks.find(chunk => chunk.ref.chunkId === hit.chunkId)!.ref.document.documentId);
    rows.push({ ...query, ranking, ...queryMetrics(ranking, query.judgments, k) });
  }
  const summarize = (items: typeof rows) => {
    const answerable = items.filter(row => row.recall !== null); const unanswerable = items.filter(row => row.recall === null);
    const mean = (key: 'recall' | 'reciprocalRank' | 'ndcg') => answerable.length ? answerable.reduce((sum, row) => sum + row[key]!, 0) / answerable.length : null;
    return { queries: items.length, answerable: answerable.length, unanswerable: unanswerable.length, recall: mean('recall'), mrr: mean('reciprocalRank'), ndcg: mean('ndcg'), falseHitRate: unanswerable.length ? unanswerable.filter(row => row.falseHit).length / unanswerable.length : null };
  };
  return { dataset: dataset.version, datasetSha256: createHash('sha256').update(bytes).digest('hex'), description: dataset.description, algorithm: LOCAL_SEARCH_FORMAT, indexManifestSha256: bundle.index.ref.manifestHash, k, externalModelTested: false, releaseEvidence: false, total: summarize(rows), categories: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => [category, summarize(rows.filter(row => row.category === category))])), queries: rows };
}

// Reports are internal diagnostics. This command never marks examples usable, creates release signatures or edits judgments.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await benchmarkKeywordSearch(); const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = join(root, 'artifacts', 'evaluation'); await mkdir(directory, { recursive: true });
  const target = join(directory, 'keyword-ko-latest.json'); await writeFile(target, JSON.stringify({ checkedAt: new Date().toISOString(), node: process.version, ...report }, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ path: target, ...report.total, categories: report.categories }, null, 2) + '\n');
}
