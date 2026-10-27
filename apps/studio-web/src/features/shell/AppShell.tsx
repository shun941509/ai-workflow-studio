"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, FolderOpen, Layers, Compass, Library, Sparkles, BookOpen, CircleHelp, UserRound, ArrowUpRight, Workflow } from "lucide-react";
import { navigation } from "../../config/navigation";

const icons = { home: Home, folder: FolderOpen, layers: Layers, compass: Compass, library: Library, sparkles: Sparkles, book: BookOpen, help: CircleHelp };

/** Focus mode reserves canvas space without changing the user's menu structure. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const editor = pathname === "/projects/new" || pathname.endsWith("/edit");
  const pageTitle = pathname === '/admin/reviews' || pathname.startsWith('/admin/reviews/') ? '관리자 검수' : undefined;
  const active = navigation.filter((item) => item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)).sort((a, b) => b.href.length - a.href.length)[0];
  return <div className={`app-shell ${editor ? "editor-shell" : ""}`}>
    <aside className="sidebar" aria-label="주 메뉴">
      <Link href="/" className="brand" aria-label="AI Workflow Studio 홈"><span className="brand-mark"><Workflow size={23}/></span><span className="brand-name">Workflow<span>STUDIO</span></span></Link>
      <div className="workspace-label"><span className="workspace-avatar">W</span><span>나의 워크스페이스<small>개인 작업 공간</small></span></div>
      <nav>{navigation.map((item, index) => { const Icon = icons[item.icon]; return <div key={item.href} className={index === 3 || index === 7 ? "nav-group-start" : ""}><Link href={item.href} className={`nav-item ${active?.href === item.href ? "active" : ""}`} title={item.label} aria-current={active?.href === item.href ? "page" : undefined}><Icon size={18}/><span>{item.label}</span></Link></div>; })}</nav>
      <div className="sidebar-note"><span className="note-dot"/><strong>내 도구에서 실행</strong><p>워크플로를 내려받아<br/>익숙한 AI 도구와 연결하세요.</p><Link href="/guide">사용 방법 보기 <ArrowUpRight size={14}/></Link></div>
      <Link href="/account" className="profile-link" title="프로필·설정"><span className="profile-avatar"><UserRound size={18}/></span><span>프로필·설정<small>내 계정 관리</small></span></Link>
    </aside>
    <div className="app-main"><header className="topbar"><span className="breadcrumb">워크스페이스 <span>/</span> <strong>{editor ? "워크플로 만들기" : pageTitle ?? active?.label ?? "프로필·설정"}</strong></span><div className="topbar-right"><span className="connection-status"><i/>로컬 초안 사용 가능</span><Link className="top-profile" href="/account" aria-label="프로필·설정"><UserRound size={18}/></Link></div></header><main id="main-content" className={editor ? "editor-main" : "page-main"}>{children}</main></div>
  </div>;
}
