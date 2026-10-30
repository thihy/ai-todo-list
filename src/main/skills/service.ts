import { dialog } from 'electron';
import { register, okResult, failResult } from '../ipc/router';
import { installLocalSkill } from './install';

export function registerSkillHandlers(): void {
  register('skill.list', async () => {
    const { peekDshRuntime } = await import('../dsh/dsh-runtime');
    const runtime = peekDshRuntime();
    if (!runtime) return failResult('ai_not_ready', 'AI 正在启动，请稍后刷新技能清单');
    return okResult(await runtime.skillCatalog());
  });
  register('skill.install', async (_event, req) => {
    let source = req?.source;
    if (!source) {
      const result = await dialog.showOpenDialog({ title: '选择包含 SKILL.md 的技能文件夹', properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return okResult(null);
      source = result.filePaths[0];
    }
    return okResult(await installLocalSkill(source));
  });
  register('ai.commands', async () => {
    const { peekDshRuntime } = await import('../dsh/dsh-runtime');
    const runtime = peekDshRuntime();
    if (!runtime) return failResult('ai_not_ready', 'AI 正在启动，请稍后重试');
    // Catalog discovery is read-only and must not allocate an arbitrary agent.
    return okResult(await runtime.commandCatalog());
  });
}
