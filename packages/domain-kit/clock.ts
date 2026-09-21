// WBS 0.14 — packages/domain-kit/clock.ts
//
// Time: timestamptz, stored UTC (doc 40 §A3). Domain code receives a Clock port; never
// `new Date()` directly (CLAUDE.md). SystemClock is the one sanctioned adapter that reads real
// wall-clock time; everything else must depend on the `Clock` port, not this concrete class.

export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FixedClock implements Clock {
  #current: Date;

  constructor(initial: Date) {
    this.#current = new Date(initial.getTime());
  }

  now(): Date {
    return new Date(this.#current.getTime());
  }

  advance(ms: number): void {
    this.#current = new Date(this.#current.getTime() + ms);
  }

  set(date: Date): void {
    this.#current = new Date(date.getTime());
  }
}
