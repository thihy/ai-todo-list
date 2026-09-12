// Provider status — splits "持久配置" vs "连通性" 两个独立信号。
//
// 已配置 (configured): 设置里有可用的 provider / apiKey / baseUrl + model 等
//   必要字段(只读持久化数据,不需要任何网络调用)。
// 已连接 (connected): 在已配置的前提下,后端对 provider 端点做过一次实际
//   探测并拿到了 2xx 响应(由 ai.health IPC 喂入)。
//
// 这两个语义必须分开:ollama 本地服务可能没启、custom baseUrl 可能填错、
// 云端 API key 可能被吊销——这些都属于"已配置但未连接"。之前的 Statusbar
// 把二者压成一个布尔,会让人误以为"只要填了 key 就一切就绪"。
//
// 反向场景:配置本身缺失时(用户没填 key、custom 还没建实例)→
// connected 状态意义不大,直接显示未配置就够了,不要再多一个"未连接"的
// 噪声标签。

import type { SettingsGetRes } from '../../shared/ipc-schema';
import type { AIHealthRes } from '../../shared/ipc-schema';

export type ProviderConfigured = boolean;

export type ProviderConnectivity =
  /** 还没探测过(尚未调用 ai.health 或在探测中)。 */
  | { state: 'unknown' }
  /** 已配置且最近一次探测成功。 */
  | { state: 'connected'; latencyMs?: number; checkedAt: number }
  /** 已配置但探测失败。 */
  | { state: 'error'; error: string; checkedAt: number }
  /** 配置本身缺失(任何连通性探测都没意义)。 */
  | { state: 'not-configured' };

export interface ProviderStatus {
  configured: ProviderConfigured;
  connectivity: ProviderConnectivity;
}

/** 配置是否齐全:这是纯本地判断,只看持久化字段,不读网络。 */
export function isAiProviderConfigured(settings: SettingsGetRes | null): ProviderConfigured {
  if (settings === null) return true; // 还在加载,先乐观放行避免闪烁
  if (settings.provider === 'ollama' || settings.provider === 'shim') return true;
  if (settings.provider === 'custom') {
    const active = settings.customProviders.find(
      (provider) => provider.id === settings.customProviderId,
    ) ?? settings.customProviders[0];
    return Boolean(active?.baseUrl.trim() && active.model.trim());
  }
  return Boolean(settings.apiKeyRedacted.trim());
}

/** 把已配置布尔 + 一次 ai.health 结果合并成统一的 ProviderStatus。
 *
 *  注意:never 暴露 API key / 任何凭据 —— health.error 在 main 进程里
 *  已经剥到只剩 HTTP 状态码或 fetch 错误信息(无 key),renderer 只读。 */
export function deriveProviderStatus(
  settings: SettingsGetRes | null,
  health: AIHealthRes | null,
  checkedAt: number,
): ProviderStatus {
  const configured = isAiProviderConfigured(settings);
  if (!configured) return { configured: false, connectivity: { state: 'not-configured' } };
  if (health === null) return { configured: true, connectivity: { state: 'unknown' } };
  if (health.ok) {
    return {
      configured: true,
      connectivity: { state: 'connected', latencyMs: health.latencyMs, checkedAt },
    };
  }
  return {
    configured: true,
    connectivity: { state: 'error', error: health.error ?? 'unknown', checkedAt },
  };
}
