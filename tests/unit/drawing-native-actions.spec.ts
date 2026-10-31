import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { exposeNativeActions } from '../../build/excalidraw-native-actions';
import { DECLARED_NATIVE_ACTIONS, validateNativeActionValue } from '../../src/shared/drawing-native-actions';
import { compactProgressBounds } from '../../src/shared/compact-progress';
import ts from 'typescript';

it('extends both actual installed Excalidraw bundles exactly once and fails on changed anchors', () => {
  for (const kind of ['dev', 'prod']) {
    const source = readFileSync(`node_modules/@excalidraw/excalidraw/dist/${kind}/index.js`, 'utf8');
    const result = exposeNativeActions(source);
    expect(result).toContain('executeNativeAction: async'); expect(result).toContain('action.perform(');
    expect(result).toContain('this.syncActionResult(result)');
    expect(result).toContain('__todoNativeCopyResult');
    const parsed = ts.transpileModule(result, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true } });
    expect(parsed.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([]);
  }
  expect(() => exposeNativeActions('unsupported upstream layout')).toThrow('anchor changed');
});

it('accounts for every declared upstream action and validates native form values', () => {
  const source = readFileSync('node_modules/@excalidraw/excalidraw/dist/types/excalidraw/actions/types.d.ts', 'utf8');
  const union = source.match(/export type ActionName = (.*?);/)![1]!;
  const names = [...union.matchAll(/"([^"]+)"/g)].map(match => match[1]);
  expect([...DECLARED_NATIVE_ACTIONS].sort()).toEqual(names.sort());
  expect(validateNativeActionValue('changeStrokeColor', { currentItemStrokeColor: '#ff0000' })).toEqual({ currentItemStrokeColor: '#ff0000' });
  expect(() => validateNativeActionValue('changeOpacity', 200)).toThrow();
  expect(() => validateNativeActionValue('changeStrokeColor', { selectedElementIds: {} })).toThrow();
  expect(validateNativeActionValue('group', undefined)).toBeNull();
});

it('removes model-facing scene JSON tools and forbids file fallback', () => {
  const runtime = readFileSync('src/main/dsh/dsh-runtime.ts', 'utf8');
  expect(runtime).not.toMatch(/name:\s*['"]drawing_(read|save)['"]/);
  const prompt = readFileSync('resources/dsh/cordis.yml', 'utf8');
  expect(prompt).toContain('禁止降级为读取或重写 .excalidraw 文件');
});

it('positions a full progress editor beside the tiny floating list and clamps to either screen edge', () => {
  const area = { x: 0, y: 0, width: 1280, height: 760 };
  expect(compactProgressBounds({ x: 0, y: 20, width: 200, height: 92 }, area)).toMatchObject({ x: 212, y: 20, width: 420, height: 360 });
  expect(compactProgressBounds({ x: 1080, y: 700, width: 200, height: 92 }, area)).toMatchObject({ x: 648, y: 400 });
});
