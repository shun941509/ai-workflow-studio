"""Cohere v2 rerank adapter maps returned indices exclusively to original sourced candidates."""
import json
import math
from contracts import ContractError, digest, fail, identifier, integer, main, source_span, text
from provider_http import post_json

ENDPOINT = 'https://api.cohere.com/v2/rerank'

def execute(data):
    operation = data.get('operation', 'prepare')
    if operation not in ('prepare', 'execute'): fail('OPERATION', 'Use prepare or execute.')
    model = text(data.get('model'), 'model', 128)
    if not all(ch.isascii() and (ch.isalnum() or ch in '-_.') for ch in model): fail('MODEL_NAME', 'Use an explicit provider model identifier.')
    query = text(data.get('query'), 'query', 4000); max_tokens = integer(data.get('maxTokensPerDocument'), 1, 32768, 'maxTokensPerDocument')
    failure = data.get('onFailure')
    if failure not in ('fail', 'use_original'): fail('FAILURE_POLICY', 'Choose fail or use_original explicitly.')
    supplied = data.get('candidates')
    if not isinstance(supplied, list) or not 1 <= len(supplied) <= 100: fail('CANDIDATES_REQUIRED', 'Provide between 1 and 100 candidates.')
    candidates, seen = [], set()
    for row in supplied:
        identity = identifier(row.get('id'), 'candidate.id'); value = text(row.get('text'), 'candidate.text', 20000)
        if identity in seen: fail('DUPLICATE_ID', 'Candidate IDs must be unique.')
        seen.add(identity); _, source = source_span(row.get('source'), value)
        candidates.append({'id': identity, 'text': value, 'source': source})
    profile = {'provider': 'cohere', 'endpoint': ENDPOINT, 'model': model, 'maxTokensPerDocument': max_tokens, 'onFailure': failure}
    common = {'profile': profile, 'profileFingerprint': digest(json.dumps(profile, sort_keys=True, separators=(',', ':')).encode('utf-8')), 'providerReportedModel': None, 'modelVersionVerified': False, 'providerMayTruncate': True}
    if operation == 'prepare': return {**common, 'status': 'connection_required', 'providerCalled': False, 'candidates': None, 'candidateIds': [row['id'] for row in candidates], 'requiredEnvironment': 'STUDIO_RERANK_API_KEY', 'sendRequired': True}
    if data.get('send') is not True: fail('SEND_APPROVAL_REQUIRED', 'Review provider, cost and source disclosure before setting send=true.')
    try:
        response = post_json(ENDPOINT, {'model': model, 'query': query, 'documents': [row['text'] for row in candidates], 'top_n': len(candidates), 'max_tokens_per_doc': max_tokens}, 'STUDIO_RERANK_API_KEY')
    except ContractError as error:
        # An explicit transient-failure policy may preserve the old rank, never claim the reranker succeeded.
        if failure == 'use_original' and error.code in ('PROVIDER_TEMPORARY', 'PROVIDER_TRANSPORT'):
            return {**common, 'status': 'original_order', 'reason': error.code, 'providerCalled': True, 'billingUncertain': True, 'candidates': [{**row, 'rank': i+1, 'score': None} for i,row in enumerate(candidates)]}
        raise
    results = response.get('results')
    if not isinstance(results, list) or len(results) != len(candidates): fail('RERANK_COUNT', 'Provider must return each input candidate exactly once.')
    ranked, returned = [], set()
    for item in results:
        index = integer(item.get('index'), 0, len(candidates)-1, 'result.index'); score = item.get('relevance_score')
        if index in returned: fail('RERANK_INDEX', 'Duplicate provider result index.')
        returned.add(index)
        if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1: fail('RERANK_SCORE', 'Relevance score must be a finite number in [0,1].')
        ranked.append({**candidates[index], 'score': score, 'originalIndex': index})
    ranked.sort(key=lambda row: (-row['score'], row['originalIndex']))
    return {**common, 'status': 'completed', 'providerCalled': True, 'candidates': [{**row, 'rank': i+1} for i,row in enumerate(ranked)], 'billingUsage': None}

if __name__ == '__main__': main(execute)
