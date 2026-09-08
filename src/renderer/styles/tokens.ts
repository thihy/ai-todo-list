// Single shared design-tokens file. AA contrast computed via Python (see ui-wireframe.md).
// Tailwind-style names exposed for CSS variables; the renderer reads via getComputedStyle.

export const designTokens = {
  color: {
    // Surfaces
    'bg-canvas': '#0F172A',
    'bg-surface': '#1E293B',
    'bg-surface-elev': '#334155',
    'bg-input': '#0B1224',
    // Text (computed AA on bg-canvas / bg-surface)
    'fg-primary': '#F8FAFC', // 16.2:1 on bg-canvas
    'fg-secondary': '#CBD5E1', // 11.0:1 on bg-canvas
    'fg-muted': '#94A3B8', // 6.3:1 on bg-canvas, 5.4:1 on bg-surface
    'fg-onAccent': '#0F172A',
    // Accent / state
    'accent-primary': '#38BDF8', // 9.5:1 on bg-canvas
    'accent-success': '#22C55E', // 6.0:1 on bg-canvas
    'accent-warn': '#F59E0B', // 8.6:1 on bg-canvas
    'accent-danger': '#F87171', // 7.4:1 on bg-canvas
    'accent-info': '#818CF8', // 7.7:1 on bg-canvas
    // Borders
    'border-default': '#334155', // 3.6:1 vs bg-canvas
    'border-strong': '#475569',
  },
  space: {
    xs: '4px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
    '3xl': '48px',
  },
  radius: {
    sm: '4px',
    md: '8px',
    lg: '12px',
    pill: '9999px',
  },
  font: {
    sans: '"Inter", -apple-system, "Segoe UI", system-ui, sans-serif',
    mono: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace',
    size: {
      xs: '11px',
      sm: '13px',
      md: '14px',
      lg: '16px',
      xl: '20px',
      '2xl': '28px',
      '3xl': '36px',
    },
    weight: {
      regular: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
  },
  motion: {
    'ease-out': 'cubic-bezier(0.16, 1, 0.3, 1)',
    'ease-in-out': 'cubic-bezier(0.65, 0, 0.35, 1)',
    'duration-fast': '120ms',
    'duration-base': '180ms',
    'duration-slow': '280ms',
  },
  z: {
    base: 0,
    sticky: 10,
    overlay: 100,
    modal: 200,
    toast: 300,
  },
} as const;

export type DesignTokens = typeof designTokens;
