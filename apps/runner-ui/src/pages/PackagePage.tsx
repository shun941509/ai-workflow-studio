import { useEffect, useRef, useState, type FormEvent, type ChangeEvent } from 'react';
import { UploadCloud, PackageCheck, Play, CheckCircle2, ArrowRight } from 'lucide-react';
import { request } from '../api/client';
import type { PackageDetail, Profile, PackageSummary } from '../types';
import { eligibleProfiles, packageConnectionProblems, ReadinessIdentity, requirementProblem, requirementLabel, RERANK_TRANSFER_NOTICE, AGENTIC_TRANSFER_NOTICE } from '../model-connections';
import { REQUEST_INTENT_PREFIX, RunRequestIntents, type PendingRunRequest } from '../request-intent';

/** Runtime forms follow the package input schema; non-scalar values use an explicit JSON field. */
export function PackagePage({ profiles, packages, onImported, onStarted, onConnections, active = true }: { profiles: Profile[]; packages: PackageSummary[]; onImported: () => Promise<void>; onStarted: (id: string) => void; onConnections: () => void; active?: boolean }) {
  const [selected, setSelected] = useState<PackageDetail>(); const [values, setValues] = useState<Record<string, unknown>>({});
  const [modelBindings, setBindings] = useState<Record<string, string>>({}); const [issues, setIssues] = useState<{ message: string }[]>([]);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const identity = useRef(new ReadinessIdentity());
  const actionInFlight = useRef(false);
  const [intents] = useState(() => new RunRequestIntents(() => window.localStorage, {
    start: body => request('/api/runs', { method: 'POST', body }),
    lookup: id => request(`/api/run-requests/${id}`),
  }));
  const [pending, setPending] = useState<PendingRunRequest[]>([]);
  const [recovered, setRecovered] = useState<{ requestId: string; runId: string }[]>([]);
  const [storageReady, setStorageReady] = useState(false); const [recovering, setRecovering] = useState(true);
  const [separateExecution, setSeparateExecution] = useState(false);
  function refreshRequests() {
    try { setPending(intents.pending()); setStorageReady(true); }
    catch (failure) { setStorageReady(false); setError(failure instanceof Error ? failure.message : '실행 요청 기록을 확인하지 못했습니다.'); }
  }
  // Reload checks only opaque IDs. It never sends stored input, reconstructs a POST, or treats not_found as non-execution.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const entries = intents.pending(); if (alive) { setPending(entries); setStorageReady(true); }
        await Promise.all(entries.map(async entry => {
          try { const runId = await intents.lookup(entry.requestId); if (alive && runId) setRecovered(items => [...items.filter(item => item.requestId !== entry.requestId), { requestId: entry.requestId, runId }]); }
          catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : '이전 실행 요청을 확인하지 못했습니다.'); }
        }));
      } catch (failure) { if (alive) { setStorageReady(false); setError(failure instanceof Error ? failure.message : '실행 요청 기록을 확인하지 못했습니다.'); } }
      finally { if (alive) { refreshRequests(); setRecovering(false); } }
    })();
    function onStorage(event: StorageEvent) { if (event.key === null || event.key.startsWith(REQUEST_INTENT_PREFIX)) { setSeparateExecution(false); refreshRequests(); } }
    window.addEventListener('storage', onStorage);
    return () => { alive = false; window.removeEventListener('storage', onStorage); };
  }, [intents]);
  function invalidate() { identity.current.invalidate(); setReady(false); setIssues([]); }
  // A saved-profile refresh or navigation cannot retain approval for an older preparation state.
  useEffect(() => { invalidate(); }, [profiles, active]);
  useEffect(() => () => { identity.current.invalidate(); }, []);
  function choose(detail: PackageDetail) { invalidate(); setSelected(detail); setValues({}); setBindings({}); setError(''); }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    invalidate(); setBusy(true); setError('');
    try { choose(await request<PackageDetail>('/api/packages/import', { method: 'POST', zip: await file.arrayBuffer() })); await onImported(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '패키지를 가져오지 못했습니다.'); }
    finally { setBusy(false); event.target.value = ''; }
  }
  async function load(handle: string) { invalidate(); setBusy(true); try { choose(await request<PackageDetail>(`/api/packages/${handle}`)); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function check() {
    if (!selected || packageConnectionProblems(selected).length) return; invalidate(); const revision = identity.current.invalidate(); setBusy(true); setError('');
    try { const result = await request<{ ready: boolean; issues: { message: string }[] }>(`/api/packages/${selected.packageHandle}/validate`, { method: 'POST', body: { modelBindings } }); if (identity.current.matches(revision)) { setReady(result.ready); setIssues(result.issues); } }
    catch (failure) { if (identity.current.matches(revision)) setError(failure instanceof Error ? failure.message : '준비 상태를 확인하지 못했습니다.'); } finally { setBusy(false); }
  }
  async function start(event: FormEvent) {
    event.preventDefault(); if (!selected || !ready || busy || recovering || !storageReady || actionInFlight.current || packageConnectionProblems(selected).length) return;
    actionInFlight.current = true; setBusy(true); setError('');
    try {
      const prepared = { ...values }; const properties = (selected.inputs.properties ?? {}) as Record<string, { type?: string }>;
      for (const [key, schema] of Object.entries(properties)) if (schema.type === 'object' || schema.type === 'array') {
        if (typeof prepared[key] === 'string') prepared[key] = JSON.parse(prepared[key] as string);
      }
      invalidate();
      const operation = intents.start({ packageHandle: selected.packageHandle, inputs: prepared, modelBindings }, separateExecution);
      setSeparateExecution(false); refreshRequests(); onStarted(await operation);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '실행 요청의 응답을 확인하지 못했습니다.'); }
    finally { actionInFlight.current = false; refreshRequests(); setBusy(false); }
  }
  /** A retry consumes the original memory-only snapshot; editing the visible form cannot silently change its inputs. */
  async function recoverRequest(requestId: string, retry: boolean) {
    if (busy || recovering || actionInFlight.current) return;
    actionInFlight.current = true; setBusy(true); setError('');
    try {
      const runId = retry ? await intents.retry(requestId) : await intents.lookup(requestId);
      if (runId) { invalidate(); setSeparateExecution(false); onStarted(runId); }
      else setError('현재 접수 기록을 찾지 못했습니다. 이전 요청이 처리 중일 수 있으므로 미실행으로 확정하지 않습니다. 잠시 후 다시 확인하세요.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '실행 요청을 확인하지 못했습니다.'); }
    finally { actionInFlight.current = false; refreshRequests(); setBusy(false); }
  }
  const properties = (selected?.inputs.properties ?? {}) as Record<string, { type?: string; title?: string; description?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>;
  const required = Array.isArray(selected?.inputs.required) ? selected.inputs.required as string[] : [];
  const connectionProblems = selected ? packageConnectionProblems(selected) : [];
  const requirements = selected?.modelRequirements ?? [];
  return <div className="page-stack">
    <div className="section-title"><span className="eyebrow">READY TO RUN</span><h1>설계한 작업을 실행하세요</h1><p>운영 ZIP을 가져오고, 입력과 AI 연결을 확인한 뒤 실행합니다.</p></div>
    <div className="steps"><span className="active">1 <b>패키지 가져오기</b></span><ArrowRight size={15} /><span className={selected ? 'active' : ''}>2 <b>입력·연결 확인</b></span><ArrowRight size={15} /><span>3 <b>실행·결과</b></span></div>
    {error && <p className="error" role="alert">{error}</p>}
    {recovering && <p role="status">이전 실행 요청의 접수 여부를 확인하고 있습니다.</p>}
    {recovered.length > 0 && <section className="panel"><h2>이전 실행을 찾았습니다</h2><p>새 실행을 만들지 않고 접수된 실행을 확인했습니다.</p>{recovered.map(item => <button type="button" className="secondary" key={item.requestId} onClick={() => onStarted(item.runId)}>이전 실행 열기 <small>{item.runId}</small></button>)}</section>}
    {pending.length > 0 && <section className="panel form-stack" aria-label="미확정 실행 요청"><h2>확인이 필요한 실행 요청</h2>
      <p>응답을 받지 못해도 작업은 시작되었을 수 있습니다. 같은 요청 재시도는 처음 보낸 입력과 연결을 그대로 사용하며, 아래에서 바꾼 입력을 사용하지 않습니다.</p>
      <ul>{pending.map(item => <li key={item.requestId}><p>요청 ID: <code>{item.requestId}</code></p><div className="actions"><button type="button" className="secondary" disabled={busy || recovering} onClick={() => void recoverRequest(item.requestId, false)}>접수 여부 확인</button>{item.retryAvailable ? <button type="button" className="secondary" disabled={busy || recovering} onClick={() => void recoverRequest(item.requestId, true)}>같은 요청으로 재시도</button> : <span>원래 입력은 저장하지 않았으므로 조회만 할 수 있습니다.</span>}</div></li>)}</ul>
      <label><input type="checkbox" checked={separateExecution} disabled={busy || recovering} onChange={event => setSeparateExecution(event.target.checked)} />이전 요청이 실행되었을 수 있음을 확인하고 별도 실행 준비</label>
      <p className="field-note">별도 실행은 새 요청 ID를 사용합니다. 이전 작업을 취소하지 않으며 같은 입력이면 작업이 중복될 수 있습니다. 미확정 요청 기록은 계속 보존합니다.</p>
    </section>}
    <div className="two-columns package-grid"><section className="panel"><div className="panel-heading"><PackageCheck size={20} /><h2>실행할 패키지</h2></div>
      <label className="upload-area"><UploadCloud size={34} /><strong>{busy ? '패키지 확인 중…' : '운영 ZIP 가져오기'}</strong><span>파일을 선택하세요 · ZIP, 최대 128 MiB</span><input type="file" accept=".zip,application/zip" onChange={(event) => void importFile(event)} disabled={busy} aria-label="운영 ZIP 파일 선택" /></label>
      <p className="field-note">가져오기는 파일과 요구 기능만 확인합니다. 모델이나 외부 작업은 실행하지 않습니다.</p>
      {packages.length > 0 && <div className="saved-packages"><h3>이 PC의 패키지</h3>{packages.map((item) => <button type="button" className={selected?.packageHandle === item.handle ? 'selected-package' : ''} key={item.handle} onClick={() => void load(item.handle)} disabled={busy}><PackageCheck size={17} /><span>{item.name}</span><ArrowRight size={15} /></button>)}</div>}
    </section><section className="panel">
      {selected ? <form className="form-stack" onSubmit={start}><div><span className="eyebrow">SELECTED WORKFLOW</span><h2>{selected.name}</h2><span className="tag">{selected.trust === 'verified' ? '배포 서명 확인됨' : '개인 미서명 패키지'}</span></div>
        {selected.warnings.length > 0 && <div className="notice compact"><span>{selected.warnings.join(' ')}</span></div>}
        {selected.materials?.length > 0 && <section className="form-stack"><h3>포함된 도구 및 자료</h3><p className="field-note">작업 지침은 명시적으로 첨부한 블록에만 적용합니다. 문서는 참고 데이터로 전달되며 실행 권한을 추가하지 않습니다.</p>{selected.materials.map((material) => <details key={material.alias}><summary>{material.name} · 버전 {material.revision}</summary><p>{material.kind === 'instruction' ? '작업 지침' : material.kind === 'document' ? '문서' : material.kind} · {material.entrypoint}</p><p>{material.uses.length ? material.uses.join(' / ') : '연결한 블록 없음'}</p><small>자료 식별값: {material.sha256}</small></details>)}</section>}
        {Object.entries(properties).map(([key, schema]) => <label key={key}>{schema.title ?? key}{required.includes(key) && <span className="required"> *</span>}
          {schema.type === 'boolean' ? <select value={values[key] === undefined ? '' : String(values[key])} required={required.includes(key)} onChange={(event) => setValues({ ...values, [key]: event.target.value === '' ? undefined : event.target.value === 'true' })}><option value="">선택하세요</option><option value="true">예</option><option value="false">아니요</option></select>
            : schema.type === 'number' || schema.type === 'integer' ? <input type="number" step={schema.type === 'integer' ? 1 : 'any'} min={schema.minimum} max={schema.maximum} required={required.includes(key)} value={values[key] === undefined ? '' : String(values[key])} onChange={(event) => setValues({ ...values, [key]: event.target.value === '' ? undefined : Number(event.target.value) })} />
              : <textarea rows={4} value={String(values[key] ?? '')} minLength={schema.minLength} maxLength={schema.maxLength} required={required.includes(key)} placeholder={schema.type === 'object' || schema.type === 'array' ? 'JSON 형식으로 입력하세요' : '처리할 내용을 입력하세요'} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />}
          {schema.description && <small>{schema.description}</small>}
        </label>)}
        {requirements.some(item => item.kind === 'embedding') && <div className="notice compact"><span>벡터·혼합 색인 생성 시 원문 조각, 검색 시 검색어가 OpenAI로 전송됩니다. text-embedding-3-small · 256차원 · 색인당 최대 128조각. 실행 시 사용 요금이 발생할 수 있습니다.</span></div>}
        {requirements.some(item => item.kind === 'reranker') && <div className="notice compact"><span>{RERANK_TRANSFER_NOTICE}</span></div>}
        {requirements.some(item => item.constraint?.contractId === 'openai-agentic-keyword-abstain-v1') && <div className="notice compact"><span>{AGENTIC_TRANSFER_NOTICE}</span></div>}
        {connectionProblems.length > 0 && <ul className="issue-list" role="alert">{connectionProblems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>}
        {requirements.filter(item => !requirementProblem(item)).map(requirement => { const matching = eligibleProfiles(requirement, profiles); const selectedId = modelBindings[requirement.alias] ?? ''; return <label key={requirement.alias}>{requirementLabel(requirement)} <small>{requirement.alias}</small><select aria-label={`${requirementLabel(requirement)} ${requirement.alias}`} value={selectedId} onChange={(event) => { invalidate(); setBindings({ ...modelBindings, [requirement.alias]: event.target.value }); }} required><option value="">연결을 선택하세요</option>{selectedId && !matching.some(profile => profile.id === selectedId) && <option value={selectedId}>선택한 연결을 사용할 수 없습니다</option>}{matching.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select>{!matching.length && <small>이 종류에 맞는 저장된 연결이 없습니다.</small>}</label>; })}
        {requirements.some(item => !requirementProblem(item)) && <button type="button" className="secondary" onClick={() => { invalidate(); onConnections(); }}>AI 연결 추가하기 <ArrowRight size={16} /></button>}
        {issues.length > 0 && <ul className="issue-list" role="status">{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
        {ready && <p className="success" role="status"><CheckCircle2 size={17} />연결과 실행 기능이 준비되었습니다. 실제 호출은 실행할 때 시작합니다.</p>}
        <div className="actions"><button type="button" className="secondary" onClick={() => void check()} disabled={busy || !!connectionProblems.length}>준비 상태 확인</button><button className="primary" disabled={busy || recovering || !storageReady || !ready || !!connectionProblems.length || pending.length > 0 && !separateExecution}><Play size={17} />{busy ? '처리 중…' : '워크플로 실행'}</button></div>
      </form> : <div className="empty large"><PackageCheck size={38} /><h3>패키지를 먼저 선택하세요</h3><p>필요한 입력과 모델 연결이 여기에 표시됩니다.</p></div>}
    </section></div>
  </div>;
}
