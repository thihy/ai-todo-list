// Settings modal — left categories / right config. Triggered from the
// bottom-left user menu (and from the title-bar 菜单 / deep link #/settings).
// Categories: 通用 / 模型 / 数据 / 快捷键 / 关于. 模型 includes provider + model
// + API key + streaming.

import React, { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useTodoListApi';
import { useDimTitleBar } from '../hooks/useDimTitleBar';
import type { SettingsGetRes } from '../../shared/ipc-schema';
import type { SettingsPatchArgs } from '../../shared/todo-list-api';
import {
  AI_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  CUSTOM_PROTOCOLS,
  PROTOCOL_LABELS,
  type AIProvider,
  type AICustomProtocol,
  type CustomProviderInput,
} from '../../shared/ai-types';
import { TagColorPicker, TAG_PALETTE } from './TagInput';
import { TaskAppearancePane } from './TaskAppearancePane';

type Category = 'general' | 'model' | 'data' | 'tags' | 'appearance' | 'hotkeys' | 'reminder' | 'about';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型' },
  { key: 'data', label: '数据' },
  { key: 'tags', label: '标签' },
  { key: 'appearance', label: '任务配色' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'reminder', label: '提醒' },
  { key: 'about', label: '关于' },
];

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [cat, setCat] = useState<Category>('model');
  const settings = useSettings();
  // Dim the frameless titleBarOverlay (native min/max/close glyphs) while
  // this modal covers the app — see useDimTitleBar for why an IPC is needed.
  useDimTitleBar(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const { data, patch, chooseDataDir } = settings;

  return (
    <div className="settings-modal" role="dialog" aria-modal="true" aria-label="设置">
      <div className="settings-modal__backdrop" onClick={onClose} />
      <div className="settings-modal__dialog">
        <header className="settings-modal__header">
          <h2 className="settings-modal__title">设置</h2>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4L12 12 M12 4L4 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="settings-modal__body">
          <nav className="settings-modal__nav" aria-label="设置分类">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`settings-modal__nav-item${cat === c.key ? ' is-active' : ''}`}
                aria-current={cat === c.key ? 'true' : undefined}
                onClick={() => setCat(c.key)}
              >
                {c.label}
              </button>
            ))}
          </nav>
          <div className="settings-modal__content">
            {!data ? (
              <div className="muted">加载中…</div>
            ) : cat === 'general' ? (
              <GeneralPane data={data} patch={patch} />
            ) : cat === 'model' ? (
              <ModelPane data={data} patch={patch} />
            ) : cat === 'data' ? (
              <DataPane data={data} patch={patch} chooseDataDir={chooseDataDir} />
            ) : cat === 'tags' ? (
              <TagsPane data={data} patch={patch} />
            ) : cat === 'appearance' ? (
              <TaskAppearancePane
                value={data.taskAppearance}
                onChange={(next) => void patch({ taskAppearance: next })}
              />
            ) : cat === 'hotkeys' ? (
              <HotkeysPane data={data} patch={patch} />
            ) : cat === 'reminder' ? (
              <ReminderPane data={data} patch={patch} />
            ) : (
              <AboutPane data={data} patch={patch} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface PaneProps {
  data: SettingsGetRes;
  patch: (p: SettingsPatchArgs) => Promise<void>;
}

const GeneralPane: React.FC<PaneProps> = ({ data, patch }) => (
  <div className="settings-pane">
    <Field label="主题" hint="当前应用使用浅色主题。">
      <select
        className="input"
        value={data.theme}
        onChange={(e) => void patch({ theme: e.target.value as 'system' | 'light' | 'dark' })}
      >
        <option value="system">跟随系统</option>
        <option value="light">浅色</option>
        <option value="dark">深色</option>
      </select>
    </Field>
  </div>
);

const ModelPane: React.FC<PaneProps> = ({ data, patch }) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    setApiKey('');
  }, [data]);

  const isCustom = data.provider === 'custom';
  const models = PROVIDER_MODELS[data.provider] ?? [];
  const noKeyNeeded = data.provider === 'ollama' || data.provider === 'shim';

  const onProviderChange = async (p: AIProvider): Promise<void> => {
    await patch({ provider: p });
    const nextModels = PROVIDER_MODELS[p] ?? [];
    if (p !== 'custom' && !nextModels.includes(data.model)) {
      await patch({ model: nextModels[0] });
    }
  };

  return (
    <div className="settings-pane">
      <Field label="模型提供商" hint="选择 AI 服务来源；切换后请重新选择模型并填写对应的 API Key。">
        <select
          className="input"
          value={data.provider}
          onChange={(e) => void onProviderChange(e.target.value as AIProvider)}
        >
          {AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABELS[p]}
            </option>
          ))}
        </select>
      </Field>

      {isCustom ? (
        <CustomProvidersEditor data={data} patch={patch} />
      ) : (
        <>
          <Field label="模型">
            <select
              className="input"
              value={data.model}
              onChange={(e) => void patch({ model: e.target.value })}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="API Key"
            hint={`${
              noKeyNeeded
                ? '本地 / 离线提供商通常无需 API Key。'
                : '仅保存在本地；渲染层永远只看到脱敏后的版本。'
            }`}
          >
            <div className="row">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={data.apiKeyRedacted || '在此粘贴 Key…'}
                className="input mono"
                autoComplete="off"
              />
              <button type="button" className="btn-secondary" onClick={() => setShowKey((v) => !v)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!apiKey}
                onClick={() => {
                  void patch({ apiKey });
                  setApiKey('');
                }}
              >
                保存
              </button>
            </div>
          </Field>
        </>
      )}

      <Field label="流式响应">
        <label className="toggle">
          <input
            type="checkbox"
            checked={data.streaming}
            onChange={(e) => void patch({ streaming: e.target.checked })}
          />
          <span>启用流式输出</span>
        </label>
      </Field>
    </div>
  );
};

