"""Exact local cosine search over supplied real embeddings; never synthesizes embedding vectors."""
import json
import math
from contracts import digest, fail, identifier, integer, main, text

def checked_profile(envelope):
    profile = envelope.get('profile')
    if not isinstance(profile, dict) or set(profile) != {'provider', 'endpoint', 'model', 'dimensions', 'encodingFormat', 'inputNormalization'}: fail('PROFILE_REQUIRED', 'Provide the complete embedding profile.')
    integer(profile.get('dimensions'), 1, 3072, 'dimensions')
    if profile.get('provider') != 'openai' or profile.get('endpoint') != 'https://api.openai.com/v1/embeddings' or profile.get('encodingFormat') != 'float' or profile.get('inputNormalization') != 'none': fail('PROFILE_UNSUPPORTED', 'This profile must be the ER-105 unnormalized float contract.')
    if profile.get('model') not in ('text-embedding-3-small', 'text-embedding-3-large'): fail('PROFILE_UNSUPPORTED', 'Unsupported embedding model.')
    fingerprint = digest(json.dumps(profile, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    if fingerprint != envelope.get('profileFingerprint'): fail('PROFILE_HASH', 'Embedding profile fingerprint does not match its fields.')
    return profile, fingerprint

def unit(vector, dimensions):
    if not isinstance(vector, list) or len(vector) != dimensions: fail('VECTOR_DIMENSIONS', 'Vector dimension mismatch.')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in vector): fail('VECTOR_VALUE', 'Vectors must contain finite numeric values.')
    scale = max(abs(x) for x in vector)
    if scale == 0: fail('ZERO_VECTOR', 'Cosine distance is undefined for zero vectors.')
    scaled = [x/scale for x in vector]; norm = math.sqrt(math.fsum(x*x for x in scaled))
    return [x/norm for x in scaled]

def execute(data):
    query = text(data.get('query'), 'query', 2000); top_k = integer(data.get('topK'), 1, 100, 'topK')
    documents = data.get('documents'); allowed = data.get('allowedDocumentIds')
    if not isinstance(documents, list) or not 1 <= len(documents) <= 1000: fail('DOCUMENTS_REQUIRED', 'Provide a bounded nonempty document list.')
    texts = {}
    for document in documents:
        identity = identifier(document.get('id'), 'document.id')
        if identity in texts: fail('DUPLICATE_ID', 'Document IDs must be unique.')
        texts[identity] = text(document.get('text'), 'document.text')
    if not isinstance(allowed, list) or len(set(allowed)) != len(allowed) or any(x not in texts for x in allowed): fail('ACCESS_SCOPE', 'Use explicit unique allowed document IDs from the authorization layer.')
    operation = data.get('operation', 'prepare')
    if operation == 'prepare':
        return {'status': 'embeddings_required', 'queryTextSha256': digest(query.encode('utf-8')), 'documentManifest': [{'id': key, 'textSha256': digest(value.encode('utf-8'))} for key, value in texts.items()], 'requiredInput': ['index: ER-105 completed result', 'queryEmbedding: ER-105 completed result containing query'], 'candidates': None, 'providerCalled': False}
    if operation != 'search': fail('OPERATION', 'Use prepare or search.')
    index = data.get('index', {}); query_embedding = data.get('queryEmbedding', {})
    profile, fingerprint = checked_profile(index); _, query_fingerprint = checked_profile(query_embedding)
    if fingerprint != query_fingerprint: fail('PROFILE_MISMATCH', 'Question and index embeddings must use the same profile.')
    records = index.get('records'); queries = query_embedding.get('records')
    if not isinstance(records, list) or len(records) != len(texts) or not isinstance(queries, list) or len(queries) != 1: fail('VECTOR_COUNT', 'Every document and exactly one question embedding are required.')
    if queries[0].get('textSha256') != digest(query.encode('utf-8')): fail('QUERY_HASH', 'Question embedding does not match the exact question text.')
    query_unit = unit(queries[0].get('vector'), profile['dimensions']); seen, candidates = set(), []
    for record in records:
        identity = record.get('id')
        if identity not in texts or identity in seen: fail('VECTOR_ID', 'Index IDs must exactly match the documents.')
        seen.add(identity)
        if record.get('textSha256') != digest(texts[identity].encode('utf-8')): fail('SOURCE_HASH', 'Embedding source text changed.')
        values = unit(record.get('vector'), profile['dimensions'])
        if identity in allowed:
            score = max(-1.0, min(1.0, math.fsum(a*b for a,b in zip(query_unit, values))))
            candidates.append({'id': identity, 'score': score, 'distance': 1-score, 'text': texts[identity], 'textSha256': record['textSha256']})
    candidates.sort(key=lambda row: (-row['score'], row['id'])); candidates = candidates[:top_k]
    recall = None
    if 'relevantIds' in data:
        relevant = data['relevantIds']
        if not isinstance(relevant, list) or len(set(relevant)) != len(relevant) or any(x not in allowed for x in relevant): fail('JUDGMENT_SCOPE', 'Relevance judgments must be unique and inside the evaluated access scope.')
        recall = len(set(relevant).intersection(row['id'] for row in candidates))/len(relevant) if relevant else None
    return {'status': 'completed', 'metric': 'cosine', 'profileFingerprint': fingerprint, 'candidates': [{**row, 'rank': rank+1} for rank, row in enumerate(candidates)], 'recallAtK': recall, 'authorizationEnforced': False, 'embeddingProvenanceAuthenticated': False, 'providerCalled': False}

if __name__ == '__main__': main(execute)
