// Settings modal — left categories / right config. Triggered from the
// bottom-left user menu (and from the title-bar 菜单 / deep link #/settings).
// Categories: 通用 / 模型 / 数据 / 快捷键 / 关于. 模型 includes provider + model
// + API key + streaming.

import React, { useCallback, useEffect, useState } from 'react';
import { useSettings, useSettingsPatchWithToast, useStartupAiState, useAppEvent } from '../hooks/useTodoListApi';
import { useDimTitleBar } from '../hooks/useDimTitleBar';
import { useToastBus } from './Toast';
import type { BackupManifest, HealthIssue, HealthIssueKind, HealthSeverity, SettingsGetRes } from '../../shared/ipc-schema';
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
import { TagManagementPane } from './TagManagementPane';
import { TaskAppearancePane } from './TaskAppearancePane';

type Category = 'general' | 'model' | 'data' | 'tags' | 'appearance' | 'hotkeys' | 'reminder' | 'integration' | 'health' | 'about';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型' },
  { key: 'data', label: '数据' },
  { key: 'tags', label: '标签' },
  { key: 'appearance', label: '任务配色' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'reminder', label: '提醒' },
  { key: 'integration', label: '外部访问' },
  { key: 'health', label: '健康' },
  { key: 'about', label: '关于' },
];

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [cat, setCat] = useState<Category>('model');
  const settings = useSettings();
  // `patchWithToast` swallows save failures into an error toast — used by
  // the simple, per-keystroke panels below. TaskAppearancePane + ModelPane
  // + CustomProvidersEditor get the raw `patch` (which throws) so they can
  // drive their own branch-on-outcome UI (clear draft only on success,
  // surface inline error, etc.).
  const patchWithToast = useSettingsPatchWithToast();
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
              <GeneralPane data={data} patch={patchWithToast} />
            ) : cat === 'model' ? (
              // ModelPane branches on save outcome (clear API key only on
              // success, etc.) — must receive the raw patch that throws on
              // failure, NOT patchWithToast which would mask the failure
              // and let the success branch fire anyway.
              <ModelPane data={data} patch={patch} />
            ) : cat === 'data' ? (
              <DataPane data={data} patch={patchWithToast} chooseDataDir={chooseDataDir} />
            ) : cat === 'tags' ? (
              // TagManagementPane replaces the old TagsPane. The catalog
              // is DB-backed since v17 — settings.tags is no longer the
              // source of truth. The pane uses useTagList / tag.* channels
              // for read / rename / merge / cleanup, and listens to
              // app:tags-changed via the data bus for live refresh.
              <TagManagementPane />
            ) : cat === 'appearance' ? (
              <TaskAppearancePane
                value={data.taskAppearance}
                customPresets={data.taskAppearanceCustomPresets ?? []}
                onSave={async (next, nextCustomPresets) => {
                  await patch({
                    taskAppearance: next,
                    taskAppearanceCustomPresets: nextCustomPresets,
                  });
                }}
              />
            ) : cat === 'hotkeys' ? (
              <HotkeysPane data={data} patch={patchWithToast} />
            ) : cat === 'reminder' ? (
              <ReminderPane data={data} patch={patchWithToast} />
            ) : cat === 'integration' ? (
              // SEC-01 — JSON-RPC bridge toggle / token management. Toggling
              // requires restart; the pane surfaces that explicitly so the
              // user isn't surprised when the socket doesn't bind/unbind
              // immediately.
              <BridgePane data={data} />
            ) : cat === 'health' ? (
              // QUALITY-01 — deterministic task health. Read-only; the
              // pane re-queries when the user clicks "刷新" or after a
              // data-changed event (see useDataVersion refresh).
              <HealthPane />
            ) : (
              <AboutPane data={data} patch={patchWithToast} />
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
    {/* 日志级别：默认 info。需要抓 stop-stuck / LLM 交互现场时切到 debug，
        所有 [LLM ...] chunk / TTFB / abort 都会立刻写入 todo-list.log。
        切换后立即生效，无需重启。 */}
    <Field
      label="日志级别"
      hint="控制主进程写入 todo-list.log 的详细程度。调试大模型交互（stop-stuck / 超时 / 401 等）时切到 debug 即可抓现场，无需重启。日常保持 info 即可。"
    >
      <select
        className="input"
        value={data.logLevel}
        onChange={(e) => void patch({ logLevel: e.target.value as 'debug' | 'info' | 'warn' | 'error' })}
      >
        <option value="debug">debug · 详细诊断</option>
        <option value="info">info · 默认</option>
        <option value="warn">warn · 仅警告</option>
        <option value="error">error · 仅错误</option>
      </select>
    </Field>
  </div>
);

