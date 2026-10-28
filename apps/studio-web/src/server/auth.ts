import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { HttpError } from "./http";
import { publicCloudConfiguration } from '../config/public-cloud';
import { boundedAccountFetch, type AccountFetchOptions } from './bounded-account-fetch';

/** Only the publishable/anonymous key is used; tenant access always passes through RLS. */
export function cloudConfigured(): boolean {
  return publicCloudConfiguration() !== null;
}

/** getUser verifies the session with Auth rather than trusting unverified cookie contents. */
export async function authenticatedClient(options: AccountFetchOptions = {}) {
  const configured = publicCloudConfiguration();
  if (!configured) throw new HttpError(503, "CLOUD_NOT_CONFIGURED", "계정 저장 연결이 아직 설정되지 않았습니다. 브라우저 초안은 계속 사용할 수 있습니다.");
  const { url, key } = configured;
  const jar = await cookies();
  const client = createServerClient(url, key, { global: { fetch: boundedAccountFetch(url, options) }, cookies: { getAll: () => jar.getAll(), setAll: (values) => { for (const cookie of values) jar.set(cookie.name, cookie.value, cookie.options); } } });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new HttpError(401, "AUTH_REQUIRED", "로그인 후 계정에 저장할 수 있습니다.");
  return { client, user: data.user };
}
