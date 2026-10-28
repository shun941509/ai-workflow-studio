"use client";
import { useId, useState } from 'react';
import type { Workflow, WorkflowNode } from '@studio/spec';
import { Button, Field } from '@studio/ui';
import { SchemaFields } from './ValueForms';
import { declaredProfiles } from './rag-authoring';
import { AGENTIC_AUTHORING, addAgenticDeclaration, changeAgentStrategy, nextAgenticAlias, validateAuthoredAgent, type AgentNode, type AgentStrategy } from './agent-authoring';

type Props = { node: WorkflowNode; workflow: Workflow; onNode: (patch: Partial<WorkflowNode>) => void; onWorkflow: (patch: Partial<Workflow>) => void };
const searchLimits = [
  { key: 'maxRounds', label: '최대 검색 라운드', min: 1, max: AGENTIC_AUTHORING.maxRounds },
  { key: 'maxQueriesPerRound', label: '라운드당 최대 검색어 수', min: 1, max: AGENTIC_AUTHORING.maxQueriesPerRound },
  { key: 'maxRetrievedChunks', label: '누적 문서 조각 수', min: 1, max: AGENTIC_AUTHORING.maxRetrievedChunks },
  { key: 'maxContextTokens', label: '누적 검색 문맥 (토큰)', min: 20, max: AGENTIC_AUTHORING.maxContextTokens },
] as const;

/** This panel is an authoring surface only; model credentials and run authorization remain in Runner. */
export function AgentInspector(props: Props) {
  if (props.node.type !== 'agent') return null;
  return <AgentFields {...props} node={props.node} key={props.node.id}/>;
}

