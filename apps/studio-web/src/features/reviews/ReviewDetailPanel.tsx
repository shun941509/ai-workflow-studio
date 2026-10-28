'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import { asFailure, reviewRequest, statusLabels, type ReviewDetail, type ReviewFailure } from './types';
import { ReviewAccessState } from './ReviewAccessState';
import styles from './reviews.module.css';

const checks: Record<string, string> = { archive: '패키지 무결성', source: '제출 원본 일치', files: '허용 파일 검사', secrets: '비밀정보 정적 검사', capabilities: '요구 기능 확인', dependencies: '의존성 고정', rights: '재배포 권리 근거', staticRisks: '정적 위험 신호' };
const stateLabels: Record<string, string> = { passed: '검사 통과', failed: '검사 실패', unverified: '미검증' };
const rightsLabels: Record<string, string> = { active: '현재 유효', expired: '권리 근거 만료', revoked: '검증 권한 취소됨', missing: '신뢰 목록에 없음', changed: '검증 키 변경됨', unverified: '권리 근거 미검증' };
const reasonLabels: Record<string, string> = { NOT_AWAITING_REVIEW: '현재 검수 대기 상태가 아닙니다.', SCAN_INCOMPLETE_OR_INCONSISTENT: '검사가 완료되지 않았거나 보고서가 고정 후보와 일치하지 않습니다.', RIGHTS_UNVERIFIED: '재배포 권리 근거를 검증하지 못했습니다.', RIGHTS_EXPIRED: '재배포 권리 근거가 만료되었습니다.', RIGHTS_REVOKED: '권리 검증자의 권한이 취소되었습니다.', RIGHTS_MISSING: '권리 검증자를 현재 신뢰 목록에서 찾을 수 없습니다.', RIGHTS_CHANGED: '권리 검증자의 키가 검사 당시와 다릅니다.' };

