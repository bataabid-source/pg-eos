// tests/scenarios/fixtures/clock.ts — enablement item 3a (Master decision 7: fixed clock
// 2026-09-27T00:00:00.000Z; `expiryDate`s derive from it).
//
// No `new Date()` (wall-clock) anywhere in this package (CLAUDE.md) — every date used by a spec is
// either this fixed constant or an offset computed from it in plain arithmetic (never
// `current_date` on the SQL side either, per the module tests' own finding 8/13 discipline).

import { FixedClock, SequentialIdGenerator } from '@pg-eos/domain-kit';

export const SCENARIO_CLOCK_ISO = '2026-09-27T00:00:00.000Z';
export const SCENARIO_CLOCK_DATE = '2026-09-27';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const MS_PER_HOUR = 60 * 60 * 1000;

export const clock = new FixedClock(new Date(SCENARIO_CLOCK_ISO));

/** A fresh SequentialIdGenerator per spec file — each spec passes its own seed so two spec files
 *  (or two runs of the guard's Node id space) never collide. */
export function createIds(seed: number): SequentialIdGenerator {
  return new SequentialIdGenerator(seed);
}

/** Returns the ISO date (yyyy-mm-dd) `days` after the fixed clock date — the only date arithmetic
 *  this package performs, always anchored to SCENARIO_CLOCK_ISO, never to a fresh `new Date()`. */
export function daysAfterClock(days: number): string {
  const base = new Date(SCENARIO_CLOCK_ISO).getTime();
  const result = new Date(base + days * MS_PER_DAY);
  return result.toISOString().slice(0, 10);
}
