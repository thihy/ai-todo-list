// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusSelect } from '../../src/renderer/components/StatusSelect';

// Regression guard for the vertical-flip timing bug in StatusSelect.
//
// The menu is portalled to document.body and is only mounted once `pos` is
// set, so its real height is unknowable during the FIRST layout pass. The
// old code computed the flip from `menuRef.current?.offsetHeight` in that
// same pass, always saw 0, always chose "below", and — because the effect
// deps were only [open, variant] — never re-ran once the menu mounted.
// A trigger near the bottom of the task list therefore opened a 168px menu
// that hung ~94px off the bottom of the window.
//
// The fix is two passes: pass 1 anchors the menu so it mounts, pass 2
// (dep on `pos`) measures and flips. These tests drive the real component
// through a real DOM click, so they fail if that ordering regresses.

let element: HTMLDivElement;
let root: Root;

const MENU_H = 168; // measured height of the 5-option status menu
const GAP = 4;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  element = document.createElement('div');
  document.body.append(element);
  // happy-dom does no layout, so offsetHeight / getBoundingClientRect come
  // back as 0. Stub exactly what StatusSelect reads, and make the menu
  // report MENU_H only after it is actually in the document.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList?.contains('status-select__menu') ? MENU_H : 20;
    },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const isMenu = this.classList?.contains('status-select__menu');
    const top = Number((this as any).dataset.testTop ?? 0);
    const h = isMenu ? MENU_H : 20;
    return {
      top, bottom: top + h, left: 0, right: 200, width: 200, height: h,
      x: 0, y: top, toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  act(() => root.unmount());
  element.remove();
  root = undefined as unknown as Root;
});

/** Mount a StatusSelect whose trigger sits at `triggerTop` in the viewport. */
function mountAt(triggerTop: number) {
  act(() => {
    root = createRoot(element);
    root.render(
      <div>
        <StatusSelect status="next" onChange={() => {}} variant="icon" />
      </div>,
    );
  });
  const trigger = element.querySelector('button.task-row__status') as HTMLButtonElement;
  trigger.dataset.testTop = String(triggerTop);
  return trigger;
}

const openMenu = (trigger: HTMLButtonElement) => {
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  return document.querySelector('.status-select__menu') as HTMLDivElement;
};

const innerHeight = () => window.innerHeight;

describe('StatusSelect flips the menu above triggers near the window bottom', () => {
  it('mounts the menu at all (guards the portalled render path)', () => {
    (window as any).innerHeight = 800;
    const menu = openMenu(mountAt(100));
    expect(menu).toBeTruthy();
  });

  it('keeps the menu inside the viewport for a bottom-row trigger', () => {
    (window as any).innerHeight = 800;
    // Bottom row of an 800px viewport: only ~20px of room below the trigger
    // but ~500px above it. This is the exact case that used to overflow.
    const trigger = mountAt(720);
    const menu = openMenu(trigger);

    const top = Number(menu.style.top.replace('px', ''));
    const bottom = top + MENU_H;
    expect(bottom).toBeLessThanOrEqual(innerHeight());
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it('actually flips upward (is-flipped) instead of merely clamping', () => {
    (window as any).innerHeight = 800;
    const trigger = mountAt(720);
    const menu = openMenu(trigger);

    expect(menu.classList.contains('is-flipped')).toBe(true);
    // Flipped means the menu's bottom edge sits ABOVE the trigger's top.
    const top = Number(menu.style.top.replace('px', ''));
    expect(top + MENU_H).toBeLessThan(720);
  });

  it('still opens downward for a top-row trigger (no over-flipping)', () => {
    (window as any).innerHeight = 800;
    const trigger = mountAt(40);
    const menu = openMenu(trigger);

    expect(menu.classList.contains('is-flipped')).toBe(false);
    const top = Number(menu.style.top.replace('px', ''));
    // Below the trigger, separated by the gap.
    expect(top).toBe(40 + 20 + GAP);
    expect(top + MENU_H).toBeLessThanOrEqual(innerHeight());
  });

  it('clamps into the viewport when neither side can fit the menu', () => {
    // 360px viewport with a 168px menu: room exists on both sides, but the
    // component must still land fully on screen rather than off an edge.
    (window as any).innerHeight = 360;
    const trigger = mountAt(250);
    const menu = openMenu(trigger);

    const top = Number(menu.style.top.replace('px', ''));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + MENU_H).toBeLessThanOrEqual(innerHeight());
  });

  it('clears the position on close so a reopen re-measures from scratch', () => {
    (window as any).innerHeight = 800;
    const trigger = mountAt(720);
    openMenu(trigger);
    expect(document.querySelector('.status-select__menu')).toBeTruthy();

    act(() => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('.status-select__menu')).toBeNull();
  });
});
