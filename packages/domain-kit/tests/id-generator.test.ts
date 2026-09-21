// WBS 0.14 — RED phase (pg-tester). Unit + determinism tests for
// packages/domain-kit/id-generator.ts against the agreed spec. docs/package/40 §A3: "Keys: uuid
// (gen_random_uuid())" — ids must be well-formed UUID v4 strings matching Postgres's format.
// id-generator.ts does not exist yet — these tests are expected to fail on import (module not
// found), which is the correct RED for this phase. Never implement id-generator.ts here.

import { describe, expect, it } from 'vitest';

import type { IdGenerator } from '../id-generator.js';
import { SequentialIdGenerator, UuidGenerator } from '../id-generator.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEQUENTIAL_SEED = 42;
const COUNT = 1000;

const generateSequence = (seed: number, count: number): string[] => {
  const generator = new SequentialIdGenerator(seed);
  return Array.from({ length: count }, () => generator.next());
};

describe('UuidGenerator', () => {
  it('implements the IdGenerator port and returns a well-formed UUID v4 string', () => {
    const generator: IdGenerator = new UuidGenerator();

    expect(generator.next()).toMatch(UUID_V4_RE);
  });
});

describe('SequentialIdGenerator', () => {
  it('produces 1000 well-formed UUID v4 strings for a fixed seed', () => {
    const ids = generateSequence(SEQUENTIAL_SEED, COUNT);

    expect(ids).toHaveLength(COUNT);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
  });

  it('never repeats an id across 1000 calls with a fixed seed (uniqueness)', () => {
    const ids = generateSequence(SEQUENTIAL_SEED, COUNT);

    expect(new Set(ids).size).toBe(COUNT);
  });

  it('is strictly increasing across calls with a fixed seed', () => {
    const ids = generateSequence(SEQUENTIAL_SEED, COUNT);

    let previous: string | undefined;
    let strictlyIncreasing = true;

    for (const id of ids) {
      if (previous !== undefined && !(id > previous)) {
        strictlyIncreasing = false;
      }
      previous = id;
    }

    expect(strictlyIncreasing).toBe(true);
  });

  it('is deterministic: the same seed produces the same 1000 ids on every run', () => {
    const runA = generateSequence(SEQUENTIAL_SEED, COUNT);
    const runB = generateSequence(SEQUENTIAL_SEED, COUNT);

    expect(runA).toEqual(runB);
  });
});
