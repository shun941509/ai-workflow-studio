import { useRef, useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { request, uploadFile } from '../api/client';
import type { FileReference, ManagedFile, Wait } from '../types';

/** Selecting files never uploads them automatically; one explicit submission uploads and confirms the selection. */
export function FileSelectionCard({ wait, uploaded }: { wait: Wait; uploaded: ManagedFile[] }) {
  const config = wait.context as { mimeTypes: string[]; maxFiles: number; maxBytesPerFile: number };
  const [selected, setSelected] = useState<{ file: File; id: string }[]>([]); const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [requestId] = useState(() => crypto.randomUUID()); const [busy, setBusy] = useState(false); const [submitted, setSubmitted] = useState(false); const [error, setError] = useState('');
  const completed = useRef(new Map<string, FileReference>());
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy || submitted || wait.state !== 'pending') return; setBusy(true); setError('');
    try {
      const references = new Map(uploaded.filter((record) => !excluded.has(record.reference.id)).map((record) => [record.reference.id, record.reference]));
      const newCount = selected.filter((selection) => !completed.current.has(selection.id)).length;
      if (!references.size && !selected.length || references.size + newCount > config.maxFiles) throw new Error(`파일을 1개 이상 ${config.maxFiles}개 이하로 선택하세요.`);
      for (const selection of selected) { if (selection.file.size > config.maxBytesPerFile) throw new Error('선택한 파일이 크기 한도를 초과합니다.'); const reference = completed.current.get(selection.id) ?? await uploadFile<FileReference>(`/api/runs/${wait.runId}/waits/${wait.id}/files`, selection.file, selection.id); completed.current.set(selection.id, reference); if (!excluded.has(reference.id)) references.set(reference.id, reference); }
      const response = await request<{ state: string }>(`/api/runs/${wait.runId}/waits/${wait.id}/responses`, { method: 'POST', body: { requestId, response: [...references.values()] } });
      if (!['responded', 'consumed'].includes(response.state)) throw new Error('파일 선택 대기가 종료되었습니다.'); setSubmitted(true);
    } catch (failure) { setError(failure instanceof Error ? failure.message : '파일 선택을 저장하지 못했습니다.'); } finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><Upload size={20} /><h2>{wait.title || '작업에 사용할 파일을 선택하세요'}</h2></div><p className="field-note">최대 {config.maxFiles}개 · 파일당 {(config.maxBytesPerFile / 1024 / 1024).toFixed(1)} MiB · {config.mimeTypes.join(', ')}<br />응답 기한: {new Date(wait.expiresAt).toLocaleString('ko-KR')}. 선택한 파일은 이 실행에서만 사용할 수 있습니다.</p>
    {error && <p className="error" role="alert">{error}</p>}{submitted || wait.state === 'responded' ? <p className="success" role="status">파일 선택을 저장했습니다. 후속 작업을 준비하고 있습니다.</p> : <form className="form-stack" onSubmit={(event) => void submit(event)}>
      {uploaded.map((record) => <label className="file-choice" key={record.reference.id}><input type="checkbox" checked={!excluded.has(record.reference.id)} disabled={busy} onChange={(event) => setExcluded((previous) => { const next = new Set(previous); if (event.target.checked) next.delete(record.reference.id); else next.add(record.reference.id); return next; })} />{record.reference.filename} · {record.reference.bytes.toLocaleString()} bytes</label>)}
      <label>파일 선택<input type="file" multiple={config.maxFiles > 1} accept={config.mimeTypes.join(',')} disabled={busy} onChange={(event) => setSelected(Array.from(event.target.files ?? []).map((file) => ({ file, id: crypto.randomUUID() })))} /></label><div className="actions"><button className="primary" disabled={busy} type="submit">{busy ? '파일을 전달하고 있습니다' : '선택한 파일로 진행'}</button></div>
    </form>}
  </section>;
}
