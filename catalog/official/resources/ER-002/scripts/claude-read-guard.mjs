/** Project-scoped PreToolUse guard: unknown/write names fail closed; allowed reads still ask the user. */
import {readFile} from 'node:fs/promises';
let decision='deny';
try { const parts=[]; let size=0; for await(const part of process.stdin){size+=part.length;if(size>1048576)throw new Error('limit');parts.push(part);} const input=JSON.parse(Buffer.concat(parts).toString('utf8')); const profile=JSON.parse(await readFile(new URL('../connection.json',import.meta.url),'utf8')); if(input.mcp_server?.source==='project' && input.mcp_server?.name==='studio_'+profile.service && profile.readTools.some(name=>input.tool_name==='mcp__studio_'+profile.service+'__'+name))decision='ask'; } catch {}
process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:decision,permissionDecisionReason:decision==='deny'?'이 연결 자료는 해당 도구를 허용하지 않습니다.':'대상·범위를 확인한 뒤 읽기를 승인하세요.'}})+'\n');
