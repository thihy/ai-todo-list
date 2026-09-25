// 备忘录详情页 —— 路由 #/memo/:id 渲染这里。
//
// 早期版本有过 markdown 编辑 / 分屏 / 预览三档（用 MarkdownText 渲染
// GFM/KaTeX/Shiki），但「随手丢碎片」的定位不需要格式。改成无衬线
// 舒适字体 + 行高的纯文本 textarea：像手机备忘录 / OneNote 快捷笔记，
// 保留回车换行，**不**解析任何标记。编辑即自动保存（debounce），
// Cmd/Ctrl+S 强制保存。右侧 / 底部是附件区 + 整理动作面板。
//
// 布局选择：与 TodoEditorPane 共享一个简单的「标题栏 + 内容区」框架。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useMemoEntry } from '../hooks/useTodoListApi';
import type { Memo, ULID } from '../../shared/todo-types';
import { IconClose, IconCheck } from '../components/icons';

export const MemoDetail: React.FC<{
  memoId: string;
  navigate: (to: string) => void;
}> = ({ memoId, navigate }) => {
  const { memo, loading } = useMemoEntry(memoId);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 加载 / id 切换时把 draft 重置为最新 content（如果还没开始改）。
  useEffect(() => {
    if (memo) setDraft(memo.content);
  }, [memo?.id, memo?.content]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = memo != null && draft != null && draft !== memo.content;
  // 自动保存（debounce 1s）—— 备忘录本质上是「随手记」，不该让用户每次都按保存。
  const saveTimer = useRef<number | null>(null);
  const performSave = useCallback(
    async (text: string): Promise<void> => {
      if (!memo) return;
      setSaving(true);
      setError(null);
      const res = await window.todoList.memo.update(memo.id, text);
      setSaving(false);
      if (!res.ok) {
        setError(res.message ?? res.code ?? '保存失败');
      }
    },
    [memo],
  );
  useEffect(() => {
    if (!dirty || draft == null) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void performSave(draft);
    }, 1000);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [draft, dirty, performSave]);

  // 进入一次详情 = 用户「读过」一次。打开详情时自动把 read_at
  // 写为 Date.now()。失败静默 —— 不影响编辑；广播会自然地把列表里的
  // 「未读」高亮推掉。memo.readAt 已是 number 时 effect early-return,
  // 不会重复发请求。
  useEffect(() => {
    if (!memo || memo.readAt) return;
    void window.todoList.memo.markRead(memo.id, true);
  }, [memo?.id, memo?.readAt]);

  // Cmd/Ctrl-S 强制保存（不等 debounce）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (draft != null) void performSave(draft);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, performSave]);

  if (loading && !memo) {
    return <div className="task-detail__loading">加载中…</div>;
  }
  if (!memo) {
    return (
      <div className="task-detail task-detail--empty">
        <div className="task-detail__empty-title">备忘录不存在</div>
        <div className="task-detail__empty-hint">
          该碎片可能已被整理或删除。
        </div>
      </div>
    );
  }

  const onDelete = async (): Promise<void> => {
    if (!window.confirm('确定删除该备忘录？此操作不可撤销。')) return;
    const res = await window.todoList.memo.remove(memo.id);
    if (!res.ok) {
      setError(res.message ?? res.code ?? '删除失败');
      return;
    }
    navigate('#/');
  };

  const onMarkResolved = async (): Promise<void> => {
    const res = await window.todoList.memo.markResolved(memo.id, true);
    if (!res.ok) {
      setError(res.message ?? res.code ?? '操作失败');
      return;
    }
    navigate('#/');
  };

  const onPromote = async (): Promise<void> => {
    const title = window.prompt('为新任务起一个标题（留空使用 memo 内容第一行）：', '');
    if (title === null) return;
    const res = await window.todoList.memo.promoteToTask(
      memo.id,
      title.trim() || undefined,
    );
    if (!res.ok) {
      setError(res.message ?? res.code ?? '生成任务失败');
      return;
    }
    const data = res.data as { todoId: ULID };
    navigate(`#/todo/${data.todoId}`);
  };

  return (
    <div className="memo-detail">
      <header className="memo-detail__header">
        <div className="memo-detail__title-row">
          <h2 className="memo-detail__title">{SOURCE_TITLE[memo.source]}</h2>
          <button
            type="button"
            className="memo-detail__close"
            onClick={() => navigate('#/')}
            aria-label="关闭"
            title="关闭"
          >
            <IconClose size={14} />
          </button>
        </div>
        <div className="memo-detail__meta">
          <span className={`memo-detail__source memo-detail__source--${memo.source}`}>
            来源：{SOURCE_LABEL[memo.source]}
          </span>
          <span className="memo-detail__created">创建于 {formatTime(memo.createdAt)}</span>
          {memo.updatedAt !== memo.createdAt && (
            <span className="memo-detail__updated">更新于 {formatTime(memo.updatedAt)}</span>
          )}
          <span className="memo-detail__save">
            {saving ? '保存中…' : error ? <span className="memo-detail__error">{error}</span> : dirty ? '未保存' : <span className="memo-detail__saved"><IconCheck size={11} /> 已保存</span>}
          </span>
        </div>
        </header>

      <div className="memo-detail__body">
        <textarea
          className="memo-detail__textarea"
          value={draft ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="输入备忘录内容…"
          spellCheck={false}
        />

        <aside className="memo-detail__sidebar">
          <section className="memo-detail__panel">
            <h3 className="memo-detail__panel-title">附件</h3>
            <MemoAttachments memo={memo} />
          </section>

          <section className="memo-detail__panel">
            <h3 className="memo-detail__panel-title">整理</h3>
            <button
              type="button"
              className="memo-detail__action"
              onClick={() => void onPromote()}
            >
              生成任务
            </button>
            <button
              type="button"
              className="memo-detail__action"
              onClick={() => void onMarkResolved()}
            >
              标记为记录
            </button>
            <button
              type="button"
              className="memo-detail__action memo-detail__action--danger"
              onClick={() => void onDelete()}
            >
              删除
            </button>
            <p className="memo-detail__hint">
              并入已有任务：从列表行 ⋮ 菜单选择。
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 附件展示 —— memo.attachmentIds 列出文件 ID，通过 memo.readAttachment 拿
// base64 dataUrl 渲染。附件可能很多，限制渲染上限避免首屏卡顿。

const MAX_INLINE_ATTACHMENTS = 8;

const MemoAttachments: React.FC<{ memo: Memo }> = ({ memo }) => {
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const id of memo.attachmentIds.slice(0, MAX_INLINE_ATTACHMENTS)) {
        const res = await window.todoList.memo.readAttachment(id);
        if (cancelled) return;
        if (res.ok && typeof res.data === 'object' && res.data && 'dataUrl' in res.data) {
          out[id] = (res.data as { dataUrl: string }).dataUrl;
        }
      }
      if (!cancelled) setPreviews(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [memo.id, memo.attachmentIds]);

  if (memo.attachmentIds.length === 0) {
    return <div className="memo-detail__empty-hint">无附件</div>;
  }

  return (
    <ul className="memo-detail__attachments">
      {memo.attachmentIds.slice(0, MAX_INLINE_ATTACHMENTS).map((id) => {
        const url = previews[id];
        return (
          <li key={id} className="memo-detail__attachment">
            {url ? (
              <img src={url} alt="附件" />
            ) : (
              <div className="memo-detail__attachment-placeholder">…</div>
            )}
          </li>
        );
      })}
      {memo.attachmentIds.length > MAX_INLINE_ATTACHMENTS && (
        <li className="memo-detail__attachment-more">
          +{memo.attachmentIds.length - MAX_INLINE_ATTACHMENTS}
        </li>
      )}
    </ul>
  );
};

// ---------------------------------------------------------------------------

const SOURCE_LABEL: Record<Memo['source'], string> = {
  drop: '拖入',
  clipboard: '剪贴板',
  capture: '捕获',
  manual: '手动',
};
const SOURCE_TITLE: Record<Memo['source'], string> = {
  drop: '拖入的碎片',
  clipboard: '剪贴板碎片',
  capture: '捕获的碎片',
  manual: '备忘录',
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
