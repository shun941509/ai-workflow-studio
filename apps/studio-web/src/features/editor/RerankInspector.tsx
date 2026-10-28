"use client";
import { useId, useState } from 'react';
import type { Workflow, WorkflowNode } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { addRerankerDeclaration, declaredProfiles, nextRerankerAlias, toggleRerank } from './rag-authoring';
import styles from './rerank-inspector.module.css';

/** Opt-in scoring has a distinct provider role and bounded candidate inventory, even for keyword search. */
export function RerankInspector({ node, workflow, onNode, onWorkflow }: { node: Extract<WorkflowNode, { type: 'retrieval' }>; workflow: Workflow; onNode: (patch: Partial<WorkflowNode>) => void; onWorkflow: (patch: Partial<Workflow>) => void }) {
  const id = useId(); const [alias, setAlias] = useState(''); const [error, setError] = useState(''); const settings = node.config.reranker;
  const profiles = declaredProfiles(workflow, 'reranker'); const selected = settings?.modelProfile ?? '';
  const patch = (value: Partial<NonNullable<typeof settings>>) => onNode({ config: { ...node.config, reranker: { ...settings!, ...value } } } as Partial<WorkflowNode>);
  return <section className="step-card"><label className={styles.toggle}><input type="checkbox" checked={!!settings} disabled={!['keyword', 'vector', 'hybrid'].includes(node.config.mode)} onChange={event => { setError(''); onNode(toggleRerank(node, event.target.checked)); }}/> 검색 결과 다시 정렬</label>
    <p className="inline-help">찾은 문서 후보를 AI가 검색어와의 관련성으로 다시 정렬합니다. 답변 생성이나 정확도 보장은 아닙니다.</p>
    {settings && <>
      <p className="inline-help">키워드 검색에서도 이 옵션을 켜면 검색어와 후보 원문이 토큰 확인·재정렬 요청에서 OpenAI로 전송됩니다. 최대 20후보·원문과 검색어 합계 64 KiB, gpt-5.4-mini-2026-03-17 고정 모델을 사용합니다. 기존 실행 예산을 함께 쓰며 추가 요금이 발생할 수 있습니다.</p>
      <Field label="검색 재정렬용 연결" htmlFor={`${id}-profile`}><select id={`${id}-profile`} value={selected} onChange={event => patch({ modelProfile: event.target.value })}><option value="">연결 자리를 추가하거나 선택하세요</option>{selected && !profiles.includes(selected) && <option value={selected}>{selected} (선언 누락 또는 종류 불일치)</option>}{profiles.map(name => <option key={name}>{name}</option>)}</select></Field>
      <Button variant="secondary" onClick={() => { try { onWorkflow(addRerankerDeclaration(workflow, node.id, alias || nextRerankerAlias(workflow))); setAlias(''); setError(''); } catch (failure) { setError(failure instanceof Error ? failure.message : '연결 식별자를 확인하세요.'); } }}>검색 재정렬용 연결 추가</Button>{error && <p role="alert" className="inline-help">{error}</p>}
      <Field label="다시 정렬할 후보 수" htmlFor={`${id}-candidates`} hint="후보 수 → 재정렬 → 최대 검색 결과 수 → 문맥 분량 순서입니다."><input id={`${id}-candidates`} type="number" min={node.config.topK} max={20} value={node.config.candidateLimit ?? ''} onChange={event => onNode({ config: { ...node.config, candidateLimit: Number(event.target.value) } } as Partial<WorkflowNode>)}/></Field>
      {(node.config.topK > 20 || !node.config.candidateLimit || node.config.candidateLimit > 20 || node.config.candidateLimit < node.config.topK) && <p role="alert" className="inline-help">최대 검색 결과 수 ≤ 후보 수 ≤ 20으로 설정하세요. 기존 값은 자동으로 줄이지 않습니다.</p>}
      <details className="advanced-settings"><summary>재정렬 세부 설정</summary>
        <Field label="재정렬 최대 대기 시간 (밀리초)" htmlFor={`${id}-timeout`} hint="1000밀리초 = 1초. 기본 30초, 최대 120초. 전체 실행·노드 시간 제한도 함께 적용합니다."><input id={`${id}-timeout`} type="number" min={1} max={120000} step={1} value={settings.timeoutMs} onChange={event => patch({ timeoutMs: Number(event.target.value) })}/></Field>
        <Field label="재정렬 실패 처리" htmlFor={`${id}-failure`}><select id={`${id}-failure`} value={settings.onFailure} onChange={event => patch({ onFailure: event.target.value as 'fail' | 'use_original' })}><option value="fail">실행 중단 (기본)</option><option value="use_original">허용된 실패에만 원래 검색 순위 사용</option></select></Field>
        <p className="inline-help">원래 순위 사용은 생성 전 확정된 호출 제한·토큰 확인 불가 또는 사용량이 확인된 모델 거절에만 적용합니다. 인증·권한·응답 변조·취소·시간·예산·처리 결과 불명은 계속 중단합니다. 대체 결과는 실행 기록에 표시합니다.</p>
        <Field label="새 재정렬 프로필 식별자" htmlFor={`${id}-alias`} hint="선택사항입니다. 비워 두면 자동으로 정합니다. 실제 연결 이름은 Runner에서 한글로 입력하세요."><input id={`${id}-alias`} value={alias} maxLength={64} placeholder={nextRerankerAlias(workflow)} onChange={event => setAlias(event.target.value)}/></Field>
      </details>
    </>}
  </section>;
}
