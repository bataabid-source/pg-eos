// WBS 0.14 — RED phase (pg-tester). Unit tests for packages/domain-kit/clock.ts against the
// agreed spec. CLAUDE.md line 27: "No Math.random() / new Date() in domain/ — inject generator
// and clock" — this is exactly the port these tests pin down. clock.ts does not exist yet —
// these tests are expected to fail on import (module not found), which is the correct RED for
// this phase. Never implement clock.ts here.

import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import { FixedClock, SystemClock } from '../clock.js';

describe('SystemClock', () => {
  it('implements the Clock port and returns a Date close to the real current time', () => {
    const clock: Clock = new SystemClock();
    const before = Date.now();
    const now = clock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('FixedClock', () => {
  it('never changes on its own — calling now() twice returns the same instant', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new FixedClock(initial);

    const first = clock.now().getTime();
    const second = clock.now().getTime();

    expect(first).toBe(second);
    expect(first).toBe(initial.getTime());
  });

  it('advance(ms) moves the clock forward by exactly ms', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new FixedClock(initial);

    clock.advance(5_000);

    expect(clock.now().getTime()).toBe(initial.getTime() + 5_000);
  });

  it('advance(ms) is cumulative across multiple calls', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new FixedClock(initial);

    clock.advance(1_000);
    clock.advance(2_000);

    expect(clock.now().getTime()).toBe(initial.getTime() + 3_000);
  });

  it('set(date) pins the clock to exactly that date', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new FixedClock(initial);
    const target = new Date('2030-06-15T12:30:00.000Z');

    clock.set(target);

    expect(clock.now().getTime()).toBe(target.getTime());
  });

  it('set(date) after advance() overrides the advanced value', () => {
    const initial = new Date('2026-01-01T00:00:00.000Z');
    const clock = new FixedClock(initial);
    const target = new Date('2030-06-15T12:30:00.000Z');

    clock.advance(10_000);
    clock.set(target);

    expect(clock.now().getTime()).toBe(target.getTime());
  });
});
