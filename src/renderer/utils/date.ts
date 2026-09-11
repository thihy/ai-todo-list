// Date helpers for the task detail "read-mode" fields. Kept dependency-free;
// the renderer owns all relative-time formatting so main stays a thin data
// layer. All comparisons are local-day based (not epoch-ms based) so "今天"
// means today's calendar day, not "within 24h".

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Next Monday strictly after today: if today IS Monday, returns today+7.
 *  Semantically "下周一" = the Monday of next week, never today (otherwise
 *  the quick chip collapses onto 今天's chip on Mondays). */
export function nextMonday(from = new Date()): Date {
  const x = startOfDay(from);
  const day = x.getDay(); // 0=Sun..6=Sat
  const delta = day === 0 ? 1 : (8 - day) % 7; // never 0 — always strictly future
  return addDays(x, delta);
}

/** Same weekday one week out: "下周一" if today is Monday → today+7; if today
 *  is Wednesday → next Wednesday (today+7, not the nearer one). Stable across
 *  the week so "下周一" always means the same anchor weekday — not "the soonest
 *  upcoming Monday" which already has `nextMonday`. */
export function nextWeek(from = new Date()): Date {
  return addDays(startOfDay(from), 7);
}

/** Same day-of-month one calendar month out (clamped to month end if the
 *  target month is shorter, e.g. May 31 → Jun 30, Jan 31 → Feb 28). Day 0 of
 *  a Date = the last day of the previous month, so we let JS pick the last
 *  day for us when the natural day overflows. */
export function nextMonth(from = new Date()): Date {
  const x = startOfDay(from);
  const y = x.getFullYear();
  const m = x.getMonth();
  const d = x.getDate();
  const lastDayNextMonth = new Date(y, m + 2, 0).getDate();
  return new Date(y, m + 1, Math.min(d, lastDayNextMonth));
}

export function toIsoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function fromIsoDate(iso: string): number {
  // Parse as local midnight so "2026-09-07" is the user's calendar day, not UTC.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime();
}

export function isOverdue(ms: number | null): boolean {
  if (!ms) return false;
  return ms < startOfDay(new Date()).getTime();
}

function dayDiff(ms: number): number {
  // Whole calendar days between today and the due day (negative = past).
  const today = startOfDay(new Date()).getTime();
  const due = startOfDay(new Date(ms)).getTime();
  return Math.round((due - today) / 86_400_000);
}

/** Read-mode due label: relative + absolute, e.g. "明天 · 09-08", "已逾期 3 天",
 *  "今天", "无截止". Designed to be scannable at a glance — the absolute date
 *  disambiguates the relative phrasing so "下周三" always carries a calendar
 *  anchor. */
export function formatDue(ms: number | null): string {
  if (!ms) return '无截止';
  const diff = dayDiff(ms);
  const abs = (() => {
    const d = new Date(ms);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${m}-${day}`;
  })();
  if (diff === 0) return `今天 · ${abs}`;
  if (diff === 1) return `明天 · ${abs}`;
  if (diff === -1) return `昨天逾期 · ${abs}`;
  if (diff === 2) return `后天 · ${abs}`;
  if (diff > 1 && diff <= 6) return `${diff} 天后 · ${abs}`;
  if (diff < -1) return `已逾期 ${-diff} 天 · ${abs}`;
  // |diff| >= 7: just the date (relative phrasing gets unwieldy past a week).
  return abs;
}
