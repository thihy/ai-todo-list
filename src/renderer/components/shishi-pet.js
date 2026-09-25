/**
 * Shishi Pet — dependency-free SVG mascot for AI to-do products.
 *
 * Browser:
 *   import './shishi-pet.js';
 *   <shishi-pet state="idle" size="220" label="拾拾正在等待"></shishi-pet>
 *
 * SSR / Node:
 *   import { shishiPetSvg } from './shishi-pet.js';
 *   const svg = shishiPetSvg({ state: 'captured', size: 220 });
 */

const STATES = new Set(['idle', 'receiving', 'captured', 'sorting', 'sleeping']);
let instanceCount = 0;

const safeState = (value) => (STATES.has(value) ? value : 'idle');
const safeSize = (value) => Math.min(1024, Math.max(48, Number(value) || 220));
const safeId = (value) => String(value || `shishi-${++instanceCount}`).replace(/[^a-zA-Z0-9_-]/g, '');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[char]));

export function shishiPetSvg({ state = 'idle', size = 220, label = '拾拾 AI 待办宠物', id } = {}) {
  const petState = safeState(state);
  const px = safeSize(size);
  const uid = safeId(id);
  const title = escapeHtml(label);

  return `<svg class="shishi shishi--${petState}" width="${px}" height="${px}" viewBox="0 0 240 240"
    xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="${uid}-title">
  <title id="${uid}-title">${title}</title>
  <defs>
    <linearGradient id="${uid}-body" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fffdf7"/><stop offset="1" stop-color="#f1eadf"/>
    </linearGradient>
    <radialGradient id="${uid}-pouch" cx="50%" cy="42%" r="65%">
      <stop offset="0" stop-color="#fff4bd" stop-opacity=".96"/>
      <stop offset="1" stop-color="#eca84f" stop-opacity=".74"/>
    </radialGradient>
    <filter id="${uid}-shadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="7" stdDeviation="7" flood-color="#554633" flood-opacity=".18"/>
    </filter>
    <filter id="${uid}-glow" x="-70%" y="-70%" width="240%" height="240%">
      <feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <style>
    .shishi { overflow: visible; }
    .shishi * { transform-box: fill-box; transform-origin: center; }
    .ear { animation: ${uid}-listen 3.2s ease-in-out infinite; }
    .ear.right { animation-delay: -.18s; }
    .body { animation: ${uid}-breathe 3.2s ease-in-out infinite; }
    .pouch-glow { opacity: .12; }
    .card, .sort-card, .success-rays, .sleep-dot { opacity: 0; }
    .shishi--receiving .card { opacity: 1; animation: ${uid}-receive 1.45s ease-in-out infinite; }
    .shishi--receiving .ear { animation-duration: .75s; }
    .shishi--captured .pouch-glow { opacity: .75; animation: ${uid}-pulse 1.5s ease-out infinite; }
    .shishi--captured .success-rays { opacity: 1; animation: ${uid}-rays 1.5s ease-out infinite; }
    .shishi--sorting .sort-card { opacity: 1; animation: ${uid}-sort 1.8s ease-in-out infinite; }
    .shishi--sorting .sort-card.two { animation-delay: -.6s; }
    .shishi--sorting .sort-card.three { animation-delay: -1.2s; }
    .shishi--sleeping .eye { transform: scaleY(.12); }
    .shishi--sleeping .body { transform: translateY(8px) rotate(4deg); animation: ${uid}-sleep 3.8s ease-in-out infinite; }
    .shishi--sleeping .ear { transform: rotate(24deg) translateY(6px); animation: none; }
    .shishi--sleeping .sleep-dot { opacity: 1; animation: ${uid}-float 2.2s ease-in-out infinite; }
    @keyframes ${uid}-breathe { 0%,100%{transform:translateY(0) scaleY(1)} 50%{transform:translateY(2px) scaleY(.985)} }
    @keyframes ${uid}-listen { 0%,100%{transform:rotate(0)} 48%{transform:rotate(-4deg)} 56%{transform:rotate(3deg)} }
    @keyframes ${uid}-receive { 0%{transform:translate(34px,-42px) rotate(12deg);opacity:0} 28%{opacity:1} 82%{opacity:1} 100%{transform:translate(0,37px) scale(.55);opacity:0} }
    @keyframes ${uid}-pulse { 0%{transform:scale(.84);opacity:.7} 80%,100%{transform:scale(1.2);opacity:0} }
    @keyframes ${uid}-rays { 0%{transform:scale(.75);opacity:0} 35%{opacity:1} 100%{transform:scale(1.16);opacity:0} }
    @keyframes ${uid}-sort { 0%,100%{transform:translate(-18px,0) rotate(-8deg)} 50%{transform:translate(18px,-10px) rotate(8deg)} }
    @keyframes ${uid}-sleep { 0%,100%{transform:translateY(8px) rotate(4deg)} 50%{transform:translateY(10px) rotate(4deg)} }
    @keyframes ${uid}-float { 0%,100%{transform:translateY(0);opacity:.4} 50%{transform:translateY(-8px);opacity:1} }
    @media (prefers-reduced-motion: reduce) { .shishi * { animation: none !important; } }
  </style>

  <ellipse cx="120" cy="216" rx="72" ry="12" fill="#655744" opacity=".13"/>

  <g class="body" filter="url(#${uid}-shadow)">
    <!-- pencil tail -->
    <g transform="translate(29 151) rotate(-24)">
      <path d="M0 9 44 0l5 11L5 22Z" fill="#d9a75c"/>
      <path d="m44 0 13 2-8 9Z" fill="#4b4541"/>
      <path d="M0 9 5 22l-8-3Z" fill="#f0b9a8"/>
      <path d="m9 7 3 12" stroke="#b77d39" stroke-width="2" opacity=".55"/>
    </g>

    <!-- leaf ears (parent holds translate+base rotate; inner element is
         driven by the CSS animation so the resting transform isn't lost
         when CSS overrides the SVG transform attribute). -->
    <g transform="translate(58 20) rotate(-26)">
      <g class="ear left">
        <path d="M52 63C23 64 1 45 5 5c38 5 56 25 47 58Z" fill="#86a99d"/>
        <path d="M13 15c14 16 25 29 36 43" stroke="#6e9187" stroke-width="3" stroke-linecap="round" opacity=".7"/>
      </g>
    </g>
    <g transform="translate(135 15) rotate(20)">
      <g class="ear right">
        <path d="M4 64C-3 33 14 10 52 3c6 40-16 59-48 61Z" fill="#86a99d"/>
        <path d="M45 14C31 29 19 43 7 58" stroke="#6e9187" stroke-width="3" stroke-linecap="round" opacity=".7"/>
      </g>
    </g>

    <!-- body and arms -->
    <path d="M57 101c0-42 27-68 63-68s63 26 63 68v60c0 38-24 58-63 58s-63-20-63-58Z" fill="url(#${uid}-body)"/>
    <path d="M66 140c-18 17-17 50 7 58 9 3 17-3 18-13l4-41c1-14-18-15-29-4Z" fill="#f7f1e7"/>
    <path d="M174 140c18 17 17 50-7 58-9 3-17-3-18-13l-4-41c-1-14 18-15 29-4Z" fill="#f7f1e7"/>

    <!-- face -->
    <ellipse class="eye" cx="96" cy="93" rx="7" ry="8" fill="#403a37"/>
    <ellipse class="eye" cx="144" cy="93" rx="7" ry="8" fill="#403a37"/>
    <circle cx="94" cy="90" r="2" fill="#fff" opacity=".9"/><circle cx="142" cy="90" r="2" fill="#fff" opacity=".9"/>
    <path d="m115 105 5 4 5-4c-2-4-8-4-10 0Z" fill="#66514a"/>
    <path d="M120 109v5m0 0c-4 4-8 3-10 0m10 0c4 4 8 3 10 0" fill="none" stroke="#66514a" stroke-width="2" stroke-linecap="round"/>

    <!-- translucent belly pouch -->
    <circle class="pouch-glow" cx="120" cy="164" r="49" fill="#ffc65c" filter="url(#${uid}-glow)"/>
    <rect x="80" y="126" width="80" height="72" rx="31" fill="url(#${uid}-pouch)" stroke="#e4a84d" stroke-width="3"/>
    <g opacity=".9">
      <rect x="94" y="143" width="28" height="19" rx="5" fill="#fff8dc" transform="rotate(-7 108 152)"/>
      <rect x="119" y="151" width="29" height="21" rx="5" fill="#9fbdb3" transform="rotate(8 133 161)"/>
      <circle cx="105" cy="178" r="8" fill="#f8d06e"/>
      <path d="m130 177 9 15h-18Z" fill="#fff0bd"/>
    </g>
    <path d="M91 136c9-9 49-14 61 4" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".6"/>
  </g>

  <!-- state overlays -->
  <g class="card" transform="translate(101 37)">
    <rect width="38" height="28" rx="7" fill="#fff9e9" stroke="#efc875" stroke-width="2"/>
    <path d="M9 10h20M9 17h13" stroke="#dda958" stroke-width="3" stroke-linecap="round"/>
  </g>
  <g class="success-rays" fill="none" stroke="#f1b94e" stroke-width="4" stroke-linecap="round">
    <path d="M61 148h-12M68 127l-9-7M179 148h12M172 127l9-7"/>
  </g>
  <g class="sort-card one" transform="translate(43 172)"><rect width="27" height="18" rx="5" fill="#f2c66d"/></g>
  <g class="sort-card two" transform="translate(172 161)"><rect width="27" height="18" rx="5" fill="#92b5aa"/></g>
  <g class="sort-card three" transform="translate(103 209)"><rect width="30" height="18" rx="5" fill="#fff0c5" stroke="#e8c982"/></g>
  <g class="sleep-dot" fill="#f6bf54"><circle cx="190" cy="65" r="7"/><circle cx="205" cy="44" r="4" opacity=".65"/></g>
</svg>`;
}

export class ShishiPet extends (globalThis.HTMLElement || class {}) {
  static observedAttributes = ['state', 'size', 'label'];

  constructor() {
    super();
    if (this.attachShadow) this.attachShadow({ mode: 'open' });
  }

  connectedCallback() { this.render(); }
  attributeChangedCallback() { if (this.isConnected) this.render(); }

  get state() { return safeState(this.getAttribute('state')); }
  set state(value) { this.setAttribute('state', safeState(value)); }

  render() {
    if (!this.shadowRoot) return;
    const size = safeSize(this.getAttribute('size'));
    this.shadowRoot.innerHTML = `<style>:host{display:inline-flex;width:${size}px;height:${size}px;line-height:0}</style>${shishiPetSvg({
      state: this.state,
      size,
      label: this.getAttribute('label') || '拾拾 AI 待办宠物',
      id: `shishi-${++instanceCount}`,
    })}`;
  }
}

if (globalThis.customElements && !customElements.get('shishi-pet')) {
  customElements.define('shishi-pet', ShishiPet);
}

export const SHISHI_STATES = Object.freeze([...STATES]);
