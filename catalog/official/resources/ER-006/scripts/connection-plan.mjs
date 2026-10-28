/** Portable connection preparation and evidence comparison. No account, file mutation, or remote call occurs here. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const fail = code => { throw new Error(code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const token = (value, pattern = /^[A-Za-z0-9_-]{1,100}$/) => { if (typeof value !== 'string' || !pattern.test(value)) fail('INVALID_SCOPE'); return value; };
const text = value => { if (typeof value !== 'string' || !value.trim() || value.length > 16000 || !value.isWellFormed()) fail('INVALID_TEXT'); return value; };
const stable = value => JSON.stringify(value, Object.keys(value).sort());

/** Service-specific scope parameters are constructed, never pasted into an arbitrary endpoint or shell command. */
export function plan(input, profile) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INPUT_OBJECT');
  let endpoint = profile.endpoint, scope, query;
  switch (profile.service) {
    case 'github': scope = `${token(input.owner)}/${token(input.repository, /^[A-Za-z0-9_.-]{1,100}$/)}`; query = { owner: input.owner, repo: input.repository, ref: token(input.commit, /^[a-f0-9]{40}$/), path: text(input.path) }; break;
    case 'notion': scope = token(input.pageId, /^[a-f0-9-]{32,36}$/); query = { pageId: scope }; break;
    case 'atlassian': scope = `${token(input.cloudId)}/${token(input.projectKey, /^[A-Z][A-Z0-9]{1,20}$/)}`; query = { cloudId: input.cloudId, projectKey: input.projectKey, issueKey: token(input.issueKey, /^[A-Z][A-Z0-9]+-\d+$/), pageId: token(input.pageId, /^\d{1,30}$/) }; if (!query.issueKey.startsWith(query.projectKey+'-')) fail('PROJECT_SCOPE'); break;
    case 'linear': scope = token(input.teamId); query = { teamId: scope, from: text(input.from), until: text(input.until) }; if (!Number.isFinite(Date.parse(query.from)) || !Number.isFinite(Date.parse(query.until)) || Date.parse(query.from) >= Date.parse(query.until) || !/Z$/.test(query.from) || !/Z$/.test(query.until)) fail('TIME_RANGE'); break;
    case 'figma': scope = `${token(input.fileKey)}/${token(input.nodeId, /^\d+:\d+$/)}`; query = { fileKey: input.fileKey, nodeId: input.nodeId }; break;
    case 'supabase': {
      scope = token(input.projectRef, /^[a-z]{20}$/);
      endpoint = `https://mcp.supabase.com/mcp?project_ref=${scope}&read_only=true&features=database`;
      const schema = token(input.schema, /^[a-z_][a-z0-9_]{0,62}$/), table = token(input.table, /^[a-z_][a-z0-9_]{0,62}$/);
      if (!Array.isArray(input.allowedTables) || !input.allowedTables.includes(schema+'.'+table)) fail('TABLE_SCOPE');
      if (!Array.isArray(input.columns) || !input.columns.length || input.columns.length > 20) fail('COLUMN_SCOPE');
      const columns = input.columns.map(value => token(value, /^[a-z_][a-z0-9_]{0,62}$/));
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) fail('ROW_LIMIT');
      // Only an identifier-only projection is emitted; no caller SQL, expression, function, or second statement is accepted.
      query = { sql: `SELECT ${columns.map(value => '"'+value+'"').join(', ')} FROM "${schema}"."${table}" LIMIT ${input.limit}`, projectRef: scope }; break;
    }
    case 'sentry': scope = `${token(input.organization)}/${token(input.project)}`; endpoint = 'https://mcp.sentry.dev/mcp/'+scope; query = { issueId: token(input.issueId), from: text(input.from), until: text(input.until) }; if (!Number.isFinite(Date.parse(query.from)) || !Number.isFinite(Date.parse(query.until)) || Date.parse(query.from) >= Date.parse(query.until)) fail('TIME_RANGE'); break;
    case 'cloudflare': case 'learn': scope = profile.sourceHost; query = { query: text(input.query) }; break;
    case 'playwright': {
      const target = new URL(input.url); if (target.protocol !== 'https:' || target.username || target.password || target.port) fail('URL_SCOPE');
      if (!Array.isArray(input.allowedOrigins) || !input.allowedOrigins.includes(target.origin)) fail('URL_SCOPE');
      return { status: 'blocked', reason: 'OS_AND_EGRESS_ISOLATION_UNIMPLEMENTED', requestedUrl: target.href, packagePin: profile.packagePin, executed: false };
    }
    default: fail('SERVICE_UNSUPPORTED');
  }
  const base = { service: profile.service, scope, endpoint, transport: 'streamable-http', query, executed: false, authorizationVerified: false, state: profile.state, requiresToolDiscovery: true };
  if (input.operation === 'mutation-preview') {
    if (!['github', 'notion'].includes(profile.service)) fail('WRITE_NOT_SUPPORTED');
    const draft = { scope, title: text(input.title), body: text(input.body) };
    return { ...base, status: 'blocked', reason: 'APPROVAL_BOUND_EXECUTION_UNIMPLEMENTED', draft, draftSha256: hash(stable(draft)), approved: false };
  }
  if (input.operation !== 'prepare') fail('OPERATION');
  return { ...base, status: profile.auth === 'none' ? 'ready_for_explicit_public_read' : 'connection_required' };
}

