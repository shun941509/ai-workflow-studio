"""Adversarial test probe: touches only verifier-created canaries; never shipped as a user Skill."""
import json
import os
import sys
import time

request_path = sys.argv[1]
root = os.path.dirname(os.path.dirname(request_path))
output = os.path.join(root, 'output')
with open(request_path, encoding='utf-8') as stream:
    request = json.load(stream)


def save(value):
    """Write a bounded observable report before stressing the job; do not fabricate successful results."""
    with open(os.path.join(output, 'worker-report.json'), 'w', encoding='utf-8') as stream:
        json.dump(value, stream)


def read(relative):
    with open(os.path.join(root, relative), encoding='utf-8') as stream:
        return stream.read()


def write(relative, content):
    with open(os.path.join(root, relative), 'w', encoding='utf-8') as stream:
        stream.write(content)
    return 'written'


def attempt(operation):
    """Retain actual OS error codes, never convert a timeout or missing file into an access denial."""
    try:
        return {'allowed': True, 'value': operation()}
    except Exception as error:
        return {'allowed': False, 'type': type(error).__name__, 'winerror': getattr(error, 'winerror', None), 'errno': getattr(error, 'errno', None)}


mode = request['mode']
if mode == 'timeout':
    save({'started': True})
    time.sleep(60)
    save({'escapedTimeout': True})
elif mode == 'cpu':
    save({'started': True})
    while True:
        pass
elif mode == 'memory':
    buffers = []
    for index in range(40):
        save({'allocatedMiB': index * 8})
        try:
            buffers.append(bytearray(8 * 1024 * 1024))
        except MemoryError:
            save({'memoryDenied': True, 'allocatedMiB': index * 8})
            sys.exit(0)
    save({'escapedMemoryLimit': True})
else:
    result = {
        'python': sys.version.split()[0],
        'isolated': sys.flags.isolated,
        'ignoreEnvironment': sys.flags.ignore_environment,
        'noSite': sys.flags.no_site,
        'safePath': sys.flags.safe_path,
        'searchPaths': sys.path,
        'envKeys': sorted(os.environ),
        'input': attempt(lambda: read('input/allowed.txt')),
        'output': attempt(lambda: write('output/allowed.txt', 'python sandbox output')),
        'inputWrite': attempt(lambda: write('input/allowed.txt', 'unwanted change')),
        'outsideRead': attempt(lambda: read('outside/private.txt')),
        'outsideWrite': attempt(lambda: write('outside/new.txt', 'unwanted change')),
        'allAppPackagesRead': attempt(lambda: read('aap-canary/readable-by-appcontainers.txt')),
    }
    # subprocess import does not itself initialize Winsock. A real child creation is required.
    def child():
        import subprocess
        completed = subprocess.run([sys.executable, '-I', '-S', '-c', 'raise SystemExit(0)'], shell=False, capture_output=True, timeout=2)
        return completed.returncode
    result['child'] = attempt(child)

    # Observe startup and connect separately: socket import failure is not proof of network isolation.
    try:
        import socket
        result['networkStartup'] = {'allowed': True}
        def connect():
            with socket.create_connection(('127.0.0.1', request['port']), timeout=2):
                return 'connected'
        result['networkConnect'] = attempt(connect)
    except Exception as error:
        result['networkStartup'] = {'allowed': False, 'type': type(error).__name__, 'winerror': getattr(error, 'winerror', None), 'message': str(error)[:300]}
        result['networkConnect'] = {'status': 'not-reached'}
    save(result)
