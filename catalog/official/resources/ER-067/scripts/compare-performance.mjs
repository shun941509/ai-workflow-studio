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

  // Reproducible descriptive statistics, not a significance test or causal conclusion.
  if(!string(input.unit))fail('Measurement unit required.');
  function stats(values){if(!Array.isArray(values)||!values.length||values.some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0))fail('Nonempty finite nonnegative samples required.');
    const sorted=[...values].sort((a,b)=>a-b),n=sorted.length;
    const mean=sorted.reduce((sum,v)=>sum+v/n,0),middle=Math.floor(n/2);
    const median=n%2?sorted[middle]:sorted[middle-1]/2+sorted[middle]/2;
    return {count:n,mean,median,p95:sorted[Math.ceil(.95*n)-1]};}
  const before=stats(input.before),after=stats(input.after);
  const changes=Object.fromEntries(['mean','median','p95'].map(k=>[k,{absolute:after[k]-before[k],percent:before[k]===0?null:(after[k]-before[k])/before[k]*100}]));
  if(Object.values(changes).some(v=>!Number.isFinite(v.absolute)||(v.percent!==null&&!Number.isFinite(v.percent))))fail('Calculation exceeds finite numeric range.');
  const result={unit:input.unit,before,after,changes,method:'nearest-rank-p95',causalClaim:false};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
