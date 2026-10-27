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

  // Missing evidence makes the total incomplete; required failures cannot be averaged away.
  const {sections,rubric,assessments}=input;
  if(!object(sections)||Object.values(sections).some(v=>typeof v!=='string')||!Array.isArray(rubric)||!rubric.length||rubric.some(r=>!object(r)||!string(r.id)||!Number.isFinite(r.weight)||r.weight<=0||typeof r.required!=='boolean')||!unique(rubric.map(r=>r.id))||!Array.isArray(assessments)||!unique(assessments.map(a=>a.id)))fail('Valid sections, unique weighted rubric and assessments required.');
  if(assessments.some(a=>!object(a)||!rubric.some(r=>r.id===a.id)||![0,.5,1].includes(a.score)))fail('Unknown or invalid assessment.');
  const issues=[],requiredFailures=[];let sum=0,weight=0;
  for(const r of rubric){const a=assessments.find(a=>a.id===r.id);weight+=r.weight;
    if(!a||!string(a.quote)||typeof sections[a.section]!=='string'||!sections[a.section].includes(a.quote)){issues.push({id:r.id,reason:'missing-assessment-or-source'});continue;}
    sum+=r.weight*a.score;if(r.required&&a.score!==1)requiredFailures.push(r.id);
  }
  if(!Number.isFinite(sum)||!Number.isFinite(weight))fail('Weights exceed finite range.');
  const result={complete:issues.length===0,scorePercent:issues.length?null:sum/weight*100,requiredFailures,issues,passesRequired:issues.length===0&&requiredFailures.length===0};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
