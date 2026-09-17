// AI tool-grants management surface (OPENSPEC §ai-assistant Persistent and
// session tool grants). Shows currently-granted `always` tools from
// settings.aiGrantedTools and (optionally) session-level grants for the active
// conversation. Revocation goes through ai.tools.revoke.
//
// Drop into SettingsModal / SettingsPane as a panel — kept standalone (no
// nested useSettings call) so the parent controls the data fetch and can
// decide where in the settings tree it sits (AI section vs. 数据 section).
//
// `always` 表持久化在 settings.aiGrantedTools，进程重启仍生效。
// `session` 表在 dsh-runtime.ts 的 sessionGrantsByConv 内存 Map，
// 进程重启即清空 —— 这里 UI 上仍允许撤销，但只影响当前进程。

import { useEffect, useState, useCallback } from 'react';

const TOOL_LABELS: Record<string, string> = {
  'read': '读取文件',
  'read_image': '查看图片',
  'write': '写入文件',
  'edit': '编辑文件',
  'bash': '运行命令',
  'pwsh': '运行 PowerShell',
  'grep': '文本搜索',
  'glob': '文件匹配',
  // 用户自己的工具如果落在 grants 表里也展示出来（不带中文 label
  // 退化成工具名），避免静默丢失
};

function labelOf(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName;
}

interface AIGrantsPanelProps {
  /** Currently active conversationId (for session-grant revocation). Optional:
   *  when omitted the panel hides the session-grant section. */
  activeConversationId?: string;
}

/** Response shape after the IpcResult<T> disc is unwrapped. */
interface ListGrantedData {
  always: string[];
  session: string[];
}

export function AIGrantsPanel({ activeConversationId }: AIGrantsPanelProps): JSX.Element {
  const [alwaysGranted, setAlwaysGranted] = useState<string[]>([]);
  const [sessionGranted, setSessionGranted] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 单行撤销中状态：用 toolName + scope 联合 key，UI 锁单行避免重复点击
  const [revoking, setRevoking] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.todoList.aiTools.listGranted(
        activeConversationId ? { conversationId: activeConversationId } : {}
      );
      if (res && res.ok && res.data) {
        const data = res.data as ListGrantedData;
        setAlwaysGranted(data.always);
        setSessionGranted(data.session);
      } else {
        // res.ok === false → has `message`; never-throws at compile-time
        // because the union's `ok:true` branch doesn't carry it.
        setError(res && !res.ok ? res.message : '未知错误');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeConversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRevoke = useCallback(async (toolName: string, scope: 'always' | 'session'): Promise<void> => {
    const key = `${scope}:${toolName}`;
    setRevoking(key);
    setError(null);
    try {
      const req: { toolName: string; scope: 'always' | 'session'; conversationId?: string } = {
        toolName, scope,
      };
      if (scope === 'session') {
        if (!activeConversationId) return;
        req.conversationId = activeConversationId;
      }
      const res = await window.todoList.aiTools.revoke(req);
      if (res && res.ok && res.data) {
        // 乐观更新；失败路径刷一次服务侧
        if (scope === 'always') {
          setAlwaysGranted((prev) => prev.filter((t) => t !== toolName));
        } else {
          setSessionGranted((prev) => prev.filter((t) => t !== toolName));
        }
      } else {
        setError(res && !res.ok ? res.message : '撤销失败');
        await refresh();
      }
    } catch (err) {
      setError((err as Error).message);
      await refresh();
    } finally {
      setRevoking(null);
    }
  }, [activeConversationId, refresh]);

  if (loading && alwaysGranted.length === 0 && sessionGranted.length === 0) {
    return <div className="aigrants-panel">正在加载授权列表…</div>;
  }

  const empty = alwaysGranted.length === 0 && sessionGranted.length === 0;

  return (
    <div className="aigrants-panel">
      <h3 className="aigrants-panel__title">AI 工具授权</h3>
      <p className="aigrants-panel__hint">
        这些工具已获得「始终允许」或「本次会话允许」授权。撤销后，下次 AI 调用此工具时会重新弹出授权卡片。
      </p>
      {error && <div className="aigrants-panel__error">{error}</div>}
      {empty && <div className="aigrants-panel__empty">暂无授权工具。</div>}

      {alwaysGranted.length > 0 && (
        <section className="aigrants-panel__section">
          <h4 className="aigrants-panel__section-title">始终允许（持久化）</h4>
          <ul className="aigrants-panel__list">
            {alwaysGranted.map((toolName) => {
              const key = `always:${toolName}`;
              return (
                <li key={key} className="aigrants-panel__row">
                  <span className="aigrants-panel__name">{labelOf(toolName)}</span>
                  <button
                    type="button"
                    className="aigrants-panel__revoke"
                    disabled={revoking === key}
                    onClick={() => void handleRevoke(toolName, 'always')}
                  >
                    {revoking === key ? '撤销中…' : '撤销'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {sessionGranted.length > 0 && activeConversationId && (
        <section className="aigrants-panel__section">
          <h4 className="aigrants-panel__section-title">本次会话允许</h4>
          <ul className="aigrants-panel__list">
            {sessionGranted.map((toolName) => {
              const key = `session:${toolName}`;
              return (
                <li key={key} className="aigrants-panel__row">
                  <span className="aigrants-panel__name">{labelOf(toolName)}</span>
                  <button
                    type="button"
                    className="aigrants-panel__revoke"
                    disabled={revoking === key}
                    onClick={() => void handleRevoke(toolName, 'session')}
                  >
                    {revoking === key ? '撤销中…' : '撤销'}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}