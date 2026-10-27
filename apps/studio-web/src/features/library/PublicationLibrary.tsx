'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight, Library, RefreshCw, Search, ShieldCheck } from 'lucide-react';
import { collectionPath, type Collection, type PublicationKind, type PublicationPage } from './types';
import styles from './library.module.css';

const titles = { official: { project: '예제 프로젝트', resource: '예제 자료 및 도구' }, community: { project: '프로젝트 둘러보기', resource: '도구 및 자료 둘러보기' } };

/** Every navigation, refresh and visible-page revisit loads current published metadata, clearing stale results on failure. */
export function PublicationLibrary({ kind, collection }: { kind: PublicationKind; collection: Collection }) {
  const [text, setText] = useState(''); const [filter, setFilter] = useState<{ query: string; cursor: string | null; previous: (string | null)[] }>({ query: '', cursor: null, previous: [] });
  const [page, setPage] = useState<PublicationPage>(); const [failure, setFailure] = useState<{ code: string; message: string }>(); const [refresh, setRefresh] = useState(0); const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setPage(undefined); setFailure(undefined);
    const params = new URLSearchParams({ kind, collection, q: filter.query }); if (filter.cursor) params.set('cursor', filter.cursor);
    void fetch(`/api/publications?${params}`, { cache: 'no-store', signal: controller.signal }).then(async (response) => {
      const body = await response.json(); if (controller.signal.aborted) return;
      if (!response.ok) setFailure(body.error ?? { code: 'PUBLICATIONS_UNAVAILABLE', message: '공개 자료실을 확인하지 못했습니다.' }); else setPage(body as PublicationPage);
    }).catch(() => { if (!controller.signal.aborted) setFailure({ code: 'PUBLICATIONS_UNAVAILABLE', message: '공개 자료실에 연결하지 못했습니다. 다시 확인해 주세요.' }); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, collection, filter, refresh]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible') setRefresh((value) => value + 1); };
    window.addEventListener('focus', recheck); window.addEventListener('pageshow', recheck); document.addEventListener('visibilitychange', recheck); const timer = window.setInterval(recheck, 60000);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', recheck); window.removeEventListener('pageshow', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, []);
  const title = titles[collection][kind]; const official = collection === 'official';
  return <><div className="page-eyebrow">{official ? 'OFFICIAL EXAMPLES' : 'COMMUNITY LIBRARY'}</div><div className="page-heading"><div><h1>{title}</h1><p>{official ? '관리자가 검수하고 공개한 예제를 찾아보세요.' : '다른 사용자가 공유하고 검수를 거친 작업을 찾아보세요.'}</p></div></div>
    <p className={styles.intro}><ShieldCheck size={18} aria-hidden="true"/>{official ? '공식 예제만 표시합니다.' : '커뮤니티가 공개한 항목만 표시합니다.'} 공개 중단된 항목은 다음 확인 시 목록에서 제외됩니다.</p>
    <form className={styles.toolbar} role="search" onSubmit={(event) => { event.preventDefault(); setFilter({ query: text.trim(), cursor: null, previous: [] }); }}><div className="search-field"><Search size={18} aria-hidden="true"/><input aria-label="공개 항목 제목 검색" placeholder="제목으로 검색" value={text} maxLength={100} onChange={(event) => setText(event.target.value)}/></div><button className="button button-primary" type="submit">검색</button><button className="button button-secondary" type="button" onClick={() => setRefresh((value) => value + 1)} aria-label="공개 목록 새로고침"><RefreshCw size={16}/></button></form>
    {loading ? <section className={styles.status} role="status"><Library size={30}/><h2>공개 목록을 확인하고 있습니다</h2><p>현재 게시 중인 항목을 불러옵니다.</p></section> : failure ? <section className={styles.status} role="alert"><Library size={30}/><h2>{failure.code === 'PUBLICATIONS_NOT_CONFIGURED' ? '공개 자료실 연결을 준비하고 있습니다' : '공개 목록을 확인하지 못했습니다'}</h2><p>{failure.message}</p><button className="button button-secondary" onClick={() => { setFilter({ query: text.trim(), cursor: null, previous: [] }); }}>다시 확인</button></section> : page?.items.length ? <><div className={styles.grid}>{page.items.map((item) => <Link prefetch={false} className={styles.card} key={item.id} href={`${collectionPath(kind, collection)}/${item.id}`}><span className={styles.badge}>{item.official ? '관리자 예제' : '커뮤니티 공유'} · {item.kind === 'project' ? '프로젝트' : '도구·자료'}</span><h2>{item.title}</h2><p>{item.description || '등록된 설명이 없습니다.'}</p><span className={styles.meta}><time dateTime={item.publishedAt}>{new Date(item.publishedAt).toLocaleDateString('ko-KR')} 공개</time><span>자세히 보기 <ArrowRight size={13}/></span></span></Link>)}</div></> : <section className={styles.status}><Library size={30}/><h2>{filter.query ? '검색 결과가 없습니다' : '아직 공개된 항목이 없습니다'}</h2><p>{filter.query ? '다른 제목으로 검색해 보세요.' : '실제 검증과 검수가 끝나 공개된 항목이 여기에 표시됩니다.'}</p><Link href="/projects/new" className="button button-secondary">내 워크플로 만들기<ArrowRight size={16}/></Link></section>}
    {!loading && !failure && (filter.previous.length > 0 || page?.nextCursor) && <nav className={styles.pagination} aria-label="공개 목록 페이지"><button className="button button-secondary" disabled={!filter.previous.length} onClick={() => setFilter({ ...filter, cursor: filter.previous.at(-1) ?? null, previous: filter.previous.slice(0, -1) })}><ChevronLeft size={15}/>이전</button><span>{filter.previous.length + 1} 페이지</span><button className="button button-secondary" disabled={!page?.nextCursor} onClick={() => page?.nextCursor && setFilter({ ...filter, cursor: page.nextCursor, previous: [...filter.previous, filter.cursor] })}>다음<ChevronRight size={15}/></button></nav>}
  </>;
}
