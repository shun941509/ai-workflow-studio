import { useState, type FormEvent } from 'react';
import { MessageSquare, Check, X } from 'lucide-react';
import { request } from '../api/client';
import type { Wait } from '../types';

type Field = { type?: string; title?: string; description?: string; enum?: unknown[] };

/** A response is sent only by an explicit form submission; reopening a page never supplies a default decision. */
export function WaitingCard({ wait }: { wait: Wait }) {
  const [values, setValues] = useState<Record<string, string>>({}); const [raw, setRaw] = useState('');
  const [requestId] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false); const [error, setError] = useState('');
  const schema = wait.responseSchema && typeof wait.responseSchema === 'object' ? wait.responseSchema as { type?: string; properties?: Record<string, Field>; required?: string[] } : {};
  const objectForm = schema.type === 'object' && schema.properties;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || submitted || wait.state !== 'pending') return;
    const choice = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = wait.kind === 'review' ? choice?.value : undefined;
    if (wait.kind === 'review' && decision !== 'accepted' && decision !== 'rejected') { setError('수락 또는 거절 버튼을 눌러 검토 결과를 제출하세요.'); return; }
    setBusy(true); setError('');
    try {
      let response: unknown;
      if (objectForm) {
        const result: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(schema.properties!)) {
          const value = values[key]; if (value === undefined || (value === '' && !schema.required?.includes(key))) continue;
          result[key] = field.type === 'number' || field.type === 'integer' ? Number(value) : field.type === 'boolean' ? value === 'true' : field.type === 'object' || field.type === 'array' || field.type === 'null' ? JSON.parse(value) : value;
        }
        response = result;
      } else response = schema.type === 'string' ? raw : JSON.parse(raw);
      const saved = await request<{ state: string }>(`/api/runs/${wait.runId}/waits/${wait.id}/responses`, { method: 'POST', body: { requestId, response, ...(decision ? { decision } : {}) } });
      if (!['responded', 'consumed'].includes(saved.state)) throw new Error('이 대기는 이미 종료되었습니다. 현재 실행 상태를 확인하세요.');
      setSubmitted(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '응답을 저장하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  const context = wait.context && typeof wait.context === 'object' ? wait.context as Record<string, unknown> : {};
  return <section className="panel"><div className="panel-heading"><MessageSquare size={20} /><h2>{wait.title || (wait.kind === 'review' ? '결과를 검토해 주세요' : '추가 입력이 필요합니다')}</h2></div>
    {wait.kind === 'review' && <p className="notice">수락·거절은 작업 내용에 대한 검토입니다. 파일 변경이나 외부 서비스 접근 권한을 승인하지 않습니다.</p>}
    <p className="field-note">응답 기한: {new Date(wait.expiresAt).toLocaleString('ko-KR')} · 기다리는 시간은 활성 실행 시간에 포함되지 않습니다.</p>
    {Object.keys(context).length > 0 && <details><summary>{wait.kind === 'review' ? '검토할 내용 보기' : '입력에 필요한 참고 내용'}</summary><pre className="result-content">{JSON.stringify(context, null, 2)}</pre></details>}
    {error && <p className="error" role="alert">{error}</p>}
    {submitted || wait.state === 'responded' ? <p className="success" role="status">응답을 저장했습니다. 후속 작업을 준비하고 있습니다.</p> : <form className="form-stack" onSubmit={(event) => void submit(event)}>
      {objectForm ? Object.entries(schema.properties!).map(([key, field]) => <label key={key}>{field.title ?? key}{schema.required?.includes(key) ? ' *' : ''}
        {field.type === 'boolean' ? <select value={values[key] ?? ''} required={schema.required?.includes(key)} onChange={(event) => setValues({ ...values, [key]: event.target.value })}><option value="">선택하세요</option><option value="true">예</option><option value="false">아니요</option></select>
          : <textarea value={values[key] ?? ''} required={schema.required?.includes(key)} rows={2} placeholder={['object', 'array', 'null'].includes(field.type ?? '') ? 'JSON으로 입력하세요' : undefined} onChange={(event) => setValues({ ...values, [key]: event.target.value })} />}{field.description && <small>{field.description}</small>}</label>)
        : <label>응답<textarea value={raw} onChange={(event) => setRaw(event.target.value)} required placeholder={schema.type === 'string' ? '응답을 입력하세요' : '요청한 형식의 JSON을 입력하세요'} /></label>}
      <div className="actions">{wait.kind === 'review' ? <><button className="secondary" type="submit" value="rejected" disabled={busy}><X size={16} />거절하고 진행</button><button className="primary" type="submit" value="accepted" disabled={busy}><Check size={16} />수락하고 진행</button></> : <button className="primary" type="submit" disabled={busy}>응답 제출</button>}</div>
    </form>}
  </section>;
}
