// TypeScript declarations for shishi-pet.js (vendor asset).
//
// Renders inline SVG. Each call to shishiPetSvg returns a unique-id'd
// `<svg>` string so multiple instances coexist on one page without
// gradient/filter id collisions.

export type ShishiState =
  | 'idle'
  | 'receiving'
  | 'captured'
  | 'sorting'
  | 'sleeping';

export interface ShishiPetOptions {
  state?: ShishiState;
  size?: number;
  label?: string;
  id?: string;
}

export declare function shishiPetSvg(options?: ShishiPetOptions): string;

export declare const SHISHI_STATES: readonly ShishiState[];

export declare class ShishiPet extends HTMLElement {
  static readonly observedAttributes: readonly string[];
  get state(): ShishiState;
  set state(value: ShishiState): void;
}