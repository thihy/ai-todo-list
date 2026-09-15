// Icons — a small shared set of line icons for the renderer. All follow the
// same convention so they read as one family: 16×16 (scalable via `size`),
// viewBox 0 0 16 16, `currentColor` stroke, 1.4 stroke width, round caps.
// Keep this the single source of truth for icon visuals; do not sprinkle
// ad-hoc emoji or text glyphs (+/-/x) into topbars — they don't scale,
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

/** Floppy-disk save glyph — used by the editor toolbar's save button. */
export const IconSave: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3.2 2.5h7.6l2.7 2.7v8.3a.5.5 0 0 1-.5.5H3.2a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
    <path d="M5.2 2.5v3h4v-3" />
    <path d="M4.7 9.5h6.6v4.5H4.7z" />
  </Svg>
);

/** Flag — priority indicator. */
export const IconFlag: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 14V3" />
    <path d="M4 3.5h7l-1.5 2.5L11 8.5H4" />
  </Svg>
);

/** Chevron-down — expand affordance (progress history, collapsibles). */
export const IconChevronDown: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 6L8 10L12 6" />
  </Svg>
);

/** Chevron-left — used as the "expand right" affordance on the AI rail.
 *  Points toward the panel it's about to reveal. Mirrors IconChevronDown
 *  so the icon family reads consistently across the chrome. */
export const IconChevronLeft: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M10 4L6 8L10 12" />
  </Svg>
);

/** Chevron-right — mirror of IconChevronLeft. Used as the trailing
 *  affordance on the task-list rail, pointing toward the list it reveals
 *  when clicked (the list sits to the rail's right). */
export const IconChevronRight: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M6 4L10 8L6 12" />
  </Svg>
);

/** Bold — the only filled icon in the family (intentional: reads as "weight"). */
export const IconBold: React.FC<IconProps> = (p) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M5 3h4.6a2.2 2.2 0 0 1 0 4.4H5V3zm0 4.4h5.2a2.4 2.4 0 0 1 0 4.8H5V7.4z" />
  </Svg>
);

/** Italic — slanted I. */
export const IconItalic: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M10 3 6 13" />
    <path d="M8 3h4" />
    <path d="M4 13h4" />
  </Svg>
);

/** Strike-through — an S with a horizontal line through it. */
export const IconStrike: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4.8 5.2a2.6 2.6 0 0 1 4.9-.4" />
    <path d="M4.8 10.8a2.6 2.6 0 0 0 4.9.4" />
    <path d="M2.8 8h10.4" />
  </Svg>
);

/** Inline code — angle brackets. */
export const IconCode: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M5.5 5 2.5 8l3 3" />
    <path d="M10.5 5l3 3-3 3" />
  </Svg>
);

/** Code block — brackets with a horizontal divider. */
export const IconCodeBlock: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M5 4 2 8l3 4" />
    <path d="M11 4l3 4-3 4" />
    <path d="M9 4 7 12" />
  </Svg>
);

/** Quote — a curly opening quote with a left bar. */
export const IconQuote: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3.5 9c0-2.5 1.5-4.5 4-5.2" />
    <path d="M3.5 9h2v3.5h-2z" />
    <path d="M9.5 9c0-2.5 1.5-4.5 4-5.2" />
    <path d="M9.5 9h2v3.5h-2z" />
  </Svg>
);

/** Heading — an H. */
export const IconHeading: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M4 3v10" />
    <path d="M12 3v10" />
    <path d="M4 8h8" />
  </Svg>
);

/** Unordered list — three dots with lines. */
export const IconListUl: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <circle cx="3" cy="4.5" r="0.8" fill="currentColor" />
    <circle cx="3" cy="8" r="0.8" fill="currentColor" />
    <circle cx="3" cy="11.5" r="0.8" fill="currentColor" />
    <path d="M6 4.5h7M6 8h7M6 11.5h7" />
  </Svg>
);

/** Ordered list — 1, 2, 3 with lines. */
export const IconListOl: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M2.5 3v1.5M2.5 7.5h1l-1 1h1.2" />
    <path d="M5.5 4.5h8M5.5 11.5h8" />
    <path d="M3.5 12.5v-1.2c0-.4-.5-.5-.8-.3" />
  </Svg>
);

/** Task list — checkbox with lines. */
export const IconListCheck: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="2" y="3" width="3.2" height="3.2" rx="0.5" />
    <path d="M2.8 4.5l0.8 0.9 1.6-1.8" />
    <rect x="2" y="9.5" width="3.2" height="3.2" rx="0.5" />
    <path d="M7 4.5h7M7 11.5h7" />
  </Svg>
);

/** Divider — horizontal rule. */
export const IconDivider: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M2 8h12" />
  </Svg>
);

/** Image — framed photo with sun + mountain. Used by the WYSIWYG slash menu's
 *  insert-image command (replaces an ad-hoc ⌗ glyph that broke icon rhythm). */
export const IconImage: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.4" />
    <circle cx="6" cy="7" r="1.1" />
    <path d="M3 12l3.2-3.2 2.2 2.2 2.6-2.6L13 12" />
  </Svg>
);

/** Fullscreen — four corner brackets pointing outward (the convention for
 *  "expand to fullscreen"). Used by the DocumentsView tab bar's expand
 *  button and the FullscreenDoc exit control. */
export const IconFullscreen: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
  </Svg>
);

/** Exit fullscreen — four corner brackets pointing inward. */
export const IconFullscreenExit: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" />
  </Svg>
);

