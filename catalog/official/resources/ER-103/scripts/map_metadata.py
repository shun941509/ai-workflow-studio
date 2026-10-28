"""Validate explicit access metadata and source ranges before constructing index records."""
from datetime import datetime, timezone
from contracts import main, fail, text, identifier, integer, source_span


def run(data):
    aliases = data.get('categoryAliases'); records = data.get('chunks')
    if not isinstance(aliases, dict) or not isinstance(records, list) or not 1 <= len(records) <= 1000: fail('INPUT_CONTRACT', 'Provide categoryAliases and 1..1000 chunks.')
    result = []; seen = set()
    for chunk in records:
        if not isinstance(chunk, dict): fail('CHUNK_CONTRACT', 'Each chunk must be an object.')
        identity = identifier(chunk.get('id'), 'chunk.id')
        if identity in seen: fail('DUPLICATE_ID', 'Chunk IDs must be unique.')
        seen.add(identity); value, source = source_span(chunk.get('source'), chunk.get('text'))
        metadata = chunk.get('metadata', {}); access = metadata.get('access')
        if not isinstance(access, dict) or set(access) != {'tenantId', 'projectId', 'subjects', 'groups'}: fail('ACCESS_REQUIRED', 'An explicit closed access scope is required for every chunk.')
        tenant = identifier(access['tenantId'], 'tenantId'); project = identifier(access['projectId'], 'projectId')
        scopes = {}
        for key in ['subjects', 'groups']:
            values = access[key]
            if not isinstance(values, list) or len(values) > 1000: fail('ACCESS_REQUIRED', 'Subject/group lists must be explicit.')
            scopes[key] = sorted(set(identifier(item, key) for item in values))
        if not scopes['subjects'] and not scopes['groups']: fail('ACCESS_REQUIRED', 'This private profile refuses an empty allowlist.')
        category = text(metadata.get('category'), 'category', 200)
        if category not in aliases: fail('UNKNOWN_CATEGORY', 'Declare a category mapping before indexing.')
        normalized_category = identifier(aliases[category], 'mapped category')
        try: published = datetime.fromisoformat(text(metadata.get('publishedAt'), 'publishedAt', 100).replace('Z', '+00:00'))
        except ValueError: fail('DATE_INVALID', 'Use an ISO date-time with an explicit offset.')
        if published.tzinfo is None or published.utcoffset() is None: fail('DATE_TIMEZONE_REQUIRED', 'A timezone is required.')
        result.append({'id': identity, 'text': value, 'source': source, 'category': normalized_category, 'publishedAt': published.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'), 'access': {'tenantId': tenant, 'projectId': project, **scopes}})
    return {'records': result, 'authorizationEnforced': False, 'scopeMetadataValidated': True, 'nextRequirement': 'Apply the trusted current ACL at every index read and retrieval.'}


if __name__ == '__main__':
    main(run)
