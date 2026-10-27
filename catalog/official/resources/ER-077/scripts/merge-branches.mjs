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

  // Stable expected order and all provenance are retained, including failed/missing branches.
  const {expectedBranchIds,branches}=input;
  if(!Array.isArray(expectedBranchIds)||!expectedBranchIds.length||expectedBranchIds.some(id=>!string(id))||!unique(expectedBranchIds)||!Array.isArray(branches)||branches.some(b=>!object(b)||!expectedBranchIds.includes(b.id)||!['completed','failed'].includes(b.status))||!unique(branches.map(b=>b.id)))fail('Unique expected and actual branches required.');
  const items=new Map(),states=[];
  for(const id of expectedBranchIds){const b=branches.find(b=>b.id===id);if(!b||b.status==='failed'){states.push({id,status:b?'failed':'missing'});continue;}
    states.push({id,status:'completed'});if(!Array.isArray(b.items)||b.items.some(i=>!object(i)||!string(i.key)||!Object.hasOwn(i,'value')||!string(i.evidence)))fail('Completed items require key, value and evidence.');
    for(const i of b.items){if(!items.has(i.key))items.set(i.key,[]);const variants=items.get(i.key),v=variants.find(v=>stable(v.value)===stable(i.value));if(v)v.sources.push({branchId:id,evidence:i.evidence});else variants.push({value:i.value,sources:[{branchId:id,evidence:i.evidence}]});}
  }
  const result={states,partial:states.some(s=>s.status!=='completed'),items:[...items].map(([key,variants])=>({key,conflict:variants.length>1,variants}))};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
