"""Actual OpenAI batch embeddings with explicit sending consent and pinned request metadata."""
import json
import math
from contracts import ContractError, digest, fail, identifier, integer, main, text
from provider_http import post_json

ENDPOINT = 'https://api.openai.com/v1/embeddings'

def execute(data):
    operation = data.get('operation', 'prepare')
    if operation not in ('prepare', 'execute'): fail('OPERATION', 'Use prepare or execute.')
    model = data.get('model')
    if model not in ('text-embedding-3-small', 'text-embedding-3-large'): fail('MODEL_UNSUPPORTED', 'This adapter accepts explicit text-embedding-3 models only.')
    dimensions = integer(data.get('dimensions'), 1, 1536 if model.endswith('small') else 3072, 'dimensions')
    batch_size = integer(data.get('batchSize'), 1, 16, 'batchSize')
    chunks = data.get('chunks')
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= 64: fail('CHUNKS_REQUIRED', 'Provide between 1 and 64 chunks.')
    seen, prepared = set(), []
    for chunk in chunks:
        identity = identifier(chunk.get('id'), 'chunk.id'); value = text(chunk.get('text'), 'chunk.text', 2000)
        if identity in seen: fail('DUPLICATE_ID', 'Chunk identifiers must be unique.')
        seen.add(identity)
        # UTF-8 bytes upper-bound byte-level token counts; this intentionally conservative profile avoids oversized requests.
        if len(value.encode('utf-8')) > 2000: fail('CHUNK_LIMIT', 'A chunk must contain at most 2000 UTF-8 bytes.')
        prepared.append({'id': identity, 'text': value, 'textSha256': digest(value.encode('utf-8'))})
    profile = {'provider': 'openai', 'endpoint': ENDPOINT, 'model': model, 'dimensions': dimensions, 'encodingFormat': 'float', 'inputNormalization': 'none'}
    fingerprint = digest(json.dumps(profile, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    result = {'profile': profile, 'profileFingerprint': fingerprint, 'modelVersionVerified': False, 'providerCalled': False, 'records': None, 'batches': (len(prepared)+batch_size-1)//batch_size}
    if operation == 'prepare':
        return {**result, 'status': 'connection_required', 'chunkManifest': [{key: row[key] for key in ('id', 'textSha256')} for row in prepared], 'requiredEnvironment': 'STUDIO_EMBEDDING_API_KEY', 'sendRequired': True}
    if data.get('send') is not True: fail('SEND_APPROVAL_REQUIRED', 'Execution requires explicit send=true after reviewing the text and provider cost.')
    records, completed, prompt_tokens, total_tokens = [], 0, 0, 0
    for start in range(0, len(prepared), batch_size):
        batch = prepared[start:start+batch_size]
        try:
            response = post_json(ENDPOINT, {'model': model, 'dimensions': dimensions, 'encoding_format': 'float', 'input': [row['text'] for row in batch]}, 'STUDIO_EMBEDDING_API_KEY')
            if response.get('model') != model or response.get('object') != 'list': fail('MODEL_MISMATCH', 'Provider model or response object differs from the locked profile.')
            values = response.get('data')
            if not isinstance(values, list) or len(values) != len(batch): fail('EMBEDDING_COUNT', 'Provider omitted or added an embedding.')
            indexed = {}
            for value in values:
                index = integer(value.get('index'), 0, len(batch)-1, 'embedding.index')
                if index in indexed: fail('EMBEDDING_INDEX', 'Provider returned duplicate indices.')
                vector = value.get('embedding')
                if value.get('object') != 'embedding' or not isinstance(vector, list) or len(vector) != dimensions: fail('EMBEDDING_DIMENSIONS', 'Embedding dimensions differ from the profile.')
                if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in vector): fail('EMBEDDING_VALUE', 'Embedding coordinates must be finite numbers.')
                indexed[index] = vector
            usage = response.get('usage', {})
            prompt = integer(usage.get('prompt_tokens'), 0, 10000000, 'usage.prompt_tokens'); total = integer(usage.get('total_tokens'), prompt, 10000000, 'usage.total_tokens')
            for index, row in enumerate(batch): records.append({'id': row['id'], 'textSha256': row['textSha256'], 'vector': indexed[index]})
            prompt_tokens += prompt; total_tokens += total; completed += 1
        except ContractError as error:
            # Earlier accepted batches may have incurred cost. Discard the partial index rather than publishing it as complete.
            fail(error.code, 'Embedding batch stopped; validated batches='+str(completed)+'. No complete index returned; current request billing may be uncertain.')
    return {**result, 'status': 'completed', 'providerCalled': True, 'providerReportedModel': model, 'records': records, 'usage': {'promptTokens': prompt_tokens, 'totalTokens': total_tokens}}

if __name__ == '__main__': main(execute)
