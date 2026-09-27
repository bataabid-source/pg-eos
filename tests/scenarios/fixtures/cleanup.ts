// tests/scenarios/fixtures/cleanup.ts — fix round finding 11 (precedent
// modules/wms/tests/process-outbound/process-outbound.test.ts:835-841): every cleanup step runs
// even if an earlier one throws — a partial cleanup must never abort at the first failing DELETE and
// leak every later table's rows, and the pool must always get closed. Failures are collected and
// re-thrown together, so a broken cleanup is still loud, never silent.

export async function runCleanupSteps(steps: ReadonlyArray<readonly [string, () => Promise<unknown>]>): Promise<void> {
  const failures: string[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err: unknown) {
      failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) throw new Error(`fixture cleanup failed: ${failures.join(' | ')}`);
}
