// Icons — a small shared set of line icons for the renderer. All follow the
// same convention so they read as one family: 16×16 (scalable via `size`),
// viewBox 0 0 16 16, `currentColor` stroke, 1.4 stroke width, round caps.
// Keep this the single source of truth for icon visuals; do not sprinkle
// ad-hoc emoji or text glyphs (＋/🗂/×) into topbars — they don't scale,
// render inconsistently across fonts, and break the visual rhythm.

import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

const Svg: React.FC<IconProps & { children: React.ReactNode }> = ({
  size = 16,
  children,
  ...rest
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

/** Plus — new/create affordance (new chat, new task, add row). */
export const IconPlus: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

/** History — conversation / activity history. A clock with a counter-
 *  clockwise arrow on the dial, the conventional "restore history" glyph. */
export const IconHistory: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M2.6 7a5.4 5.4 0 1 1 1.2 3.4" />
    <path d="M2.6 4v3h3" />
    <path d="M8 5v3l2 1.2" />
  </Svg>
);

/** Paperclip — attach / attachment. */
export const IconAttach: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M11.5 7.5 7 12a2.5 2.5 0 0 1-3.5-3.5l5.5-5.5a1.8 1.8 0 1 1 2.5 2.5L6.5 10.5a1.1 1.1 0 1 1-1.5-1.5l4-4" />
  </Svg>
);

/** Link — external link. */
export const IconLink: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
  </Svg>
);

/** Doc — generic document / note. */
export const IconDoc: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 2h5l3 3v9a0 0 0 0 1 0 0H4z" />
    <path d="M9 2v3h3" />
    <path d="M6 8h4M6 11h4" />
  </Svg>
);

/** Drawing — pen/stylus on a surface. */
export const IconDrawing: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3 13l1-3 6.5-6.5a1.4 1.4 0 0 1 2 2L6 12l-3 1z" />
    <path d="M10.5 4.5l1.5 1.5" />
  </Svg>
);

/** Activity — a pulse / timeline line. */
export const IconActivity: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M2 8h2.5l1.2-3.5L7.3 12l1.4-4H14" />
  </Svg>
);

/** Close — × for dismiss / remove. */
export const IconClose: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Svg>
);

/** Check — selection marker for menus / option lists. */
export const IconCheck: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3.5 8l3 3 6-6" />
  </Svg>
);

/** Flag — priority indicator. */
export const IconFlag: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 14V3" />
    <path d="M4 3.5h7l-1.5 2.5L11 8.5H4" />
  </Svg>
);

export default Svg;
