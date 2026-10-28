import { describe, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { buildMaterialsPackage, inspectPackage, verifyResources, type ResourceDescriptor } from '@studio/package-kit';
import type { ResourceRef } from '@studio/spec';
import type { OfficialCatalog } from '../../tooling/catalog/inventory.js';
import { checkCatalog } from '../../tooling/catalog/check.js';

const root = process.cwd(), ids = Array.from({ length: 10 }, (_, index) => `ER-${String(index+1).padStart(3,'0')}`);
const directory = (id: string) => path.join(root, 'catalog/official/resources', id);
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const catalog = JSON.parse(await readFile(path.join(root,'catalog/official/catalog.json'),'utf8')) as OfficialCatalog;
const readJson = async (id: string, file: string): Promise<any> => JSON.parse(await readFile(path.join(directory(id),file),'utf8'));
function invoke(id: string, input: unknown, helper = 'connection-plan.mjs') {
  return spawnSync(process.execPath,[path.join(directory(id),'scripts',helper)],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:10000});
}
function run(id: string, input: unknown): any { const output=invoke(id,input);expect(output.status,output.stderr).toBe(0);return JSON.parse(output.stdout); }
function reject(id: string, input: unknown, code: string) { const output=invoke(id,input);expect(output.status).toBe(1);expect(JSON.parse(output.stderr).error).toBe(code); }

