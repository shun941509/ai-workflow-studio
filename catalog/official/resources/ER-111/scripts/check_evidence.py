"""Evaluate declared evidence criteria and provenance; semantic support remains a reviewed judgment."""
from contracts import main, fail, text, identifier, integer, source_span


def run(data):
    claims = data.get('claims'); candidates = data.get('candidates'); judgments = data.get('judgments')
    if not isinstance(claims, list) or not 1 <= len(claims) <= 100 or not isinstance(candidates, list): fail('EVIDENCE_CONTRACT', 'Declare claims and actual candidate evidence.')
    remaining = integer(data.get('remainingSearches'), 0, 100, 'remainingSearches'); required = {}; inventory = {}
    for claim in claims:
        identity = identifier(claim.get('id'), 'claim.id')
        if identity in required: fail('DUPLICATE_ID', 'Claim IDs must be unique.')
        required[identity] = text(claim.get('text'), 'claim.text', 4000)
    for candidate in candidates:
        identity = identifier(candidate.get('id'), 'candidate.id')
        if identity in inventory: fail('DUPLICATE_ID', 'Candidate IDs must be unique.')
        value, reference = source_span(candidate.get('source'), candidate.get('text')); inventory[identity] = {'text': value, 'source': reference}
    if judgments is None: return {'action': 'assess', 'claims': [{'id': key, 'text': value} for key,value in required.items()], 'candidateIds': list(inventory), 'requiredJudgmentFields': ['claimId', 'status:supported|missing|conflicting', 'evidence:[{candidateId,quote}]'], 'sufficient': None, 'modelCalled': False}
    if not isinstance(judgments, list): fail('JUDGMENT_CONTRACT', 'Provide actual reviewed judgments.')
    seen = set(); assessed = []
    for judgment in judgments:
        identity = identifier(judgment.get('claimId'), 'claimId'); status = judgment.get('status'); evidence = judgment.get('evidence')
        if identity not in required or identity in seen or status not in ['supported','missing','conflicting'] or not isinstance(evidence,list): fail('JUDGMENT_CONTRACT', 'Every claim needs one explicit supported/missing/conflicting judgment.')
        if status == 'supported' and not evidence: fail('UNSUPPORTED_CLAIM', 'A supported judgment must contain source evidence.')
        refs = []
        for item in evidence:
            candidate_id = identifier(item.get('candidateId'), 'candidateId'); quote = text(item.get('quote'), 'quote', 10000)
            if candidate_id not in inventory or quote not in inventory[candidate_id]['text']: fail('EVIDENCE_MISMATCH', 'Judgment evidence does not resolve to an exact original quote.')
            refs.append({'candidateId':candidate_id,'quote':quote,'source':inventory[candidate_id]['source']})
        seen.add(identity); assessed.append({'claimId':identity,'status':status,'evidence':refs})
    if seen != set(required): fail('JUDGMENT_MISSING', 'At least one claim has no judgment.')
    missing = [item['claimId'] for item in assessed if item['status']=='missing']; conflicting = [item['claimId'] for item in assessed if item['status']=='conflicting']
    action = 'hold' if conflicting or (missing and remaining==0) else 'search_more' if missing else 'answer_with_reviewed_evidence'
    return {'sufficient':not missing and not conflicting,'action':action,'missingClaims':missing,'conflictingClaims':conflicting,'assessed':assessed,'semanticAssessmentByCaller':True,'modelCalled':False}


if __name__ == '__main__': main(run)