const ModelPane: React.FC<PaneProps> = ({ data, patch }) => {
  const toast = useToastBus();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  // Inline error status for the API Key save row. The toast is fine for the
  // simple toggle/select paths, but a save failure here must keep the user's
  // Key draft intact AND visibly tell them so they can decide whether to
  // retry — Key contents are not echoed in the toast (we never log them).
  const [keyError, setKeyError] = useState<string | null>(null);
  // Local draft for the User-Agent field. Synced from persisted settings so a
  // change broadcast (e.g. another pane triggering a re-fetch) doesn't clobber
  // an in-flight edit; patched on blur so typing isn't a request storm.
  const [userAgent, setUserAgent] = useState(data.userAgent);

  // UX-01 — when the AI component is in 'failed' state, a successful
  // settings save should automatically schedule a retry so the user
  // doesn't have to bounce back to the AI pane to click "重试". This
  // hook is local to ModelPane because model-related fields are the
  // ones that unblock a previously-failed DSH boot (provider / apiKey /
  // model / custom providers).
  const { state: aiStartup, retry: retryAi } = useStartupAiState();

  useEffect(() => {
    setApiKey('');
    setKeyError(null);
    setUserAgent(data.userAgent);
  }, [data]);

  const isCustom = data.provider === 'custom';
  const models = PROVIDER_MODELS[data.provider] ?? [];
  const noKeyNeeded = data.provider === 'ollama' || data.provider === 'shim';

  // After any AI-relevant save that completes while ai is 'failed', ask
  // main to retry the boot. No-op otherwise — main will reject if the
  // component isn't in 'failed' state.
  const maybeAutoRetryAi = useCallback((): void => {
    if (aiStartup.status !== 'failed') return;
    void retryAi();
  }, [aiStartup.status, retryAi]);

  // Switching provider often invalidates the selected model (different
  // provider's model list doesn't contain the previous one). Merge into one
  // patch so a partial-write failure doesn't strand us on a new provider
  // with a stale / unsupported model still selected.
  const onProviderChange = async (p: AIProvider): Promise<void> => {
    const nextModels = PROVIDER_MODELS[p] ?? [];
    const nextPatch: SettingsPatchArgs =
      p !== 'custom' && !nextModels.includes(data.model)
        ? { provider: p, model: nextModels[0] }
        : { provider: p };
    try {
      await patch(nextPatch);
      maybeAutoRetryAi();
    } catch (err) {
      // Bubble as a toast so the user knows the switch didn't stick. Keep
      // the draft select value as-is — on next render `data.provider` is
      // unchanged so the control reflects the persisted value.
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `切换提供商失败：${reason}`, ttl: 3000 });
    }
  };

  const onSaveApiKey = async (): Promise<void> => {
    if (!apiKey || savingKey) return;
    setSavingKey(true);
    setKeyError(null);
    try {
      await patch({ apiKey });
      // 成功 —— 清空本地草稿;若稍后失败,草稿仍在 input 里。
      setApiKey('');
      maybeAutoRetryAi();
    } catch (err) {
      // 失败 —— 草稿保留;把原因显示给用户。绝不把密钥本身写进消息。
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      setKeyError(`保存失败：${reason}（草稿已保留，可重试）`);
    } finally {
      setSavingKey(false);
    }
  };

  // 流式开关的单独 patch —— 失败必须吞 toast,不让 select 卡在错误态。
  const onStreamingChange = async (checked: boolean): Promise<void> => {
    try {
      await patch({ streaming: checked });
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `更新流式设置失败：${reason}`, ttl: 3000 });
    }
  };

  // User-Agent 在 blur 时 patch。空字符串回退到适配器默认
  // (deepseek-harness/…);非空才覆盖。失败 toast,草稿保留。
  const onUserAgentBlur = async (): Promise<void> => {
    const next = userAgent.trim();
    if (next === data.userAgent) return;
    try {
      await patch({ userAgent: next });
      maybeAutoRetryAi();
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `更新 User-Agent 失败：${reason}`, ttl: 3000 });
      setUserAgent(data.userAgent);
    }
  };

  // 切换 model —— 失败 toast,保留 select 显示当前持久化值。
  const onModelChange = async (next: string): Promise<void> => {
    try {
      await patch({ model: next as typeof data.model });
      maybeAutoRetryAi();
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      toast.push({ kind: 'error', message: `切换模型失败：${reason}`, ttl: 3000 });
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
              onChange={(e) => void onModelChange(e.target.value)}
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
                onChange={(e) => { setApiKey(e.target.value); if (keyError) setKeyError(null); }}
                placeholder={data.apiKeyRedacted || '在此粘贴 Key…'}
                className="input mono"
                autoComplete="off"
                disabled={savingKey}
              />
              <button type="button" className="btn-secondary" onClick={() => setShowKey((v) => !v)} disabled={savingKey}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!apiKey || savingKey}
                onClick={() => void onSaveApiKey()}
              >
                {savingKey ? '保存中…' : '保存'}
              </button>
            </div>
            {keyError && (
              <div
                className="field-hint"
                role="status"
                aria-live="polite"
                style={{ color: 'var(--accent-danger)' }}
              >
                {keyError}
              </div>
            )}
          </Field>
        </>
      )}

      <Field label="流式响应">
        <label className="toggle">
          <input
            type="checkbox"
            checked={data.streaming}
            onChange={(e) => void onStreamingChange(e.target.checked)}
          />
          <span>启用流式输出</span>
        </label>
      </Field>

      <Field
        label="User-Agent"
        hint="发送给 LLM 提供商的 User-Agent 请求头。默认 TodoList；留空回退到适配器内置值 (deepseek-harness/…)。"
      >
        <input
          type="text"
          className="input mono"
          value={userAgent}
          onChange={(e) => setUserAgent(e.target.value)}
          onBlur={() => void onUserAgentBlur()}
          placeholder="TodoList"
          autoComplete="off"
        />
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

  // UX-01 — same auto-retry logic as ModelPane: any successful save here
  // that touches provider / apiKey / baseUrl / model will re-trigger DSH
  // boot if the previous attempt failed. We gate on `ai.status === 'failed'`
  // to avoid pointless IPC round-trips on every save when ai is healthy.
  const { state: aiStartup, retry: retryAi } = useStartupAiState();
  const maybeAutoRetryAi = useCallback((): void => {
    if (aiStartup.status !== 'failed') return;
    void retryAi();
  }, [aiStartup.status, retryAi]);

  // editingId = the instance whose fields are shown below. Defaults to active.
  const [editingId, setEditingId] = useState<string | null>(activeId);
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<AICustomProtocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  // Saving state machine — disables re-entry while a patch is in flight
  // and surfaces success/failure for the buttons that aren't tied to a
  // draft row (新建 / 删除 / 选择当前). The 保存 button below stays
  // tied to the existing dirty check + add its own saving flag.
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  // If the active instance was deleted externally, fall back to null editing.
  useEffect(() => {
    if (editingId && !custom.some((c) => c.id === editingId)) {
      setEditingId(custom[0]?.id ?? null);
    }
  }, [custom, editingId]);

  const editing = custom.find((c) => c.id === editingId) ?? null;

  // Run a write and surface failure inline (don't rely on toast for the
  // 草稿表单 —— 用户在敲文本框，看到 toast 还要回头找上下文)。成功后清
  // 除错误状态。
  const runSave = async (apply: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    setSaveError(null);
    try {
      await apply();
      return true;
    } catch (err) {
      const reason = err instanceof Error && err.message ? err.message : '未知错误';
      setSaveError(reason);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onNew = async (): Promise<void> => {
    if (busy) return;
    const id = crypto.randomUUID();
    const newInstance: CustomProviderInput = {
      id,
      name: `实例 ${custom.length + 1}`,
      protocol: 'openai',
      baseUrl: '',
      model: '',
    };
    const ok = await runSave(
      () => patch({ customProviders: [...toInputs(custom), newInstance], customProviderId: id }),
    );
    if (ok) {
      setEditingId(id);
      maybeAutoRetryAi();
    }
  };

  const onSave = async (): Promise<void> => {
    if (!editingId) return;
    const next = toInputs(custom).map((c) =>
      c.id === editingId
        ? { id: c.id, name, protocol, baseUrl, model, ...(apiKey ? { apiKey } : {}) }
        : c,
    );
    const ok = await runSave(
      () => patch({ customProviders: next, customProviderId: editingId }),
    );
    if (ok) {
      setApiKey('');
      maybeAutoRetryAi();
    }
  };

  const onDelete = async (): Promise<void> => {
    if (!editingId) return;
    const next = toInputs(custom).filter((c) => c.id !== editingId);
    const nextActive = next[0]?.id ?? null;
    const ok = await runSave(
      () => patch({ customProviders: next, customProviderId: nextActive }),
    );
    if (ok) setEditingId(nextActive);
  };

  const onSelectInstance = async (id: string): Promise<void> => {
    setEditingId(id);
    const ok = await runSave(() => patch({ customProviderId: id }));
    if (ok) maybeAutoRetryAi();
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
            disabled={busy}
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
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void onNew()}
            disabled={busy}
          >
            ＋ 新建
          </button>
          {editing && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onDelete()}
              disabled={busy || custom.length === 0}
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
              disabled={busy}
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
                disabled={busy}
              />
              <button type="button" className="btn-secondary" onClick={() => setShowKey((v) => !v)} disabled={busy}>
                {showKey ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!dirty || busy}
                onClick={() => void onSave()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </Field>
          {saveError && (
            <div className="field-hint" role="status" aria-live="polite" style={{ color: 'var(--accent-danger)' }}>
              保存失败：{saveError}（草稿已保留，可直接重试）
            </div>
          )}
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
  patch,
  chooseDataDir,
}) => {
  const [relocating, setRelocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // REL-01 MVP-1 — backup state. `lastBackup` is shown below the
  // button so the user can confirm a recent backup exists without
  // opening the file manager; `busy` disables the button while the
  // hot-backup is in flight (a large attachments dir can take
  // seconds to copy).
  const [backupBusy, setBackupBusy] = useState(false);
  const [lastBackup, setLastBackup] = useState<{ path: string; manifest: BackupManifest } | null>(null);

  const onChangeDataDir = async (): Promise<void> => {
    setRelocating(true);
    const path = await chooseDataDir();
    setRelocating(false);
    if (path) setNotice(`数据目录已更改为 ${path}，应用即将重启…`);
  };

  // REL-01 MVP-1 — open the OS folder picker, then trigger the backup
  // service. The flow is two IPC calls because the picker is modal
  // and the backup itself is async (SQLite online backup + recursive
  // copy); combining them into one would force the renderer to hold
  // open a modal callback while the backup writes.
  const onBackup = async (): Promise<void> => {
    setBackupBusy(true);
    setNotice(null);
    try {
      const pick = await window.todoList.app.backupChooseDest();
      if (!pick.ok) {
        setNotice(`选择目录失败：${pick.message ?? pick.code ?? '未知错误'}`);
        return;
      }
      if (pick.data.canceled || !pick.data.path) {
        // User dismissed the picker — silent no-op is the right UX.
        return;
      }
      const res = await window.todoList.app.backupCreate(pick.data.path);
      if (!res.ok) {
        setNotice(`备份失败：${res.message ?? res.code ?? '未知错误'}`);
        return;
      }
      setLastBackup({ path: res.data.path, manifest: res.data.manifest });
      // Surface the location in the same notice slot as the data-dir
      // change so the user has one consistent place to read the
      // outcome. Sizes are kept unformatted for now (renderer formats
      // would diverge across locales; the manifest stores raw bytes).
      const m = res.data.manifest;
      setNotice(
        `备份完成：${res.data.path}（${m.sizes.total} 字节；` +
          `${m.counts.todos} 任务，${m.counts.conversations} 对话）`,
      );
    } catch (err) {
      setNotice(`备份失败：${(err as Error).message}`);
    } finally {
      setBackupBusy(false);
    }
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
      {/* REL-01 MVP-1 — backup action. The hint surfaces the DSH
          session exclusion so users don't expect AI conversation
          logs in the snapshot. Restore + delete are scoped for the
          next iteration; for now the user must keep the dest folder
          themselves. */}
      <Field
        label="数据备份"
        hint="立即创建一份 SQLite + 任务 / 绘图 / 附件的快照到一个新文件夹。不包含 AI 会话日志（可在下次使用时重新生成）。恢复与删除将在下一版本提供。"
      >
        <div className="row">
          <button
            type="button"
            className="btn-secondary"
            disabled={backupBusy}
            onClick={() => void onBackup()}
            aria-label="立即备份"
          >
            {backupBusy ? '备份中…' : '立即备份…'}
          </button>
          {lastBackup && (
            <span className="muted" style={{ fontSize: 'var(--font-xs)' }}>
              上次：{lastBackup.path}
            </span>
          )}
        </div>
      </Field>
      {/* AI 对话保留上限 —— 只对未归档对话生效。0 = 不限；超过 N 时新建
          后会自动物理删最老的（按 updated_at ASC），归档对话不会被清。
          在 onChange 里做夹紧（负数 / NaN / 非整数全部丢弃），不让脏值
          落到 store。 */}
      <Field
        label="AI 对话保留数量"
        hint="单个工作区最多保留多少条未归档 AI 对话（0 = 不限）。新建对话后若超过此数，最老的会被自动物理删除。归档里的对话不受此限制。默认 100。"
      >
        <input
          className="input mono"
          type="number"
          min={0}
          max={10000}
          step={10}
          value={data.maxConversations}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n) || n < 0) return;
            const intN = Math.floor(n);
            if (intN > 10000) return;
            void patch({ maxConversations: intN });
          }}
        />
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

