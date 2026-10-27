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

  // Invalid physical lines stay visible; raw log messages are intentionally not copied.
  if (!string(input.sourceId) || typeof input.text!=='string') fail('sourceId and text required.');
  const lines=input.text.split(/\r?\n/); if(lines.at(-1)==='')lines.pop();
  const groups=new Map(), errors=[]; let normalCount=0;
  lines.forEach((line,index)=>{let row;try{row=JSON.parse(line);}catch{errors.push({line:index+1,reason:'invalid-json'});return;}
    if(!object(row)||!string(row.timestamp)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(row.timestamp)||!Number.isFinite(Date.parse(row.timestamp))||!['info','warn','error','debug'].includes(row.level)||!string(row.code)){errors.push({line:index+1,reason:'invalid-fields'});return;}
    if(!['warn','error'].includes(row.level)){normalCount++;return;}
    const key=JSON.stringify([row.level,row.code]);if(!groups.has(key))groups.set(key,{level:row.level,code:row.code,count:0,lines:[],timestamps:[]});
    const group=groups.get(key);group.count++;group.lines.push(index+1);group.timestamps.push(row.timestamp);
  });
  const result={sourceId:input.sourceId,physicalLines:lines.length,normalCount,groups:[...groups.values()],errors};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
