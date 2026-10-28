"""Preserve Markdown ATX hierarchy and indivisible pipe-table/fenced blocks with byte offsets."""
import re
from contracts import main, fail, integer, text, identifier, digest


def run(data):
    source = text(data.get('text'), 'text'); document_id = identifier(data.get('documentId'), 'documentId')
    maximum = integer(data.get('maxCharacters'), 32, 20000, 'maxCharacters')
    lines = source.splitlines(keepends=True); blocks = []; position = 0; headings = []; index = 0
    while index < len(lines):
        start_index = index; line = lines[index]; heading = re.match(r'^(#{1,6})[ \t]+(.+?)\s*$', line)
        fence = re.match(r'^(`{3,}|~{3,})', line)
        if heading:
            level = len(heading.group(1)); title = heading.group(2).strip()
            headings = [item for item in headings if item['level'] < level] + [{'level': level, 'title': title}]
            kind = 'heading'; index += 1
        elif fence:
            kind = 'code'; index += 1; marker = fence.group(1)
            while index < len(lines) and not re.match(r'^' + re.escape(marker[0]) + '{' + str(len(marker)) + r',}\s*$', lines[index]): index += 1
            if index == len(lines): fail('UNCLOSED_FENCE', 'Close the fenced block before splitting.')
            index += 1
        elif '|' in line and index + 1 < len(lines) and re.fullmatch(r'[ |:\-\t\r\n]+', lines[index + 1]) and '-' in lines[index + 1]:
            kind = 'table'; index += 2
            while index < len(lines) and '|' in lines[index] and lines[index].strip(): index += 1
        else:
            kind = 'paragraph'; index += 1
            while index < len(lines) and lines[index].strip() and not re.match(r'^(#{1,6})[ \t]|^(`{3,}|~{3,})', lines[index]):
                if '|' in lines[index] and index + 1 < len(lines) and re.fullmatch(r'[ |:\-\t\r\n]+', lines[index + 1]) and '-' in lines[index + 1]: break
                index += 1
        value = ''.join(lines[start_index:index]); byte_length = len(value.encode('utf-8'))
        if len(value) > maximum: fail('BLOCK_TOO_LARGE', 'An indivisible block exceeds maxCharacters; increase the reviewed bound.')
        blocks.append({'id': f'{document_id}-b{len(blocks)+1}', 'kind': kind, 'text': value, 'headingPath': [dict(item) for item in headings], 'source': {'documentId': document_id, 'sha256': digest(source.encode('utf-8')), 'encoding': 'utf8', 'start': position, 'end': position + byte_length}})
        position += byte_length
    if ''.join(block['text'] for block in blocks) != source: fail('COVERAGE_ERROR', 'Structure parsing changed the source.')
    return {'profile': 'markdown-atx-pipe-fence-v1', 'chunks': blocks, 'coverageComplete': True, 'tablesSplit': False}


if __name__ == '__main__':
    main(run)
