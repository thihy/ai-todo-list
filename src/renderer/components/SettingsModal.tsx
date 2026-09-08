// Settings modal — left categories / right config. Triggered from the
// bottom-left user menu (and from the title-bar 菜单 / deep link #/settings).
// Categories: 通用 / 模型 / 数据 / 快捷键 / 关于. 模型 includes provider + model
// + API key + streaming.

import React, { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useThihyApi';
import type { SettingsGetRes } from '../../shared/ipc-schema';
import type { SettingsPatchArgs } from '../../shared/thihy-api';
import {
  AI_PROVIDERS,
  PROVIDER_LABELS,
  PROVIDER_MODELS,
  type AIProvider,
} from '../../shared/ai-types';

type Category = 'general' | 'model' | 'data' | 'hotkeys' | 'about';

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'model', label: '模型' },
  { key: 'data', label: '数据' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'about', label: '关于' },
];

export const SettingsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const [cat, setCat] = useState<Category>('model');
  const settings = useSettings();

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
            ) : cat === 'hotkeys' ? (
              <HotkeysPane data={data} patch={patch} />
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

  const models = PROVIDER_MODELS[data.provider] ?? [];

  const onProviderChange = async (p: AIProvider): Promise<void> => {
    await patch({ provider: p });
    const nextModels = PROVIDER_MODELS[p] ?? [];
    if (!nextModels.includes(data.model)) {
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
          data.provider === 'ollama' || data.provider === 'shim'
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

const AboutPane: React.FC<PaneProps> = ({ data }) => (
  <div className="settings-pane">
    <p className="muted" style={{ lineHeight: 1.8 }}>
      thihy-todolist — AI 原生 TODO 清单 · Markdown 进展 · Excalidraw 绘图
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
