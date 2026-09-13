// TagManagementPane — DB-backed (v17) tag catalog management.
//
// Surfaces:
//   - Active tab: every catalog row with retired_at = NULL, plus
//     activeCount (valid-task usage) and historicalCount. Search
//     filters by name (case-insensitive substring). Per-row actions:
//     rename / recolour / merge / retire / view-using-tasks.
//   - Retired tab: catalog rows with retired_at IS NOT NULL. Actions:
//     reactivate (clear retired_at) and view-using-tasks.
//   - Cleanup button: opens a modal preview. Two sections:
//        * 未使用标签 — names with zero valid-task usage (active
//          catalog rows only).
//        * 相似标签   — names whose candidate key (trim + collapse
//          whitespace + lowercase) collides; suggested target is the
//          most-used member. The preview is read-only; the user
//          ticks the rows they want and picks the merge targets
//          before applying.
//
// Important data semantics:
//   - "Valid task" = deleted_at IS NULL AND archived_at IS NULL.
//     Done but unarchived tasks count as valid. The stats use the
//     SAME predicate as the rest of the app (TodoRepo.list).
//   - Historical tasks (deleted or archived) are NEVER touched by
//     rename / merge / cleanup. Their tag associations stay intact
//     so the user can always see "this task was tagged X" in their
//     history. Restoring such a task brings the original name back
//     into the active management list automatically (the activate
//     hook on the next write revives a retired catalog row).
//   - The cleanup preview is captured as a snapshot; on apply the
//     server re-validates each action in a single transaction. A
//     tag that picked up valid-task usage between preview and apply
//     is skipped with a stale-preview reason — the renderer must
//     re-fetch the preview if the user wants to retry.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTagList } from '../hooks/useTodoListApi';
import { useToastBus } from './Toast';
import type {
  CleanupActions,
  CleanupApplyResult,
  CleanupPreview,
  CleanupPreviewSimilarGroup,
  CleanupPreviewUnused,
  TagCatalogEntry,
} from '../../shared/ipc-schema';

