import type { EventRecord } from './types';

export interface RerankStatusView { sequence: number; nodeId: string; state: 'reranked' | 'fallback' | 'skipped_empty' | 'failed' | 'unknown'; title: string; description: string; failureCode?: string }

/** Read only sanitized durable stage events, never infer reranking success from a completed run or a model's text. */
export function rerankStatuses(events: readonly EventRecord[]): RerankStatusView[] {
  return events.filter(event => event.type === 'rag.rerank').map(event => {
    const value = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
    const state = ['reranked', 'fallback', 'skipped_empty', 'failed'].includes(String(value.status)) ? value.status as RerankStatusView['state'] : 'unknown';
    const copy = {
      reranked: ['검색 결과를 다시 정렬했습니다', '형식을 검사한 모델 점수로 정렬한 단계 기록입니다. 검색 정확도나 최종 결과 공개를 보증하지 않습니다.'],
      fallback: ['원래 검색 순위를 사용했습니다', '허용된 공급자 실패로 재정렬을 적용하지 않았습니다. 원래 검색 후보 순서를 사용했으며 재정렬 점수는 없습니다.'],
      skipped_empty: ['재정렬할 검색 결과가 없습니다', '후보가 없어 이 재정렬 단계는 모델을 호출하지 않았습니다.'],
      failed: ['검색 결과 재정렬을 중단했습니다', '이 기록을 성공이나 원래 순위 사용으로 처리하지 않습니다. 실행 상태와 오류를 함께 확인하세요.'],
      unknown: ['재정렬 기록을 확인해야 합니다', '이 Runner 화면에서 해석할 수 없는 단계 상태입니다. 성공으로 표시하지 않습니다.'],
    }[state];
    return { sequence: event.sequence, nodeId: typeof value.nodeId === 'string' ? value.nodeId : '검색 단계', state, title: copy[0]!, description: copy[1]!, ...(typeof value.failureCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.failureCode) ? { failureCode: value.failureCode } : {}) };
  });
}
