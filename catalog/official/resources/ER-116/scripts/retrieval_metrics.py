"""Macro Recall@k, MRR@k and graded nDCG@k from explicit relevance judgments and actual rankings."""
import math
from contracts import main, fail, identifier, integer


def run(data):
    k = integer(data.get('k'), 1, 1000, 'k'); queries = data.get('queries')
    if not isinstance(queries, list) or not 1 <= len(queries) <= 1000: fail('QUERY_LIMIT', 'Provide 1..1000 evaluated queries.')
    rows = []; seen = set()
    for query in queries:
        identity = identifier(query.get('id'), 'query.id')
        if identity in seen: fail('DUPLICATE_QUERY', 'Query IDs must be unique.')
        seen.add(identity); judgments = query.get('judgments'); ranking = query.get('ranking')
        if not isinstance(judgments, dict) or not judgments or not isinstance(ranking, list) or len(ranking) > 10000: fail('JUDGMENTS_REQUIRED', 'Explicit relevance judgments and ranking are required.')
        grades = {identifier(key, 'judgment.id'): integer(value, 0, 5, 'grade') for key, value in judgments.items()}
        ranked = [identifier(item, 'ranking.id') for item in ranking]
        if len(set(ranked)) != len(ranked): fail('DUPLICATE_RESULT', 'Deduplicate results before measuring retrieval.')
        if any(item not in grades for item in ranked): fail('UNJUDGED_RESULT', 'Do not silently treat an unjudged result as irrelevant.')
        relevant = {key for key, grade in grades.items() if grade > 0}
        if not relevant:
            rows.append({'id': identity, 'status': 'excluded_no_relevant_judgment', 'recall': None, 'reciprocalRank': None, 'ndcg': None}); continue
        selected = ranked[:k]; found = [index for index, item in enumerate(selected, 1) if item in relevant]
        dcg = sum((2 ** grades[item] - 1) / math.log2(index + 1) for index, item in enumerate(selected, 1))
        ideal = sum((2 ** grade - 1) / math.log2(index + 1) for index, grade in enumerate(sorted(grades.values(), reverse=True)[:k], 1))
        rows.append({'id': identity, 'status': 'evaluated', 'recall': len(found) / len(relevant), 'reciprocalRank': 1 / found[0] if found else 0, 'ndcg': dcg / ideal})
    valid = [item for item in rows if item['status'] == 'evaluated']
    means = {key: sum(item[key] for item in valid) / len(valid) if valid else None for key in ['recall', 'reciprocalRank', 'ndcg']}
    return {'k': k, 'aggregation': 'macro_over_queries_with_positive_judgments', 'perQuery': rows, 'evaluatedQueries': len(valid), 'excludedQueries': len(rows) - len(valid), 'means': means, 'judgmentQualityVerified': False}


if __name__ == '__main__':
    main(run)
