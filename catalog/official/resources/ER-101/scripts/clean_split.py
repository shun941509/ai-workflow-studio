"""Deterministic text cleanup with original UTF-8 ranges; no document parser or model is implied."""
from contracts import main, fail, integer, text, identifier, digest


def run(data):
    document = data.get('document', {})
    document_id = identifier(document.get('id'), 'document.id')
    revision = integer(document.get('revision'), 1, 1000000, 'revision')
    original = text(document.get('text'), 'document.text')
    limit = integer(data.get('maxCharacters'), 16, 20000, 'maxCharacters')
    overlap = integer(data.get('overlap', 0), 0, 1000, 'overlap')
    if overlap != 0: fail('OVERLAP_UNSUPPORTED', 'This coverage-preserving profile requires overlap=0.')
    # Each cleaned scalar retains the exact source byte interval that produced it.
    cleaned = []; spans = []; removed = []; offset = 0; cursor = 0
    while cursor < len(original):
        char = original[cursor]; width = len(char.encode('utf-8'))
        if cursor == 0 and char == '\ufeff':
            removed.append({'start': 0, 'end': width, 'reason': 'leading_bom'}); offset += width; cursor += 1; continue
        if char == '\r' and cursor + 1 < len(original) and original[cursor + 1] == '\n':
            cleaned.append('\n'); spans.append((offset, offset + width + 1)); offset += width + 1; cursor += 2; continue
        if ord(char) < 32 and char not in '\n\r\t':
            fail('CONTROL_CHARACTER', 'Binary control characters require a separate extraction decision.')
        cleaned.append(char); spans.append((offset, offset + width)); offset += width; cursor += 1
    value = ''.join(cleaned)
    if not value:
        fail('EMPTY_DOCUMENT', 'Cleanup produced no source text.')
    source_hash = digest(original.encode('utf-8')); cleaned_hash = digest(value.encode('utf-8'))
    chunks = []
    for start in range(0, len(value), limit):
        end = min(start + limit, len(value)); part = value[start:end]
        source_start, source_end = spans[start][0], spans[end - 1][1]
        chunks.append({'id': f'{document_id}-c{len(chunks) + 1}', 'documentId': document_id, 'revision': revision, 'text': part, 'sha256': digest(part.encode('utf-8')), 'cleanedCharacters': {'start': start, 'end': end}, 'originalBytes': {'start': source_start, 'end': source_end}, 'originalSha256': source_hash})
    if ''.join(chunk['text'] for chunk in chunks) != value or sum(len(chunk['text']) for chunk in chunks) != len(value):
        fail('COVERAGE_ERROR', 'Chunk coverage is inconsistent.')
    return {'documentId': document_id, 'originalSha256': source_hash, 'cleanedSha256': cleaned_hash, 'cleanedText': value, 'chunks': chunks, 'removed': removed, 'coverageComplete': True, 'overlap': 0, 'extractionPerformed': False}


if __name__ == '__main__':
    main(run)
