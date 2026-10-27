import { useEffect, useState } from 'react';
import { Activity, Download, Square, CheckCircle2 } from 'lucide-react';
import { request, downloadFile } from '../api/client';
import { statusNames, type Run, type EventRecord } from '../types';
import { WaitingCard } from './WaitingCard';
import { FileSelectionCard } from './FileSelectionCard';

/** Polls durable run records; an unmounted page cannot overwrite a newly selected execution. */
export function RunPage({ runId }: { runId: string }) {
  const [run, setRun] = useState<Run>(); const [events, setEvents] = useState<EventRecord[]>([]); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>; let cursor = 0;
    setRun(undefined); setEvents([]); setError('');
    const poll = async () => {
      try {
        const [next, added] = await Promise.all([request<Run>(`/api/runs/${runId}`), request<EventRecord[]>(`/api/runs/${runId}/events?after=${cursor}`)]);
        if (!alive) return;
        setRun(next); setEvents((previous) => [...previous, ...added]); cursor = added.at(-1)?.sequence ?? cursor;
        // A completed run can still have more than one event page; drain those pages before ending polling.
        if (['created', 'running', 'waiting', 'cancelling'].includes(next.status) || added.length === 100) timer = setTimeout(() => void poll(), added.length === 100 ? 0 : 1000);
      } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : '실행 상태를 확인하지 못했습니다.'); }
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [runId]);
  async function cancel() { try { setRun(await request<Run>(`/api/runs/${runId}/cancel`, { method: 'POST', body: {} })); } catch (failure) { setError(String(failure)); } }
  const envelope = run?.result as { data?: unknown; text?: string } | null;
  const result = envelope ? typeof envelope.data === 'string' ? envelope.data : JSON.stringify(envelope.data, null, 2) : '';
  const fileResult = envelope?.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) && run?.files?.some((file) => file.reference.id === (envelope.data as { id?: unknown }).id);
  function download() { const url = URL.createObjectURL(new Blob([result ?? ''], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `${runId}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  return <div className="page-stack"><div className="section-title"><span className="eyebrow">EXECUTION</span><h1>실행 상태와 결과</h1><p className="run-id">{runId}</p></div>
    {error && <p className="error" role="alert">{error}</p>}
    {run ? <><div className="run-summary"><div><span className={`status status-${run.status}`}><Activity size={16} />{statusNames[run.status] ?? run.status}</span><p>{new Date(run.createdAt).toLocaleString('ko-KR')}</p></div><div><strong>{run.usage.modelCalls}</strong><span>모델 호출</span></div><div><strong>{run.usage.consumedTokens.toLocaleString()}</strong><span>확인된 토큰</span></div><div><strong>{run.usage.reservedTokens.toLocaleString()}</strong><span>예약·확인 중 토큰</span></div>{['created', 'running', 'waiting'].includes(run.status) && <button className="secondary danger" onClick={() => void cancel()}><Square size={15} />취소 요청</button>}</div>
      {run.error && <div className="notice warning" role="alert"><span><strong>{run.error.message}</strong><br /><small>{run.error.code}</small></span></div>}
      {events.some((event) => event.type === 'orchestrator.planned') && <div className="notice"><span><strong>실행 계획을 작성했습니다.</strong><br />계획 안의 작업은 실행하지 않았습니다. 계획은 검토할 자료이며 도구 사용이나 외부 변경을 승인하지 않습니다.</span></div>}
      {run.waits?.map((wait) => wait.kind === 'files' ? <FileSelectionCard key={wait.id} wait={wait} uploaded={(run.files ?? []).filter((file) => file.waitId === wait.id && file.source === 'user_upload')} /> : <WaitingCard key={wait.id} wait={wait} />)}
      {!!run.files?.length && <section className="panel"><h2>작업 파일</h2><ul className="child-scopes">{run.files.map(({ reference, source }) => <li key={reference.id}><div><strong>{reference.filename}</strong><small>{source === 'user_upload' ? '선택한 파일' : '만든 파일'} · {reference.bytes.toLocaleString()} bytes</small></div><button className="secondary" onClick={() => void downloadFile(`/api/runs/${run.id}/artifacts/${reference.id}`, reference.filename).catch((failure) => setError(String(failure)))}><Download size={16} />내려받기</button></li>)}</ul></section>}
      {!!run.childScopes?.length && <section className="panel"><h2>하위 작업 <span className="count">{run.childScopeCount ?? run.childScopes.length}</span></h2><p className="field-note">반복·병렬·팀 작업도 이 실행의 사용량과 한도를 함께 사용합니다.{(run.childScopeCount ?? 0) > run.childScopes.length && ' 최근 200개 작업을 표시합니다.'}</p><ul className="child-scopes">{run.childScopes.map((scope) => <li key={scope.id}><div><strong>{scope.flowId}</strong><small>{scope.key.startsWith('item:') ? `목록 ${Number(scope.key.slice(5)) + 1}번째` : scope.key.startsWith('iteration:') ? `${scope.key.slice(10)}번째 반복` : scope.key.startsWith('branch:') ? `분기 ${scope.key.slice(7)}` : scope.key.startsWith('member:') ? `팀 작업자 ${scope.key.slice(7)}` : scope.key === 'integration' ? '팀 결과 통합' : '하위 흐름'} · 깊이 {scope.depth}</small>{scope.error && <p>{scope.error.message}</p>}</div><span className={`status status-${scope.status}`}>{statusNames[scope.status] ?? scope.status}</span></li>)}</ul></section>}
      <div className="two-columns"><section className="panel"><div className="panel-heading"><CheckCircle2 size={20} /><h2>작업 결과</h2>{envelope && !fileResult && <button className="icon-button" onClick={download} aria-label="결과 내려받기"><Download size={18} /></button>}</div>{fileResult ? <p>파일을 만들었습니다. 위 작업 파일에서 내려받을 수 있습니다.</p> : envelope ? <pre className="result-content">{result}</pre> : <div className="empty"><Activity size={30} /><p>{run.status === 'running' ? '작업을 처리하고 있습니다.' : '아직 확인된 결과가 없습니다.'}</p></div>}</section>
      <section className="panel"><h2>진행 기록</h2><ol className="timeline">{events.map((event) => { const data = event.payload as { nodeId?: string; status?: string; filename?: string }; const action = data.status ? statusNames[data.status] ?? data.status : event.type === 'attempt.started' ? '처리 시작' : event.type === 'wait.created' ? '사용자 응답 대기' : event.type === 'wait.responded' ? '사용자 응답 저장' : event.type === 'wait.consumed' ? '후속 작업 준비' : event.type === 'artifact.registered' ? `${data.filename ?? '파일'} 저장` : event.type.startsWith('run.') ? statusNames[event.type.slice(4)] ?? event.type : event.type === 'model.reserved' ? '모델 사용량 예약' : event.type === 'model.usage' ? '모델 사용량 기록' : '처리 기록'; return <li key={event.sequence}><span className="timeline-dot" /><div><strong>{data.nodeId ? `${data.nodeId} · ${action}` : action}<small>{new Date(event.createdAt).toLocaleTimeString('ko-KR')}</small></strong></div></li>; })}</ol></section></div>
    </> : <div className="panel empty"><Activity size={30} /><p>실행 기록을 불러오고 있습니다.</p></div>}
  </div>;
}
