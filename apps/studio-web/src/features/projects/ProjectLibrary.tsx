"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Clock3, FolderOpen, Plus, Search, Trash2, Workflow } from "lucide-react";
import { Badge, Button, EmptyState } from "@studio/ui";
import { listLocalDrafts, removeLocalDraft, type LocalDraft } from "../editor/local-drafts";

type CloudProject = { id: string; name: string; updated_at: string };

/** The library clearly separates browser recovery drafts from server-confirmed account projects. */
export function ProjectLibrary({ compact = false }: { compact?: boolean }) {
  const [drafts, setDrafts] = useState<LocalDraft[]>([]); const [cloud, setCloud] = useState<CloudProject[]>([]);
  const [cloudMessage, setCloudMessage] = useState(""); const [query, setQuery] = useState(""); const [ready, setReady] = useState(false);
  useEffect(() => { try { setDrafts(listLocalDrafts()); } finally { setReady(true); } if (compact) return; const controller = new AbortController(); void fetch("/api/projects", { signal: controller.signal, cache: "no-store" }).then(async (response) => { const body = await response.json(); if (response.ok) setCloud(body.projects ?? []); else setCloudMessage(body.error?.message ?? "계정 프로젝트를 불러오지 못했습니다."); }).catch((error: unknown) => { if (!(error instanceof DOMException && error.name === "AbortError")) setCloudMessage("계정 프로젝트에 연결하지 못했습니다."); }); return () => controller.abort(); }, [compact]);
  const filtered = drafts.filter((draft) => draft.workflow.name.toLowerCase().includes(query.toLowerCase())).slice(0, compact ? 3 : 100);
  const deleteLocal = (draft: LocalDraft) => { if (!window.confirm(`“${draft.workflow.name}”의 이 브라우저 초안을 삭제할까요? 계정 저장본에는 영향을 주지 않습니다.`)) return; try { removeLocalDraft(draft.workflow.id); setDrafts(listLocalDrafts()); } catch { setCloudMessage("브라우저 초안을 삭제하지 못했습니다."); } };
  return <div className="project-library">
    {!compact ? <div className="library-toolbar"><div className="search-field"><Search size={17}/><input aria-label="프로젝트 검색" placeholder="프로젝트 이름 검색" value={query} onChange={(event) => setQuery(event.target.value)}/></div><Badge>브라우저 초안 {drafts.length}개</Badge></div> : null}
    {!ready ? <p className="muted">저장한 초안을 확인하고 있습니다…</p> : filtered.length ? <div className="project-grid">{filtered.map((draft) => <article className="project-card" key={draft.workflow.id}><Link className="project-card-body" href={`/projects/new?draft=${encodeURIComponent(draft.workflow.id)}`}><div className="project-card-top"><span className="project-mark"><Workflow size={21}/></span><Badge>브라우저 초안</Badge></div><h3>{draft.workflow.name}</h3><p>{draft.workflow.nodes.length}개 블록으로 구성한 워크플로</p><div className="project-mini-flow" aria-hidden="true"><span/><i/><span/><i/><span/></div><div className="project-card-bottom"><span><Clock3 size={13}/>{formatDate(draft.updatedAt)}</span><ArrowUpRight size={17}/></div></Link>{!compact ? <button className="project-delete" aria-label={`${draft.workflow.name} 브라우저 초안 삭제`} onClick={() => deleteLocal(draft)}><Trash2 size={14}/></button> : null}</article>)}</div> : <EmptyState title={query ? "일치하는 프로젝트가 없습니다" : "첫 번째 워크플로를 만들어 보세요"} description={query ? "다른 이름으로 검색해 주세요." : "입력, AI 작업, 결과 블록으로 시작합니다. 작업 내용은 이 브라우저에 자동 저장됩니다."}>{!query ? <Link className="button button-primary" href="/projects/new"><Plus size={16}/>워크플로 만들기</Link> : null}</EmptyState>}
    {!compact ? <section className="account-projects"><div className="section-heading"><h2><FolderOpen size={19}/>계정에 저장한 프로젝트</h2></div>{cloudMessage ? <div className="inline-notice"><p>{cloudMessage}</p><Link href="/account">프로필·설정에서 확인 →</Link></div> : cloud.length ? <div className="cloud-project-list">{cloud.filter((project) => project.name.toLowerCase().includes(query.toLowerCase())).map((project) => <Link href={`/projects/${project.id}/edit`} key={project.id}><span className="project-mark"><FolderOpen size={18}/></span><div><strong>{project.name}</strong><small>{formatDate(project.updated_at)}</small></div><Badge tone="success">계정 저장</Badge><ArrowUpRight size={16}/></Link>)}</div> : <p className="muted">계정에 저장한 프로젝트가 없습니다. 편집기에서 ‘계정에 저장’을 선택하면 여기에 표시됩니다.</p>}</section> : null}
  </div>;
}

/** Invalid timestamps are displayed honestly rather than inventing a relative update time. */
function formatDate(value: string) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date) : "저장 시각 확인 필요"; }