export const TagManagementPane: React.FC = () => {
  const { data: tags, loading, refresh } = useTagList();
  const { data: retired, refresh: refreshRetired } = useTagList({ activeOnly: false });
  const [tab, setTab] = useState<'active' | 'retired'>('active');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{
    originalName: string;
    row: TagCatalogEntry;
    draftName: string;
  } | null>(null);
  const [mergeFrom, setMergeFrom] = useState<{ sources: TagCatalogEntry[]; target: TagCatalogEntry | null } | null>(null);
  const [cleanupPreview, setCleanupPreview] = useState<CleanupPreview | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  // The retired tab needs the full catalog (activeOnly: false).
  // useTagList's data already includes active rows in its
  // default-config (activeOnly=false returns the union). Filter
  // client-side for tab switching.
  const activeRows = useMemo(
    () => tags.filter((t) => t.retiredAt == null),
    [tags],
  );
  const retiredRows = useMemo(
    () => (retired.length ? retired : tags).filter((t) => t.retiredAt != null),
    [tags, retired],
  );
  const visible = (tab === 'active' ? activeRows : retiredRows).filter((t) =>
    !search.trim() || t.name.toLowerCase().includes(search.trim().toLowerCase()),
  );

  // Cleanup preview: cached, lazily fetched when the modal opens.
  // The user clicks "扫描" to (re)fetch; "应用" sends back the
  // ticked rows + per-group merge target overrides.
  const openCleanup = useCallback(async () => {
    setCleanupLoading(true);
    setCleanupOpen(true);
    try {
      const res = await window.todoList.tag.previewCleanup();
      if (res.ok) setCleanupPreview(res.data);
      else setCleanupPreview({ unused: [], similar: [] });
    } finally {
      setCleanupLoading(false);
    }
  }, []);
  const closeCleanup = useCallback(() => {
    setCleanupOpen(false);
    setCleanupPreview(null);
  }, []);

  return (
    <div className="settings-pane settings-tags-pane">
      <header className="settings-tags__header">
        <div>
          <h3 className="settings-tags__title">标签管理</h3>
          <p className="settings-tags__description">
            管理标签名称、查看使用情况，或合并和停用不再需要的标签。
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={openCleanup}>
          扫描清理
        </button>
      </header>

      <div className="settings-tags__toolbar">
        <label className="settings-tags__search">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            className="input"
            aria-label="搜索标签名称"
            placeholder="搜索标签名称…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="settings-tags__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'active'}
            className={`settings-tags__tab${tab === 'active' ? ' is-active' : ''}`}
            onClick={() => setTab('active')}
          >
            活跃 <span className="settings-tags__tab-count">{activeRows.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'retired'}
            className={`settings-tags__tab${tab === 'retired' ? ' is-active' : ''}`}
            onClick={() => setTab('retired')}
          >
            已停用 <span className="settings-tags__tab-count">{retiredRows.length}</span>
          </button>
        </div>
      </div>

      <div className="settings-tags">
        {loading && <div className="settings-tags__empty">正在加载标签…</div>}
        {!loading && visible.length === 0 && (
          <div className="settings-tags__empty">
            <strong>
              {search.trim()
                ? `没有匹配“${search.trim()}”的标签`
                : tab === 'active' ? '还没有标签' : '没有已停用标签'}
            </strong>
            <span>
              {search.trim()
                ? '换一个关键词试试。'
                : tab === 'active'
                  ? '在任务详情中输入 #标签，即可自动加入管理。'
                  : '停用的标签会显示在这里，并可随时恢复。'}
            </span>
          </div>
        )}
        {visible.map((t) => (
          <TagRow
            key={t.name}
            row={t}
            editing={editing}
            onStartEdit={(row) => setEditing({ originalName: row.name, row, draftName: row.name })}
            onDraftChange={(draftName) => setEditing((current) => current ? { ...current, draftName } : null)}
            onCancelEdit={() => setEditing(null)}
            onCommitRename={async (row, newName) => {
              if (newName === row.name) {
                setEditing(null);
                return;
              }
              const res = await window.todoList.tag.rename(row.name, newName);
              if (!res.ok) {
                // The server already surfaces a readable reason
                // (e.g. "目标名称「X」已存在,请改用合并或先清理该名称").
                // We toast so the user sees the failure; the row stays
                // editable so they can try again.
                alert(`重命名失败:${res.message ?? '未知错误'}`);
                return;
              }
              setEditing(null);
            }}
            onStartMerge={(row) => setMergeFrom({ sources: [row], target: null })}
            onRetire={async (row) => {
              const ok = window.confirm(
                `停用标签「${row.name}」?\n仅影响管理列表显示,不影响历史任务的标签。`,
              );
              if (!ok) return;
              // Retire is implemented via applyCleanup with a single
              // name — previewCleanup already produces the same list
              // shape; we just re-fetch and filter down.
              const res = await window.todoList.tag.previewCleanup();
              if (!res.ok) return;
              const target = res.data.unused.find((u) => u.name === row.name)
                ?? { name: row.name, historicalCount: row.historicalCount };
              const apply = await window.todoList.tag.applyCleanup({ retire: [target.name] });
              if (!apply.ok) {
                alert(`停用失败:${apply.message ?? '未知错误'}`);
                return;
              }
              void refresh();
              void refreshRetired();
            }}
            onReactivate={async (row) => {
              const res = await window.todoList.tag.reactivate(row.name);
              if (!res.ok) {
                alert(`恢复失败:${res.message ?? '未知错误'}`);
                return;
              }
              void refresh();
              void refreshRetired();
            }}
          />
        ))}
      </div>

      {mergeFrom && (
        <MergeDialog
          initial={mergeFrom}
          allActive={activeRows}
          onClose={() => setMergeFrom(null)}
          onApply={async (sources, target) => {
            const res = await window.todoList.tag.merge(
              sources.map((s) => s.name),
              target.name,
            );
            if (!res.ok) {
              alert(`合并失败:${res.message ?? '未知错误'}`);
              return false;
            }
            setMergeFrom(null);
            void refresh();
            void refreshRetired();
            return true;
          }}
        />
      )}

      {cleanupOpen && (
        <CleanupDialog
          preview={cleanupPreview}
          loading={cleanupLoading}
          onClose={closeCleanup}
          onRefresh={openCleanup}
          onApply={async (actions): Promise<CleanupApplyResult | null> => {
            const res = await window.todoList.tag.applyCleanup(actions);
            if (!res.ok) {
              alert(`清理失败:${res.message ?? '未知错误'}`);
              return null;
            }
            closeCleanup();
            void refresh();
            void refreshRetired();
            return res.data ?? null;
          }}
        />
      )}
    </div>
  );
};