/** SEC-01 — bridge controls. The pane keeps the freshly-returned token
 *  in local state so the user can copy it once; we never persist it in
 *  any renderer-side store. `data.sdkBridge.token` mirrors main's
 *  current value but we treat it as opaque (the user only needs to know
 *  "there is one" — copy comes from local state). */
const BridgePane: React.FC<{ data: SettingsGetRes }> = ({ data }) => {
  const [busy, setBusy] = useState(false);
  // The most recent token we received from main. `null` = "haven't
  // gotten one back yet" or "currently disabled with no token stored".
  const [freshToken, setFreshToken] = useState<string | null>(data.sdkBridge.token);
  const [showToken, setShowToken] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset freshToken when main's response changes (broadcast or other
  // tab mutation). We only replace it if main actually has one — if
  // main reports `null`, we keep whatever the user was looking at so
  // they don't lose a copy mid-session.
  useEffect(() => {
    if (data.sdkBridge.token !== null) setFreshToken(data.sdkBridge.token);
  }, [data.sdkBridge.token]);

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.todoList.app.sdkBridgeSetEnabled(next);
      if (!res.ok) {
        setError(`保存失败：${res.message}`);
        return;
      }
      // Capture the freshly-minted token so the user can copy it.
      // When disabling, main returns the existing token (if any) —
      // we deliberately DON'T clear `freshToken` on disable because
      // re-enabling is a single click away and losing the token from
      // the UI would be surprising.
      if (res.data.token !== null) setFreshToken(res.data.token);
      setNotice(next ? '已启用，下次启动后生效。' : '已停用，下次启动后生效。');
    } catch (err) {
      setError(`保存失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.todoList.app.sdkBridgeRotateToken();
      if (!res.ok) {
        setError(`重新生成失败：${res.message}`);
        return;
      }
      setFreshToken(res.data.token);
      setShowToken(true);
      setNotice('已重新生成 token；桥接已停用，请重新启用以使其生效。');
    } catch (err) {
      setError(`重新生成失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!freshToken) return;
    try {
      await navigator.clipboard.writeText(freshToken);
      setNotice('已复制到剪贴板。');
    } catch {
      setError('复制失败：浏览器拒绝了剪贴板权限。请手动选中 token。');
    }
  };

  // Mask all but the first 4 and last 4 chars to discourage shoulder-
  // surfing while still letting the user verify they're looking at the
  // right token. Length is preserved so the user can roughly tell when
  // a rotate produced a new one.
  const masked = freshToken
    ? `${freshToken.slice(0, 4)}${'*'.repeat(Math.max(freshToken.length - 8, 0))}${freshToken.slice(-4)}`
    : null;

  return (
    <div className="settings-pane">
      <Field
        label="外部脚本 / 插件访问"
        hint="JSON-RPC 桥接（Unix socket / Windows named pipe）。默认关闭；启用后外部脚本可以查询和修改任务，但必须提供本地生成的 token。"
      >
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={data.sdkBridge.enabled}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>{data.sdkBridge.enabled ? '已启用（重启后生效）' : '未启用'}</span>
        </label>
      </Field>

      <Field
        label="监听地址"
        hint="脚本连接到该地址；非本机进程无法连接。"
      >
        <div className="row">
          <input className="input mono" value={data.sdkBridge.socketPath} readOnly aria-label="监听地址" />
        </div>
      </Field>

      <Field
        label="Capability token"
        hint={`首次启用时自动生成；点击「重新生成」会作废旧 token 并停用桥接。token 只在重启后随桥接启动时校验。脚本必须在第一次请求时附上 auth: "<token>"。`}
      >
        {freshToken ? (
          <div className="row" style={{ gap: 8 }}>
            <input
              className="input mono"
              value={showToken ? freshToken : masked ?? ''}
              readOnly
              aria-label="token"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setShowToken((v) => !v)}
              disabled={busy}
            >
              {showToken ? '隐藏' : '显示'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void copy()}
              disabled={busy || !freshToken}
            >
              复制
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void rotate()}
              disabled={busy}
            >
              重新生成
            </button>
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 'var(--font-xs)' }}>
            尚未生成 token；启用桥接时会自动创建。
          </div>
        )}
      </Field>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="notice notice--error">{error}</div>}
    </div>
  );
};

