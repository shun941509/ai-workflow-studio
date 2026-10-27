import 'server-only';
import { authenticatedClient } from './auth';
import { HttpError } from './http';

/** Review privileges come from server-verified Auth plus DB-assigned roles, never headers, body flags or ownership. */
export async function reviewerClient() {
  const context = await authenticatedClient(); const { data, error } = await context.client.rpc('has_studio_role', { p_roles: ['reviewer', 'administrator'] });
  if (error) throw new HttpError(503, 'REVIEW_ROLE_UNAVAILABLE', '검수 권한을 확인하지 못했습니다.');
  if (data !== true) throw new HttpError(403, 'REVIEW_ROLE_REQUIRED', '관리자에게 검수 권한을 요청해 주세요.');
  return context;
}
