// Operational helper: no network, no implicit permissions, no writes to input files.
const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.trim().length > 0;
const stable = (value) => JSON.stringify(Array.isArray(value) ? value.map(v => JSON.parse(stable(v))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value);
const unique = (values) => new Set(values).size === values.length;
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 1048576) fail('Input exceeds 1 MiB.'); chunks.push(chunk); }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!object(input)) fail('Expected a JSON object.');

  // Structural diff deliberately does not claim full OpenAPI semantic compatibility.
  const { before, after } = input;
  if (![before, after].every(v => object(v) && string(v.openapi) && object(v.paths))) fail('Two OpenAPI objects with paths are required.');
  const verbs = new Set(['get','put','post','delete','options','head','patch','trace']);
  const operations = doc => Object.entries(doc.paths).flatMap(([p,v]) => object(v) ? Object.keys(v).filter(k => verbs.has(k)).map(k => k.toUpperCase()+' '+p) : []).sort();
  const previous = operations(before), next = operations(after), changes = [];
  const pointer = key => key.replaceAll('~','~0').replaceAll('/','~1');
  function walk(a,b,location,depth=0) {
    if (depth > 50) fail('Document nesting exceeds supported depth.');
    if (stable(a) === stable(b)) return;
    if (object(a) && object(b)) { for (const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()) {
      const at=location+'/'+pointer(key);
      if (!Object.hasOwn(a,key)) changes.push({path:at,kind:'added',after:b[key]});
      else if (!Object.hasOwn(b,key)) changes.push({path:at,kind:'removed',before:a[key]});
      else walk(a[key],b[key],at,depth+1);
    }} else changes.push({path:location,kind:'changed',before:a,after:b});
  }
  walk(before,after,'');
  const result={operations:{added:next.filter(v=>!previous.includes(v)),removed:previous.filter(v=>!next.includes(v)),retained:next.filter(v=>previous.includes(v))},changes,semanticReviewRequired:true};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
