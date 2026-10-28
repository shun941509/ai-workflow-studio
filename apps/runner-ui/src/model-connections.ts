import type { ModelRequirement, PackageDetail, Profile } from './types';

export const RERANK_MODEL = 'gpt-5.4-mini-2026-03-17';
export const AGENTIC_MODEL = 'gpt-5.4-mini-2026-03-17';
export const AGENTIC_TRANSFER_NOTICE = 'Agentic RAG는 작업 내용·추가 문맥·검색한 원문 근거를 매 계획의 토큰 확인과 응답 생성 요청에서 OpenAI로 전송합니다. 키워드 검색 자체는 PC에서 수행하지만 계획·답변은 유료 모델 호출입니다. 최대4회 검색·회당3질의·32단계와 기존 실행 예산을 함께 적용합니다. 근거가 부족하면 답변을 보류하며 실제 모델 접근 권한·답변 품질은 준비 검사로 확인하지 않습니다.';
export const RERANK_TRANSFER_NOTICE = '검색 결과 재정렬 시 검색어와 후보 원문이 토큰 확인·재정렬 요청에서 OpenAI로 전송됩니다. 최대 20후보·합계 64 KiB, 응답 상한 4096토큰을 기존 실행 예산에서 예약합니다. 추가 요금이 발생할 수 있으며 실제 모델 접근 권한·검색 품질은 준비 검사로 확인하지 않습니다.';

/** A missing saved kind is the only legacy fallback; unsupported kinds must never become chat. */
export function profileKind(profile: Profile): string { return profile.kind === undefined ? 'chat' : profile.kind; }
export function profileKindName(profile: Profile): string {
  const kind = profileKind(profile);
  return kind === 'chat' ? '대화·작업' : kind === 'embedding' ? '문서 임베딩' : kind === 'reranker' ? '검색 결과 재정렬' : '지원하지 않는 연결 종류';
}
export function requirementLabel(requirement: ModelRequirement): string { return requirement.constraint?.contractId === 'openai-agentic-keyword-abstain-v1' ? 'Agentic RAG 연결' : requirement.kind === 'embedding' ? '임베딩 연결' : requirement.kind === 'reranker' ? '재정렬 연결' : '대화·작업 연결'; }

/** Server readiness remains authoritative; the client refuses incomplete metadata rather than guessing aliases. */
export function requirementProblem(requirement: ModelRequirement): string | undefined {
  if (requirement.kind === null) return `${requirement.alias}: 프로젝트에 모델 프로필 선언이 없습니다.`;
  if (!['chat', 'embedding', 'reranker'].includes(requirement.kind)) return `${requirement.alias}: 현재 화면에서 지원하지 않는 모델 연결 종류입니다.`;
  if (requirement.kind === 'embedding') {
    const c = requirement.constraint;
    if (!c || c.contractId !== 'openai-small-256-cl100k-v1' || c.provider !== 'openai' || c.model !== 'text-embedding-3-small' || c.dimensions !== 256 || c.maxChunks !== 128) return `${requirement.alias}: 임베딩 실행 규격을 확인할 수 없습니다. Runner를 확인하세요.`;
  }
  if (requirement.kind === 'reranker') {
    const c = requirement.constraint;
    if (!c || c.contractId !== 'openai-responses-rerank-v1' || c.provider !== 'openai' || c.model !== RERANK_MODEL || !('maxCandidates' in c) || c.maxCandidates !== 20 || c.maxInputBytes !== 65536 || c.maxOutputTokens !== 4096) return `${requirement.alias}: 검색 재정렬 실행 규격을 확인할 수 없습니다. Runner를 확인하세요.`;
  }
  if (requirement.kind === 'chat' && requirement.constraint) {
    const c = requirement.constraint;
    if (c.contractId !== 'openai-agentic-keyword-abstain-v1' || c.provider !== 'openai' || c.model !== AGENTIC_MODEL || !('maxIndexes' in c) || c.maxIndexes !== 4 || c.maxInputBytes !== 131072 || c.maxOutputTokens !== 4096) return `${requirement.alias}: Agentic RAG 실행 규격을 확인할 수 없습니다. Runner를 확인하세요.`;
  }
  return undefined;
}

export function packageConnectionProblems(detail: PackageDetail): string[] {
  if (!Array.isArray(detail.modelRequirements) || !Array.isArray(detail.modelProfiles)) return ['모델 연결 규격이 없습니다. Runner를 업데이트하고 패키지를 다시 가져오세요.'];
  const aliases = detail.modelRequirements.map(item => item.alias);
  if (new Set(aliases).size !== aliases.length || aliases.length !== detail.modelProfiles.length || aliases.some(alias => !detail.modelProfiles.includes(alias))) return ['모델 연결 목록이 일치하지 않습니다. 패키지를 다시 가져오세요.'];
  return detail.modelRequirements.flatMap(requirement => { const problem = requirementProblem(requirement); return problem ? [problem] : []; });
}

/** The same provider/model filter drives the options and readiness invalidation; empty matching sets are meaningful. */
export function eligibleProfiles(requirement: ModelRequirement, profiles: Profile[]): Profile[] {
  if (requirementProblem(requirement)) return [];
  return profiles.filter(profile => profileKind(profile) === requirement.kind && profile.provider === 'openai' && (requirement.kind === 'chat' && !requirement.constraint || profile.model === requirement.constraint?.model));
}

/** Every user edit invalidates pending responses immediately, before React's next render or effect. */
export class ReadinessIdentity {
  private revision = 0;
  invalidate(): number { return ++this.revision; }
  matches(revision: number): boolean { return this.revision === revision; }
}
