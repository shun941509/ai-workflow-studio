import { useState, type FormEvent, type ChangeEvent } from 'react';
import { UploadCloud, PackageCheck, Play, CheckCircle2, ArrowRight } from 'lucide-react';
import { request } from '../api/client';
import type { PackageDetail, Profile, PackageSummary } from '../types';

/** Runtime forms follow the package input schema; non-scalar values use an explicit JSON field. */
export function PackagePage({ profiles, packages, onImported, onStarted, onConnections }: { profiles: Profile[]; packages: PackageSummary[]; onImported: () => Promise<void>; onStarted: (id: string) => void; onConnections: () => void }) {
  const [selected, setSelected] = useState<PackageDetail>(); const [values, setValues] = useState<Record<string, unknown>>({});
  const [modelBindings, setBindings] = useState<Record<string, string>>({}); const [issues, setIssues] = useState<{ message: string }[]>([]);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  function choose(detail: PackageDetail) { setSelected(detail); setValues({}); setBindings({}); setReady(false); setIssues([]); setError(''); }
  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    setBusy(true); setError('');
    try { choose(await request<PackageDetail>('/api/packages/import', { method: 'POST', zip: await file.arrayBuffer() })); await onImported(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '패키지를 가져오지 못했습니다.'); }
    finally { setBusy(false); event.target.value = ''; }
  }
  async function load(handle: string) { setBusy(true); try { choose(await request<PackageDetail>(`/api/packages/${handle}`)); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } }
  async function check() {
    if (!selected) return; setBusy(true); setError('');
    try { const result = await request<{ ready: boolean; issues: { message: string }[] }>(`/api/packages/${selected.packageHandle}/validate`, { method: 'POST', body: { modelBindings } }); setReady(result.ready); setIssues(result.issues); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '준비 상태를 확인하지 못했습니다.'); } finally { setBusy(false); }
  }
  async function start(event: FormEvent) {
    event.preventDefault(); if (!selected) return; setBusy(true); setError('');
    try {
      const prepared = { ...values }; const properties = (selected.inputs.properties ?? {}) as Record<string, { type?: string }>;
      for (const [key, schema] of Object.entries(properties)) if (schema.type === 'object' || schema.type === 'array') {
        if (typeof prepared[key] === 'string') prepared[key] = JSON.parse(prepared[key] as string);
      }
      const result = await request<{ runId: string }>('/api/runs', { method: 'POST', body: { packageHandle: selected.packageHandle, requestId: crypto.randomUUID(), inputs: prepared, modelBindings } });
      onStarted(result.runId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '실행을 시작하지 못했습니다.'); } finally { setBusy(false); }
  }
  const properties = (selected?.inputs.properties ?? {}) as Record<string, { type?: string; title?: string; description?: string; minLength?: number; maxLength?: number; minimum?: number; maximum?: number }>;
  const required = Array.isArray(selected?.inputs.required) ? selected.inputs.required as string[] : [];
  return <div className="page-stack">
    <div className="section-title"><span className="eyebrow">READY TO RUN</span><h1>설계한 작업을 실행하세요</h1><p>운영 ZIP을 가져오고, 입력과 AI 연결을 확인한 뒤 실행합니다.</p></div>
    <div className="steps"><span className="active">1 <b>패키지 가져오기</b></span><ArrowRight size={15} /><span className={selected ? 'active' : ''}>2 <b>입력·연결 확인</b></span><ArrowRight size={15} /><span>3 <b>실행·결과</b></span></div>
    {error && <p className="error" role="alert">{error}</p>}
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
        {selected.modelProfiles.map((alias) => <label key={alias}>AI 연결 <small>{alias}</small><select value={modelBindings[alias] ?? ''} onChange={(event) => { setBindings({ ...modelBindings, [alias]: event.target.value }); setReady(false); }} required><option value="">연결을 선택하세요</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.model}</option>)}</select></label>)}
        {!!selected.modelProfiles.length && !profiles.length && <button type="button" className="secondary" onClick={onConnections}>AI 연결 추가하기 <ArrowRight size={16} /></button>}
        {issues.length > 0 && <ul className="issue-list" role="status">{issues.map((issue, index) => <li key={index}>{issue.message}</li>)}</ul>}
        {ready && <p className="success" role="status"><CheckCircle2 size={17} />연결과 실행 기능이 준비되었습니다. 실제 호출은 실행할 때 시작합니다.</p>}
        <div className="actions"><button type="button" className="secondary" onClick={() => void check()} disabled={busy}>준비 상태 확인</button><button className="primary" disabled={busy || !ready}><Play size={17} />{busy ? '처리 중…' : '워크플로 실행'}</button></div>
      </form> : <div className="empty large"><PackageCheck size={38} /><h3>패키지를 먼저 선택하세요</h3><p>필요한 입력과 모델 연결이 여기에 표시됩니다.</p></div>}
    </section></div>
  </div>;
}
