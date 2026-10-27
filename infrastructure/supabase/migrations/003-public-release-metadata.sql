-- Public discovery exposes safe metadata columns even when a caller bypasses the web API.
-- Private storage paths, submitter account IDs and submission IDs remain backend-only.
revoke select on public.public_releases from anon,authenticated;
grant select(id,kind,title,description,artifact_sha256,manifest_sha256,status,is_official,created_at)
  on public.public_releases to anon,authenticated;

-- Existing row policies still hide unpublished releases from anonymous readers. Privileged
-- review/publish/moderate functions execute with their fixed definer privileges and search_path.
