"""Assemble provided claims only after each quote resolves to an exact original UTF-8 source span."""
from contracts import main, fail, text, identifier, source_span


def run(data):
    candidates = data.get('candidates'); claims = data.get('claims')
    if not isinstance(candidates, list) or not isinstance(claims, list) or not 1 <= len(claims) <= 100: fail('INPUT_CONTRACT', 'Provide candidates and 1..100 already drafted claims.')
    inventory = {}
    for candidate in candidates:
        identity = identifier(candidate.get('id'), 'candidate.id')
        if identity in inventory: fail('DUPLICATE_ID', 'Candidate IDs must be unique.')
        value, source = source_span(candidate.get('source'), candidate.get('text'))
        inventory[identity] = {'text': value, 'source': source}
    citations = []; labels = {}; lines = []
    for claim in claims:
        content = text(claim.get('text'), 'claim.text', 10000); evidence = claim.get('evidence')
        if not isinstance(evidence, list) or not evidence: fail('UNSUPPORTED_CLAIM', 'Every provided claim needs explicit source evidence.')
        references = []
        for item in evidence:
            identity = identifier(item.get('candidateId'), 'candidateId'); quote = text(item.get('quote'), 'quote', 10000)
            candidate = inventory.get(identity)
            if candidate is None: fail('UNKNOWN_CITATION', 'A cited candidate is absent from the verified inventory.')
            if quote not in candidate['text']: fail('QUOTE_MISMATCH', 'The quote is not verbatim within its cited source chunk.')
            # Text equality verifies provenance, not the semantic entailment of a model-authored claim.
            key = (identity, quote)
            if key not in labels:
                label = f'S{len(citations)+1}'; labels[key] = label
                citations.append({'label': label, 'candidateId': identity, 'quote': quote, 'source': candidate['source']})
            references.append('[' + labels[key] + ']')
        lines.append(content + ' ' + ' '.join(dict.fromkeys(references)))
    return {'answerMarkdown': '\n\n'.join(lines), 'citations': citations, 'provenanceChecked': True, 'semanticSupportChecked': False, 'modelCalled': False}


if __name__ == '__main__':
    main(run)
