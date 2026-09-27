// apps/worker/src/loop.ts — X part 5b. runRelayLoop: one relayOnce (packages/events) per tick,
// strictly sequential — the next tick is scheduled with setTimeout only AFTER the previous one
// completed (never setInterval), because relayOnce takes no row lock and assumes a single caller
// (relay.ts "CONCURRENCY"). The first tick runs immediately. A tick that throws is logged at error
// level with `err` and the next tick is still scheduled. The returned promise resolves only once
// `signal` is aborted, after the in-flight tick has finished.
//
// Idle detection: @pg-eos/events exports no subscriber count (packages/** frozen for this part), so
// the loop relies on relayOnce's own contract (relay.ts:26-30, :123-125) — with zero registered
// subscribers it returns without touching platform.outbox. A tick that checked no client out of
// the pool (pg.Pool 'acquire' event) therefore ran with 0 subscribers; the loop warns about it once.

import { relayOnce } from '@pg-eos/events';
import type { RelayResult } from '@pg-eos/events';
import type { Pool } from 'pg';

export const IDLE_WARNING = '0 subscribers registered — relay idle';

export interface RelayOptions {
  readonly limit?: number;
  readonly eventType?: string;
}

export type RelayFn = (pool: Pool, opts?: RelayOptions) => Promise<RelayResult>;

export interface LoopLogger {
  info(obj: object, msg: string): void;
  warn(msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RelayLoopOptions {
  readonly pool: Pool;
  readonly intervalMs: number;
  readonly logger: LoopLogger;
  readonly signal: AbortSignal;
  readonly relayOptions?: RelayOptions;
  readonly relay?: RelayFn;
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runRelayLoop(options: RelayLoopOptions): Promise<void> {
  const { pool, intervalMs, logger, signal, relayOptions } = options;
  const relay: RelayFn = options.relay ?? relayOnce;

  let acquired = 0;
  const onAcquire = (): void => {
    acquired += 1;
  };
  pool.on('acquire', onAcquire);

  let idleWarned = false;

  try {
    while (!signal.aborted) {
      const acquiredBefore = acquired;
      try {
        const result = await relay(pool, relayOptions);
        logger.info({ ...result }, 'relay tick');
        if (!idleWarned && result.processed === 0 && acquired === acquiredBefore) {
          idleWarned = true;
          logger.warn(IDLE_WARNING);
        }
      } catch (error) {
        logger.error({ err: error }, 'relay tick failed');
      }
      if (signal.aborted) break;
      await pause(intervalMs, signal);
    }
  } finally {
    pool.off('acquire', onAcquire);
  }
}
