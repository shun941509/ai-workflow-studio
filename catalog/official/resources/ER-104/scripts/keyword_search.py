"""Small reproducible BM25 keyword retrieval retaining exact identifier tokens and source hashes."""
import math
import re
import unicodedata
from collections import Counter
from contracts import main, fail, text, identifier, integer, digest


def terms(value):
    # NFKC/casefold is an explicit search normalization, never a mutation of stored original text.
    return re.findall(r'\w+(?:[-_.:/]\w+)*', unicodedata.normalize('NFKC', value).casefold(), re.UNICODE)


def run(data):
    documents = data.get('documents'); allowed = data.get('allowedDocumentIds')
    query = text(data.get('query'), 'query', 4000); top_k = integer(data.get('topK'), 1, 100, 'topK')
    if not isinstance(documents, list) or not 1 <= len(documents) <= 1000 or not isinstance(allowed, list): fail('INPUT_CONTRACT', 'Provide documents and an explicit authorized ID list.')
    authorized = set(identifier(item, 'allowedDocumentId') for item in allowed); inventory = {}; corpus = []
    for document in documents:
        identity = identifier(document.get('id'), 'document.id'); original = text(document.get('text'), 'document.text')
        if identity in inventory: fail('DUPLICATE_ID', 'Document IDs must be unique.')
        inventory[identity] = original
        if identity in authorized: corpus.append((identity, original, Counter(terms(original))))
    if authorized - set(inventory): fail('UNKNOWN_AUTHORIZED_ID', 'An allowed ID is absent from the source inventory.')
    requested = sorted(set(terms(query)))
    if not requested: fail('EMPTY_TERMS', 'Query has no supported keyword tokens.')
    if not corpus: return {'profile': 'bm25-nfkc-identifiers-v1', 'results': [], 'queryTerms': requested, 'authorizationEnforced': False}
    average = sum(sum(tokens.values()) for _, _, tokens in corpus) / len(corpus)
    if average == 0: fail('EMPTY_TERMS', 'Authorized documents contain no searchable terms.')
    results = []
    for identity, original, frequencies in corpus:
        score = 0.0; matches = []; length = sum(frequencies.values())
        for term in requested:
            frequency = frequencies[term]
            if not frequency: continue
            document_frequency = sum(1 for _, _, counts in corpus if counts[term])
            inverse = math.log(1 + (len(corpus) - document_frequency + .5) / (document_frequency + .5))
            score += inverse * frequency * 2.2 / (frequency + 1.2 * (.25 + .75 * length / average)); matches.append(term)
        if matches: results.append({'id': identity, 'text': original, 'sourceSha256': digest(original.encode('utf-8')), 'score': score, 'matchedTerms': matches})
    results.sort(key=lambda item: (-item['score'], item['id']))
    return {'profile': 'bm25-nfkc-identifiers-v1', 'k1': 1.2, 'b': .75, 'queryTerms': requested, 'results': [dict(item, rank=index + 1) for index, item in enumerate(results[:top_k])], 'authorizationEnforced': False}


if __name__ == '__main__':
    main(run)
