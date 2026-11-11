import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Entrypoints start servers/migrations on import. Parse actual call nodes so
// comments mentioning lifecycle APIs cannot satisfy these boot contracts.
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => { if (predicate(node)) found.push(node); node.forEachChild(visit); };
  visit(root);
  return found;
}
function calls(root: ts.Node, name: string): ts.CallExpression[] {
  return nodes(root, ts.isCallExpression).filter(node => ts.isIdentifier(node.expression) && node.expression.text === name);
}
function functionBody(source: ts.SourceFile, name: string): ts.Block {
  const declared = nodes(source, ts.isFunctionDeclaration).find(node => node.name?.text === name)?.body;
  const initializer = nodes(source, ts.isVariableDeclaration).find(node => ts.isIdentifier(node.name) && node.name.text === name)?.initializer;
  const expressionBody = initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) && ts.isBlock(initializer.body)
    ? initializer.body : undefined;
  const body = declared ?? expressionBody;
  if (!body) throw new Error(`Missing ${name} function body`);
  return body;
}

describe.each([
  { file: 'index.ts', startup: 'bootstrap', workers: 'initializeWorkers' },
  { file: 'worker.ts', startup: 'bootWorker', workers: 'startRegisteredWorkers' },
])('capacity guard lifecycle in $file', ({ file, startup, workers }) => {
  const source = ts.createSourceFile(file, readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const boot = functionBody(source, startup);
  const shutdown = functionBody(source, 'shutdownRuntime');

  it('starts exactly once after configuration and loop monitoring, before workers can execute', () => {
    const starts = calls(boot, 'startCapacityGuard');
    expect(starts).toHaveLength(1);
    expect(calls(source, 'startCapacityGuard')).toHaveLength(1);
    const [validation] = calls(boot, 'validateConfig');
    const [monitor] = calls(boot, 'startEventLoopMonitor');
    const [workerStart] = calls(boot, workers);
    expect(validation).toBeDefined(); expect(monitor).toBeDefined(); expect(workerStart).toBeDefined();
    expect(starts[0]!.getStart(source)).toBeGreaterThan(validation!.getStart(source));
    expect(starts[0]!.getStart(source)).toBeGreaterThan(monitor!.getStart(source));
    expect(starts[0]!.getStart(source)).toBeLessThan(workerStart!.getStart(source));
  });

  it('injects the dependency check during startup', () => {
    const argument = calls(boot, 'startCapacityGuard')[0]!.arguments[0];
    expect(argument && ts.isObjectLiteralExpression(argument)).toBe(true);
    const properties = (argument as ts.ObjectLiteralExpression).properties;
    expect(properties.some(property => property.name?.getText(source) === 'checkDependencies')).toBe(true);
  });

  it('validates fleet admission tuning before workers execute', () => {
    const validations = calls(boot, 'agentRolloutLimits');
    expect(validations).toHaveLength(1);
    expect(validations[0]!.getStart(source)).toBeLessThan(calls(boot, workers)[0]!.getStart(source));
  });

  it('stops admission sampling before shutdown drains workers and shared connections', () => {
    const stops = calls(shutdown, 'stopCapacityGuard');
    expect(stops).toHaveLength(1);
    expect(calls(source, 'stopCapacityGuard')).toHaveLength(1);
    const [drain] = calls(shutdown, 'runShutdownPhases');
    expect(drain).toBeDefined();
    expect(stops[0]!.getStart(source)).toBeLessThan(drain!.getStart(source));
  });
});
