"""Bounded HTTPS transport: secrets stay in headers, redirects/proxies/retries are disabled."""
import json
import os
import socket
import urllib.error
import urllib.request
from contracts import fail, pairs

ALLOWED = {'https://api.openai.com/v1/embeddings', 'https://api.cohere.com/v2/rerank'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def post_json(url, payload, key_name):
    """Only the caller's fixed endpoint can receive user-approved text and the environment secret."""
    if url not in ALLOWED: fail('ENDPOINT_DENIED', 'The provider endpoint is not allowed.')
    secret = os.environ.get(key_name, '')
    if not secret or len(secret) > 4096 or any(ord(ch) < 33 or ord(ch) > 126 for ch in secret):
        fail('CONNECTION_REQUIRED', 'Prepare the documented provider connection before execution.')
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode('utf-8')
    if len(encoded) > 1048576: fail('REQUEST_LIMIT', 'Provider request exceeds the local byte limit.')
    request = urllib.request.Request(url, data=encoded, headers={'Authorization': 'Bearer '+secret, 'Content-Type': 'application/json'}, method='POST')
    # Do not inherit a machine proxy or forward credentials to a redirect destination.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=20) as response:
            if response.status != 200: fail('PROVIDER_HTTP', 'Provider returned a non-success status.')
            raw = response.read(8388609)
            if len(raw) > 8388608: fail('RESPONSE_LIMIT', 'Provider response exceeds 8 MiB.')
    except urllib.error.HTTPError as error:
        if error.code == 429 or 500 <= error.code <= 599: fail('PROVIDER_TEMPORARY', 'Provider temporarily unavailable; no automatic retry was made.')
        fail('PROVIDER_HTTP', 'Provider rejected the request; response body is not logged.')
    except (urllib.error.URLError, TimeoutError, socket.timeout):
        fail('PROVIDER_TRANSPORT', 'Provider transport failed; billing may be uncertain and no retry was made.')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=lambda _: fail('PROVIDER_RESPONSE', 'Nonfinite provider value.'))
    except (ValueError, UnicodeDecodeError): fail('PROVIDER_RESPONSE', 'Provider response is not valid JSON.')
    if not isinstance(value, dict): fail('PROVIDER_RESPONSE', 'Provider response must be an object.')
    return value
