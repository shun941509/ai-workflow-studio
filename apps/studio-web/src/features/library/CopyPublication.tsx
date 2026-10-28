'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Copy } from 'lucide-react';
import styles from './library.module.css';

type Receipt = { importId: string; projectId: string | null; resources: { alias: string; resourceId: string; versionId: string; revision: 1 }[] };
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

/** A receipt is shown only for a confirmed atomic commit. The same request ID survives interrupted browser responses. */
export function CopyPublication({ id, kind }: { id: string; kind: 'project' | 'resource' }) {
  const [busy, setBusy] = useState(false), [attempted, setAttempted] = useState(false), [error, setError] = useState(''), [needsLogin, setNeedsLogin] = useState(false), [receipt, setReceipt] = useState<Receipt>();
  const controller = useRef<AbortController | null>(null), retryId = useRef<string | null>(null);
  const storageKey = `studio.publication-copy.v1:${id}`;
  useEffect(() => {
    setBusy(false); setAttempted(false); setError(''); setReceipt(undefined); retryId.current = null;
    try { const stored = sessionStorage.getItem(storageKey); if (uuid(stored)) { retryId.current = stored; setAttempted(true); } } catch { /* The current tab still retains its retry ID when browser storage is unavailable. */ }
    return () => { controller.current?.abort(); controller.current = null; };
  }, [storageKey]);
  const copy = async () => {
    if (controller.current || receipt) return;
    const own = new AbortController(); controller.current = own; setBusy(true); setError(''); setNeedsLogin(false);
    retryId.current ??= crypto.randomUUID();
    try { sessionStorage.setItem(storageKey, retryId.current); } catch { /* Retry in this tab uses the owned ref; no second request ID is generated. */ }
    setAttempted(true);
    try {
      const response = await fetch(`/api/publications/${encodeURIComponent(id)}/copy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: retryId.current }), signal: AbortSignal.any([own.signal, AbortSignal.timeout(100000)]) });
      const body = await response.json(); if (own.signal.aborted) return;
      if (!response.ok) {
        setNeedsLogin(response.status === 401);
        // A new ID is allowed only after the server confirmed a terminal failure; unknown outcomes retain the old ID.
        if (body.error?.code === 'COPY_PREVIOUSLY_FAILED' || body.error?.issues?.requestEnded === true) { retryId.current = null; setAttempted(false); try { sessionStorage.removeItem(storageKey); } catch { /* Current state remains authoritative in this tab. */ } }
        throw new Error(typeof body.error?.message === 'string' ? body.error.message : '복사 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
      }
      const value = body.receipt;
      if (!value || !uuid(value.importId) || !Array.isArray(value.resources) || value.resources.length > 1000 || value.resources.some((item: Receipt['resources'][number]) => !item || !uuid(item.resourceId) || !uuid(item.versionId) || item.revision !== 1) || (kind === 'project' ? !uuid(value.projectId) : value.projectId !== null)) throw new Error('저장 완료 정보를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
      setReceipt(value);
    } catch (failure) { if (!own.signal.aborted) setError(failure instanceof Error ? failure.message : '복사 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.'); }
    finally { if (controller.current === own) { controller.current = null; setBusy(false); } }
  };
  return <section className={styles.notice} aria-label="내 계정으로 복사">
    <h2>{kind === 'project' ? '내 프로젝트로 가져오기' : '내 도구 및 자료에 추가'}</h2>
    <p>원본의 이용 조건과 고정된 자료를 함께 보관합니다. 복사·수정이 허용된 공개 항목을 로그인한 계정에 추가할 수 있습니다.</p>
    {receipt ? <div role="status"><p>{receipt.projectId ? '프로젝트와 연결된 자료를 내 계정에 복사했습니다.' : `도구 및 자료 ${receipt.resources.length}개를 내 계정에 추가했습니다.`}</p><Link className="button button-primary" href={receipt.projectId ? `/projects/${receipt.projectId}/edit` : '/resources'}>{receipt.projectId ? '복사한 프로젝트 열기' : '내 도구 및 자료 열기'}</Link></div> : <button className="button button-secondary" disabled={busy} onClick={() => void copy()}><Copy size={16}/>{busy ? '원본 확인·복사 중…' : attempted ? '같은 복사 요청 다시 확인' : kind === 'project' ? '내 프로젝트로 복사' : '내 도구 및 자료에 추가'}</button>}
    {error && <p role="alert" className={styles.downloadError}>{error} {needsLogin && <Link href="/account">프로필·설정에서 로그인</Link>}</p>}
  </section>;
}
