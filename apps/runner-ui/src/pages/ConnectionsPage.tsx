import { useState, type FormEvent } from 'react';
import { KeyRound, ShieldCheck, Plus } from 'lucide-react';
import { request } from '../api/client';
import type { Profile } from '../types';

/** Keys go directly to the local secure-store endpoint and are cleared after successful storage. */
export function ConnectionsPage({ profiles, available, onSaved }: { profiles: Profile[]; available: boolean; onSaved: () => Promise<void> }) {
  const [name, setName] = useState('내 AI 연결'); const [model, setModel] = useState(''); const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false);
    try { await request('/api/profiles', { method: 'POST', body: { name, model, apiKey: key } }); setKey(''); await onSaved(); setSaved(true); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '연결을 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  return <div className="page-stack">
    <div className="section-title"><span className="eyebrow">CONNECTIONS</span><h1>AI 연결</h1><p>워크플로가 사용할 모델을 연결하세요. 인증정보는 이 PC의 보안 저장소에 보관합니다.</p></div>
    <div className="notice"><ShieldCheck size={20} /><span>Codex·Claude Code·OpenCode의 구독과 Runner 모델 사용 요금은 별개입니다.</span></div>
    <div className="two-columns"><section className="panel"><div className="panel-heading"><KeyRound size={20} /><h2>연결 추가</h2></div>
      {!available && <p className="error" role="alert">Windows 보안 저장소를 사용할 수 없어 인증정보를 저장할 수 없습니다.</p>}
      <form onSubmit={save} className="form-stack">
        <label>연결 이름<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
        <label>OpenAI 모델 ID<input value={model} onChange={(event) => setModel(event.target.value)} required maxLength={120} placeholder="사용할 모델의 정확한 ID" autoComplete="off" /></label>
        <label>API 키<input type="password" value={key} onChange={(event) => setKey(event.target.value)} required autoComplete="off" spellCheck={false} /></label>
        <p className="field-note">키는 프로젝트·ZIP·실행 로그에 포함하지 않습니다. 저장 시 모델을 호출하지 않습니다.</p>
        <p className="field-note">실행하면 입력 토큰 계산과 응답 생성에 필요한 작업 내용·지침·선택한 자료가 OpenAI로 전송됩니다. 로컬 문서 검색만 하는 작업에는 모델 호출이 필요하지 않습니다.</p>
        {error && <p className="error" role="alert">{error}</p>}{saved && <p className="success" role="status">이 PC에 연결을 저장했습니다.</p>}
        <button className="primary" disabled={busy || !available}><Plus size={17} />{busy ? '보안 저장 중…' : '연결 저장'}</button>
      </form>
    </section><section className="panel"><h2>저장된 연결 <span className="count">{profiles.length}</span></h2>
      {profiles.length ? <div className="connection-list">{profiles.map((profile) => <article key={profile.id}><div className="icon-tile"><KeyRound size={19} /></div><div><strong>{profile.name}</strong><p>{profile.model}</p><small>OpenAI · 이 PC에 저장됨</small></div></article>)}</div> : <div className="empty"><KeyRound size={30} /><h3>아직 연결이 없습니다</h3><p>모델 연결을 추가하면 실행 준비 화면에서 선택할 수 있습니다.</p></div>}
    </section></div>
  </div>;
}