// ----- per-row UI -----

interface TagRowProps {
  row: TagCatalogEntry;
  editing: { originalName: string; row: TagCatalogEntry; draftName: string } | null;
  onStartEdit(row: TagCatalogEntry): void;
  onDraftChange(value: string): void;
  onCancelEdit(): void;
  onCommitRename(row: TagCatalogEntry, newName: string): Promise<void>;
  onStartMerge(row: TagCatalogEntry): void;
  onRetire(row: TagCatalogEntry): Promise<void>;
  onReactivate(row: TagCatalogEntry): Promise<void>;
}

const TagRow: React.FC<TagRowProps> = ({
  row,
  editing,
  onStartEdit,
  onDraftChange,
  onCancelEdit,
  onCommitRename,
  onStartMerge,
  onRetire,
  onReactivate,
}) => {
  const isEditing = editing?.originalName === row.name;
  const isRetired = row.retiredAt != null;
  return (
    <div className={`settings-tags__row${isRetired ? ' is-retired' : ''}`}>
      <span
        className="settings-tags__swatch"
        style={{ backgroundColor: row.color }}
        aria-hidden="true"
      />
      {isEditing ? (
        <input
          className="input settings-tags__name"
          value={editing!.draftName}
          autoFocus
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={(e) => void onCommitRename(row, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') onCancelEdit();
          }}
        />
      ) : (
        <span
          className="settings-tags__name"
          title={row.name}
        >
          #{row.name}
        </span>
      )}
      <span className={`settings-tags__status${row.activeCount === 0 ? ' is-unused' : ''}`} title={`有效任务 ${row.activeCount} · 历史任务 ${row.historicalCount}`}>
        {row.activeCount === 0
          ? (isRetired
              ? '已停用'
              : row.historicalCount > 0 ? '仅历史使用' : '未使用')
          : `${row.activeCount} 个有效任务`}
      </span>
      {!isRetired && (
        <div className="settings-tags__actions">
          <button
            type="button"
            className="settings-tags__action"
            onClick={() => onStartEdit(row)}
          >
            重命名
          </button>
          <button
            type="button"
            className="settings-tags__action"
            onClick={() => onStartMerge(row)}
            title="合并到其他标签"
          >
            合并
          </button>
          <button
            type="button"
            className="settings-tags__action settings-tags__action--danger"
            onClick={() => void onRetire(row)}
            title="停用 — 仅从管理列表隐藏,不影响历史任务"
          >
            停用
          </button>
        </div>
      )}
      {isRetired && (
        <div className="settings-tags__actions">
          <button
            type="button"
            className="settings-tags__action settings-tags__action--restore"
            onClick={() => void onReactivate(row)}
          >
            恢复
          </button>
        </div>
      )}
    </div>
  );
};

// ----- Merge dialog -----

interface MergeDialogProps {
  initial: { sources: TagCatalogEntry[]; target: TagCatalogEntry | null };
  allActive: TagCatalogEntry[];
  onClose(): void;
  onApply(sources: TagCatalogEntry[], target: TagCatalogEntry): Promise<boolean>;
}

