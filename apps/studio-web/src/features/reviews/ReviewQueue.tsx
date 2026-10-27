'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, ClipboardCheck, RefreshCw } from 'lucide-react';
import { asFailure, reviewRequest, statusLabels, type QueuePage, type ReviewFailure } from './types';
import { ReviewAccessState } from './ReviewAccessState';
import styles from './reviews.module.css';

/** The queue contains only server-authorized submissions; client filters never add review authority. */
export function ReviewQueue() {
  const [status, setStatus] = useState('scanned'); const [cursor, setCursor] = useState<QueuePage['next']>(null); const [history, setHistory] = useState<QueuePage['next'][]>([]);
  const [result, setResult] = useState<QueuePage>(); const [failure, setFailure] = useState<ReviewFailure>(); const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setResult(undefined); setFailure(undefined); const params = new URLSearchParams({ status }); if (cursor) { params.set('before', cursor.before); params.set('id', cursor.id); }
    void reviewRequest<QueuePage>(`/api/admin/reviews?${params}`, { signal: abort.signal }).then((value) => { if (!abort.signal.aborted) setResult(value); }).catch((error) => { if (!abort.signal.aborted) setFailure(asFailure(error)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); return () => abort.abort();
  }, [status, cursor, refresh]);
  return <><div className="page-eyebrow">ADMINISTRATOR REVIEW</div><div className="page-heading"><div><h1>관리자 검수</h1><p>고정된 게시 후보와 검사 보고서를 확인하고 검수 결정을 기록합니다.</p></div></div><p className={styles.intro}>검수 승인은 게시 준비 과정의 기록입니다. 이 화면에서 서명하거나 외부에 게시하지 않습니다. 권한은 요청할 때마다 서버에서 확인합니다.</p>
    <div className={styles.toolbar}><label>검수 상태<select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(null); setHistory([]); }}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button button-secondary" onClick={() => setRefresh((value) => value + 1)} aria-label="검수 목록 새로고침"><RefreshCw size={16}/></button></div>
    {loading ? <section className={styles.statusCard} role="status"><ClipboardCheck size={30}/><h2>검수 목록을 확인하고 있습니다</h2></section> : failure ? <ReviewAccessState failure={failure} retry={() => setRefresh((value) => value + 1)}/> : result?.items.length ? <div className={styles.list}>{result.items.map((item) => <Link prefetch={false} key={item.id} href={`/admin/reviews/${item.id}`} className={styles.row}><div><h2>{item.kind === 'project' ? '프로젝트' : '도구 및 자료'} 검수</h2><code>{item.id}</code><small>{new Date(item.created_at).toLocaleString('ko-KR')} 제출</small></div><span className={styles.badge}>{statusLabels[item.status] ?? item.status}<ArrowRight size={14}/></span></Link>)}</div> : <section className={styles.statusCard}><ClipboardCheck size={30}/><h2>현재 상태의 제출 항목이 없습니다</h2><p>다른 검수 상태를 선택하거나 새로고침해 주세요.</p></section>}
    {!loading && !failure && (history.length > 0 || result?.next) && <nav className={styles.pagination} aria-label="검수 목록 페이지"><button className="button button-secondary" disabled={!history.length} onClick={() => { setCursor(history.at(-1) ?? null); setHistory(history.slice(0, -1)); }}><ChevronLeft size={14}/>이전</button><span>{history.length + 1} 페이지</span><button className="button button-secondary" disabled={!result?.next} onClick={() => { if (result?.next) { setHistory([...history, cursor]); setCursor(result.next); } }}>다음<ChevronRight size={14}/></button></nav>}
  </>;
}
