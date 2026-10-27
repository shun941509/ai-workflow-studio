import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import ts from 'typescript';

export interface BoundarySource { path: string; text: string }
interface Edge { target: string; runtime: boolean }
interface Module { path: string; client: boolean; server: boolean; edges: Edge[]; dynamic: boolean }
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const native = (name: string) => name.startsWith('node:') || builtins.has(name);
const asset = (name: string) => /\.(?:json|css|svg|png|jpe?g|woff2?)$/.test(name);

/** Parse actual import/export syntax; comments and type-only references cannot fake a runtime dependency. */
function parse(source: BoundarySource): Module {
  const ast = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
  const directives = ast.statements.filter(ts.isExpressionStatement).filter(statement => ts.isStringLiteral(statement.expression)).map(statement => (statement.expression as ts.StringLiteral).text);
  const module: Module = { path: source.path, client: directives.includes('use client'), server: directives.includes('use server'), edges: [], dynamic: false };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause; const bindings = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || !clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every(item => item.isTypeOnly);
      module.edges.push({ target: node.moduleSpecifier.text, runtime: !onlyTypes });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const onlyTypes = node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly);
      module.edges.push({ target: node.moduleSpecifier.text, runtime: !onlyTypes });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      if (node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) module.edges.push({ target: node.arguments[0]!.text, runtime: true });
      else module.dynamic = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast); module.server ||= module.edges.some(edge => edge.target === 'server-only' && edge.runtime); return module;
}

/** Trace local/workspace dependencies, including barrels and dynamic literals, before producing client bundles. */
export function findBoundaryViolations(sources: readonly BoundarySource[], workspaceExports: Readonly<Record<string, string>>): string[] {
  const modules = new Map(sources.map(source => [source.path, parse(source)])); const violations = new Set<string>();
  const resolve = (from: string, target: string): string | undefined => {
    const raw = target.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), target)) : workspaceExports[target];
    if (!raw) return undefined;
    const extensionless = raw.replace(/\.(?:[cm]?js|jsx)$/, '');
    return [raw, `${extensionless}.ts`, `${extensionless}.tsx`, `${extensionless}.mts`, `${extensionless}/index.ts`, `${extensionless}/index.tsx`].find(candidate => modules.has(candidate));
  };
  // App boundaries apply to type-only references too: one app never depends on another app's internals.
  for (const module of modules.values()) for (const edge of module.edges) {
    const destination = resolve(module.path, edge.target);
    if (module.path.startsWith('apps/') && destination?.startsWith('apps/') && module.path.split('/')[1] !== destination.split('/')[1]) violations.add(`${module.path}: imports another app: ${edge.target}`);
  }
  for (const origin of modules.values()) {
    const pure = /^packages\/(spec|workflow-core|rag-core)\//.test(origin.path);
    if (!origin.client && !pure) continue;
    const seen = new Set<string>(); const stack: { module: Module; chain: string[] }[] = [{ module: origin, chain: [origin.path] }];
    while (stack.length) {
      const { module, chain } = stack.pop()!; if (seen.has(module.path)) continue; seen.add(module.path);
      const report = (reason: string) => violations.add(`${origin.path}: ${pure ? 'pure' : 'client'} dependency violation (${reason}): ${chain.join(' -> ')}`);
      if (module.server || module.path.includes('/server/') || module.path.startsWith('packages/package-kit/')) report('server module');
      if (pure && module.path.startsWith('apps/')) report('application module');
      if (module.dynamic) report('unresolved dynamic import/require');
      for (const edge of module.edges.filter(item => item.runtime)) {
        if (native(edge.target) || edge.target === 'server-only' || edge.target.startsWith('@studio/package-kit')) { report(edge.target); continue; }
        const destination = resolve(module.path, edge.target);
        if (destination) stack.push({ module: modules.get(destination)!, chain: [...chain, destination] });
        else if ((edge.target.startsWith('.') || edge.target.startsWith('@studio/')) && !asset(edge.target)) report(`unresolved local module ${edge.target}`);
      }
    }
  }
  return [...violations].sort();
}
