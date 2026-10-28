"""Route by an explicit source taxonomy and reject collection results outside the approved route."""
from contracts import main, fail, text, identifier


def run(data):
    question = text(data.get('question'), 'question', 8000); sources = data.get('sources'); allowed = data.get('allowedSourceIds')
    if not isinstance(sources, list) or not 1 <= len(sources) <= 100 or not isinstance(allowed, list): fail('SOURCE_CONTRACT', 'Declare source taxonomy and a trusted current allowlist.')
    allowed = set(identifier(item, 'allowedSourceId') for item in allowed); inventory = {}; selected = []
    for item in sources:
        identity = identifier(item.get('id'), 'source.id'); terms = item.get('terms')
        if identity in inventory or not isinstance(terms, list) or not terms: fail('SOURCE_CONTRACT', 'Sources need unique IDs and explicit matching terms.')
        checked = [text(term, 'source.term', 100) for term in terms]; inventory[identity] = checked
        matched = [term for term in checked if term.casefold() in question.casefold()]
        if identity in allowed and matched: selected.append({'sourceId': identity, 'query': question, 'matchedTerms': matched})
    if allowed - set(inventory): fail('UNKNOWN_SOURCE', 'Allowlist names a source absent from this taxonomy.')
    responses = data.get('responses')
    if responses is None: return {'action': 'retrieve' if selected else 'clarify', 'calls': selected, 'results': None, 'serviceCalled': False, 'authorizationVerified': False}
    if not isinstance(responses, list): fail('RESPONSE_CONTRACT', 'Actual service responses must be an array.')
    required = {item['sourceId'] for item in selected}; seen = set(); result = []
    for response in responses:
        identity = identifier(response.get('sourceId'), 'response.sourceId')
        if identity not in required or identity in seen: fail('UNAUTHORIZED_RESPONSE', 'Response is duplicate or outside the approved route.')
        seen.add(identity)
        if response.get('status') != 'ok' or not isinstance(response.get('items'), list): fail('SOURCE_FAILED', 'A selected search source did not return a confirmed result.')
        result.append({'sourceId': identity, 'items': response['items']})
    if seen != required: fail('SOURCE_MISSING', 'A selected source response is missing.')
    return {'action': 'review_results', 'calls': selected, 'results': result, 'serviceCalled': False, 'authorizationVerified': False, 'sourceContentReviewRequired': True}


if __name__ == '__main__': main(run)
