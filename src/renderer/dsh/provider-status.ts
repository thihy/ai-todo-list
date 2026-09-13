// Provider status —— 展示用的纯配置状态。
//
// 关键约束:本模块只描述"持久化配置是否齐全"这一件事,不依赖任何网络
// 调用。已配置并不证明网络连通、模型可达或凭据有效——这些是 AI 实际
// 提问时才会发生的事,由该轮的错误展示承担,而不是常驻标签。
//
// 反向场景:配置本身缺失时(用户没填 key、custom 还没建实例),不需要
// 任何额外提示;直接显示未配置就够了。

import type { SettingsGetRes } from '../../shared/ipc-schema';

export type ProviderConfigured = boolean;

/** AI provider 配置状态——纯本地判定,无网络。 */
export type ProviderStatus =
  | { state: 'loading' }
  | { state: 'not-configured' }
  | { state: 'configured' };

/** 配置是否齐全:这是纯本地判断,只看持久化字段,不读网络。
 *
 *  null(settings 还没从主进程读到)返回 true 是历史"先乐观放行"的实现,
 *  在新的展示类型下由调用方把 null 显式映射成 loading,本函数只在 settings
 *  已就绪时调用。 */
export function isAiProviderConfigured(settings: SettingsGetRes): ProviderConfigured {
  if (settings.provider === 'ollama' || settings.provider === 'shim') return true;
  if (settings.provider === 'custom') {
    const active = settings.customProviders.find(
      (provider) => provider.id === settings.customProviderId,
    ) ?? settings.customProviders[0];
    return Boolean(active?.baseUrl.trim() && active.model.trim());
  }
  return Boolean(settings.apiKeyRedacted.trim());
}

/** 把 settings 派生成本地展示用的 ProviderStatus。
 *
 *  null 表示 settings 还没拿到(初次加载 / IPC 失败)——直接归为 loading,
 *  不要用乐观放行把"未配置"误报成"已配置"。 */
export function deriveProviderStatus(settings: SettingsGetRes | null): ProviderStatus {
  if (settings === null) return { state: 'loading' };
  if (!isAiProviderConfigured(settings)) return { state: 'not-configured' };
  return { state: 'configured' };
}
