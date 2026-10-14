import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { defineTool } from '@deepseek-ai/dsh-tools';

describe('drawing_draw tool registration', () => {
  it('accepts the actual nested parameter schema during DSH startup', () => {
    const filename = resolve(__dirname, '../../src/main/dsh/dsh-runtime.ts');
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    let parameters: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(ts.isPropertyAssignment);
        const name = properties.find((p) => p.name.getText(source) === 'name');
        if (name && ts.isStringLiteral(name.initializer) && name.initializer.text === 'drawing_draw') {
          parameters = properties.find((p) => p.name.getText(source) === 'parameters')?.initializer;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(parameters).toBeDefined();
    // Read the production schema rather than maintaining a second schema in the test.
    const schema = runInNewContext(`(${parameters!.getText(source)})`);
    expect(() => defineTool({ name: 'drawing_draw', description: 'Draw a diagram',
      parameters: schema,
      output: { schema: { type: 'object', additionalProperties: true, properties: {} },
        render: () => [{ type: 'text', text: 'ok' }] },
      execute: async () => ({}) })).not.toThrow();
  });
});
