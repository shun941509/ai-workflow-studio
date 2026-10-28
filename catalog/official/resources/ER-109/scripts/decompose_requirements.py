"""Create traceable subquestions from explicit original spans and validate complete declared coverage."""
from contracts import main, fail, text, identifier, integer, digest


def run(data):
    question = text(data.get('question'), 'question', 10000); raw = question.encode('utf-8')
    requirements = data.get('requirements')
    if not isinstance(requirements, list) or not 1 <= len(requirements) <= 50: fail('REQUIREMENTS_REQUIRED', 'Declare 1..50 requirement spans from the actual original question.')
    inventory = {}
    for item in requirements:
        identity = identifier(item.get('id'), 'requirement.id')
        if identity in inventory: fail('DUPLICATE_ID', 'Requirement IDs must be unique.')
        start = integer(item.get('start'), 0, len(raw), 'start'); end = integer(item.get('end'), start+1, len(raw), 'end')
        try: quote = raw[start:end].decode('utf-8')
        except UnicodeDecodeError: fail('SOURCE_RANGE', 'Requirement span splits a Unicode scalar.')
        if quote != text(item.get('quote'), 'quote'): fail('REQUIREMENT_MISMATCH', 'Declared requirement differs from the original question.')
        inventory[identity] = {'id': identity, 'quote': quote, 'start': start, 'end': end}
    proposed = data.get('subquestions')
    if proposed is None: proposed = [{'id': 'q-'+identity, 'question': value['quote'], 'requirementIds': [identity], 'dependsOn': []} for identity, value in inventory.items()]
    if not isinstance(proposed, list) or not 1 <= len(proposed) <= 50: fail('SUBQUESTION_LIMIT', 'One to fifty subquestions are supported.')
    seen = set(); covered = set(); result = []
    for item in proposed:
        identity = identifier(item.get('id'), 'subquestion.id'); value = text(item.get('question'), 'subquestion.question', 4000)
        if identity in seen: fail('DUPLICATE_ID', 'Subquestion IDs must be unique.')
        refs = item.get('requirementIds'); dependencies = item.get('dependsOn')
        if not isinstance(refs, list) or not refs or any(ref not in inventory for ref in refs): fail('UNKNOWN_REQUIREMENT', 'Subquestion must map to actual declared requirements.')
        if not isinstance(dependencies, list) or len(set(dependencies)) != len(dependencies) or any(dep not in seen for dep in dependencies): fail('DEPENDENCY_ORDER', 'Dependencies must name unique earlier subquestions.')
        covered.update(refs); seen.add(identity)
        result.append({'id': identity, 'question': value, 'requirementIds': refs, 'dependsOn': dependencies, 'sourceRequirements': [inventory[ref] for ref in refs]})
    if covered != set(inventory): fail('REQUIREMENT_OMITTED', 'At least one declared original requirement has no subquestion.')
    return {'questionSha256': digest(raw), 'subquestions': result, 'declaredCoverageComplete': True, 'undeclaredRequirementReviewRequired': True, 'semanticCoverageVerified': False, 'executionStarted': False}


if __name__ == '__main__': main(run)
