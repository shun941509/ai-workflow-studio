import { NODE_DEFINITIONS } from '@studio/spec';
import type { OfficialExample } from './contracts.generated.js';

export interface OfficialCatalog { schemaVersion: '1.0.0'; releaseTargets: { projects: 120; resources: 120 }; entries: OfficialExample[] }
const sourcePath = 'docs/specifications/official-catalog-design.md' as const;

/** Preserve the exact authoring brief; deriving metadata never declares the item implemented. */
export function parseOfficialBrief(markdown: string): OfficialExample[] {
  const known = new Set(NODE_DEFINITIONS.map((node) => node.type));
  return markdown.split(/\r?\n/).filter((line) => /^\| E[PR]-\d{3} /.test(line)).map((row) => {
    const cells = row.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) throw new Error(`Expected five catalogue columns: ${row}`);
    const matched = /^(E[PR]-\d{3}) (.+)$/.exec(cells[0]!);
    if (!matched) throw new Error(`Invalid catalogue identity: ${row}`);
    const id = matched[1]!; const rawName = matched[2]!;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(rawName);
    const name = link?.[1] ?? rawName;
    const kind = id.startsWith('EP-') ? 'project' : 'resource';
    const number = Number(id.slice(3));
    const resourceKind = kind === 'project' ? undefined : number <= 10 ? 'mcp' : number <= 40 ? 'instruction' : number <= 60 ? 'document' : 'skill';
    const blocks = [...new Set([...cells[2]!.matchAll(/`([^`]+)`/g)].flatMap((match) => match[1]!.split('·')))];
    if (!blocks.length || blocks.some((block) => !known.has(block as typeof NODE_DEFINITIONS[number]['type']))) throw new Error(`Unknown block in ${id}`);
    const requiredCapabilities = [...new Set([...(kind === 'project' ? ['input', 'output'] : []), ...blocks])].map((block) => `node.${block}@1`);
    if (/Agentic RAG/.test(name)) requiredCapabilities.push('agent.agentic_rag@1');
    if (/Hybrid|RRF/.test(row)) requiredCapabilities.push('retrieval.hybrid@1');
    if (/reranker|재정렬/.test(row)) requiredCapabilities.push('retrieval.rerank@1');
    if (/GraphRAG|그래프|개체|관계·/.test(row)) requiredCapabilities.push('knowledge.graph@1');
    const externalDependencies: OfficialExample['externalDependencies'] = [];
    if (blocks.some((block) => ['ai', 'agent', 'agent_team', 'orchestrator', 'classify'].includes(block))) externalDependencies.push({ id: 'model', kind: 'model', requirement: '실제 모델 프로필 연결·호출·사용량을 검증해야 합니다.' });
    if (resourceKind === 'mcp' || /\/(?:[^|]*)(GitHub|Notion|Jira|Confluence|Linear|Figma|Sentry|MCP)/.test(cells[2]!)) externalDependencies.push({ id: 'service', kind: 'service', requirement: cells[2]! });
    if (/제한 DB|SQL|DB 권한/.test(row)) externalDependencies.push({ id: 'database', kind: 'database', requirement: '쓰기 금지된 실제 데이터베이스 권한과 조회 결과를 검증해야 합니다.' });
    if (/\/.*웹|웹 검색/.test(row)) externalDependencies.push({ id: 'search', kind: 'search', requirement: '실제 검색 결과의 URL·본문·확인 시점을 검증해야 합니다.' });
    if (/격리 브라우저/.test(row)) externalDependencies.push({ id: 'browser', kind: 'browser', requirement: '격리된 브라우저와 허용 사이트 범위에서 실제 관측을 기록해야 합니다.' });
    if (/임베딩|벡터|Hybrid/.test(row)) externalDependencies.push({ id: 'embedding', kind: 'embedding', requirement: '실제 임베딩 모델·차원·색인 버전·검색 결과를 기록해야 합니다.' });
    if (/reranker|재정렬/.test(row)) externalDependencies.push({ id: 'reranker', kind: 'reranker', requirement: '실제 재정렬 프로필·후보·순위와 실패 정책을 검증해야 합니다.' });
    if (requiredCapabilities.includes('knowledge.graph@1')) externalDependencies.push({ id: 'graph', kind: 'graph', requirement: '출처 있는 실제 개체·관계·색인과 조회 경로를 검증해야 합니다.' });
    return {
      schemaVersion: '1.0.0', id, kind, ...(resourceKind ? { resourceKind } : {}), name, state: 'planned',
      source: { path: sourcePath, row, ...(link?.[2] ? { referenceUrl: link[2] } : {}) },
      definition: { purpose: cells[1]!, blocksAndConnections: cells[2]!, inputOutput: cells[3]!, acceptanceCriteria: cells[4]! },
      blocks: blocks as OfficialExample['blocks'], requiredCapabilities: [...new Set(requiredCapabilities)] as OfficialExample['requiredCapabilities'], externalDependencies,
      targetHosts: ['codex', 'claude-code', 'opencode'], verificationRecords: [], requiresExtension: rawName.includes('†'),
    };
  });
}

/** Stable source comparison prevents silently replacing any agreed example with a differently named filler. */
export function sourceIdentity(entry: OfficialExample) { return { id: entry.id, kind: entry.kind, resourceKind: entry.resourceKind, name: entry.name, source: entry.source, definition: entry.definition }; }
