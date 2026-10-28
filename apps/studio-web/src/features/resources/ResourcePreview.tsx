'use client';
import { useState } from 'react';
import { Button } from '@studio/ui';
import type { PrivateResourceDetail } from './types';

/** Only named provenance fields are displayed. Unknown source metadata cannot expose storage paths or server details. */
export function ResourceOrigin({ origin }: { origin: PrivateResourceDetail['origin'] }) {
  if (!origin) return null;
  const text = (name: string) => typeof origin.source[name] === 'string' ? String(origin.source[name]).slice(0, 160) : undefined;
  return <details className="advanced-settings"><summary>복사한 원본 정보</summary><dl><dt>원본 패키지</dt><dd>{text('packageId') ?? '확인 가능한 정보 없음'} · {text('packageVersion') ?? ''}</dd><dt>가져온 시각</dt><dd>{origin.copied_at}</dd>{/^[a-f0-9]{64}$/.test(text('artifactSha256') ?? '') && <><dt>원본 파일 SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{text('artifactSha256')}</dd></>}</dl><p className="muted">계정에 복사한 버전입니다. 원본 게시 상태와 이 복사본의 실행 준비 상태는 별도로 확인합니다.</p></details>;
}

/** Archives show escaped metadata only. Code, HTML, binaries and Skill scripts are never executed or rendered inline. */
export function ResourcePreview({ detail }: { detail: PrivateResourceDetail }) {
  const [limit, setLimit] = useState(30); const content = detail.version.content;
  return <><ResourceOrigin origin={detail.origin}/>{content.format === 'text' ? <><p className="muted">{content.license ? `이용 조건: MIT · ${content.license.copyrightYear} ${content.license.copyrightHolder}` : '이용 조건: 개인 사용 · 공개 재배포 허용 안 함'}</p><pre style={{ maxHeight: 360, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{content.text}</pre></> : <>
    <p className="muted">복사한 파일 묶음의 정보입니다. 원본 파일은 자료 ZIP으로 보존합니다. 이 화면에서 코드·Skill·MCP를 실행하지 않습니다.</p>
    <p>이용 조건: {content.license.id} · {content.license.path}</p><ul>{content.files.slice(0, limit).map(file => <li key={file.path} style={{ overflowWrap: 'anywhere' }}>{file.path} · {file.bytes.toLocaleString()} bytes</li>)}</ul>
    {content.files.length > limit && <Button variant="secondary" onClick={() => setLimit(value => value + 30)}>파일 정보 더 보기</Button>}
  </>}</>;
}
