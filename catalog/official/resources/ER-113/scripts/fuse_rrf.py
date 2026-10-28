"""Document-level reciprocal rank fusion, exact normalized identity, and deterministic ties."""
from fractions import Fraction
from contracts import main, fail, identifier, integer, text


def run(data):
    k = integer(data.get('k'), 1, 1000, 'k'); limit = integer(data.get('limit'), 1, 1000, 'limit')
    lists = data.get('rankings')
    if not isinstance(lists, dict) or set(lists) != {'keyword', 'vector'}: fail('CHANNELS_REQUIRED', 'Provide both keyword and vector ranking arrays.')
    combined = {}; versions = {}
    for channel, ranking in lists.items():
        if not isinstance(ranking, list) or len(ranking) > 1000: fail('RANKING_LIMIT', 'Each ranking allows up to 1000 documents.')
        seen = set()
        for index, item in enumerate(ranking):
            document = identifier(item.get('documentId'), 'documentId'); revision = integer(item.get('revision'), 1, 1000000, 'revision')
            if document in versions and versions[document] != revision: fail('VERSION_CONFLICT', 'One pinned revision per document is required across channels.')
            versions[document] = revision
            sha = text(item.get('sourceSha256'), 'sourceSha256', 64)
            if len(sha) != 64 or any(char not in '0123456789abcdef' for char in sha): fail('HASH_REQUIRED', 'A lower-case source SHA-256 is required.')
            # A source ID/revision cannot silently acquire two content hashes across channels.
            key = f'{document}@{revision}'
            existing = combined.get(key)
            if existing and existing['sourceSha256'] != sha: fail('SOURCE_CONFLICT', 'Same source identity has conflicting content hashes.')
            if key in seen: continue
            seen.add(key); rank = index + 1
            if existing is None: existing = {'documentId': document, 'revision': revision, 'sourceSha256': sha, 'ranks': {}, 'fraction': Fraction(0)}; combined[key] = existing
            existing['ranks'][channel] = rank; existing['fraction'] += Fraction(1, k + rank)
    ordered = sorted(combined.values(), key=lambda value: (-value['fraction'], value['documentId'], value['revision']))
    output = []
    for index, item in enumerate(ordered[:limit]):
        fraction = item.pop('fraction')
        output.append(dict(item, rank=index + 1, score=float(fraction), exactScore={'numerator': fraction.numerator, 'denominator': fraction.denominator}))
    return {'profile': 'document-rrf-v1', 'k': k, 'results': output, 'inputScoresCombined': False, 'embeddingGenerated': False}


if __name__ == '__main__':
    main(run)
