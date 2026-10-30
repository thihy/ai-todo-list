import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './helpers';

test('local documents refresh current contents and import through a dialog', async () => {
  const handle = await launchApp();
  const sources = mkdtempSync(join(tmpdir(), 'doc-import-e2e-'));
  try {
    await handle.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.focus(); });
    const id = await handle.win.evaluate(async () => {
      const result = await window.todoList.todo.create({ title: '本地文档回归' });
      if (!result.ok) throw new Error(result.message);
      location.hash = '/todo/' + result.data.id;
      return result.data.id;
    });
    await expect(handle.win.getByRole('button', { name: '重新扫描目录', exact: true })).toBeVisible();
    const guide = handle.win.getByRole('dialog', { name: '今日待办', exact: true });
    if (await guide.isVisible()) await guide.getByRole('button', { name: '关闭', exact: true }).click();
    const taskName = readdirSync(join(handle.dataDir, 'todos')).find((name) => name.startsWith(id.slice(0, 6)))!;
    const taskDir = join(handle.dataDir, 'todos', taskName);
    writeFileSync(join(taskDir, '手工.md'), '# 初始内容');
    await handle.win.getByRole('button', { name: '重新扫描目录', exact: true }).click({ timeout: 5000 });
    await handle.win.getByRole('tab', { name: /手工/ }).click();
    // The editor may initially show its rendered preview; IPC and reopening
    // independently verify the on-disk source, then the active editor refresh.
    await expect(handle.win.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveValue('# 初始内容');
    writeFileSync(join(taskDir, '手工.md'), '# 外部最新正文');
    await handle.win.getByRole('button', { name: '重新扫描目录', exact: true }).click();
    await expect(handle.win.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveValue('# 外部最新正文');
    const source = join(sources, '导入.md');
    writeFileSync(source, '# 导入成功');
    await handle.app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, source);
    await handle.win.getByRole('button', { name: '导入文档', exact: true }).click();
    await expect(handle.win.getByRole('dialog', { name: '导入文档' })).toBeVisible();
    await handle.win.getByRole('dialog', { name: '导入文档' }).screenshot({ path: test.info().outputPath('import-dialog.png') });
    await handle.win.getByRole('button', { name: '选择本地文件', exact: true }).click();
    await expect(handle.win.getByRole('dialog', { name: '导入文档' })).not.toBeVisible();
    await expect(handle.win.getByRole('tab', { name: /导入/ })).toBeVisible();
    expect(readFileSync(join(taskDir, '导入.md'), 'utf8')).toBe('# 导入成功');
    expect(existsSync(source)).toBe(true);
    // Use a real local File provided by Chromium to exercise drag upload
    // and Electron webUtils across the context-isolated preload bridge.
    await handle.win.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file'; input.id = 'e2e-local-file'; input.hidden = true;
      document.body.append(input);
    });
    await handle.win.locator('#e2e-local-file').setInputFiles(source);
    await handle.win.getByRole('button', { name: '导入文档', exact: true }).click();
    await handle.win.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#e2e-local-file')!;
      const transfer = new DataTransfer();
      transfer.items.add(input.files![0]!);
      document.querySelector('dialog > div')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(handle.win.getByRole('dialog', { name: '导入文档' })).not.toBeVisible();
    expect(readFileSync(join(taskDir, '导入_1.md'), 'utf8')).toBe('# 导入成功');
    const beforeLinks = readdirSync(taskDir).sort();
    await handle.win.getByRole('button', { name: '添加链接', exact: true }).click();
    await handle.win.getByRole('tab', { name: '本地文件', exact: true }).click();
    await handle.win.getByRole('button', { name: '选择本地文件链接', exact: true }).click();
    await handle.win.getByRole('button', { name: '保存', exact: true }).last().click();
    await expect(handle.win.getByRole('button', { name: '默认应用打开', exact: true })).toBeVisible();
    await expect(handle.win.getByRole('button', { name: '在文件夹中显示', exact: true })).toBeVisible();
    expect(readdirSync(taskDir).sort()).toEqual(beforeLinks);
    // Exercise webUtils across the real context bridge with a genuine File.
    const result = await handle.win.evaluate(() => {
      return window.todoList.document.pathsForFiles([new File(['# no local path'], 'virtual.md')]);
    });
    expect(result).toEqual(['']);
  } finally {
    await handle.app.close();
    rmSync(sources, { recursive: true, force: true });
  }
});