/** External link / open in new window — used for "open task directory". */
export const IconExternal: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M9 3h4v4" />
    <path d="M13 3 7 9" />
    <path d="M11 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3" />
  </Svg>
);

/** Calendar — due date. A month-grid glyph with two header ticks; the same
 *  icon is used wherever a "date / due" affordance appears (task list row,
 *  detail DatePicker chip) so the visual language stays consistent. */
export const IconCalendar: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.4" />
    <path d="M2.5 6.5h11" />
    <path d="M5.5 2v3M10.5 2v3" />
  </Svg>
);

/** Sparkle — AI / magic / auto-generated marker. A four-point star with two
 *  smaller accent stars; used on AI composer brand, assistant turns, etc. */
export const IconSparkle: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M8 2l1.2 3.4L12.5 7l-3.3 1.6L8 12l-1.2-3.4L3.5 7l3.3-1.6z" />
    <path d="M13 2.5l.5 1.3L14.8 4.3l-1.3.5L13 6.1l-.5-1.3-1.3-.5 1.3-.5z" />
  </Svg>
);

/** Send — paper-airplane "submit / send now" affordance. Used on composer
 *  send button (during input) and AI submit button. */
export const IconSend: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M2.5 8l11-5-3 11-3-5z" />
    <path d="M7.5 9l6-6" />
  </Svg>
);

/** Stop — square "abort the running action" affordance. Pairs with Send:
 *  same button, different icon, toggled by streaming state. */
export const IconStop: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <rect x="4" y="4" width="8" height="8" rx="1.2" />
  </Svg>
);

/** Trash — delete affordance. Outline trash can with lid handle and a few
 *  interior lines. */
export const IconTrash: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3 4.5h10" />
    <path d="M6 3h4" />
    <path d="M4.5 4.5l.7 8.5a1 1 0 0 0 1 1h3.6a1 1 0 0 0 1-1l.7-8.5" />
    <path d="M6.5 7v4M9.5 7v4" />
  </Svg>
);

/** Warning — caution / error inline marker. Triangle with exclamation. */
export const IconWarn: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M8 2.5l6 11H2z" />
    <path d="M8 7v3" />
    <path d="M8 11.5h.01" />
  </Svg>
);

/** Think — speech-bubble outline with three dots. Marks the AI "thinking /
 *  reasoning" surface (the 思考过程 panel). */
export const IconThink: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3 4.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6.5l-2.5 2v-2H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" />
    <path d="M5.5 8h.01M7.5 8h.01M9.5 8h.01" />
  </Svg>
);

/** Tool — wrench + screwdriver crossed. Marks the AI's tool-calls / actions
 *  surface (function-call chips, tool-result rows). */
export const IconTool: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M11 2.5a3 3 0 0 0-2.6 4.6l-5.4 5.4a1 1 0 0 0 1.4 1.4l5.4-5.4A3 3 0 1 0 11 2.5z" />
    <path d="M13 11l1.5 1.5M14.5 9.5l-1 1" />
  </Svg>
);

/** InboxEmpty — empty-state illustration for the AI pane / inbox. A tray
 *  outline with a small downward arrow indicating "nothing arrived". */
export const IconInboxEmpty: React.FC<IconProps> = (p) => (
  <Svg {...p}>
    <path d="M3 9V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v4" />
    <path d="M3 9h3l1 2h2l1-2h3v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
  </Svg>
);

/** CollapseBar — the pane-collapse affordance: a single rectangle split
 *  into two asymmetric halves sharing the central divider. The left half
 *  is smaller and rendered as a hollow outline (the handle / divider that
 *  does the collapsing); the right half is bigger and rendered as a solid
 *  fill (the pane / region being collapsed). Reads as "a small handle
 *  attached to a larger panel" — collapsing pushes the larger solid side
 *  away toward the handle.
 *
 *  Geometry: outer extent 13×13 centered in the 16×16 viewBox (1.5px inset
 *  on each side). Left half: x=1.5→6 (width 4.5), rx=1 rounded corners,
 *  outlined only (1.4 stroke). Right half: x=6→14.5 (width 8.5), rx=1
 *  rounded corners, filled solid. The two halves butt at x=6 so the eye
 *  reads them as one rectangle divided in two, not two floating rects.
 *  The 8.5/4.5 ratio is what makes the right half visually "the panel"
 *  and the left half "the handle" — equal halves would lose that
 *  affordance.
 *
 *  Why mixed fill+stroke: earlier iterations went (a) pure outline ([|]
 *  with stroke on outer + inner rect), (b) pure fill (filled square with
 *  vertical gap via fill-rule=evenodd), then (c) this asymmetric
 *  hollow+solid split. (a) read too light next to the IconSparkle in
 *  the AI rail; (b) read as a generic square, not as a collapse
 *  affordance; (c) finally communicates "a panel + its handle" — the
 *  asymmetric sizes and fill treatments make the affordance legible
 *  at a glance even at 16px. */
export const IconCollapseBar: React.FC<IconProps> = ({ size = 16, children: _ignored, ...rest }) => (
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
    {/* Left half — the handle. Smaller, outlined only (no fill). */}
    <rect x="1.5" y="1.5" width="4.5" height="13" rx="1" />
    {/* Right half — the pane. Bigger, filled solid. `stroke="none"`
       suppresses the inherited 1.4 stroke so this half reads as a clean
       filled mass next to the outlined handle. */}
    <rect x="6" y="1.5" width="8.5" height="13" rx="1" fill="currentColor" stroke="none" />
  </svg>
);

export default Svg;
