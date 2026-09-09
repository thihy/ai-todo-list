// Settings — API key, model, streaming, hotkey, theme, data directory.

import React, { useEffect, useState } from 'react';
import { useSettings } from '../hooks/useTodoListApi';
import type { AIModel } from '../../shared/ai-types';

export const SettingsPane: React.FC = () => {
  const { data, patch, chooseDataDir } = useSettings();
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [relocating, setRelocating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (data) setApiKey('');
  }, [data]);

  if (!data) return <div style={{ padding: 'var(--space-lg)' }}>加载中…</div>;

  const onChangeDataDir = async (): Promise<void> => {
    setRelocating(true);
    const path = await chooseDataDir();
    setRelocating(false);
    if (path) {
      setNotice(`数据目录已更改为 ${path}，应用即将重启…`);
    }
  };

  return (
    <form className="settings-pane" autoComplete="off">
      <h1 className="pane-title">设置</h1>

      <Field label="DeepSeek API Key" hint="仅保存在本地；渲染层永远只看到脱敏后的版本。">
        <div className="row">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={data.apiKeyRedacted || 'sk-...'}
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
            onClick={() => { void patch({ apiKey }); setApiKey(''); }}
          >
            保存
          </button>
        </div>
      </Field>

      <Field label="模型">
        <select
          className="input"
          value={data.model}
          onChange={(e) => { void patch({ model: e.target.value as AIModel }); }}
        >
          <option value="deepseek-chat">deepseek-chat</option>
          <option value="deepseek-reasoner">deepseek-reasoner</option>
        </select>
      </Field>

      <Field label="流式响应">
        <label className="toggle">
          <input
            type="checkbox"
            checked={data.streaming}
            onChange={(e) => { void patch({ streaming: e.target.checked }); }}
          />
          <span>启用流式输出</span>
        </label>
      </Field>

      <Field label="快速捕获快捷键" hint="例如 CommandOrControl+Shift+T">
        <input
          className="input mono"
          value={data.captureHotkey}
          onChange={(e) => { void patch({ captureHotkey: e.target.value }); }}
          placeholder="CommandOrControl+Shift+T"
        />
      </Field>

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

      <Field label="主题">
        <select
          className="input"
          value={data.theme}
          onChange={(e) => { void patch({ theme: e.target.value as 'system' | 'light' | 'dark' }); }}
        >
          <option value="system">跟随系统</option>
          <option value="dark">深色</option>
          <option value="light">浅色</option>
        </select>
      </Field>

      <Field
        label="自动归档"
        hint="已完成的任务超过此处设定的天数后，自动进入「归档」以保持列表清爽。设为 0 则关闭自动归档。归档任务可在 过滤→归档 中查看与恢复。"
      >
        <div className="row">
          <input
            type="number"
            min={0}
            className="input mono"
            value={data.archiveAfterDays}
            onChange={(e) => {
              const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
              void patch({ archiveAfterDays: n });
            }}
          />
          <span className="muted" style={{ alignSelf: 'center' }}>天</span>
        </div>
      </Field>

      <Field label="用量统计">
        <div className="muted mono">
          本月累计 ${data.monthlyCostUsd.toFixed(2)} · 心跳{' '}
          {data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).toLocaleString() : '—'}
        </div>
      </Field>

      {notice && <div className="notice">{notice}</div>}
    </form>
  );
};

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="field">
    <label className="field-label">{label}</label>
    {children}
    {hint && <div className="field-hint">{hint}</div>}
  </div>
);
