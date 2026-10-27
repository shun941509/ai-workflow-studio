import { immutable, integer, object, requireCondition, text } from './common.js';
import { authorizeCurrent, currentSearchAuthorization, type AccessAuthority, type AuthorizationResult, type RetrievalContext } from './access.js';
import { normalizeRankedHits, type SearchChannel, type SearchProvider } from './ranking.js';

/** Search is filtered before scoring and reauthorized after the async provider call, including membership revocation. */
export async function searchCurrentChannel(
  context: RetrievalContext, provider: SearchProvider, authority: AccessAuthority,
  options: { query: string; channel: SearchChannel; limit: number }, signal: AbortSignal,
): Promise<AuthorizationResult> {
  context = immutable(context); options = immutable(options); object(options, ['query', 'channel', 'limit']);
  text(options.query, 8192); integer(options.limit, 1, 1000); requireCondition(['keyword', 'vector'].includes(options.channel), 'SEARCH_CHANNEL', 'Unknown search channel');
  signal.throwIfAborted();
  const authorization = await currentSearchAuthorization(context, authority); signal.throwIfAborted();
  const response = await provider.search({ index: context.index.ref, ...options, ...authorization }, signal); signal.throwIfAborted();
  const candidates = await normalizeRankedHits(response, context.corpus, context.index, options.channel);
  // A provider exceeding the requested count cannot widen a reranker disclosure or bypass a budget.
  requireCondition(candidates.length <= options.limit, 'SEARCH_RESPONSE_LIMIT', 'Provider exceeded the requested search limit');
  const result = await authorizeCurrent(context, candidates, authority); signal.throwIfAborted(); return result;
}
