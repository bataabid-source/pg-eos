// modules/platform/tests/evaluate-alerts/alert-machine.unit.test.ts — WBS 5.13 part 1, replicated
// from the golden slice (modules/wms/tests/receive-inbound/inbound-machine.unit.test.ts), renamed
// from the scaffold's inbound-machine.unit.test.ts (scripts/new-slice.sh copy) — this use case has
// no inbound order, it has an alert_log row's own lifecycle.
//
// CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions — XState." This is the pure,
// data-only state machine the application-layer commands (evaluate-alert-rules.ts writes the
// initial 'fired' row; acknowledge-alert.ts drives fired -> acknowledged) must consult instead of a
// hand-written if/switch on `acknowledged_at`/`escalated_at`/`resolved_at` being null or not.
//
// Expected surface — modules/platform/domain/evaluate-alerts/machine.ts:
//   - `ALERT_LOG_STATUS` — an enum object with (at least) FIRED = 'fired' and
//     ACKNOWLEDGED = 'acknowledged' (mirroring platform.alert_log's own fired_at/acknowledged_at
//     columns). ESCALATED/RESOLVED may also be declared (escalated_at/resolved_at columns exist on
//     the table) but are OUT of scope for part 1 (slice brief "Explicitly OUT of scope" — escalation
//     EXECUTION is part 2) — this file does not require them and does not test their edges.
//   - `ALERT_LOG_EVENTS` — event-type constants; this file only requires ACKNOWLEDGE.
//   - `alertLogMachine` — an XState v5 machine, `id: 'alertLog'`, `initial:
//     ALERT_LOG_STATUS.FIRED`, at minimum the fired --ACKNOWLEDGE--> acknowledged edge and no
//     ACKNOWLEDGE edge out of 'acknowledged' (re-acknowledging is a domain error, not a machine
//     transition — assert-alert-application layer maps that to AlertAlreadyAcknowledgedError,
//     exercised in evaluate-alerts.test.ts, not here).
//
// Table-driven, via XState v5's own `actor.getSnapshot().can(event)` — never a hand-rolled
// comparison against a parallel if/switch, which would just relocate the CLAUDE.md violation into
// the test.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { ALERT_LOG_EVENTS, ALERT_LOG_STATUS, alertLogMachine } from '../../domain/evaluate-alerts/machine.js';

function actorAt(state: string) {
  // XState v5: start an actor and immediately re-hydrate it at the target state via its own
  // persisted-snapshot shape (same technique the golden slice's machine test uses) — no
  // hand-written transition table.
  const initial = createActor(alertLogMachine).getSnapshot();
  const snapshot = { ...initial, value: state };
  return createActor(alertLogMachine, { snapshot });
}

describe('alertLogMachine — fired -> acknowledged (part 1 scope)', () => {
  it('starts in "fired"', () => {
    const actor = createActor(alertLogMachine);
    actor.start();
    expect(actor.getSnapshot().value).toBe(ALERT_LOG_STATUS.FIRED);
    actor.stop();
  });

  it('ALLOWS ACKNOWLEDGE from "fired" and lands on "acknowledged"', () => {
    const actor = createActor(alertLogMachine);
    actor.start();
    expect(actor.getSnapshot().can({ type: ALERT_LOG_EVENTS.ACKNOWLEDGE })).toBe(true);
    actor.send({ type: ALERT_LOG_EVENTS.ACKNOWLEDGE });
    expect(actor.getSnapshot().value).toBe(ALERT_LOG_STATUS.ACKNOWLEDGED);
    actor.stop();
  });

  it('REJECTS a second ACKNOWLEDGE from "acknowledged" — the machine offers no such edge', () => {
    const actor = actorAt(ALERT_LOG_STATUS.ACKNOWLEDGED);
    actor.start();
    expect(actor.getSnapshot().can({ type: ALERT_LOG_EVENTS.ACKNOWLEDGE })).toBe(false);
    actor.stop();
  });
});
