// Stats — totals, completion rate, AI spend.

import React from 'react';
import { useStats } from '../hooks/useTodoListApi';

export const StatsPane: React.FC = () => {
  const { stats } = useStats(7);
  if (!stats) return <div style={{ padding: 'var(--space-lg)' }}>加载中…</div>;

  return (
    <div
      style={{
        padding: 'var(--space-lg)',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 'var(--space-md)',
      }}
    >
      <Card label="总 TODO" value={stats.total} />
      <Card label="已完成" value={stats.byStatus.done} accent="var(--accent-success)" />
      <Card label="进行中" value={stats.byStatus.doing} accent="var(--accent-primary)" />
      <Card label="完成率" value={`${Math.round(stats.completionRate7d * 100)}%`} />
      <Card label="平均完成耗时" value={`${Math.round(stats.avgDoneLatencyMs / 1000)}s`} accent="var(--accent-info)" />
    </div>
  );
};

const Card: React.FC<{ label: string; value: React.ReactNode; accent?: string }> = ({ label, value, accent }) => (
  <div
    style={{
      padding: 'var(--space-lg)',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)',
    }}
  >
    <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--font-sm)' }}>{label}</div>
    <div style={{ fontSize: 'var(--font-2xl)', fontWeight: 700, color: accent ?? 'var(--fg-primary)', marginTop: 4 }}>
      {value}
    </div>
  </div>
);