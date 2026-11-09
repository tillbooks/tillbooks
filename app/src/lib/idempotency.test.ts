/**
 * The primitive on its own, so its two halves are pinned without a surface in the way.
 *
 * The surface suites (`Payments.test.tsx`, `OpenItems.test.tsx`) assert the BEHAVIOUR through a real
 * form and a real transport, which is where the defect was found and where it must stay found. These
 * assert the CONTRACT, including the edges no surface reaches: a question that stringifies to
 * `undefined`, and a question whose values are equal but whose object identity is not.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useIdempotencyKey } from './idempotency';

describe('useIdempotencyKey', () => {
  it('holds ONE key across re-renders of the same question, which is the double-write guard', () => {
    const { result, rerender } = renderHook(({ q }) => useIdempotencyKey(q), {
      initialProps: { q: ['record', 50000, '2026-07-26'] as unknown },
    });
    const first = result.current;
    expect(typeof first).toBe('string');
    expect(first).not.toBe('');

    rerender({ q: ['record', 50000, '2026-07-26'] });
    // A FRESH array with equal contents. Identity is not the question: the values are.
    expect(result.current).toBe(first);
  });

  it('mints a NEW key the moment the question changes, so a lost response cannot replay it', () => {
    const { result, rerender } = renderHook(({ q }) => useIdempotencyKey(q), {
      initialProps: { q: ['record', 50000] as unknown },
    });
    const first = result.current;

    rerender({ q: ['record', 25000] });
    expect(result.current).not.toBe(first);
  });

  it('gives two independent callers two keys, so one surface cannot answer for another', () => {
    const a = renderHook(() => useIdempotencyKey(['same']));
    const b = renderHook(() => useIdempotencyKey(['same']));
    expect(a.result.current).not.toBe(b.result.current);
  });

  it('keeps its footing on a question JSON renders as nothing at all', () => {
    // `JSON.stringify(undefined)` is the VALUE `undefined`, not a string, and comparing two of those
    // would read every question as unchanged. A caller whose fields are not ready yet must not be
    // silently pinned to one key for the rest of the mount.
    const { result, rerender } = renderHook(({ q }) => useIdempotencyKey(q), {
      initialProps: { q: undefined as unknown },
    });
    const first = result.current;
    expect(typeof first).toBe('string');

    rerender({ q: undefined });
    expect(result.current).toBe(first);

    rerender({ q: ['ready'] });
    expect(result.current).not.toBe(first);
  });

  it('re-minting on the way back is a NEW key, which is the stated limit rather than a surprise', () => {
    // Documented in the header: it remembers the current question only. Asserted here so a future
    // change to a remember-every-question map is a deliberate decision with a red test in front of
    // it, rather than an accident nobody notices.
    const { result, rerender } = renderHook(({ q }) => useIdempotencyKey(q), {
      initialProps: { q: ['a'] as unknown },
    });
    const first = result.current;
    rerender({ q: ['b'] });
    rerender({ q: ['a'] });
    expect(result.current).not.toBe(first);
  });
});
