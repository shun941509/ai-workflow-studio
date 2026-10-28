import { presentOutcome, checkMethods, checkReasons } from '../outcome-presentation';

/** Assessment is a separate, escaped view of fixed criteria, never a reinterpretation of generated result text. */
export function OutcomeCard({ outcome, status }: { outcome: unknown; status: string }) {
  const view = presentOutcome(outcome, status);
  return <section className="panel" aria-label="업무 완료 판단"><h2>{view.label}</h2><p>{view.description}</p>
    {!!view.outcome?.checks.length && <ul className="child-scopes">{view.outcome.checks.map(check => <li key={check.criterionId}><div><strong>{check.label}</strong><p>{checkReasons[check.reason]}</p><small>{checkMethods[check.method]}</small>{check.method === 'model_evaluation' && <p className="field-note">모델의 평가는 사실 인증을 보장하지 않습니다.</p>}<details><summary>판정 근거 확인</summary><small>블록: {check.source.nodeId}<br/>실행 근거: {check.source.nodeInstanceId ?? '없음'}<br/>결과 해시: {check.source.resultHash ?? '없음'}</small></details></div><span>{check.status === 'passed' ? '충족' : check.status === 'failed' ? '미충족' : '확인 불가'}</span></li>)}</ul>}
  </section>;
}
