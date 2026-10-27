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

  // Offsets are UTF-16 string indices, never PDF/image coordinates.
  const {pages,citations}=input;
  if(!Array.isArray(pages)||pages.some(p=>!object(p)||!Number.isInteger(p.page)||p.page<1||typeof p.text!=='string')||!unique(pages.map(p=>p.page))||!Array.isArray(citations)||citations.some(c=>!object(c)||!string(c.id)||!string(c.quote))||!unique(citations.map(c=>c.id)))fail('Unique pages and nonempty citation IDs/quotes required.');
  let matchCount=0;
  const results=citations.map(c=>{const matches=[];for(const p of pages){let start=0;while((start=p.text.indexOf(c.quote,start))!==-1){if(++matchCount>10000)fail('Too many citation matches.');matches.push({page:p.page,start,endExclusive:start+c.quote.length});start++;}}
    return{id:c.id,status:matches.length===0?'unverified':matches.length===1?'located':'ambiguous',matches};});
  const result={coordinateUnit:'utf16-code-unit',citations:results};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
