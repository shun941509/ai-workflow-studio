"""Constrained glossary expansion and proposed-query validation without dropping the original question."""
import re
from contracts import main, fail, text, integer


def run(data):
    question = text(data.get('question'), 'question', 8000)
    required = data.get('requiredTerms'); glossary = data.get('glossary')
    if not isinstance(required, list) or not isinstance(glossary, list) or len(glossary) > 100: fail('INPUT_CONTRACT', 'Provide requiredTerms and a bounded glossary.')
    protected = [text(item, 'requiredTerm', 200) for item in required]
    if any(item not in question for item in protected): fail('UNKNOWN_CONSTRAINT', 'Every required term must come from the original question.')
    # Numbers and identifier-like strings are preserved literally in every proposed search query.
    protected = list(dict.fromkeys(protected + re.findall(r'\d+(?:[./:-]\d+)*|[A-Za-z]+[-_]\d+', question)))
    additions = []; aliases = {}
    for item in glossary:
        surface = text(item.get('term'), 'glossary.term', 200); canonical = text(item.get('canonical'), 'canonical', 200)
        if surface in aliases and aliases[surface] != canonical: fail('GLOSSARY_CONFLICT', 'The same term has conflicting approved meanings.')
        aliases[surface] = canonical
        if surface in question and canonical not in question: additions.append(canonical)
    proposed = data.get('proposedQueries')
    if proposed is None: proposed = [question + (' | ' + ' | '.join(dict.fromkeys(additions)) if additions else '')]
    if not isinstance(proposed, list) or not 1 <= len(proposed) <= 5: fail('QUERY_LIMIT', 'Provide one to five proposed queries.')
    output = []
    for query in proposed:
        query = text(query, 'query', 10000)
        missing = [term for term in protected if term not in query]
        if missing: fail('CONSTRAINT_LOST', 'A proposed query lost an original protected condition.')
        if query not in output: output.append(query)
    return {'originalQuestion': question, 'queries': output, 'protectedTerms': protected, 'glossaryExpansions': list(dict.fromkeys(additions)), 'semanticReviewRequired': True, 'modelCalled': False}


if __name__ == '__main__': main(run)