const MergeDialog: React.FC<MergeDialogProps> = ({ initial, allActive, onClose, onApply }) => {
  const [sources, setSources] = useState<TagCatalogEntry[]>(initial.sources);
  const [target, setTarget] = useState<TagCatalogEntry | null>(initial.target);
  const candidates = useMemo(
    () => allActive.filter((t) => !sources.some((s) => s.name === t.name)),
    [allActive, sources],
  );
  const totalAffected = sources.reduce((acc, s) => acc + s.activeCount, 0);
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__header">
          <h3>合并标签</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal__body">
          <div className="muted" style={{ marginBottom: 8, fontSize: 12, lineHeight: 1.6 }}>
            合并仅影响未删除、未归档任务。已删除或已归档任务上的原标签保持不变。
          </div>
          <div className="form-row">
            <label>源标签（要合并掉的）</label>
            <div className="settings-tags__chip-row">
              {sources.map((s) => (
                <span key={s.name} className="settings-tags__chip" style={{ background: `color-mix(in srgb, ${s.color} 16%, transparent)`, color: s.color }}>
                  #{s.name}
                  <button type="button" className="settings-tags__chip-remove" onClick={() => setSources((arr) => arr.filter((x) => x.name !== s.name))} aria-label={`移除 ${s.name}`}>×</button>
                </span>
              ))}
            </div>
            <select
              className="input"
              value=""
              onChange={(e) => {
                const name = e.target.value;
                if (!name) return;
                const found = allActive.find((a) => a.name === name);
                if (found && !sources.some((s) => s.name === found.name) && found.name !== target?.name) {
                  setSources((arr) => [...arr, found]);
                }
              }}
            >
              <option value="">添加源标签…</option>
              {candidates.map((c) => (
                <option key={c.name} value={c.name}>{c.name}（{c.activeCount}）</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label>目标标签（保留）</label>
            <select
              className="input"
              value={target?.name ?? ''}
              onChange={(e) => {
                const found = allActive.find((a) => a.name === e.target.value);
                setTarget(found ?? null);
              }}
            >
              <option value="">选择目标…</option>
              {candidates
                .filter((c) => !sources.some((s) => s.name === c.name))
                .map((c) => (
                  <option key={c.name} value={c.name}>{c.name}（{c.activeCount}）</option>
                ))}
            </select>
          </div>
          <div className="muted" style={{ fontSize: 12, lineHeight: 1.6 }}>
            将影响 <strong>{totalAffected}</strong> 个有效任务。同任务已有源和目标时,合并后只保留目标。
          </div>
        </div>
        <div className="modal__footer">
          <button type="button" className="btn-secondary" onClick={onClose}>取消</button>
          <button
            type="button"
            className="btn-primary"
            disabled={!target || sources.length === 0 || sources.some((s) => s.name === target.name)}
            onClick={() => void onApply(sources, target!)}
          >
            合并
          </button>
        </div>
      </div>
    </div>
  );
};

// ----- Cleanup dialog -----

interface CleanupDialogProps {
  preview: CleanupPreview | null;
  loading: boolean;
  onClose(): void;
  onRefresh(): Promise<void>;
  onApply(actions: CleanupActions): Promise<CleanupApplyResult | null>;
}

const CleanupDialog: React.FC<CleanupDialogProps> = ({ preview, loading, onClose, onRefresh, onApply }) => {
  const toast = useToastBus();
  const [retire, setRetire] = useState<Set<string>>(new Set());
  const [merges, setMerges] = useState<Map<string, string>>(new Map()); // groupKey → target
  const [applying, setApplying] = useState(false);

  // Reset tick state whenever a fresh preview lands.
  useEffect(() => {
    setRetire(new Set());
    const m = new Map<string, string>();
    preview?.similar.forEach((g) => m.set(g.key, g.target));
    setMerges(m);
  }, [preview]);

  const toggleRetire = (name: string): void => {
    setRetire((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };
  const setTarget = (groupKey: string, targetName: string): void => {
    setMerges((cur) => {
      const next = new Map(cur);
      next.set(groupKey, targetName);
      return next;
    });
  };

  const apply = async (): Promise<void> => {
    setApplying(true);
    try {
      const actions: CleanupActions = {
        retire: Array.from(retire),
        merges: (preview?.similar ?? [])
          .filter((g) => {
            const t = merges.get(g.key);
            return t && g.members.some((m) => m.name === t) && g.members.length >= 2;
          })
          .map((g) => ({
            sources: g.members.filter((m) => m.name !== merges.get(g.key)).map((m) => m.name),
            target: merges.get(g.key)!,
          })),
      };
      const result = await onApply(actions);
      if (result) {
        const skippedMsg = result.skipped.length > 0 ? ` (${result.skipped.length} 已跳过)` : '';
        toast.push({ kind: 'info', message: `清理完成 · 影响 ${result.affectedTodoIds.length} 个任务${skippedMsg}`, ttl: 3000 });
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal--wide">
        <div className="modal__header">
          <h3>扫描清理</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>
        <div className="modal__body">
          <div className="muted" style={{ marginBottom: 12, fontSize: 12, lineHeight: 1.6 }}>
            仅影响未删除、未归档任务。已删除或已归档任务的标签保持原样。
          </div>
          {loading && <div className="muted">扫描中…</div>}
          {!loading && preview && (
            <>
              <CleanupSection
                title={`未使用标签（${preview.unused.length}）`}
                hint="活跃但没有任何有效任务使用。停用后从管理列表隐藏；历史任务的标签不变。"
                empty="没有可清理的未使用标签。"
              >
                {preview.unused.map((u) => (
                  <UnusedRow
                    key={u.name}
                    row={u}
                    checked={retire.has(u.name)}
                    onChange={() => toggleRetire(u.name)}
                  />
                ))}
              </CleanupSection>
              <CleanupSection
                title={`相似标签（${preview.similar.length} 组）`}
                hint="大小写 / 重复空格 / 首尾空白差异的标签。合并后只保留目标，原标签上的历史任务不变。"
                empty="没有相似标签。"
              >
                {preview.similar.map((g) => (
                  <SimilarGroupRow
                    key={g.key}
                    group={g}
                    selectedTarget={merges.get(g.key) ?? g.target}
                    onChangeTarget={(t) => setTarget(g.key, t)}
                  />
                ))}
              </CleanupSection>
            </>
          )}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn-secondary" onClick={() => void onRefresh()} disabled={loading || applying}>
            重新扫描
          </button>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={applying}>取消</button>
          <button
            type="button"
            className="btn-primary"
            disabled={applying || loading || (!retire.size && !Array.from(merges.values()).some((target, i) => {
              const g = preview?.similar[i];
              return g && g.members.some((m) => m.name === target);
            }))}
            onClick={() => void apply()}
          >
            {applying ? '清理中…' : '应用'}
          </button>
        </div>
      </div>
    </div>
  );
};

const CleanupSection: React.FC<{ title: string; hint: string; empty: string; children: React.ReactNode }> = ({
  title, hint, empty, children,
}) => {
  const arr = React.Children.toArray(children);
  return (
    <section style={{ marginBottom: 16 }}>
      <h4 style={{ marginBottom: 4 }}>{title}</h4>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8, lineHeight: 1.5 }}>{hint}</div>
      {arr.length === 0 ? <div className="muted" style={{ fontSize: 12 }}>{empty}</div> : children}
    </section>
  );
};

const UnusedRow: React.FC<{ row: CleanupPreviewUnused; checked: boolean; onChange(): void }> = ({ row, checked, onChange }) => (
  <label className="cleanup-row">
    <input type="checkbox" checked={checked} onChange={onChange} />
    <span className="cleanup-row__name">{row.name}</span>
    <span className="cleanup-row__hint">历史任务 {row.historicalCount} 个不受影响</span>
  </label>
);

const SimilarGroupRow: React.FC<{
  group: CleanupPreviewSimilarGroup;
  selectedTarget: string;
  onChangeTarget(t: string): void;
}> = ({ group, selectedTarget, onChangeTarget }) => (
  <div className="cleanup-similar">
    <div className="cleanup-similar__members">
      {group.members.map((m) => (
        <span
          key={m.name}
          className={`cleanup-similar__member${m.name === selectedTarget ? ' is-target' : ''}`}
          title={m.name === selectedTarget ? '目标（保留）' : `合并到 ${selectedTarget}`}
        >
          #{m.name} <span className="muted">×{m.activeCount}</span>
        </span>
      ))}
    </div>
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      <span className="muted">目标:</span>
      <select
        className="input"
        value={selectedTarget}
        onChange={(e) => onChangeTarget(e.target.value)}
        style={{ fontSize: 12, padding: '2px 6px' }}
      >
        {group.members.map((m) => (
          <option key={m.name} value={m.name}>{m.name}</option>
        ))}
      </select>
    </label>
  </div>
);