// TagsPane was deleted when the v17 catalog migration hoisted the
// tag directory into the DB; the new management surface lives in
// src/renderer/components/TagManagementPane.tsx. The pane slot in
// <SettingsModal/> now mounts <TagManagementPane/> directly.

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

/** QUALITY-01 — deterministic task health. The pane calls
 *  `app.health.check` on mount, after `app:data-changed` (via the
 *  data-bus hook), and when the user clicks "刷新". AI suggestions
 *  are NOT in scope; this pane is read-only. */
const HealthPane: React.FC = () => {
  const [issues, setIssues] = useState<HealthIssue[]>([]);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.todoList.app.healthCheck();
      if (!res.ok) {
        setError(`健康检查失败：${res.message}`);
        return;
      }
      setIssues(res.data.issues);
      setCheckedAt(res.data.checkedAt);
    } catch (err) {
      setError(`健康检查失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Re-check whenever a data-change event fires. The data bus is the
  // canonical signal — explicit refresh is only needed when the user
  // opens the pane cold.
  useEffect(() => {
    return window.todoList.on('app:data-changed', () => { void refresh(); });
  }, [refresh]);

  return (
    <div className="settings-pane">
      <Field
        label="任务健康"
        hint="按确定性规则扫描：长期 doing 无进展、已过期、blocked 无说明、父任务完成但子任务未完成、progress/status 矛盾、今日超载。只报告，不自动修复。"
      >
        <div className="row">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {busy ? '扫描中…' : '刷新'}
          </button>
          {checkedAt && (
            <span className="muted mono" style={{ fontSize: 'var(--font-xs)' }}>
              最近一次 {new Date(checkedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </Field>

      {error && <div className="notice notice--error">{error}</div>}

      {issues.length === 0 && !busy && checkedAt && (
        <div className="notice">没有发现问题。</div>
      )}

      {issues.map((issue) => (
        <div
          key={issue.kind}
          className="notice"
          data-severity={issue.severity}
          style={{
            // severity → colour: blocker = red, warn = amber, info = blue.
            borderLeft:
              issue.severity === 'blocker'
                ? '4px solid var(--danger-fg, #d97757)'
                : issue.severity === 'warn'
                  ? '4px solid var(--warning-fg, #c8a44c)'
                  : '4px solid var(--info-fg, #5eafe6)',
          }}
        >
          <div style={{ fontWeight: 500, marginBottom: 4 }}>
            {severityLabel(issue.severity)} · {kindLabel(issue.kind)}
          </div>
          <div>{issue.message}</div>
          {issue.todoIds.length > 0 && (
            <div
              className="muted"
              style={{ fontSize: 'var(--font-xs)', marginTop: 4 }}
            >
              涉及 {issue.todoIds.length} 个任务
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

function severityLabel(s: HealthSeverity): string {
  switch (s) {
    case 'blocker': return '阻断';
    case 'warn': return '警告';
    case 'info': return '提示';
  }
}

function kindLabel(k: HealthIssueKind): string {
  switch (k) {
    case 'long_doing_no_progress': return '长期 doing 无进展';
    case 'overdue': return '已过期';
    case 'blocked_no_reason': return 'blocked 无说明';
    case 'parent_done_child_open': return '父任务完成但子任务未完成';
    case 'progress_status_conflict': return 'progress / status 矛盾';
    case 'today_overload': return '今日超载';
  }
}

const AboutPane: React.FC<PaneProps> = ({ data, patch }) => {
  // OBS-01 — drive a Save-As dialog from the renderer. Two-step:
  // build the bundle (redacted in main), then ask main to write it.
  // The button is gated on `busy` to prevent double-clicks.
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-updater state (electron-updater → GitCode releases feed).
  // Initial state comes from a one-shot `updaterStatus()` read; the
  // two `app:update-*` events keep it in sync with main's
  // background auto-check without a poll loop. The hook is local
  // to this pane so other settings panes don't pay the cost.
  const [updater, setUpdater] = useState<{
    currentVersion: string;
    latestVersion: string | null;
    downloaded: boolean;
    checking: boolean;
    devMode: boolean;
  }>({
    currentVersion: '',
    latestVersion: null,
    downloaded: false,
    checking: false,
    devMode: false,
  });
  const onExport = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await window.todoList.app.diagnosticsExport();
      if (!res.ok) {
        setError(`生成诊断包失败：${res.message}`);
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const saveRes = await window.todoList.app.diagnosticsSaveToFile(
        `diagnostics-${stamp}.json`,
        res.data.json,
      );
      if (!saveRes.ok) {
        setError(`保存失败：${saveRes.message}`);
        return;
      }
      if (saveRes.data.path === null) {
        setNotice(null); // user cancelled — silent
        return;
      }
      setNotice(`已保存到 ${saveRes.data.path}`);
    } catch (err) {
      setError(`生成诊断包失败：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Open the userData directory (parent of todo-list.log) so the user
  // can grab the log file before filing a bug report. The button is
  // intentionally always-enabled: shell.openPath on a missing dir
  // surfaces the failure via the toast, no pre-flight check needed.
  const onOpenLogDir = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const res = await window.todoList.app.openLogDir();
      if (!res.ok) {
        setError(`打开日志目录失败：${res.message ?? res.code ?? '未知错误'}`);
      }
    } catch (err) {
      setError(`打开日志目录失败：${(err as Error).message}`);
    }
  };

  // Auto-updater — fetch the latest known status once when the
  // pane mounts, then keep the local copy in sync with the two
  // `app:update-*` events main emits on the background
  // auto-check. No polling — events are the source of truth.
  useEffect(() => {
    let alive = true;
    void (async (): Promise<void> => {
      const res = await window.todoList.app.updaterStatus();
      if (!alive) return;
      if (res.ok) setUpdater(res.data);
    })();
    return (): void => { alive = false; };
  }, []);

  useAppEvent('app:update-available', (p) => {
    setUpdater((prev) => ({ ...prev, latestVersion: p.version, checking: false }));
  });
  useAppEvent('app:update-downloaded', (p) => {
    setUpdater((prev) => ({
      ...prev,
      latestVersion: p.version,
      downloaded: true,
      checking: false,
    }));
  });

  // User-initiated check. The auto-check is fire-and-forget; this
  // path surfaces failure via `error` so the user knows the
  // network round-trip failed.
  const onCheckUpdate = async (): Promise<void> => {
    setUpdater((prev) => ({ ...prev, checking: true }));
    setError(null);
    try {
      const res = await window.todoList.app.updaterCheck();
      if (!res.ok) {
        setError(`检查更新失败：${res.message ?? res.code ?? '未知错误'}`);
        setUpdater((prev) => ({ ...prev, checking: false }));
        return;
      }
      setUpdater({ ...res.data, checking: false });
    } catch (err) {
      setError(`检查更新失败：${(err as Error).message}`);
      setUpdater((prev) => ({ ...prev, checking: false }));
    }
  };

  // Quit + install the already-downloaded update. The renderer's
  // job ends here — main's quitAndInstall tears down the app
  // and applies the binary on next launch.
  const onInstallUpdate = (): void => {
    void window.todoList.app.updaterInstall();
  };

  // Compose the update-status copy the user sees. Five discrete
  // states instead of a generic blob so the user always knows
  // whether an action is pending.
  const updateLabel = updater.devMode
    ? '开发模式下不可用'
    : updater.checking
      ? '正在检查更新…'
      : updater.downloaded
        ? `已下载版本 ${updater.latestVersion}，重启后生效`
        : updater.latestVersion && updater.latestVersion !== updater.currentVersion
          ? `发现新版本 ${updater.latestVersion}，下载中…`
          : updater.latestVersion
            ? `已是最新版本（${updater.latestVersion}）`
            : '尚未检查';
  return (
    <div className="settings-pane">
      <p className="muted" style={{ lineHeight: 1.8 }}>
        AI 待办 — 本地优先的 AI 辅助任务管理
      </p>
      <Field label="当前版本">
        <div className="muted mono">版本 {updater.currentVersion || '—'}</div>
      </Field>
      <Field
        label="自动更新"
        hint={
          updater.devMode
            ? '开发模式下不可用'
            : '启用后，应用启动约 5 秒会自动检查一次更新；下载完成后重启即生效。关闭后仍可手动「检查更新」获取版本。'
        }
      >
        <label className="toggle">
          <input
            type="checkbox"
            checked={data.autoUpdate}
            disabled={updater.devMode}
            onChange={(e) => { void patch({ autoUpdate: e.target.checked }); }}
          />
          <span>{data.autoUpdate ? '已启用' : '已禁用'}</span>
        </label>
      </Field>
      <Field
        label="更新"
        hint={
          updater.devMode
            ? '开发模式下自动更新不可用；请通过 pnpm dist:win / dist:mac / dist:linux 生成新版本。'
            : '自动检查启动后约 5 秒进行一次；也可点击下方按钮手动检查。下载完成后重启应用即生效。'
        }
      >
        <div className="row" style={{ alignItems: 'center', gap: 'var(--space-md)', flexWrap: 'wrap' }}>
          <div className="muted" style={{ flex: '1 1 auto', minWidth: 0 }}>{updateLabel}</div>
          {!updater.devMode && (
            <>
              <button
                type="button"
                className="btn-secondary"
                disabled={updater.checking}
                onClick={() => void onCheckUpdate()}
              >
                {updater.checking ? '检查中…' : '检查更新'}
              </button>
              {updater.downloaded && (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onInstallUpdate}
                >
                  立即重启更新
                </button>
              )}
            </>
          )}
        </div>
      </Field>
      <Field label="用量统计">
        <div className="muted mono">
          本月累计 ${data.monthlyCostUsd.toFixed(2)} · 心跳{' '}
          {data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).toLocaleString() : '—'}
        </div>
      </Field>
      <Field
        label="诊断包"
        hint="导出一份脱敏的应用 / 数据库 / 启动信息摘要（不含 API Key、token、附件、绝对路径、AI 会话正文），方便附在 bug 报告里。"
      >
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void onExport()}
        >
          {busy ? '生成中…' : '导出诊断包…'}
        </button>
      </Field>
      <Field
        label="日志目录"
        hint="应用日志（todo-list.log）与 SQLite 数据库都在这里。遇到问题时方便附在 bug 报告里。"
      >
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void onOpenLogDir()}
        >
          打开日志目录
        </button>
      </Field>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="notice notice--error">{error}</div>}
    </div>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="field">
    <label className="field-label">{label}</label>
    {children}
    {hint && <div className="field-hint">{hint}</div>}
  </div>
);