/** Compare captured facts with their actual reference snapshot; this proves equality, never authentication or source truth. */
export function compare(input, profile) {
  const prepared = plan({ ...input.request, operation: 'prepare' }, profile);
  if (prepared.status === 'blocked') fail('ISOLATION_REQUIRED');
  if (!Array.isArray(input.original) || !Array.isArray(input.observed) || input.original.length !== input.observed.length || !input.original.length || input.original.length > 100) fail('OBSERVATION_COUNT');
  const originals = new Map();
  for (const row of input.original) { const id = token(row.id); if (originals.has(id) || row.scope !== prepared.scope) fail('OBSERVATION_SCOPE'); originals.set(id, row); }
  const matched = new Set();
  for (const row of input.observed) {
    const original = originals.get(row.id); if (!original || matched.has(row.id) || row.scope !== prepared.scope) fail('OBSERVATION_SCOPE'); matched.add(row.id);
    for (const field of profile.compareFields) if (!Object.hasOwn(row.fields ?? {}, field) || !Object.hasOwn(original.fields ?? {}, field) || JSON.stringify(row.fields[field]) !== JSON.stringify(original.fields[field])) fail('FIELD_MISMATCH');
    const url = new URL(original.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password || !profile.sourceHosts.some(host => url.hostname === host || (host.startsWith('*.') && url.hostname.endsWith(host.slice(1))))) fail('SOURCE_HOST');
    if (row.sourceUrl !== original.sourceUrl) fail('SOURCE_MISMATCH');
  }
  return { comparedRows: matched.size, matchedFields: profile.compareFields, snapshotEquality: true, sourceAuthenticityVerified: false, hostVerification: 'unverified' };
}

/** Tool discovery is mandatory; a readOnly annotation is an advisory hint, never a replacement for server permissions. */
export function auditTools(input, profile) {
  if (!Array.isArray(input.tools) || input.tools.length > 1000 || new Set(input.tools.map(tool => tool.name)).size !== input.tools.length) fail('TOOLS_CONTRACT');
  const accepted = [], denied = [];
  for (const tool of input.tools) {
    token(tool.name, /^[A-Za-z0-9_.-]{1,128}$/);
    if (profile.readTools.includes(tool.name) && tool.inputSchema?.type === 'object' && tool.annotations?.readOnlyHint !== false) accepted.push(tool.name);
    else denied.push(tool.name);
  }
  return { accepted, denied, missing: profile.readTools.filter(name => !accepted.includes(name)), approvalForWrites: false, annotationsAreNotAuthorization: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const profile = JSON.parse(await readFile(new URL('../connection.json', import.meta.url), 'utf8')); const parts = []; let size = 0;
    for await (const part of process.stdin) { size += part.length; if (size > 1048576) fail('INPUT_LIMIT'); parts.push(part); }
    const input = JSON.parse(Buffer.concat(parts).toString('utf8'));
    const result = input.operation === 'compare' ? compare(input, profile) : input.operation === 'audit-tools' ? auditTools(input, profile) : plan(input, profile);
    process.stdout.write(JSON.stringify(result)+'\n');
  } catch (error) { process.stderr.write(JSON.stringify({ error: /^[A-Z_]+$/.test(error?.message) ? error.message : 'INVALID_INPUT' })+'\n'); process.exitCode = 1; }
}
