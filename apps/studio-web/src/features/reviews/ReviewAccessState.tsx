import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import type { ReviewFailure } from './types';
import styles from './reviews.module.css';

/** These explanations describe the actual server failure; a visible administrator page is not proof of authorization. */
export function ReviewAccessState({ failure, retry }: { failure: ReviewFailure; retry: () => void }) {
  const title = failure.status === 401 ? '로그인이 필요합니다' : failure.status === 403 ? '검수 권한이 필요합니다' : failure.code === 'CLOUD_NOT_CONFIGURED' ? '관리자 서비스 연결을 준비하고 있습니다' : '검수 정보를 확인하지 못했습니다';
  const message = failure.code === 'CLOUD_NOT_CONFIGURED' ? '검수에는 계정 서비스 연결과 실제 관리자 권한이 필요합니다. 연결 전에는 항목이나 승인 결과를 표시하지 않습니다.' : failure.message;
  return <section className={styles.statusCard} role="alert"><ShieldCheck size={32}/><h2>{title}</h2><p>{message}</p><div className={styles.actions}>{failure.status === 401 && <Link className="button button-primary" href="/account">프로필·설정에서 로그인</Link>}<button className="button button-secondary" onClick={retry}>다시 확인</button></div></section>;
}
