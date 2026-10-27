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

  // Dependency validation produces a plan, never starts agents or grants permissions.
  const {initialInputs,roles,tasks}=input;
  const names=v=>Array.isArray(v)&&v.every(string)&&unique(v);
  if(!names(initialInputs)||!names(roles)||!Array.isArray(tasks)||!tasks.length||tasks.some(t=>!object(t)||!string(t.id)||!roles.includes(t.role)||!names(t.dependsOn)||!names(t.inputs)||!names(t.outputs))||!unique(tasks.map(t=>t.id)))fail('Valid unique roles/tasks/inputs/outputs required.');
  const byId=new Map(tasks.map(t=>[t.id,t])),producer=new Map(initialInputs.map(k=>[k,null]));
  for(const t of tasks){if(t.dependsOn.some(id=>!byId.has(id)||id===t.id))fail('Unknown or self dependency.');for(const key of t.outputs){if(producer.has(key))fail('Output has multiple producers.');producer.set(key,t.id);}}
  const order=[],remaining=[...tasks],ancestors=new Map();
  while(remaining.length){const index=remaining.findIndex(t=>t.dependsOn.every(id=>order.includes(id)));if(index<0)fail('Dependency cycle.');const t=remaining.splice(index,1)[0],parents=new Set(t.dependsOn.flatMap(id=>[id,...ancestors.get(id)]));
    for(const key of t.inputs)if(!producer.has(key)||(producer.get(key)!==null&&!parents.has(producer.get(key))))fail('Input producer is missing or not an ancestor.');
    ancestors.set(t.id,parents);order.push(t.id);
  }
  const result={order,tasks:tasks.map(t=>({id:t.id,role:t.role,inputs:t.inputs,outputs:t.outputs})),executionStarted:false};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
