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

  // Existence and type checks cannot prove that a quotation semantically supports a value.
  const {fields,sources,records,evidence}=input;
  if(!object(fields)||!Object.keys(fields).length||!Array.isArray(sources)||!Array.isArray(records)||!Array.isArray(evidence)||evidence.length!==records.length)fail('fields, sources, records and matching evidence required.');
  if(sources.some(s=>!object(s)||!string(s.id)||typeof s.text!=='string')||!unique(sources.map(s=>s.id)))fail('Unique source IDs required.');
  for(const spec of Object.values(fields))if(!object(spec)||!['string','number','integer','boolean'].includes(spec.type)||typeof spec.required!=='boolean'||(spec.nullable!==undefined&&typeof spec.nullable!=='boolean'))fail('Unsupported field contract.');
  const sourceMap=new Map(sources.map(s=>[s.id,s.text])),issues=[];
  records.forEach((record,index)=>{if(!object(record)||!object(evidence[index]))fail('Record and evidence objects required.');
    for(const key of Object.keys(record))if(!Object.hasOwn(fields,key))issues.push({index,field:key,reason:'unknown-field'});
    for(const [key,spec]of Object.entries(fields)){
      if(!Object.hasOwn(record,key)){if(spec.required)issues.push({index,field:key,reason:'required'});continue;}
      const v=record[key];if(v===null&&spec.nullable)continue;
      const valid=spec.type==='integer'?Number.isSafeInteger(v):spec.type==='number'?typeof v==='number'&&Number.isFinite(v):typeof v===spec.type;
      if(!valid)issues.push({index,field:key,reason:'type'});
      const proof=evidence[index][key],source=proof&&sourceMap.get(proof.sourceId);
      if(!object(proof)||!string(proof.quote)||typeof source!=='string'||!source.includes(proof.quote))issues.push({index,field:key,reason:'missing-or-invalid-quote'});
    }
  });
  const result={valid:issues.length===0,issues,semanticReviewRequired:true};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