/** Pending destructive intent belongs to the exact immutable node snapshot, never just an ID reused by another flow. */
function AgentFields({ node, workflow, onNode, onWorkflow }: Omit<Props, 'node'> & { node: AgentNode }) {
  const id = useId();
  const [alias, setAlias] = useState('');
  const [failure, setFailure] = useState<{ node: AgentNode; message: string }>();
  const [pendingTask, setPendingTask] = useState<AgentNode>();
  const agentic = node.config.strategy === 'agentic_rag';
  const policy = node.config.retrievalPolicy;
  const profiles = declaredProfiles(workflow, 'chat');
  const patch = (config: AgentNode['config']) => onNode({ config } as Partial<WorkflowNode>);
  const act = (action: () => void) => {
    try { action(); setFailure(undefined); setPendingTask(undefined); }
    catch (error) { setFailure({ node, message: error instanceof Error ? error.message : '설정을 확인하세요.' }); }
  };
  let validation = '';
  try { validateAuthoredAgent(node, workflow); } catch (error) { validation = error instanceof Error ? error.message : '에이전트 설정을 확인하세요.'; }

  return <>
    <Field label="에이전트 실행 방식" htmlFor={`${id}-strategy`}><select id={`${id}-strategy`} value={node.config.strategy} onChange={event => {
      const strategy = event.target.value as AgentStrategy;
      if (strategy === 'task' && agentic && (policy || Object.hasOwn(node.inputBindings, 'indexes'))) { setPendingTask(node); setFailure(undefined); }
      else act(() => onWorkflow(changeAgentStrategy(workflow, node.id, strategy)));
    }}><option value="task">한 번 작업하기</option><option value="agentic_rag">키워드 문서를 검색하며 답하기</option></select></Field>
    {pendingTask === node && <section className="step-card" aria-label="단일 작업 전환 확인"><p>단일 작업으로 바꾸면 검색 설정과 색인 입력이 제거됩니다. 작업 지침·모델 프로필·결과 형식·작업 및 참고 입력은 유지합니다.</p><Button variant="secondary" onClick={() => act(() => onWorkflow(changeAgentStrategy(workflow, node.id, 'task', { discardSearchSettings: true })))}>검색 설정과 색인 입력을 제거하고 전환</Button><Button variant="ghost" onClick={() => setPendingTask(undefined)}>전환 취소</Button></section>}
    {failure?.node === node && <p className="form-error" role="alert">{failure.message}</p>}
    <Field label="에이전트 역할과 작업 방법" htmlFor={`${id}-instructions`} hint={agentic ? '최대 16,000자. 가져온 긴 지침은 자동으로 자르지 않습니다.' : undefined}><textarea id={`${id}-instructions`} rows={7} value={node.config.instructions} maxLength={agentic ? 16000 : 100000} onChange={event => patch({ ...node.config, instructions: event.target.value })}/></Field>
    <Field label="에이전트 모델 프로필" htmlFor={`${id}-profile`}><select id={`${id}-profile`} value={node.config.modelProfile} onChange={event => patch({ ...node.config, modelProfile: event.target.value })}>{!profiles.includes(node.config.modelProfile) && <option value={node.config.modelProfile}>{node.config.modelProfile || '선택 필요'} (대화 프로필 필요)</option>}{profiles.map(profile => <option key={profile}>{profile}</option>)}</select></Field>
    {agentic && <>
      <Button variant="secondary" onClick={() => act(() => { onWorkflow(addAgenticDeclaration(workflow, node.id, alias || nextAgenticAlias(workflow))); setAlias(''); })}>검색 에이전트용 모델 프로필 추가</Button>
      <p className="inline-help">실제 연결은 Runner에서 지정합니다. OpenAI {AGENTIC_AUTHORING.model} 대화 모델이 필요합니다. 같은 이름의 임베딩·재정렬 연결은 사용할 수 없습니다. 기존 프로필을 공유하면 같은 프로필을 쓰는 작업에도 이 모델 요구가 적용됩니다.</p>
      <p className="inline-help">모델이 판단할 때 작업·참고 내용·찾은 원문 근거가 토큰 확인과 응답 생성 요청으로 OpenAI에 전달됩니다. 검색을 반복하면 추가 모델 호출과 요금이 발생할 수 있습니다. 키워드 검색 자체는 내 PC에서 수행합니다.</p>
    </>}
    <SchemaFields label={agentic ? '답변이 있을 때의 결과 형식' : '에이전트 결과 형식'} value={node.config.resultSchema} onChange={resultSchema => patch({ ...node.config, resultSchema })}/>
    {agentic ? <>
      <section className="step-card"><strong>검색용 색인 연결</strong><p className="inline-help">입력·결과 탭에서 ‘에이전트가 할 일’과 ‘검색용 색인 목록’을 연결하세요. 현재 실행에서 만든 서로 다른 키워드 색인 1~4개가 필요합니다. 색인이 하나여도 경로 합류 블록의 ‘목록 만들기’로 배열을 만든 뒤 전체 결과를 연결하세요.</p><p className="inline-help">추가 참고 내용은 선택사항이며 JSON 기준 UTF-8 16 KiB까지입니다. 직접 자료 첨부, 추가 질문, 외부 도구, 벡터·혼합·재순위·Graph 검색은 이 모드에서 지원하지 않습니다.</p></section>
      <details className="advanced-settings"><summary>검색 범위와 한도</summary>
        <Field label="전체 최대 단계" htmlFor={`${id}-steps`} hint="모델의 판단 한 번과 개별 검색 한 번을 각각 한 단계로 계산합니다."><input id={`${id}-steps`} type="number" min={3} max={AGENTIC_AUTHORING.maxSteps} step={1} value={node.config.maxSteps} onChange={event => patch({ ...node.config, maxSteps: Number(event.target.value) })}/></Field>
        {policy ? searchLimits.map(limit => <Field key={limit.key} label={limit.label} htmlFor={`${id}-${limit.key}`}><input id={`${id}-${limit.key}`} type="number" min={limit.min} max={limit.max} step={1} value={policy[limit.key]} onChange={event => patch({ ...node.config, retrievalPolicy: { ...policy, [limit.key]: Number(event.target.value) } })}/></Field>) : <p role="alert" className="inline-help">가져온 설정에 검색 정책이 없습니다. 원본을 자동으로 변경하지 않습니다.</p>}
        <p className="inline-help">검색 문맥은 안내문을 포함한 o200k_base 토큰 누적량입니다. 모델의 전체 과금 토큰이나 비용 상한은 아닙니다. 실행 전체의 모델 호출·토큰·시간 예산도 함께 적용됩니다.</p>
        <p className="inline-help">근거 부족 처리: {policy?.onInsufficient === 'abstain' ? '답변 유보' : `${policy?.onInsufficient ?? '설정 누락'} (가져온 설정 · 현재 미지원)`}. 자동 재시도와 오류 경로 우회 없이 실행 오류를 중단합니다.</p>
        <Field label="새 검색 에이전트 프로필 식별자" htmlFor={`${id}-alias`} hint="선택사항입니다. 비워 두면 사용하지 않는 이름을 정합니다."><input id={`${id}-alias`} value={alias} maxLength={64} placeholder={nextAgenticAlias(workflow)} onChange={event => setAlias(event.target.value)}/></Field>
      </details>
      <p className="inline-help">결과에는 답변 상태·답변·인용·종료 이유·사용량이 담깁니다. 근거 부족이나 충돌이면 답변(/data/result)은 null입니다. 최종 결과를 JSON으로 설정하고 /data 전체를 연결하면 유보 상태와 근거를 함께 보존할 수 있습니다. 원문 인용 확인이 답변의 정확성을 보증하지는 않습니다.</p>
    </> : <p className="inline-help">모델 호출 한 번으로 지정한 작업을 수행합니다. 다음 블록은 /data/result에서 결과를 읽습니다. 도구 사용·반복·검색은 이 모드에서 지원하지 않습니다.</p>}
    {validation && <p className="form-error" role="status">{validation}</p>}
  </>;
}
