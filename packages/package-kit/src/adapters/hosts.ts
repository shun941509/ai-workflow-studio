export type TargetHost = 'codex' | 'claude-code' | 'opencode';

/** Only an installed Bridge is referenced. Opening a host must never install a package or skip approval. */
export function createHostFiles(host: TargetHost): Record<string, string> {
  const instructions = '# AI Workflow Studio 프로젝트\n\n이 폴더의 workflow.json은 Studio Runner가 실행하는 설계입니다.\n사용자가 실행을 요청하면 studio.inspect_package와 studio.validate로 준비 상태를 확인한 뒤 studio.start를 호출하세요.\n실행 상태와 결과는 studio.status, studio.events, studio.results로 확인하세요.\n파일 열기만으로 작업을 시작하지 말고, 실패나 연결 필요 상태를 성공으로 바꾸지 마세요.\n키·승인 기록을 이 폴더에 저장하지 마세요. 변경 작업의 보안 승인은 Runner 화면에서 확인합니다.\n';
  const skill = '---\nname: studio-workflow\ndescription: Studio Runner로 이 프로젝트의 워크플로를 검사하고 사용자가 요청한 실행의 상태와 결과를 확인합니다.\n---\n\n' + instructions;
  if (host === 'codex') return { 'AGENTS.md': instructions, '.agents/skills/studio-workflow/SKILL.md': skill, '.codex/config.toml': '# 설치된 Studio Bridge만 연결합니다. 실행은 명시적인 요청 후 시작합니다.\n[mcp_servers.studio]\ncommand = "studio-bridge"\nargs = ["--stdio", "--package", "."]\n' };
  if (host === 'claude-code') return { 'CLAUDE.md': instructions, '.claude/skills/studio-workflow/SKILL.md': skill, '.mcp.json': JSON.stringify({ mcpServers: { studio: { type: 'stdio', command: 'studio-bridge', args: ['--stdio', '--package', '.'] } } }, null, 2) + '\n' };
  if (host === 'opencode') return { 'AGENTS.md': instructions, '.opencode/skills/studio-workflow/SKILL.md': skill, 'opencode.json': JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { studio: { type: 'local', command: ['studio-bridge', '--stdio', '--package', '.'], enabled: true } } }, null, 2) + '\n' };
  throw new Error('지원하지 않는 AI 도구입니다.');
}