/**
 * Multi-instance editor for custom providers. The user can create arbitrarily
 * many instances (each: name / protocol / baseURL / API key / model) and pick
 * the active one. Saves send the whole list back; the store preserves API keys
 * for entries the user didn't re-type, so redacted keys are never wiped.
 */
const CustomProvidersEditor: React.FC<PaneProps> = ({ data, patch }) => {
  const custom = data.customProviders;
  const activeId = data.customProviderId ?? custom[0]?.id ?? null;

  // editingId = the instance whose fields are shown below. Defaults to active.
  const [editingId, setEditingId] = useState<string | null>(activeId);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<AICustomProtocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  // Load draft from the instance being edited whenever editingId changes.
  // (Not on every `custom` refresh — that would clobber unsaved edits; after a
  // save the typed values already match the persisted ones, and we clear the
  // apiKey draft manually in onSave.)
  useEffect(() => {
    const inst = custom.find((c) => c.id === editingId);
    setName(inst?.name ?? '');
    setProtocol(inst?.protocol ?? 'openai');
    setBaseUrl(inst?.baseUrl ?? '');
    setModel(inst?.model ?? '');
    setApiKey('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // If the active instance was deleted externally, fall back to null editing.
  useEffect(() => {
    if (editingId && !custom.some((c) => c.id === editingId)) {
      setEditingId(custom[0]?.id ?? null);
    }
  }, [custom, editingId]);

  const editing = custom.find((c) => c.id === editingId) ?? null;

  const onNew = async (): Promise<void> => {
    const id = crypto.randomUUID();
    const newInstance: CustomProviderInput = {
      id,
      name: `实例 ${custom.length + 1}`,
      protocol: 'openai',
      baseUrl: '',
      model: '',
    };
    await patch({ customProviders: [...toInputs(custom), newInstance], customProviderId: id });
    setEditingId(id);
  };

  const onSave = async (): Promise<void> => {
    if (!editingId) return;
    const next = toInputs(custom).map((c) =>
      c.id === editingId
        ? { id: c.id, name, protocol, baseUrl, model, ...(apiKey ? { apiKey } : {}) }
        : c,
    );
    await patch({ customProviders: next, customProviderId: editingId });
    setApiKey('');
  };

  const onDelete = async (): Promise<void> => {
    if (!editingId) return;
    const next = toInputs(custom).filter((c) => c.id !== editingId);
    const nextActive = next[0]?.id ?? null;
    await patch({ customProviders: next, customProviderId: nextActive });
    setEditingId(nextActive);
  };

  const onSelectInstance = async (id: string): Promise<void> => {
    setEditingId(id);
    await patch({ customProviderId: id });
  };

  const dirty =
    !!editing &&
    (editing.name !== name ||
      editing.protocol !== protocol ||
      editing.baseUrl !== baseUrl ||
      editing.model !== model ||
      apiKey.length > 0);

  return (
    <>
      <Field label="自定义实例" hint="可创建多个自定义提供商实例（各自协议 / baseURL / Key / 模型），从下拉中选择当前生效的实例。">
        <div className="row">
          <select
            className="input"
            value={activeId ?? ''}
            onChange={(e) => void onSelectInstance(e.target.value)}
            aria-label="选择当前生效的自定义实例"
          >
            {custom.length === 0 ? (
              <option value="">尚未创建</option>
            ) : (
              custom.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || '（未命名）'}
                  {c.id === activeId ? ' · 当前' : ''}
                </option>
              ))
            )}
          </select>
          <button type="button" className="btn-secondary" onClick={() => void onNew()}>
            ＋ 新建
          </button>
          {editing && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onDelete()}
              disabled={custom.length === 0}
            >
              删除
            </button>
          )}
        </div>
      </Field>

      {editing ? (
        <>
          <Field label="实例名称" hint="便于区分的标签，例如 OpenRouter、公司网关。">
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="实例名称"
              autoComplete="off"
            />
          </Field>

          <Field
            label="API 协议"
            hint="OpenAI（/chat/completions）、OpenAI Responses（/responses）或 Anthropic（/messages）。"
          >
            <select
              className="input"
              value={protocol}
              onChange={(e) => setProtocol(e.target.value as AICustomProtocol)}
            >
              {CUSTOM_PROTOCOLS.map((p) => (
                <option key={p} value={p}>
                  {PROTOCOL_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Base URL"
            hint="服务根地址，通常含版本号，例如 https://api.openai.com/v1 或 https://api.anthropic.com。"
          >
            <input
              type="text"
              className="input mono"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
          </Field>

          <Field label="模型名称" hint="自定义提供商下的模型标识，例如 gpt-4o、claude-3-5-sonnet-20241022。">
            <input
              type="text"
              className="input mono"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="模型 ID"
              autoComplete="off"
            />
          </Field>

          <Field label="API Key" hint="仅保存在本地；渲染层只看到脱敏后的版本。留空保存则保留原 Key。">
            <div className="row">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={editing.apiKeyRedacted || '在此粘贴 Key…'}
                className="input mono"
                autoComplete="off"
              />
              <button type="button" className="btn-secondary" onClick={() => setShowKey((v) => !v)}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty}
                onClick={() => void onSave()}
              >
                保存
              </button>
            </div>
          </Field>
        </>
      ) : (
        <div className="field-hint">
          尚未创建自定义实例。点击「新建」添加一个，填写其协议、Base URL、模型与 API Key。
        </div>
      )}
    </>
  );
};

/** Strip a view list to the writable input shape (no apiKey) so the store merge
 *  preserves existing keys. */
function toInputs(
  views: { id: string; name: string; protocol: AICustomProtocol; baseUrl: string; model: string }[],
): CustomProviderInput[] {
  return views.map((c) => ({ id: c.id, name: c.name, protocol: c.protocol, baseUrl: c.baseUrl, model: c.model }));
}

const DataPane: React.FC<PaneProps & { chooseDataDir: () => Promise<string | null> }> = ({
  data,
  chooseDataDir,
}) => {
  const [relocating, setRelocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const onChangeDataDir = async (): Promise<void> => {
    setRelocating(true);
    const path = await chooseDataDir();
    setRelocating(false);
    if (path) setNotice(`数据目录已更改为 ${path}，应用即将重启…`);
  };

  return (
    <div className="settings-pane">
      <Field
        label="数据目录"
        hint="TODO、Markdown、绘图与数据库都保存在此目录。更改后将自动重启应用以从新位置加载。"
      >
        <div className="row">
          <input className="input mono" value={data.dataDir} readOnly aria-label="当前数据目录" />
          <button
            type="button"
            className="btn-secondary"
            disabled={relocating}
            onClick={() => void onChangeDataDir()}
          >
            {relocating ? '选择中…' : '更改…'}
          </button>
        </div>
      </Field>
      {notice && <div className="notice">{notice}</div>}
    </div>
  );
};

const HotkeysPane: React.FC<PaneProps> = ({ data, patch }) => (
  <div className="settings-pane">
    <Field label="快速捕获快捷键" hint="例如 CommandOrControl+Shift+T">
      <input
        className="input mono"
        value={data.captureHotkey}
        onChange={(e) => void patch({ captureHotkey: e.target.value })}
        placeholder="CommandOrControl+Shift+T"
      />
    </Field>
  </div>
);

const TagsPane: React.FC<PaneProps> = ({ data, patch }) => {
  const tags = data.tags ?? [];
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_PALETTE[0]!);

  const commit = (next: { name: string; color: string }[]): void => {
    void patch({ tags: next });
  };

  const add = (): void => {
    const n = name.trim().replace(/^#/, '');
    if (!n) return;
    if (tags.some((t) => t.name.toLowerCase() === n.toLowerCase())) {
      setName('');
      return;
    }
    commit([...tags, { name: n, color }]);
    setName('');
    setColor(TAG_PALETTE[tags.length % TAG_PALETTE.length]!);
  };

  const remove = (n: string): void => commit(tags.filter((t) => t.name !== n));
  const recolor = (n: string, c: string): void =>
    commit(tags.map((t) => (t.name === n ? { ...t, color: c } : t)));
  const rename = (n: string, nn: string): void => {
    const trimmed = nn.trim();
    if (!trimmed || trimmed === n) return;
    if (tags.some((t) => t.name.toLowerCase() === trimmed.toLowerCase())) return;
    commit(tags.map((t) => (t.name === n ? { ...t, name: trimmed } : t)));
  };

  return (
    <div className="settings-pane">
      <Field label="标签管理" hint="为标签设置颜色；在任务详情中输入即可联想、新建。">
        <div className="settings-tags">
          {tags.length === 0 && <div className="muted">还没有标签。在任务详情中新建，或在此添加。</div>}
          {tags.map((t) => (
            <div key={t.name} className="settings-tags__row">
              <TagColorPicker value={t.color} onChange={(c) => recolor(t.name, c)} ariaLabel={`${t.name} 颜色`} />
              <input
                className="input settings-tags__name"
                defaultValue={t.name}
                onBlur={(e) => rename(t.name, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              />
              <button type="button" className="settings-tags__del" onClick={() => remove(t.name)} aria-label={`删除标签 ${t.name}`}>
                ×
              </button>
            </div>
          ))}
          <div className="settings-tags__row settings-tags__row--new">
            <TagColorPicker value={color} onChange={setColor} ariaLabel="新标签颜色" />
            <input
              className="input settings-tags__name"
              placeholder="新标签名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            />
            <button type="button" className="btn-secondary" onClick={add} disabled={!name.trim()}>添加</button>
          </div>
        </div>
      </Field>
    </div>
  );
};

/** 每日计划提醒面板 — 控制 `dailyPlanReminderTime`（HH:MM）。到点且今天
 *  还没安排任何任务时，主进程会弹一次系统通知（参见
 *  src/main/notification/plan-reminder.ts）。时间的修改立即生效：调度器读
 *  settings.get() 在每次 tick 时拿最新值。 */
const ReminderPane: React.FC<PaneProps> = ({ data, patch }) => {
  // HTML time input expects `HH:MM`。空字符串 → 退回默认 09:00（与 store DEFAULTS 一致）。
  const onTimeChange = (value: string): void => {
    const v = value && /^\d{2}:\d{2}$/.test(value) ? value : '09:00';
    void patch({ dailyPlanReminderTime: v });
  };
  return (
    <div className="settings-pane">
      <Field
        label="每日提醒时间"
        hint="到点时如果今天还没有安排任何任务，主进程会发送一次系统通知；点击通知会打开计划引导窗口。默认 09:00。"
      >
        <input
          className="input mono"
          type="time"
          value={data.dailyPlanReminderTime ?? '09:00'}
          onChange={(e) => onTimeChange(e.target.value)}
        />
      </Field>
      <div className="muted" style={{ fontSize: 'var(--font-xs)', lineHeight: 1.6 }}>
        「今日待办」区里的「改天再提醒」会把这个引导延后 24 小时；跳过或确认后当天不再询问。
      </div>
    </div>
  );
};

const AboutPane: React.FC<PaneProps> = ({ data }) => (
  <div className="settings-pane">
    <p className="muted" style={{ lineHeight: 1.8 }}>
      AI待办 — AI 原生 TODO 清单 · Markdown 进展 · Excalidraw 绘图
    </p>
    <Field label="用量统计">
      <div className="muted mono">
        本月累计 ${data.monthlyCostUsd.toFixed(2)} · 心跳{' '}
        {data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).toLocaleString() : '—'}
      </div>
    </Field>
  </div>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="field">
    <label className="field-label">{label}</label>
    {children}
    {hint && <div className="field-hint">{hint}</div>}
  </div>
);
