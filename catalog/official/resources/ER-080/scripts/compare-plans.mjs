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

  // ID-based comparison cannot detect a completed action renamed to a new ID; retain human review.
  const {before,after}=input;
  for(const plan of [before,after])if(!object(plan)||!Array.isArray(plan.permissions)||plan.permissions.some(p=>!string(p))||!unique(plan.permissions)||!Array.isArray(plan.tasks)||plan.tasks.some(t=>!object(t)||!string(t.id)||!string(t.action)||!['pending','completed','failed','outcome-unknown'].includes(t.status)||(t.status==='completed'&&!/^[a-f0-9]{64}$/.test(t.resultSha256??'')))||!unique(plan.tasks.map(t=>t.id)))fail('Unique task IDs, valid status and completed hashes required.');
  const changes=[],blocking=[],preservedCompleted=[];
  for(const old of before.tasks){const next=after.tasks.find(t=>t.id===old.id);
    if(old.status==='completed'){if(!next||stable(old)!==stable(next))blocking.push({id:old.id,reason:'completed-task-changed-or-removed'});else preservedCompleted.push(old.id);}
    if(old.status==='outcome-unknown'&&(!next||stable(old)!==stable(next)))blocking.push({id:old.id,reason:'external-outcome-must-be-reconciled'});
    if(!next)changes.push({id:old.id,kind:'removed',before:old});else if(stable(old)!==stable(next))changes.push({id:old.id,kind:'changed',before:old,after:next});
  }
  for(const next of after.tasks)if(!before.tasks.some(t=>t.id===next.id))changes.push({id:next.id,kind:'added',after:next});
  const permissionAdditions=after.permissions.filter(p=>!before.permissions.includes(p));
  const result={changes,preservedCompleted,blocking,permissionAdditions,requiresApproval:permissionAdditions.length>0,executionStarted:false};

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) { process.stderr.write('Invalid or unsupported input: ' + (error instanceof Error ? error.message : 'unknown error') + '\n'); process.exitCode = 1; }
