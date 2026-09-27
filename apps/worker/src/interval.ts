// apps/worker/src/interval.ts — X part 5b. The relay runs every second: doc 36 §3-1:165
// «ناقل (Relay) كل ثانية» and 13B:145 «ناقل ينشر كل ثانية». The RELAY_INTERVAL_SECONDS
// environment override is accepted in every environment (the tests use it); production leaves it
// unset. Whether the interval becomes a GM-editable platform.thresholds key is an open question.

import type { WorkerEnv } from './role.js';

export const RELAY_INTERVAL_SECONDS = 1;
export const MS_PER_SECOND = 1000;

const INTERVAL_ENV_KEY = 'RELAY_INTERVAL_SECONDS';

/** Unset → RELAY_INTERVAL_SECONDS in ms. Set → must be a finite number > 0 (an empty string, which
 *  Number() turns into 0, is refused). undefined = invalid: startup is fatal. */
export function resolveIntervalMs(env: WorkerEnv): number | undefined {
  const raw = env[INTERVAL_ENV_KEY];
  if (raw === undefined) return RELAY_INTERVAL_SECONDS * MS_PER_SECOND;
  if (raw.trim() === '') return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * MS_PER_SECOND : undefined;
}
