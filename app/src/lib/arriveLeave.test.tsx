/**
 * D204, the Arrive and leave moment (`arriveLeave`, `useArriveLeave` in motion.ts). jsdom has no layout
 * and no Web Animations API, so each test hands the items a position and records what `animate` was
 * asked: an arriving item fades and scales in, a moved one plays its old-to-new offset on transform, a
 * leaving one fades out from a detached copy that never takes a click, and under reduced motion or the
 * Off level nothing is scheduled at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';

import { ARRIVE_KEY_ATTR, arriveLeave, snapshotArrangement, useArriveLeave } from './motion';

/** Where each key stands, as the fake layout reports it; tests move items by editing this map. */
const layout = new Map<string, { left: number; top: number }>();

interface Call {
  key: string | null;
  frames: Keyframe[];
  options: KeyframeAnimationOptions;
  anim: { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: () => void };
}
const calls: Call[] = [];

function rectOf(el: Element): DOMRect {
  const key = el.getAttribute(ARRIVE_KEY_ATTR);
  // A key the test placed stands there; any other item stands by its place among its siblings.
  const index = el.parentElement === null ? 0 : Array.from(el.parentElement.children).indexOf(el);
  const at = (key === null ? undefined : layout.get(key)) ?? { left: index * 120, top: 0 };
  return { left: at.left, top: at.top, width: 100, height: 40, right: at.left + 100, bottom: at.top + 40, x: at.left, y: at.top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  layout.clear();
  calls.length = 0;
  document.documentElement.setAttribute('data-motion', 'calm');
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return rectOf(this);
  });
  (HTMLElement.prototype as unknown as { animate: unknown }).animate = function (this: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions) {
    const anim = { onfinish: null as (() => void) | null, oncancel: null as (() => void) | null, cancel: vi.fn() };
    calls.push({ key: this.getAttribute(ARRIVE_KEY_ATTR), frames, options, anim });
    return anim as unknown as Animation;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate;
  document.documentElement.removeAttribute('data-motion');
  document.body.querySelectorAll('.motion-leave-copy').forEach((el) => el.remove());
});

function grid(keys: string[]): HTMLElement {
  const box = document.createElement('ul');
  for (const key of keys) {
    const li = document.createElement('li');
    li.setAttribute(ARRIVE_KEY_ATTR, key);
    li.textContent = key;
    li.id = `item-${key}`;
    box.appendChild(li);
  }
  document.body.appendChild(box);
  return box;
}

describe('arriveLeave', () => {
  it('an arriving item fades and scales in from 0.98; a moved neighbour plays its old offset back to none', () => {
    layout.set('a', { left: 0, top: 0 });
    layout.set('b', { left: 120, top: 0 });
    const box = grid(['a', 'b']);
    const before = snapshotArrangement(box);
    // A new card lands first; the two others move one place on.
    const c = document.createElement('li');
    c.setAttribute(ARRIVE_KEY_ATTR, 'c');
    box.prepend(c);
    layout.set('c', { left: 0, top: 0 });
    layout.set('a', { left: 120, top: 0 });
    layout.set('b', { left: 240, top: 0 });
    arriveLeave(box, before);

    const byKey = new Map(calls.map((call) => [call.key, call]));
    expect(byKey.get('c')?.frames).toEqual([{ opacity: 0, transform: 'scale(0.98)' }, { opacity: 1, transform: 'none' }]);
    expect(byKey.get('c')?.options.duration).toBe(200);
    expect(byKey.get('a')?.frames).toEqual([{ transform: 'translate(-120px, 0px)' }, { transform: 'none' }]);
    expect(byKey.get('b')?.options.duration).toBe(200);
    // Only transform and opacity ever move.
    for (const call of calls) for (const frame of call.frames) for (const prop of Object.keys(frame)) expect(['opacity', 'transform']).toContain(prop);
    box.remove();
  });

  it('a leaving item goes from the layout at once; a copy with no ids and no pointer fades out in 120 ms and is removed', () => {
    layout.set('a', { left: 0, top: 0 });
    layout.set('b', { left: 120, top: 0 });
    const box = grid(['a', 'b']);
    const before = snapshotArrangement(box);
    box.querySelector('[data-arrive-key="a"]')?.remove();
    layout.set('b', { left: 0, top: 0 });
    arriveLeave(box, before);

    const copy = document.body.querySelector<HTMLElement>('.motion-leave-copy');
    expect(copy).not.toBeNull();
    expect(copy?.getAttribute('aria-hidden')).toBe('true');
    expect(copy?.hasAttribute('inert')).toBe(true);
    expect(copy?.id).toBe('');
    expect(copy?.hasAttribute(ARRIVE_KEY_ATTR)).toBe(false);
    const leave = calls.find((call) => call.key === null);
    expect(leave?.options.duration).toBe(120);
    expect(leave?.frames[1]).toEqual({ opacity: 0, transform: 'scale(0.98)' });
    leave?.anim.onfinish?.();
    expect(document.body.querySelector('.motion-leave-copy')).toBeNull();
    // The neighbour glides into the freed place.
    expect(calls.find((call) => call.key === 'b')?.frames[0]).toEqual({ transform: 'translate(120px, 0px)' });
    box.remove();
  });

  it('an item that did not move is left alone', () => {
    layout.set('a', { left: 0, top: 0 });
    const box = grid(['a']);
    arriveLeave(box, snapshotArrangement(box));
    expect(calls).toEqual([]);
    box.remove();
  });

  it('under the Off level, and under reduced motion, nothing is scheduled and nothing is copied', () => {
    layout.set('a', { left: 0, top: 0 });
    const box = grid(['a', 'b']);
    const before = snapshotArrangement(box);
    box.querySelector('[data-arrive-key="a"]')?.remove();
    document.documentElement.setAttribute('data-motion', 'off');
    arriveLeave(box, before);
    expect(calls).toEqual([]);
    expect(document.body.querySelector('.motion-leave-copy')).toBeNull();

    document.documentElement.setAttribute('data-motion', 'calm');
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', matchMedia);
    arriveLeave(box, before);
    expect(calls).toEqual([]);
    vi.unstubAllGlobals();
    box.remove();
  });
});

function List({ keys }: { keys: string[] }) {
  const ref = useRef<HTMLUListElement | null>(null);
  useArriveLeave(ref, keys);
  return (
    <ul ref={ref}>
      {keys.map((k) => (
        <li key={k} data-arrive-key={k}>
          {k}
        </li>
      ))}
    </ul>
  );
}

describe('useArriveLeave', () => {
  it('plays nothing on the first render, then the change whenever the keys change', () => {
    const { rerender } = render(<List keys={['a', 'b']} />);
    expect(calls).toEqual([]);
    rerender(<List keys={['b', 'a']} />);
    expect(calls.map((c) => c.key).sort()).toEqual(['a', 'b']);
    calls.length = 0;
    rerender(<List keys={['b', 'a']} />);
    expect(calls).toEqual([]);
  });
});
