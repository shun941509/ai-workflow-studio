import { useEffect, useState } from 'react';
import { Workflow, PackageOpen, KeyRound, History, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { connect, request } from './api/client';
import { PackagePage } from './pages/PackagePage';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { RunPage } from './pages/RunPage';
import { statusNames, type Profile, type PackageSummary, type Run } from './types';
import { withoutRunContent } from './run-disclosure';

/** The operational shell displays only real local packages, profiles, and durable run records. */
export function App() {
  const [page, setPage] = useState<'prepare' | 'connections' | 'history' | 'run'>('prepare');
  const [profiles, setProfiles] = useState<Profile[]>([]); const [packages, setPackages] = useState<PackageSummary[]>([]); const [runs, setRuns] = useState<Run[]>([]);
  const [secure, setSecure] = useState(false); const [connected, setConnected] = useState(false); const [error, setError] = useState(''); const [runId, setRunId] = useState('');
  async function refresh() { const [nextProfiles, nextPackages, nextRuns] = await Promise.all([request<Profile[]>('/api/profiles'), request<PackageSummary[]>('/api/packages'), request<Run[]>('/api/runs')]); setProfiles(nextProfiles); setPackages(nextPackages); setRuns(nextRuns.map(withoutRunContent)); }
  useEffect(() => { let alive = true; void (async () => { try { await connect(); const info = await request<{ secureStoreAvailable: boolean }>('/api/info'); if (!alive) return; setSecure(info.secureStoreAvailable); await refresh(); if (alive) setConnected(true); } catch (failure) { if (alive) setError(failure instanceof Error ? failure.message : 'Runner 연결을 확인하세요.'); } })(); return () => { alive = false; }; }, []);
  function showRun(id: string) { setRunId(id); setPage('run'); }
  return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/" aria-label="Studio Runner 홈"><span><Workflow size={25} /></span><div>Workflow Studio<small>RUNNER</small></div></a><div className="sidebar-label">내 PC에서 실행</div><nav aria-label="Runner 메뉴">
    <button className={page === 'prepare' ? 'active' : ''} onClick={() => setPage('prepare')}><PackageOpen size={19} />실행 준비</button>
    <button className={page === 'connections' ? 'active' : ''} onClick={() => setPage('connections')}><KeyRound size={19} />AI 연결</button>
    <button className={page === 'history' || page === 'run' ? 'active' : ''} onClick={() => { setPage('history'); void refresh().catch((failure) => setError(String(failure))); }}><History size={19} />실행 기록</button>
  </nav><div className="sidebar-note"><ShieldCheck size={22} /><strong>내 PC의 실행 공간</strong><p>연결 정보와 실행 기록은 이 PC에 보관합니다.</p></div><div className="sidebar-bottom"><span className={connected ? 'connection-dot online' : 'connection-dot'} />{connected ? 'Runner 연결됨' : '연결 확인 중'}</div></aside>
    <div className="workspace"><header className="topbar"><span>Studio Runner</span><span className="local-badge"><ShieldCheck size={14} />로컬 실행</span></header><main>
      {error && <p className="error" role="alert">{error}</p>}
      {!connected ? <section className="panel empty"><Workflow size={36} /><h1>Runner에 연결하고 있습니다</h1><p>설치된 Runner가 제공하는 주소에서 이 화면을 열어 주세요.</p></section>
        : <>{/* Preserve the package and typed input while visiting connections; no draft or ZIP enters browser storage. */}
          <div hidden={page !== 'prepare'}><PackagePage active={page === 'prepare'} profiles={profiles} packages={packages} onImported={refresh} onStarted={showRun} onConnections={() => setPage('connections')} /></div>
          {page === 'prepare' ? null : page === 'connections' ? <ConnectionsPage profiles={profiles} available={secure} onSaved={refresh} />
            : page === 'run' ? <RunPage runId={runId} />
              : <div className="page-stack"><div className="section-title"><span className="eyebrow">RUN HISTORY</span><h1>실행 기록</h1><p>실행 상태와 결과를 다시 살펴보세요. 업무 완료 기준의 충족 여부는 각 실행 상세에서 확인할 수 있습니다.</p></div><section className="panel">{runs.length ? <div className="run-list">{runs.map((run) => <button key={run.id} onClick={() => showRun(run.id)}><div><strong>{packages.find((item) => item.handle === run.packageHandle)?.name ?? '워크플로'}</strong><small>{new Date(run.createdAt).toLocaleString('ko-KR')}</small></div><span className={`status status-${run.status}`}>{statusNames[run.status] ?? run.status}</span><ArrowUpRight size={18} /></button>)}</div> : <div className="empty large"><History size={36} /><h3>아직 실행 기록이 없습니다</h3><p>패키지를 실행하면 진행 상태와 결과가 여기에 보관됩니다.</p><button className="primary" onClick={() => setPage('prepare')}>패키지 가져오기</button></div>}</section></div>}</>}
    </main><footer>프로젝트에 필요한 기능과 연결은 실행 전 준비 검사에서 확인하세요.</footer></div>
  </div>;
}