describe('original MCP connection materials and conservative completion claims',()=>{
  test.each(ids)('%s preserves source brief, original hashes and three inactive host packages',async id=>{
    const entry=catalog.entries.find(value=>value.id===id)!;
    const descriptor=await readJson(id,'resource.json') as ResourceDescriptor, bytes=await readFile(path.join(directory(id),'resource.json'));
    const files:Record<string,Uint8Array>={[`resources/${id}/resource.json`]:bytes};
    for(const file of descriptor.files) files[`resources/${id}/${file.path}`]=await readFile(path.join(directory(id),file.path));
    const ref:ResourceRef={id,revision:1,kind:'mcp',sha256:hash(bytes)};
    expect(verifyResources({[id]:ref},new Map(Object.entries(files))).get(id)?.kind).toBe('mcp');
    const instructions=new TextDecoder().decode(files[`resources/${id}/instructions.md`]);
    for(const value of [entry.name,entry.definition.purpose,entry.definition.inputOutput,entry.definition.acceptanceCriteria])expect(instructions).toContain(value);
    expect(instructions.match(/^\d+\. /gm)).toHaveLength(5);
    const profile=await readJson(id,'connection.json'); expect(profile.actualHostVerification).toBe('unverified');
    expect(entry.verificationRecords).toEqual([]);
    if(['ER-001','ER-002','ER-009'].includes(id)){expect(entry.state).toBe('planned');expect(entry.artifact).toBeUndefined();expect(profile.blockers.length).toBeGreaterThan(0);}
    else expect(entry.state).toBe('implemented');
    for(const host of ['codex','claude-code','opencode'] as const){
      const built=await buildMaterialsPackage({host,refs:{[id]:ref},resources:files,name:entry.name});
      const inspected=await inspectPackage(built.bytes);expect(inspected.manifest.requiredConnections).toEqual(['service']);expect(inspected.manifest.compatibility.host.verification).toBe('unverified');
      const archive=unzipSync(built.bytes);for(const [name,original] of Object.entries(files))expect(hash(archive[name]!)).toBe(hash(original));
      expect(Object.keys(archive).some(name=>/(^|\/)(node_modules|fixtures|tests)(\/|$)|verification\.spec|\.env$/.test(name))).toBe(false);
      // Materials import must not silently install the external MCP config in the host's active config file.
      expect(archive['.codex/config.toml']).toBeUndefined();expect(archive['.mcp.json']).toBeUndefined();expect(archive['opencode.json']).toBeUndefined();
      for(const value of Object.values(archive))expect(new TextDecoder().decode(value)).not.toMatch(/ghp_[A-Za-z0-9]{20}|sk-[A-Za-z0-9]{20}|Bearer\s+[A-Za-z0-9_-]{20}|@playwright\/mcp@latest/);
    }
  });

  test.each(ids)('%s executes its real preparation path without an external call',async id=>{
    const result=run(id,await readJson(id,'references/example-input.json'));expect(result.executed).toBe(false);
    expect(result.status).toBe(id==='ER-009'?'blocked':['ER-008','ER-010'].includes(id)?'ready_for_explicit_public_read':'connection_required');
  });

  test('GitHub/Notion draft hashes bind content while mutation remains blocked regardless of a claimed approval',async()=>{
    for(const id of ['ER-001','ER-002']){
      const input={...await readJson(id,'references/example-input.json'),operation:'mutation-preview',title:'가상 변경 제안',body:'검토용 본문',approved:true};
      const first=run(id,input),second=run(id,{...input,body:'다른 본문'});
      expect(first).toMatchObject({status:'blocked',reason:'APPROVAL_BOUND_EXECUTION_UNIMPLEMENTED',approved:false,executed:false});expect(first.draftSha256).not.toBe(second.draftSha256);
    }
  });

  test('Supabase always pins one project and read-only SQL, rejects table and identifier injection',async()=>{
    const input=await readJson('ER-006','references/example-input.json'),result=run('ER-006',input),url=new URL(result.endpoint);
    expect(url.searchParams.get('project_ref')).toBe(input.projectRef);expect(url.searchParams.get('read_only')).toBe('true');expect(url.searchParams.get('features')).toBe('database');
    expect(result.query.sql).toBe('SELECT "id", "title" FROM "public"."handbook" LIMIT 20');
    reject('ER-006',{...input,table:'handbook;DELETE'},'INVALID_SCOPE');reject('ER-006',{...input,allowedTables:[]},'TABLE_SCOPE');reject('ER-006',{...input,columns:['pg_read_file(secret)']},'INVALID_SCOPE');reject('ER-006',{...input,limit:101},'ROW_LIMIT');
    expect(run('ER-006',{...input,endpoint:'https://evil.invalid/mcp'}).endpoint).toBe(result.endpoint);
  });

  test('service scopes reject foreign Jira keys, reversed time ranges and unapproved navigation',async()=>{
    const jira=await readJson('ER-003','references/example-input.json');reject('ER-003',{...jira,issueKey:'OTHER-4'},'PROJECT_SCOPE');
    const linear=await readJson('ER-004','references/example-input.json');reject('ER-004',{...linear,until:linear.from},'TIME_RANGE');
    const figma=await readJson('ER-005','references/example-input.json');reject('ER-005',{...figma,nodeId:'../12'},'INVALID_SCOPE');
    const browser=await readJson('ER-009','references/example-input.json');reject('ER-009',{...browser,url:'https://unapproved.invalid/'},'URL_SCOPE');
    expect(run('ER-009',browser).reason).toBe('OS_AND_EGRESS_ISOLATION_UNIMPLEMENTED');
  });

  test('fact comparison checks required fields, exact scope and official source without claiming source authenticity',async()=>{
    const request=await readJson('ER-004','references/example-input.json');
    const original=[{id:'issue1',scope:request.teamId,sourceUrl:'https://linear.app/fictional/issue/DEMO-1',fields:{teamId:request.teamId,assigneeId:null,dueDate:'2026-10-31',stateId:'state-open'}}];
    const result=run('ER-004',{operation:'compare',request,original,observed:original});expect(result).toMatchObject({comparedRows:1,snapshotEquality:true,sourceAuthenticityVerified:false});
    const changed=structuredClone(original);changed[0]!.fields.stateId='state-done';reject('ER-004',{operation:'compare',request,original,observed:changed},'FIELD_MISMATCH');
    reject('ER-004',{operation:'compare',request,original,observed:[{...original[0],scope:'other'}]},'OBSERVATION_SCOPE');
    const forged=[{...original[0],sourceUrl:'https://linear.app.evil.invalid/issue'}];reject('ER-004',{operation:'compare',request,original:forged,observed:forged},'SOURCE_HOST');
  });

  test('tool audit denies unknown/write names and contradictory read annotations',async()=>{
    const result=run('ER-005',{operation:'audit-tools',tools:[{name:'get_metadata',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'use_figma',inputSchema:{type:'object'}},{name:'new_unreviewed_tool',inputSchema:{type:'object'}},{name:'get_screenshot',inputSchema:{type:'object'},annotations:{readOnlyHint:false}}]});
    expect(result.accepted).toEqual(['get_metadata']);expect(result.denied).toEqual(['use_figma','new_unreviewed_tool','get_screenshot']);expect(result.annotationsAreNotAuthorization).toBe(true);
  });

  test('actual Claude guard asks only for known reads from the configured project and denies writes or spoofed provenance',()=>{
    const call=(tool:string,source='project')=>{
      const result=invoke('ER-005',{tool_name:'mcp__studio_figma__'+tool,mcp_server:{name:'studio_figma',source}},'claude-read-guard.mjs');expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
    };
    expect(call('get_metadata')).toBe('ask');expect(call('use_figma')).toBe('deny');expect(call('new_tool')).toBe('deny');expect(call('get_metadata','plugin')).toBe('deny');
    expect(JSON.parse(invoke('ER-005',{tool_name:'mcp__studio_figma__get_metadata'},'claude-read-guard.mjs').stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  test('catalogue still excludes partial original requirements and lacks all actual-use/publication evidence',async()=>{
    const report=await checkCatalog(catalog,{root});expect(report.issues).toEqual([]);expect(report.counts.usableResources).toBe(0);expect(report.counts.publishedResources).toBe(0);expect(report.counts.verifiedHostCombinations).toBe(0);expect(report.releaseReady).toBe(false);
    expect(ids.filter(id=>catalog.entries.find(item=>item.id===id)?.state==='implemented')).toHaveLength(7);
  });

  test('a planned partial folder is still immutable to the initial materializer',async()=>{
    const original=hash(await readFile(path.join(directory('ER-009'),'resource.json')));
    const result=spawnSync(process.execPath,['--import','tsx','tooling/catalog/materialize-mcp-resources.ts','ER-009'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
    expect(result.status).toBe(1);expect(result.stderr).toContain('refusing to overwrite sealed content');expect(hash(await readFile(path.join(directory('ER-009'),'resource.json')))).toBe(original);
  });
});

describe('anonymous documentation MCP protocol boundaries',()=>{
  // Test-only remote transport responses exercise actual shipped HTTP/SSE code; no fake response is included in the resource.
  async function withServer(action:(reader:any,calls:any[])=>Promise<void>,options:{sse?:boolean;mutate?:(message:any,result:any)=>any}={}){
    const calls:any[]=[];
    vi.stubGlobal('fetch',vi.fn(async (_url:string,init:any)=>{
      const message=JSON.parse(init.body);calls.push(message);expect(init.redirect).toBe('error');expect(init.headers.Accept).toBe('application/json, text/event-stream');
      if(message.method==='notifications/initialized')return new Response(null,{status:202});
      let result:any=message.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'test-only',version:'1'}}:message.method==='tools/list'?{tools:[{name:'microsoft_docs_search',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']}},{name:'microsoft_docs_fetch',inputSchema:{type:'object',properties:{url:{type:'string'}},required:['url']}}]}:{content:[{type:'text',text:'Internal test response; never distributed.'}]};
      if(options.mutate)result=options.mutate(message,result);
      const payload=JSON.stringify({jsonrpc:'2.0',id:message.id,result});
      return new Response(options.sse?'event: message\ndata: '+payload+'\n\n':payload,{headers:{'Content-Type':options.sse?'text/event-stream':'application/json','Mcp-Session-Id':'test-session'}});
    }));
    try{const reader=await import(pathToFileURL(path.join(directory('ER-008'),'scripts/public-docs.mjs')).href);await action(reader,calls);}finally{vi.unstubAllGlobals();}
  }
  test.each([false,true])('initializes, lists then reads through actual JSON/SSE transport (SSE=%s)',async sse=>{
    await withServer(async(reader,calls)=>{const result=await reader.readDocumentation({operation:'read',tool:'microsoft_docs_search',arguments:{query:'Azure Functions'}},'learn');expect(result.hostVerification).toBe('unverified');expect(calls.map(row=>row.method)).toEqual(['initialize','notifications/initialized','tools/list','tools/call']);expect(calls[3].params.arguments).toEqual({query:'Azure Functions'});},{sse});
  });
  test('blocks unknown writes before network and rejects foreign URLs or changed request schema',async()=>{
    await withServer(async(reader,calls)=>{await expect(reader.readDocumentation({operation:'read',tool:'delete_all',arguments:{}},'learn')).rejects.toThrow('READ_TOOL_REQUIRED');expect(calls).toHaveLength(0);await expect(reader.readDocumentation({operation:'read',tool:'microsoft_docs_fetch',arguments:{url:'https://learn.microsoft.com.evil.invalid/x'}},'learn')).rejects.toThrow('SOURCE_URL_DENIED');expect(calls.some(row=>row.method==='tools/call')).toBe(false);});
    await withServer(async(reader,calls)=>{await expect(reader.readDocumentation({operation:'read',tool:'microsoft_docs_search',arguments:{query:'x'}},'learn')).rejects.toThrow('SCHEMA_CHANGED');expect(calls.some(row=>row.method==='tools/call')).toBe(false);},{mutate:(message,result)=>message.method==='tools/list'?{tools:[{name:'microsoft_docs_search',inputSchema:{type:'object',properties:{secret:{type:'string'}},required:['secret']}}]}:result});
  });
  test('rejects provider tool errors and protocol revisions that have not been implemented',async()=>{
    await withServer(async reader=>{await expect(reader.readDocumentation({operation:'read',tool:'microsoft_docs_search',arguments:{query:'x'}},'learn')).rejects.toThrow('TOOL_FAILED');},{mutate:(message,result)=>message.method==='tools/call'?{isError:true,content:[]}:result});
    await withServer(async reader=>{await expect(reader.readDocumentation({operation:'list'},'learn')).rejects.toThrow('PROTOCOL_UNSUPPORTED');},{mutate:(message,result)=>message.method==='initialize'?{protocolVersion:'future'}:result});
  });
});
