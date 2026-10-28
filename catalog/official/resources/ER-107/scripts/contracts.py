"""Strict bounded JSON protocol shared by these independent original RAG helpers."""
import hashlib
import json
import re
import sys

class ContractError(Exception):
    def __init__(self, code, message): self.code = code; super().__init__(message)
def fail(code, message): raise ContractError(code, message)
def integer(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum: fail('INVALID_INTEGER', name+' must be a bounded integer.')
    return value
def text(value, name, maximum=1048576):
    if not isinstance(value, str) or not 1 <= len(value) <= maximum: fail('INVALID_TEXT', name+' must be nonempty bounded text.')
    try: value.encode('utf-8')
    except UnicodeEncodeError: fail('INVALID_UNICODE', 'Source contains an unpaired surrogate.')
    return value
def identifier(value, name):
    text(value, name, 128)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', value): fail('INVALID_ID', name+' must be an explicit identifier.')
    return value
def digest(value): return hashlib.sha256(value).hexdigest()
def pairs(items):
    result = {}
    for key,value in items:
        if key in result: fail('DUPLICATE_KEY', 'Duplicate JSON object keys are forbidden.')
        result[key] = value
    return result
def source_span(source, expected):
    if not isinstance(source, dict): fail('SOURCE_REQUIRED', 'Actual original text and UTF-8 byte range are required.')
    identity = identifier(source.get('documentId'), 'documentId'); revision = integer(source.get('revision'), 1, 1000000, 'revision')
    original = text(source.get('text'), 'source.text').encode('utf-8')
    start = integer(source.get('start'), 0, len(original), 'start'); end = integer(source.get('end'), start+1, len(original), 'end')
    try: value = original[start:end].decode('utf-8')
    except UnicodeDecodeError: fail('SOURCE_RANGE', 'Source byte range splits a Unicode scalar.')
    if value != text(expected, 'chunk.text'): fail('SOURCE_MISMATCH', 'Chunk differs from its actual source byte range.')
    ref = {'documentId': identity, 'revision': revision, 'sha256': digest(original), 'encoding': 'utf8', 'start': start, 'end': end}
    if 'page' in source: ref['page'] = integer(source['page'], 1, 1000000, 'page')
    return value,ref
def main(operation):
    try:
        raw = sys.stdin.buffer.read(1048577)
        if len(raw)>1048576: fail('INPUT_LIMIT', 'Input exceeds 1 MiB.')
        data = json.loads(raw.decode('utf-8-sig'), object_pairs_hook=pairs, parse_constant=lambda _: fail('INVALID_NUMBER', 'Nonfinite JSON numbers are forbidden.'))
        if not isinstance(data, dict): fail('INPUT_CONTRACT', 'A JSON object is required.')
        result = operation(data)
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, allow_nan=False)+'\n').encode('utf-8'))
    except ContractError as error:
        sys.stderr.write(json.dumps({'error':error.code,'message':str(error)})+'\n'); raise SystemExit(1)
    except Exception:
        sys.stderr.write(json.dumps({'error':'INVALID_INPUT','message':'Input does not match the documented contract.'})+'\n'); raise SystemExit(1)
