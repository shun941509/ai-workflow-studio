'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Download, Library, ShieldCheck } from 'lucide-react';
import { collectionPath, type Collection, type Publication, type PublicationKind } from './types';
import styles from './library.module.css';
import { receivePublicationArchive } from './download-publication';
import { CopyPublication } from './CopyPublication';

/** Detail rechecks visibility independently of the gallery; only verified metadata is rendered as plain text. */
export function PublicationDetail({ id, kind, collection }: { id: string; kind: PublicationKind; collection: Collection }) {
  const [item, setItem] = useState<Publication>(); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState(''); const [report, setReport] = useState(''); const [reportError, setReportError] = useState(''); const [needsLogin, setNeedsLogin] = useState(false); const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false); const [downloadError, setDownloadError] = useState(''); const [downloadNotice, setDownloadNotice] = useState(''); const [downloadLogin, setDownloadLogin] = useState(false);
  const downloadController = useRef<AbortController | null>(null);
  useEffect(() => { setDownloading(false); setDownloadError(''); setDownloadNotice(''); setDownloadLogin(false); return () => { downloadController.current?.abort(); downloadController.current = null; }; }, [id]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setItem(undefined); setError('');
    void fetch(`/api/publications/${encodeURIComponent(id)}?${new URLSearchParams({ kind, collection })}`, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      const value = await response.json(); if (controller.signal.aborted) return; if (!response.ok) setError(value.error?.message ?? '공개 항목을 확인하지 못했습니다.'); else setItem(value.item as Publication);
    }).catch(() => { if (!controller.signal.aborted) setError('공개 항목을 확인하지 못했습니다. 연결 상태를 확인해 주세요.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [id, kind, collection, refresh]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    window.addEventListener('focus', recheck); window.addEventListener('pageshow', recheck); document.addEventListener('visibilitychange', recheck); const timer = window.setInterval(recheck, 60000);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', recheck); window.removeEventListener('pageshow', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, []);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || report || !item) return; setBusy(true); setReportError(''); setNeedsLogin(false);
    try {
      const response = await fetch(`/api/publications/${encodeURIComponent(id)}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); const body = await response.json();
      if (!response.ok) { setNeedsLogin(response.status === 401); throw new Error(body.error?.message ?? '신고를 접수하지 못했습니다.'); }
      setReport('신고를 접수했습니다. 운영자가 내용을 확인합니다. 신고 접수만으로 공개가 자동 중단되지는 않습니다.'); setReason('');
    } catch (failure) { setReportError(failure instanceof Error ? failure.message : '신고 접수 결과를 확인하지 못했습니다.'); } finally { setBusy(false); }
  };
  const download = async () => {
    if (!item || downloadController.current) return;
    const controller = new AbortController(); downloadController.current = controller; setDownloading(true); setDownloadError(''); setDownloadNotice(''); setDownloadLogin(false);
    try {
      const response = await fetch(`/api/publications/${encodeURIComponent(item.id)}/download`, { cache: 'no-store', signal: controller.signal });
      if (!response.ok) { const body = await response.json(); setDownloadLogin(response.status === 401); throw new Error(typeof body.error?.message === 'string' ? body.error.message : '공개 ZIP을 내려받지 못했습니다.'); }
      const archive = await receivePublicationArchive(response, item.id, item.artifactSha256, controller.signal);
      // Only a completed, hash-matched response becomes a browser download; no page HTML or private URL is opened.
      const url = URL.createObjectURL(archive.blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = archive.filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDownloadNotice('원본 ZIP을 브라우저 다운로드로 전달했습니다. 압축을 푼 뒤 포함된 안내를 확인하세요.');
    } catch (failure) { if (!controller.signal.aborted) setDownloadError(failure instanceof Error ? failure.message : '공개 ZIP을 내려받지 못했습니다.'); }
    finally { if (downloadController.current === controller) { downloadController.current = null; setDownloading(false); } }
  };
  return <div className={styles.detail}><Link href={collectionPath(kind, collection)} className={styles.back}><ArrowLeft size={16}/>목록으로 돌아가기</Link>
    {loading ? <section className={styles.status} role="status"><Library size={30}/><h1>공개 항목을 확인하고 있습니다</h1></section> : error ? <section className={styles.status} role="alert"><Library size={30}/><h1>항목을 확인할 수 없습니다</h1><p>{error}</p><button className="button button-secondary" onClick={() => setRefresh((value) => value + 1)}>다시 확인</button></section> : item ? <>
      <span className={styles.badge}><ShieldCheck size={14}/>{item.official ? '관리자 예제' : '커뮤니티 공유'} · {item.kind === 'project' ? '프로젝트' : '도구·자료'}</span><div className="page-heading"><div><h1>{item.title}</h1><p><time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString('ko-KR')} 공개</time></p></div></div><p className={styles.description}>{item.description || '등록된 설명이 없습니다.'}</p>
      <section className={styles.notice} aria-label="공개 ZIP 다운로드"><p>로그인한 뒤 게시된 원본 ZIP을 내려받을 수 있습니다. 파일의 권리와 서명을 현재 상태로 확인합니다. ZIP은 게시자가 선택한 AI 도구용이며, 실행에 필요한 연결은 포함된 안내에 따라 준비하세요.</p><button className="button button-primary" onClick={() => void download()} disabled={downloading}><Download size={16}/>{downloading ? '공개 파일 확인 중…' : '운영 ZIP 다운로드'}</button>{downloadNotice && <p role="status">{downloadNotice}</p>}{downloadError && <p role="alert" className={styles.downloadError}>{downloadError} {downloadLogin && <Link href="/account">프로필·설정에서 로그인</Link>}</p>}</section>
      <CopyPublication id={item.id} kind={item.kind}/>
      <details className={styles.hashes}><summary>공개 버전 검증 정보</summary><dl><dt>게시 ID</dt><dd>{item.id}</dd><dt>공개 파일 SHA-256</dt><dd>{item.artifactSha256}</dd><dt>Manifest SHA-256</dt><dd>{item.manifestSha256}</dd></dl></details>
      <section className={styles.report}><h2>문제가 있는 항목 신고</h2><p>개인정보 노출, 이용 권한 문제 또는 잘못된 내용을 발견했다면 알려 주세요. 로그인한 계정으로 신고합니다.</p>{report ? <p role="status">{report}</p> : <form onSubmit={(event) => void submit(event)}><label htmlFor="publication-report-reason">신고 사유</label><textarea id="publication-report-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={4000} required disabled={busy}/><small>문제가 있는 부분을 10자 이상 구체적으로 설명해 주세요. 비밀번호나 API 키는 적지 마세요.</small>{reportError && <p role="alert">{reportError} {needsLogin && <Link href="/account">프로필·설정에서 로그인</Link>}</p>}<button className="button button-secondary" type="submit" disabled={busy || reason.trim().length < 10}>{busy ? '접수 중…' : '신고 접수'}</button></form>}</section>
    </> : null}
  </div>;
}
