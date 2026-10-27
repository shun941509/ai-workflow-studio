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

  // Literal-only copying preserves the input and avoids executing caller-supplied regular expressions.
  const {text,rules}=input;
  if(typeof text!=='string'||!Array.isArray(rules)||rules.some(r=>!object(r)||!string(r.id)||!string(r.type)||!string(r.literal))||!unique(rules.map(r=>r.id)))fail('Unique rules with nonempty literal values required.');
  const matches=[];
  for(const r of rules){let start=0;while((start=text.indexOf(r.literal,start))!==-1){if(matches.length>=10000)fail('Too many masking matches.');matches.push({start,endExclusive:start+r.literal.length,ruleId:r.id,type:r.type});start++;}}
  matches.sort((a,b)=>a.start-b.start||a.endExclusive-b.endExclusive);
  for(let i=1;i<matches.length;i++)if(matches[i].start<matches[i-1].endExclusive)fail('Overlapping literal rules require review.');
  let output='',cursor=0;for(const m of matches){output+=text.slice(cursor,m.start)+'[REDACTED]';cursor=m.endExclusive;}output+=text.slice(cursor);
  const result={text:output,audit:matches,unmatchedRuleIds:rules.filter(r=>!matches.some(m=>m.ruleId===r.id)).map(r=>r.id),manualReviewRequired:true};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
