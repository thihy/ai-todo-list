// 「今日待办」 定时提醒 —— 每小时 tick 一次，比较本地 HH:MM 与设置里的
// dailyPlanReminderTime；匹配且今天还没有任何 plannedFor 时，弹一条系统
// 通知；点击通知聚焦主窗口并触发渲染端的 plan-guide modal（沿用现有
// `app:plan-guide` 事件）。
//
// 设计选择：
// - 用 setInterval(60 分钟) 而不是 cron-like setTimeout，因为我们要的是"近似
//   一小时一次"；App 在系统休眠期间不 tick（系统唤醒后会立刻触发一次，因为
//   间隔累加），用户桌面锁屏时弹通知反而是想要的行为。
// - 启动后立即跑一次 tick，让"刚才开机正好错过提醒时间 + 今天还没安排"的
//   用户立即收到通知，不必等下一个整小时。
// - HH:MM 比对时同时带 todayKey 的"当日"语义：HH:MM 匹配时若 plannedFor
//   集合里已经有今天 'YYYY-MM-DD' 的 stamp，抑制通知；用 repo.countPlannedFor(todayKey)
//   直接走 idx_todos_planned_for 索引。
// - 通知点击：`webContents.send('app:plan-guide', {})` + window.show()/focus()。
//   show() 把最小化/隐藏的窗口拉回，focus() 在 macOS 上需要 show() 配合。
// - 「改天再提醒」 / 「跳过」的 snooze 状态由渲染端写 settings，本模块只读
//   settings.snoozePlanGuideUntil —— snooze 期内不弹通知，与 boot-time guide
//   共享同一抑制窗口。
// - lastPlanGuideDate 的语义由渲染端处理：本模块只关心"今天还没计划过"。

import { Notification, BrowserWindow } from 'electron';
import { logger } from '../logger';
import type { SettingsStore } from '../settings/store';
import type { TodoRepo } from '../db/todo-repo';

export interface PlanReminderDeps {
  settings: SettingsStore;
  repo: TodoRepo;
  /** 给通知点击用的主窗口句柄。可能尚未创建（冷启动 race）；返回 null 时
   *  只发事件，不 show/focus —— 渲染端 mount 时自行拉回。 */
  getMainWindow: () => BrowserWindow | null;
}

const TICK_MS = 60 * 60 * 1000;
const NOTIFICATION_TITLE = '今天安排些什么？';
const NOTIFICATION_BODY = '点一下，选几个任务加入今日待办。';

/** Today's local date as 'YYYY-MM-DD'. Compared against planned_for by
 *  equality (the renderer uses the same key format). Date strings are
 *  tz-stable — a stamp written in one tz reads back correctly after
 *  waking up in another. */
export function todayDateKey(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Returns "HH:MM" of `d` in local time. */
function hhmm(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Validate a stored dailyPlanReminderTime string. We accept only strict
 *  HH:MM (24h); anything else falls back to the default 09:00 so a typo in
 *  settings.json can't silently disable reminders. */
function normalizeReminderTime(s: string | undefined): string {
  if (typeof s === 'string' && /^\d{2}:\d{2}$/.test(s)) return s;
  return '09:00';
}

/** Should the current tick fire a notification? Combines snooze + daily
 *  window + already-planned guards. Pure function — exported for tests. */
export function shouldFire(args: {
  /** Current local HH:MM. */
  now: string;
  /** Stored reminder HH:MM (already normalized). */
  target: string;
  /** Tasks planned for todayStart (active, non-deleted, non-archived). */
  plannedToday: number;
  /** epoch ms; snoozePlanGuideUntil > now → suppress. */
  snoozeUntil: number | null;
  /** epoch ms. */
  nowMs: number;
}): boolean {
  if (args.snoozeUntil != null && args.snoozeUntil > args.nowMs) return false;
  if (args.plannedToday > 0) return false;
  return args.now === args.target;
}

/** Lazy Notification.isSupported() — Electron returns false in headless CI
 *  where libnotify isn't installed. Skip quietly in that case; the user just
 *  won't see notifications, the app keeps running. */
function notificationsSupported(): boolean {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

export interface PlanReminderHandle {
  /** Stop the timer (idempotent). Call from app's `before-quit`. */
  stop: () => void;
  /** Run a tick immediately (useful for tests + manual `tickNow()` plumbing). */
  tickNow: () => void;
}

/** Install the hourly reminder. Returns a handle with stop()/tickNow(). */
export function schedulePlanReminder(deps: PlanReminderDeps): PlanReminderHandle {
  let lastTarget: string | null = null; // de-dupe: only one notification per HH:MM match
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    try {
      const settings = deps.settings.get();
      const target = normalizeReminderTime(settings.dailyPlanReminderTime);
      const todayKey = todayDateKey();
      const now = new Date();
      const hhmmNow = hhmm(now);

      // Within one HH:MM minute, suppress duplicate notifications (the user
      // might not have dismissed it within the same minute; OS normally
      // replaces, but be defensive against slow libnotify stacks).
      if (lastTarget === target && /* same minute */ hhmmNow === target) return;

      const planned = deps.repo.countPlannedFor(todayKey);
      const fire = shouldFire({
        now: hhmmNow,
        target,
        plannedToday: planned,
        snoozeUntil: settings.snoozePlanGuideUntil,
        nowMs: now.getTime(),
      });
      if (!fire) {
        // Reset de-dupe once we're outside the target window — when the next
        // HH:MM match comes, we should be allowed to fire again.
        if (hhmmNow !== target) lastTarget = null;
        return;
      }

      lastTarget = target;
      if (!notificationsSupported()) {
        logger.info('plan-reminder: Notification.isSupported()=false; skipping notification');
        return;
      }
      const n = new Notification({ title: NOTIFICATION_TITLE, body: NOTIFICATION_BODY });
      n.on('click', () => {
        const win = deps.getMainWindow();
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('app:plan-guide', {});
        }
      });
      n.show();
      logger.info(`plan-reminder: fired at ${hhmmNow} (target=${target}, plannedToday=${planned})`);
    } catch (err) {
      logger.warn(`plan-reminder tick failed: ${(err as Error).message}`);
    }
  };

  // Boot-time tick: catch the case where the user just launched the app
  // and it's within the reminder window — they shouldn't have to wait an
  // hour for the first notification. Tiny delay so app.whenReady() finishes
  // and any startup-modal flow can settle.
  setTimeout(tick, 5_000);
  timer = setInterval(tick, TICK_MS);

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickNow: tick,
  };
}
