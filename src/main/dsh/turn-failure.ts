import { toolInterruptionState } from '../../shared/tool-interruption';

/** Stop a failed filesystem turn before the agent can retry it indefinitely. */
import { logger } from '../logger';

export class TurnFailureGuard {
  private readonly calls = new Map<string, string>();
  error: Error | undefined;

  constructor(private readonly cancel: () => void) {}

  observe(event: { type: string; data?: unknown }): void {
    if (this.error) return;
    const data = event.data as {
      callId?: unknown;
      name?: string;
      error?: unknown;
      message?: { source?: { callId?: unknown }; content?: Array<{ isError?: boolean; content?: Array<{ type?: string; text?: string }> }> };
      reason?: { kind?: string; error?: { message?: string } };
    } | undefined;
    if (event.type === 'tool/call' && data?.callId != null && data.name) {
      this.calls.set(String(data.callId), data.name);
    } else if (event.type === 'tool/result') {
      const id = data?.message?.source?.callId;
      const name = id == null ? undefined : this.calls.get(String(id));
      if (id != null) this.calls.delete(String(id));
      const block = data?.message?.content?.[0];
      if (!name || !FILE_TOOLS.has(name) || !block?.isError) return;
      if (toolInterruptionState(data?.error)) return;
      const detail = block.content?.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
      // User cancellation already has its own normal terminal path.
      if (detail?.startsWith('cancelled:')) return;
      // LLM 日志点：文件系统工具执行失败 → 触发整轮取消。这条是排查
      // "为什么这轮突然停了 / 接下来又重试又失败" 的关键标记。
      logger.warn(`[LLM turn] file-tool-failed name=${name} callId=${String(id)} detail=${detail || '(none)'}`);
      this.error = new Error(`文件工具 ${name} 执行失败，本轮已停止：${detail || '未知错误'}`);
      this.cancel();
    } else if (event.type === 'turn/end' && data?.reason?.kind === 'error') {
      // DSH contains driver exceptions, so whenIdle() may resolve on error.
      // LLM 日志点：turn/end reason=error。停轮而非自然 done 的另一条路径。
      logger.warn(`[LLM turn] turn-end-error reason=${data.reason.error?.message ?? '(no message)'}`);
      this.error = new Error(data.reason.error?.message || 'AI 执行失败');
    }
  }
}

const FILE_TOOLS = new Set(['read', 'read_image', 'write', 'edit', 'grep', 'glob', 'bash', 'pwsh']);
