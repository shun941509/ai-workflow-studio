"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Download, FileText, Plus, Search, X } from 'lucide-react';
import { Badge, Button, EmptyState, Field } from '@studio/ui';
import type { PrivateResourceSummary } from './types';
import { useResourcePages } from './useResourcePages';
import { useResourceDetail } from './useResourceDetail';
import { ResourcePreview } from './ResourcePreview';

const labels: Record<string, string> = { instruction: '작업 지침', document: '문서', skill: 'Skill', mcp: 'MCP 연결' };

/** Metadata pages and explicit version reads keep large archives and text out of the collection response. */
export function ResourceLibrary({ configured }: { configured: boolean }) {
  const pages = useResourcePages(configured); const [message, setMessage] = useState(''); const [query, setQuery] = useState(''); const [kind, setKind] = useState('all');
  const [creating, setCreating] = useState(false); const [selected, setSelected] = useState<PrivateResourceSummary>(); const [versionId, setVersionId] = useState<string>(); const [host, setHost] = useState('codex');
  const [name, setName] = useState(''); const [newKind, setNewKind] = useState('instruction'); const [text, setText] = useState(''); const [description, setDescription] = useState(''); const [busy, setBusy] = useState(false);
  const [licenseMode, setLicenseMode] = useState('private'); const [copyrightHolder, setCopyrightHolder] = useState(''); const [copyrightYear, setCopyrightYear] = useState(new Date().getFullYear()); const [confirmedAuthority, setConfirmedAuthority] = useState(false);
  const opened = useResourceDetail(selected?.id, versionId); const action = useRef(false); const downloadRequest = useRef<AbortController | undefined>(undefined); const selection = `${selected?.id ?? ''}:${versionId ?? ''}`; const currentSelection = useRef(selection); currentSelection.current = selection;
  const detailHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (!selected?.id || !detailHeading.current) return;
    // Only an explicit resource selection moves focus; content arrivals and version changes leave the user's focus intact.
    detailHeading.current.focus({ preventScroll: true });
    detailHeading.current.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [selected?.id]);
  useEffect(() => { downloadRequest.current?.abort(); return () => downloadRequest.current?.abort(); }, [selection]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (action.current) return; action.current = true; setBusy(true); setMessage('');
    try {
      // Each new revision carries its own explicit terms. Service code licensing never grants rights over user material.
      const license = licenseMode === 'MIT' ? { id: 'MIT', copyrightHolder: copyrightHolder.trim(), copyrightYear, confirmedAuthority } : undefined;
      const response = await fetch('/api/resources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind: newKind, description, text, ...(license ? { license } : {}) }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? '저장하지 못했습니다.');
      setCreating(false); setName(''); setText(''); setDescription(''); setLicenseMode('private'); setCopyrightHolder(''); setConfirmedAuthority(false); await pages.reload();
    } catch (failure) { setMessage(failure instanceof Error ? failure.message : '저장하지 못했습니다.'); }
    finally { action.current = false; setBusy(false); }
  };
  const download = async () => {
    const detail = opened.detail; if (!detail || action.current) return; action.current = true; setBusy(true); setMessage(''); const key = currentSelection.current; const targetHost = host; const controller = new AbortController(); downloadRequest.current = controller;
    try {
      // The complete verified selection is sent unchanged; account UUIDs are not substituted for source aliases.
      const response = await fetch('/api/resources/export', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: targetHost, refs: detail.refs, resourceBindings: detail.resourceBindings }) });
      if (!response.ok) { const body = await response.json(); throw new Error(body.error?.message ?? '자료 ZIP을 만들지 못했습니다.'); }
      const bytes = await response.blob(); if (controller.signal.aborted || key !== currentSelection.current) return;
      const url = URL.createObjectURL(bytes); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `materials-${targetHost}.zip`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('선택한 버전과 의존 자료를 ZIP으로 내려받았습니다. 다운로드만으로 작업이 실행되지는 않습니다.');
    } catch (failure) { if (!controller.signal.aborted && key === currentSelection.current) setMessage(failure instanceof Error ? failure.message : '자료 ZIP을 만들지 못했습니다.'); }
    finally { action.current = false; setBusy(false); }
  };
  const visible = pages.items.filter(item => (kind === 'all' || item.kind === kind) && `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-eyebrow">MY RESOURCES</div><div className="page-heading"><div><h1>도구 및 자료</h1><p>AI에게 알려줄 작업 방법과 참고 자료를 모아두세요.</p></div><Button onClick={() => setCreating(true)} disabled={!configured || busy}><Plus size={16}/>자료 추가</Button></div>
    <div className="library-toolbar"><div className="search-field"><Search size={17}/><input aria-label="자료 검색" placeholder="불러온 자료의 이름 또는 설명" value={query} onChange={event => setQuery(event.target.value)}/></div><select aria-label="자료 종류" className="filter-select" value={kind} onChange={event => setKind(event.target.value)}><option value="all">모든 종류</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
    {(message || pages.error) && <div className="inline-notice" role="status"><p>{message || pages.error}</p><Link href="/account">프로필·설정에서 확인 →</Link></div>}
    {!pages.ready ? <p className="muted">자료를 불러오고 있습니다…</p> : visible.length ? <div className="resource-grid">{visible.map(item => <button className="resource-card" key={item.id} onClick={() => { setMessage(''); setSelected(item); setVersionId(item.resource_versions[0]?.id); }}><span className="quick-icon violet"><FileText size={21}/></span><Badge>{labels[item.kind] ?? item.kind}</Badge><h3>{item.name}</h3><p>{item.description || '설명이 없는 자료'}</p><small>비공개 · 버전 {item.resource_versions[0]?.revision ?? '?'}</small></button>)}</div> : <EmptyState title={query || kind !== 'all' ? '불러온 자료 중 일치하는 항목이 없습니다' : '아직 저장한 자료가 없습니다'} description="작업 지침과 문서는 블록에 연결할 수 있습니다. Skill·MCP 파일 묶음은 원본 ZIP으로 활용하며 이 화면에서 실행하지 않습니다."/>}
    {pages.nextCursor && <div className="library-toolbar"><Button variant="secondary" onClick={() => void pages.loadMore()} disabled={pages.loading}>{pages.loading ? '자료를 불러오는 중…' : '자료 더 보기'}</Button><span className="muted">현재 {pages.items.length}개를 불러왔습니다. 검색은 불러온 자료에 적용됩니다.</span></div>}
    {creating && <section className="surface-card resource-form"><div className="modal-heading"><h2>새 자료 저장</h2><Button variant="ghost" onClick={() => setCreating(false)} aria-label="자료 추가 닫기"><X/></Button></div><form onSubmit={save}>
      <Field label="자료 이름" htmlFor="resource-name"><input id="resource-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120}/></Field>
      <Field label="종류" htmlFor="resource-kind"><select id="resource-kind" value={newKind} onChange={event => setNewKind(event.target.value)}><option value="instruction">작업 지침</option><option value="document">텍스트 문서</option></select></Field>
      <Field label="설명" htmlFor="resource-description"><input id="resource-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={2000}/></Field>
      <Field label="내용" htmlFor="resource-text" hint="256 KiB 이하의 비공개 자료로 저장됩니다. API 키나 비밀번호는 넣지 마세요."><textarea id="resource-text" value={text} onChange={event => setText(event.target.value)} rows={10} required maxLength={200000}/></Field>
      <Field label="자료 이용 조건" htmlFor="resource-license"><select id="resource-license" value={licenseMode} onChange={event => { setLicenseMode(event.target.value); setConfirmedAuthority(false); }}><option value="private">개인 사용 — 공개 재배포 허용 안 함</option><option value="MIT">MIT — 원문 고지를 보존한 사용·수정·재배포 허용</option></select></Field>
      {licenseMode === 'MIT' && <fieldset className="step-card"><legend>이 자료의 MIT 이용 조건</legend>
        <p className="muted">저장해도 자료는 비공개입니다. 공유하려면 별도 검수를 거칩니다. 기존 자료의 이용 조건은 바뀌지 않습니다.</p>
        <Field label="저작권자" htmlFor="resource-copyright-holder"><input id="resource-copyright-holder" required maxLength={160} value={copyrightHolder} onChange={event => setCopyrightHolder(event.target.value)}/></Field>
        <Field label="저작권 연도" htmlFor="resource-copyright-year"><input id="resource-copyright-year" type="number" required min={1900} max={9999} step={1} value={copyrightYear} onChange={event => setCopyrightYear(Number(event.target.value))}/></Field>
        <label className="file-type-choice"><input type="checkbox" required checked={confirmedAuthority} onChange={event => setConfirmedAuthority(event.target.checked)}/>이 자료에 MIT 이용 조건을 부여할 권한이 있음을 확인합니다.</label>
        <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT 이용 조건 전문 확인</a>
      </fieldset>}
      <Button type="submit" disabled={busy || licenseMode === 'MIT' && !confirmedAuthority}>{busy ? '저장 중…' : '계정에 저장'}</Button>
    </form></section>}
    {selected && <section className="surface-card resource-detail"><div className="modal-heading"><h2 ref={detailHeading} tabIndex={-1}>{opened.detail?.version.content.name ?? selected.name}</h2><Button variant="ghost" onClick={() => { setSelected(undefined); setVersionId(undefined); }} aria-label="자료 내용 닫기"><X/></Button></div>
      <div className="library-toolbar"><Field label="다운로드할 버전" htmlFor="download-version"><select id="download-version" value={versionId ?? ''} onChange={event => { setMessage(''); setVersionId(event.target.value); }}>{selected.resource_versions.map(version => <option key={version.id} value={version.id}>버전 {version.revision}</option>)}</select></Field><Field label="사용할 AI 도구" htmlFor="download-host"><select id="download-host" value={host} disabled={busy} onChange={event => setHost(event.target.value)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="opencode">OpenCode</option></select></Field><Button onClick={() => void download()} disabled={busy || !opened.detail || opened.loading}><Download size={16}/>{busy ? 'ZIP 준비 중…' : '자료 ZIP 다운로드'}</Button></div>
      {selected.versionsTruncated && <p className="muted">최근 100개 버전을 표시합니다. 프로젝트에 이미 고정한 이전 버전은 자동 변경하지 않습니다.</p>}
      {opened.loading ? <p role="status">선택한 버전을 확인하고 있습니다…</p> : opened.error ? <p className="form-error" role="alert">{opened.error}</p> : opened.detail ? <><Badge>{labels[opened.detail.version.content.kind]}</Badge><p>{opened.detail.version.content.description}</p><p className="muted">선택한 버전과 고정된 의존 자료 {Math.max(0, Object.keys(opened.detail.refs).length - 1)}개를 포함합니다.</p><ResourcePreview key={opened.detail.version.id} detail={opened.detail}/></> : <p className="muted">이 자료에서 열 수 있는 버전이 없습니다.</p>}
    </section>}
  </>;
}
