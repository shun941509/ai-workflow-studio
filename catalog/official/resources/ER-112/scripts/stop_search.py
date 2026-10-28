"""Bounded next-action decision from explicit search history; no query execution or cost fabrication."""
import unicodedata
from contracts import main, fail, text, identifier, integer


def normalized(value): return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def run(data):
    history = data.get('history'); limits = data.get('limits', {})
    if not isinstance(history, list) or len(history)>1000: fail('HISTORY_CONTRACT', 'Provide a bounded real search history.')
    rounds = integer(limits.get('rounds'), 1, 100, 'round limit'); tokens = integer(limits.get('tokens'), 1, 10000000, 'token limit')
    document_limit = integer(limits.get('documents'), 1, 10000, 'document limit'); used = 0; documents = set(); queries = set(); duplicate = False
    for index,item in enumerate(history):
        if integer(item.get('round'),1,1000,'round') != index+1: fail('ROUND_SEQUENCE', 'History rounds must be contiguous and one-based.')
        query = normalized(text(item.get('query'), 'history.query', 8000)); duplicate = duplicate or query in queries; queries.add(query)
        used += integer(item.get('tokens'), 0, 10000000, 'observed tokens')
        if not isinstance(item.get('documentIds'), list): fail('HISTORY_CONTRACT', 'Document IDs must be explicit.')
        documents.update(identifier(value,'documentId') for value in item['documentIds'])
    evidence = data.get('sufficientEvidence'); cancelled = data.get('cancelled', False)
    if not isinstance(evidence,bool) or not isinstance(cancelled,bool): fail('BOOLEAN_REQUIRED', 'Evidence and cancellation decisions must be explicit booleans.')
    if cancelled: action,reason='stop','cancelled'
    elif used>tokens or len(history)>rounds or len(documents)>document_limit: action,reason='stop','history_limit_exceeded'
    elif evidence: action,reason='answer','reviewed_evidence_sufficient'
    elif duplicate: action,reason='clarify','repeated_history_query'
    elif len(history)>=rounds or used>=tokens or len(documents)>=document_limit: action,reason='hold','limit_reached'
    else:
        query = normalized(text(data.get('nextQuery'), 'nextQuery', 8000)); reserve = integer(data.get('nextTokenReservation'), 1, 10000000, 'nextTokenReservation')
        if query in queries: action,reason='clarify','duplicate_next_query'
        elif used+reserve>tokens: action,reason='hold','next_reservation_exceeds_limit'
        else: action,reason='retrieve','within_limits'
    return {'action':action,'reason':reason,'roundsUsed':len(history),'tokensRecorded':used,'distinctDocuments':len(documents),'remainingRounds':max(0,rounds-len(history)),'remainingTokens':max(0,tokens-used),'remainingDocumentSlots':max(0,document_limit-len(documents)),'usageBasis':'provided_history_not_provider_verified','executionStarted':False}


if __name__ == '__main__': main(run)
