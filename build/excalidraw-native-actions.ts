import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/** Await native asynchronous side effects before the engine acknowledges completion. */
function awaitNativeClipboardActions(code: string): string {
  const source = ts.createSourceFile('excalidraw.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const patched = new Set<string>();
  const propertyName = (node: ts.ObjectLiteralElementLike) => node.name?.getText(source).replaceAll(/['"]/g, '');
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
      && node.arguments[1] && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === 'pasteFromClipboard') {
      const wrapper = node.arguments[2];
      const fn = wrapper && ts.isCallExpression(wrapper) ? wrapper.arguments[0] : undefined;
      if (!fn || !ts.isArrowFunction(fn) || !ts.isBlock(fn.body)) throw Error('Excalidraw paste task layout changed');
      const asyncModifier = fn.modifiers?.find(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
      if (!asyncModifier) throw Error('Excalidraw paste task is no longer asynchronous');
      // withBatchedUpdates discards the async callback's return value. Keep the
      // real task on this editor so an AI acknowledgement can await it.
      edits.push({ start: asyncModifier.getStart(source), end: asyncModifier.end, text: '' });
      edits.push({ start: fn.body.getStart(source) + 1, end: fn.body.getStart(source) + 1,
        text: 'const __todoNativePasteTask = this.__todoNativePasteTask = (async () => {' });
      edits.push({ start: fn.body.end - 1, end: fn.body.end - 1,
        text: '})(); __todoNativePasteTask.catch(() => {}); return __todoNativePasteTask;' });
      patched.add('paste-task');
      const inspect = (child: ts.Node) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'insertImageElement') {
          edits.push({ start: child.getStart(source), end: child.getStart(source), text: 'await ' });
          patched.add('paste-image-initialization');
        }
        ts.forEachChild(child, inspect);
      };
      if (node.arguments[2]) inspect(node.arguments[2]);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const name = node.properties.find(property => propertyName(property) === 'name');
      const perform = node.properties.find(property => propertyName(property) === 'perform');
      if (name && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer) && ['paste', 'copyText', 'cut'].includes(name.initializer.text)
        && perform && ts.isPropertyAssignment(perform) && ts.isArrowFunction(perform.initializer)) {
        const action = name.initializer.text, fn = perform.initializer;
        if (action === 'cut' && !ts.isBlock(fn.body)) {
          let body: ts.Expression = fn.body;
          while (ts.isParenthesizedExpression(body)) body = body.expression;
          if (!ts.isBinaryExpression(body) || body.operatorToken.kind !== ts.SyntaxKind.CommaToken || !ts.isCallExpression(body.left) || !ts.isCallExpression(body.right)) throw Error('Excalidraw minified cut layout changed');
          edits.push({ start: fn.getStart(source), end: fn.getStart(source), text: 'async ' });
          edits.push({ start: fn.body.getStart(source), end: fn.body.end,
            text: `{ const __todoNativeCopyResult = await ${body.left.getText(source)}; if (__todoNativeCopyResult && __todoNativeCopyResult.appState && __todoNativeCopyResult.appState.errorMessage) return __todoNativeCopyResult; return ${body.right.getText(source)}; }` });
          patched.add(action);
          ts.forEachChild(node, visit);
          return;
        }
        let statement: ts.ExpressionStatement | undefined;
        const find = (child: ts.Node) => {
          if (!statement && ts.isExpressionStatement(child) && ts.isCallExpression(child.expression)) {
            const callee = child.expression.expression;
            if (action === 'copyText' || (ts.isPropertyAccessExpression(callee) && callee.name.text === (action === 'paste' ? 'pasteFromClipboard' : 'perform'))) statement = child;
          }
          ts.forEachChild(child, find);
        };
        find(fn.body);
        if (!statement) throw Error(`Excalidraw ${action} async layout changed`);
        const call = (statement as ts.ExpressionStatement).expression;
        if (!fn.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) edits.push({ start: fn.getStart(source), end: fn.getStart(source), text: 'async ' });
        if (action === 'cut') edits.push({ start: statement.getStart(source), end: statement.end,
          text: `const __todoNativeCopyResult = await ${call.getText(source)}; if (__todoNativeCopyResult && __todoNativeCopyResult.appState && __todoNativeCopyResult.appState.errorMessage) return __todoNativeCopyResult;` });
        else edits.push({ start: call.getStart(source), end: call.getStart(source), text: 'await ' });
        patched.add(action);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (patched.size !== 5) throw Error('Excalidraw clipboard action registry changed; review awaited completion.');
  for (const edit of edits.sort((left, right) => right.start - left.start)) code = code.slice(0, edit.start) + edit.text + code.slice(edit.end);
  return code;
}

/** Version-checked extension of Excalidraw's imperative API. No React-private access at runtime. */
export function exposeNativeActions(code: string): string {
  const marker = /registerAction:\s*(?:\([^)]*\)|[\w$]+)\s*=>\s*\{\s*this\.actionManager\.registerAction\(/g;
  const matches = [...code.matchAll(marker)];
  if (matches.length !== 1) throw Error('Excalidraw native action API anchor changed; review engine integration before upgrading.');
  code = awaitNativeClipboardActions(code);
  const anchor = [...code.matchAll(marker)][0]!.index!;
  const fields = `
    getNativeActions: () => Object.values(this.actionManager.actions).map(action => ({
      name: action.name, label: typeof action.label === "string" ? action.label : action.name,
      enabled: this.props.UIOptions.canvasActions[action.name] !== false,
      available: !action.predicate || action.predicate(this.scene.getElementsIncludingDeleted(), this.state, this.props, this),
      viewMode: action.viewMode === true
    })),
    executeNativeAction: async (name, value) => {
      const action = this.actionManager.actions[name];
      if (!action) throw Error("当前引擎未注册此动作：" + name);
      if (this.props.UIOptions.canvasActions[name] === false) throw Error("当前编辑器配置禁用此动作：" + name);
      if (this.state.viewModeEnabled && action.viewMode !== true) throw Error("当前是查看模式，请先关闭 viewMode");
      if (action.predicate && !action.predicate(this.scene.getElementsIncludingDeleted(), this.state, this.props, this)) throw Error("动作前提未满足，请检查选区/元素类型：" + name);
      if (name === "paste") {
        this.focusContainer();
        const box = this.interactiveCanvas.getBoundingClientRect();
        let point;
        for (const y of [.5, .7, .85, .3]) for (const x of [.5, .7, .3, .85]) {
          const candidate = { x: box.left + box.width * x, y: box.top + box.height * y };
          if (!point && document.elementFromPoint(candidate.x, candidate.y) === this.interactiveCanvas) point = candidate;
        }
        if (!point) throw Error("画布被浮层遮挡，请收起浮层后重新粘贴");
        this.lastViewportPosition = point;
      }
      const previousPasteTask = this.__todoNativePasteTask;
      const result = await action.perform(this.scene.getElementsIncludingDeleted(), this.state, value === undefined ? null : value, this);
      if (name === "paste" && this.__todoNativePasteTask !== previousPasteTask) await this.__todoNativePasteTask;
      if (name === "paste" && result === false) throw Error("粘贴未完成，剪贴板读取被拒绝或已取消");
      const error = result && result.appState && result.appState.errorMessage;
      if (error && error !== this.state.errorMessage) throw Error(String(error));
      this.syncActionResult(result);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { result: result === false ? "no-scene-update" : "native-result-applied",
        ui: { openDialog: this.state.openDialog, openMenu: this.state.openMenu,
          openSidebar: this.state.openSidebar, activeTool: this.state.activeTool.type,
          hyperlink: this.state.showHyperlinkPopup, croppingElementId: this.state.croppingElementId,
          editingLinearElement: this.state.editingLinearElement && this.state.editingLinearElement.elementId,
          pasteDialog: this.state.pasteDialog && this.state.pasteDialog.shown,
          toast: this.state.toast && this.state.toast.message } };
    },
  `;
  return code.slice(0, anchor) + fields + code.slice(anchor);
}

export function excalidrawNativeActionsPlugin(): Plugin {
  const { version } = JSON.parse(readFileSync(resolve('node_modules/@excalidraw/excalidraw/package.json'), 'utf8'));
  if (version !== '0.18.1') throw Error(`Excalidraw ${version} requires reviewing the native action bridge and coverage inventory.`);
  return { name: 'todo-excalidraw-native-actions', enforce: 'pre', transform(code, id) {
    if (!/\/@excalidraw\/excalidraw\/dist\/(dev|prod)\/index\.js(?:\?|$)/.test(id.replaceAll('\\', '/'))) return;
    return { code: exposeNativeActions(code), map: null };
  } };
}
