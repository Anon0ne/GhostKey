import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Load a TypeScript module from src/ with its imports stubbed out.
export function load(file, imports = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  // Same realm as the tests, so deepEqual compares arrays and objects normally.
  new Function('module', 'exports', 'require', js)(module, module.exports, (name) => imports[name] ?? {});
  return module.exports;
}