/** All approval controls depend on fresh server readiness; the database repeats every authorization/hash check at commit. */
export function ReviewDetailPanel({ id }: { id: string }) {
  const [detail, setDetail] = useState<ReviewDetail>(); const [failure, setFailure] = useState<ReviewFailure>(); const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [decisionError, setDecisionError] = useState('');
  const busyRef = useRef(false); const identityRef = useRef(''); const mounted = useRef(true); const activeId = useRef(id); activeId.current = id;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A route change cannot carry a prior candidate's acknowledgment or success receipt into the new candidate.
  useEffect(() => { identityRef.current = ''; setReason(''); setConfirmed(false); setMessage(''); setDecisionError(''); }, [id]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setDetail(undefined); setFailure(undefined);
    void reviewRequest<ReviewDetail>(`/api/admin/reviews/${encodeURIComponent(id)}`, { signal: abort.signal }).then((value) => {
      if (abort.signal.aborted) return;
      const identity = JSON.stringify([id, value.readiness.artifactSha256, value.readiness.reportSha256, value.readiness.status, value.readiness.rights.state]);
      if (identityRef.current && identityRef.current !== identity) { setReason(''); setConfirmed(false); setMessage('검수 상태 또는 고정된 검사 정보가 변경되었습니다. 최신 정보를 다시 확인해 주세요.'); }
      identityRef.current = identity; setDetail(value);
    }).catch((error) => { if (!abort.signal.aborted) setFailure(asFailure(error)); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, refresh]);
  useEffect(() => {
    const recheck = () => { if (document.visibilityState === 'visible' && !busyRef.current) setRefresh((value) => value + 1); };
    window.addEventListener('focus', recheck); document.addEventListener('visibilitychange', recheck); const timer = window.setInterval(recheck, 60000);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck); };
  }, []);
  async function decide(decision: 'approved' | 'rejected') {
    const hash = detail?.scan?.artifact_sha256; const allowed = decision === 'approved' ? detail?.readiness.canApprove : detail?.readiness.canReject;
    const reasonLength = Array.from(reason.trim()).length;
    if (busyRef.current || !hash || hash !== detail?.readiness.artifactSha256 || !allowed || !confirmed || reasonLength < 10 || reasonLength > 4000) return;
    // Repeat the displayed-report guard inside the callback; disabled controls are only a presentation aid.
    if (decision === 'approved' && (!detail?.scan?.evidence || detail.scan.evidence.reportSha256 !== detail.readiness.reportSha256)) return;
    busyRef.current = true; setBusy(true); setDecisionError(''); setMessage('');
    try {
      await reviewRequest(`/api/admin/reviews/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifactSha256: hash, decision, reason: reason.trim() }) });
      if (mounted.current && activeId.current === id) { identityRef.current = ''; setMessage(`${decision === 'approved' ? '승인' : '반려'} 결정을 저장했습니다. 서명하거나 게시하지 않았습니다.`); setConfirmed(false); setReason(''); }
    } catch (error) {
      const result = asFailure(error); if (mounted.current && activeId.current === id) setDecisionError(result.status === 409 ? '다른 검수 또는 상태 변경이 확인되었습니다. 최신 기록을 불러옵니다. 다시 제출하기 전에 결과를 확인해 주세요.' : `${result.message} 저장 여부가 불확실하면 아래 최신 검수 기록을 확인해 주세요.`);
    } finally { busyRef.current = false; if (mounted.current) { setBusy(false); if (activeId.current === id) setRefresh((value) => value + 1); } }
  }
  const scan = detail?.scan; const report = scan?.evidence; const readiness = detail?.readiness;
  const exact = Boolean(scan && report && scan.artifact_sha256 === readiness?.artifactSha256 && report.reportSha256 === readiness?.reportSha256);
  const validReason = Array.from(reason.trim()).length >= 10 && Array.from(reason.trim()).length <= 4000;
  return <><Link href="/admin/reviews" className={styles.back}><ArrowLeft size={16}/>검수 목록으로 돌아가기</Link><div className="page-eyebrow">FIXED ARTIFACT REVIEW</div><div className="page-heading"><div><h1>게시 후보 검수</h1><p>아래의 고정 파일 해시와 현재 검사·권리 상태를 확인하세요.</p></div><button className="button button-secondary" aria-label="검수 상태 새로고침" disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16}/></button></div>
    <div className={styles.notice}><strong>승인 기록은 게시 완료가 아닙니다.</strong><br/>정적 검사는 완전한 안전성과 실제 사용 성공을 보장하지 않습니다. 이 화면은 파일을 실행·렌더링하지 않으며 서명·외부 게시를 수행하지 않습니다.</div>
    {message && <p className={styles.success} role="status">{message}</p>}{decisionError && <p className={styles.error} role="alert">{decisionError}</p>}
    {loading ? <section className={styles.statusCard} role="status"><ShieldCheck size={30}/><h2>최신 검수 정보를 확인하고 있습니다</h2></section> : failure ? <ReviewAccessState failure={failure} retry={() => setRefresh((value) => value + 1)}/> : detail && readiness ? <>
      <div className={styles.titleMeta}><span className={styles.badge}>{statusLabels[readiness.status] ?? readiness.status}</span><code>{detail.submission.id}</code></div>
      <div className={styles.cards}><section className={styles.panel}><h2>고정된 파일과 검사 보고서</h2><dl className={styles.hashes}><dt>제출 종류</dt><dd>{detail.submission.kind === 'project' ? '프로젝트' : '도구 및 자료'}</dd><dt>ZIP SHA-256</dt><dd data-testid="review-artifact-hash">{scan?.artifact_sha256 ?? '아직 검사된 파일이 없습니다.'}</dd><dt>Manifest SHA-256</dt><dd>{scan?.manifest_sha256 ?? '확인하지 못했습니다.'}</dd><dt>검사 보고서 SHA-256</dt><dd>{report?.reportSha256 ?? '현재 규격의 보고서가 없습니다.'}</dd><dt>원본 snapshot SHA-256</dt><dd>{report?.sourceSnapshotSha256 ?? '확인하지 못했습니다.'}</dd>{report && <><dt>검사 정책</dt><dd>{report.policy.id} / {report.policy.version}<br/>{report.policy.sha256}</dd></>}</dl></section>
      <section className={styles.panel}><h2>현재 권리 상태</h2><p className={readiness.rights.state === 'active' ? styles.passed : styles.failed}><strong>{rightsLabels[readiness.rights.state] ?? '상태 확인 필요'}</strong></p><p className={styles.muted}>근거 만료: {readiness.rights.expiresAt ? new Date(readiness.rights.expiresAt).toLocaleString('ko-KR') : '검증된 만료 정보 없음'}<br/>서버 확인: {new Date(readiness.rights.checkedAt).toLocaleString('ko-KR')}</p><p className={styles.muted}>검사 후 검증 권한이 취소되거나 키가 변경되면 승인을 차단합니다. 최종 결정 시 서버가 다시 확인합니다.</p>{readiness.blockedReasons.length > 0 && <><h2>승인이 막힌 이유</h2><ul className={styles.reasons}>{readiness.blockedReasons.map((code) => <li key={code}>{reasonLabels[code] ?? '현재 검수 조건을 충족하지 못했습니다.'}</li>)}</ul></>}</section></div>
      <div className={styles.cards}><section className={styles.panel}><h2>정적 검사 항목</h2><ul className={styles.checks}>{Object.entries(checks).map(([key, label]) => { const state = report?.checks[key] ?? 'unverified'; return <li key={key}><span>{label}</span><strong className={state === 'passed' ? styles.passed : state === 'failed' ? styles.failed : styles.unverified}>{stateLabels[state] ?? '미확인'}</strong></li>; })}</ul></section>
      <section className={styles.panel}><h2>검사에서 확인할 내용</h2>{report?.findings.length ? report.findings.map((finding, index) => <div className={styles.finding} key={`${finding.code}-${index}`}><strong>{checks[finding.check] ?? '기타 검사'} · {stateLabels[finding.status] ?? '확인 필요'}</strong><code>{finding.code}{finding.path ? `\n${finding.path}` : ''}</code></div>) : <p className={styles.muted}>{report ? '보고된 정적 위험 신호가 없습니다. 이 결과가 완전한 안전성이나 실제 실행 품질을 보장하지는 않습니다.' : '표시할 검증된 검사 보고서가 없습니다.'}</p>}</section></div>
      {detail.review && <section className={styles.panel}><div className={styles.sectionHeader}><h2>이미 저장된 검수 결정</h2><span className={styles.badge}><CheckCircle2 size={15}/>{statusLabels[detail.review.decision] ?? detail.review.decision}</span></div><p className={styles.previous}>{detail.review.reason}</p><p className={styles.muted}>{new Date(detail.review.created_at).toLocaleString('ko-KR')} 기록</p><dl className={styles.hashes}><dt>검수한 파일 SHA-256</dt><dd>{detail.review.artifact_sha256}</dd></dl></section>}
      <section className={styles.panel}><h2>검수 결정 기록</h2>{readiness.canApprove || readiness.canReject ? <form className={styles.form} onSubmit={(event) => event.preventDefault()}><label htmlFor="review-reason">구체적인 검수 사유</label><textarea id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={10} maxLength={4000} disabled={busy}/><small>확인한 내용과 남은 제한을 10자 이상 작성해 주세요. 원본 비밀정보는 옮겨 적지 마세요.</small><label className={styles.confirmation}><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)}/><span>표시된 ZIP SHA-256과 검사 보고서를 확인했습니다. 이 결정은 서명이나 게시가 아님을 확인합니다.</span></label>{!exact && <p className={styles.error}>현재 표시된 검사 해시가 일치하지 않아 승인할 수 없습니다. 최신 정보를 다시 확인해 주세요.</p>}<div className={styles.actions}><button type="button" className="button button-primary" disabled={busy || !validReason || !confirmed || !exact || !readiness.canApprove} onClick={() => void decide('approved')}>{busy ? '기록 중…' : '승인 기록'}</button><button type="button" className="button button-secondary" disabled={busy || !validReason || !confirmed || !readiness.canReject} onClick={() => void decide('rejected')}>반려 기록</button></div></form> : <p className={styles.readonly}>현재 상태에서는 새 검수 결정을 기록할 수 없습니다. 보완 또는 이미 저장된 검수 기록을 확인해 주세요.</p>}</section>
    </> : null}
  </>;
}
