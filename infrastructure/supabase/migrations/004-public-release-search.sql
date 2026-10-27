-- Discovery is a bounded metadata-only query. SECURITY INVOKER preserves row and column permissions.
create function public.search_public_releases(
  p_kind text,
  p_official boolean,
  p_query text default '',
  p_before_created_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 25
) returns table(id uuid,kind text,title text,description text,artifact_sha256 text,manifest_sha256 text,status text,is_official boolean,created_at timestamptz)
language plpgsql stable security invoker set search_path='' as $$
begin
  if p_kind is null or p_kind not in ('project','resource') or p_official is null
    or p_query is null or length(p_query)>100 or p_query ~ '[[:cntrl:]]'
    or p_limit is null or p_limit not between 1 and 25
    or ((p_before_created_at is null) <> (p_before_id is null))
    or (p_before_created_at is not null and not isfinite(p_before_created_at))
  then raise exception 'INVALID_DISCOVERY_QUERY' using errcode='22023'; end if;
  return query
    select r.id,r.kind,r.title,r.description,r.artifact_sha256,r.manifest_sha256,r.status,r.is_official,r.created_at
    from public.public_releases r
    where r.status='published' and r.kind=p_kind and r.is_official=p_official
      -- strpos treats %, _, quotes and slashes as literal title text, never SQL or wildcard syntax.
      and (btrim(p_query)='' or strpos(lower(r.title),lower(btrim(p_query)))>0)
      and (p_before_created_at is null or (r.created_at,r.id)<(p_before_created_at,p_before_id))
    order by r.created_at desc,r.id desc limit p_limit;
end $$;
revoke all on function public.search_public_releases(text,boolean,text,timestamptz,uuid,integer) from public;
grant execute on function public.search_public_releases(text,boolean,text,timestamptz,uuid,integer) to anon,authenticated;
