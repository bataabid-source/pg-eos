// modules/hr/domain/dispute-commission/machine.ts — WBS 3.13 part 4.
//
// domain/ layer: pure state-transition rules for hr.commission_daily.status, no I/O, no Date, no
// Math.random() (CLAUDE.md · AGENT CONSTRAINTS). CLAUDE.md · ARCHITECTURE: "No if/switch for state
// transitions — XState." SHARED by both dispute-commission and confirm-commission (brief decision
// 2: "may be SHARED — a single commission-daily-status machine both commands import") — this file
// is the ONE machine both use cases' application layers consult via `canTransition`/
// `allowedEventsFrom`, never a hand-written if/switch on the status string.
//
// Source: database/schema/13-Schema-Additions.sql:379-380 (`status` column comment: "calculated ·
// disputed · confirmed · paid") + migration 0033 (chk_commission_daily_status corrected to this
// 4-value vocabulary; hr.guard_commission_daily_status() enforces the identical edge set as a
// DB-level backstop). Edges (brief decision 2, verbatim):
//   calculated -> disputed  (DISPUTE, DisputeCommission)
//   calculated -> confirmed (CONFIRM, ConfirmCommission — the window-expiry auto-confirm path,
//                             skipping "disputed" entirely)
//   disputed   -> confirmed (CONFIRM, ConfirmCommission — DEL_SUP resolves the dispute)
// `paid` carries NO incoming edge this slice (brief decision 2: "confirmed -> paid ... OUT OF
// SCOPE this part" — WBS 5.6 Payroll ledger's own future concern).
//
// Shape copied from modules/hr/domain/register-employee/machine.ts (this module's own nearest
// precedent): a status enum, an events enum, and a single flat XState v5 machine consulted only
// through `.can()`.

import { createActor, createMachine } from 'xstate';

/** hr.commission_daily.status — the 4-value vocabulary, verbatim (13-Schema-Additions.sql:379-380,
 *  migration 0033's own corrected chk_commission_daily_status). */
export const COMMISSION_DAILY_STATUS = {
  CALCULATED: 'calculated',
  DISPUTED: 'disputed',
  CONFIRMED: 'confirmed',
  PAID: 'paid',
} as const;

export type CommissionDailyStatus = (typeof COMMISSION_DAILY_STATUS)[keyof typeof COMMISSION_DAILY_STATUS];

/** One event per command this slice delivers (brief decision 2) — DisputeCommission always sends
 *  DISPUTE, ConfirmCommission always sends CONFIRM, regardless of which of the two legal source
 *  states ('calculated' or 'disputed') the row is currently in. */
export const COMMISSION_DAILY_EVENTS = {
  DISPUTE: 'DISPUTE',
  CONFIRM: 'CONFIRM',
} as const;

export type CommissionDailyEventType = (typeof COMMISSION_DAILY_EVENTS)[keyof typeof COMMISSION_DAILY_EVENTS];

/** Per-state tags (XState v5 `states.<id>.tags`) — the ONLY per-status requirement the shared
 *  application layer (ConfirmCommission) reads via the actor's own snapshot (`.hasTag()`), never a
 *  hand-written `=== COMMISSION_DAILY_STATUS.X` comparison (CLAUDE.md · ARCHITECTURE: "No
 *  if/switch for state transitions — XState", round-1 review finding 1). `REQUIRES_WINDOW_ELAPSED`
 *  is carried by exactly the 'calculated' state (the plain window-expiry auto-confirm path must
 *  wait for the dispute window to close, brief decision 2/4). `REQUIRES_CONFIRM_PERMISSION` is
 *  carried by exactly the 'disputed' state (resolving an ACTIVE dispute is DEL_SUP-only,
 *  SCR-HR-COMM-01, D-190, migration 0033 round-4 finding 3). */
export const COMMISSION_DAILY_TAGS = {
  REQUIRES_WINDOW_ELAPSED: 'requiresWindowElapsed',
  REQUIRES_CONFIRM_PERMISSION: 'requiresConfirmPermission',
} as const;

export type CommissionDailyTag = (typeof COMMISSION_DAILY_TAGS)[keyof typeof COMMISSION_DAILY_TAGS];

/**
 * Pure state chart — no actions, no guards, no context: the application layer decides everything
 * ABOUT a transition (SoD, the dispute-window check, optimistic lock, DB writes); this machine
 * only decides WHETHER one is legal from the current status, and (via `tags`) WHICH per-state
 * requirements apply — never an if/switch on the status string.
 */
export const commissionDailyMachine = createMachine({
  id: 'commissionDaily',
  initial: COMMISSION_DAILY_STATUS.CALCULATED,
  states: {
    [COMMISSION_DAILY_STATUS.CALCULATED]: {
      tags: [COMMISSION_DAILY_TAGS.REQUIRES_WINDOW_ELAPSED],
      on: {
        [COMMISSION_DAILY_EVENTS.DISPUTE]: COMMISSION_DAILY_STATUS.DISPUTED,
        [COMMISSION_DAILY_EVENTS.CONFIRM]: COMMISSION_DAILY_STATUS.CONFIRMED,
      },
    },
    [COMMISSION_DAILY_STATUS.DISPUTED]: {
      tags: [COMMISSION_DAILY_TAGS.REQUIRES_CONFIRM_PERMISSION],
      on: {
        [COMMISSION_DAILY_EVENTS.CONFIRM]: COMMISSION_DAILY_STATUS.CONFIRMED,
      },
    },
    [COMMISSION_DAILY_STATUS.CONFIRMED]: {
      // No outgoing edge this slice (confirmed -> paid is WBS 5.6's own future concern).
    },
    [COMMISSION_DAILY_STATUS.PAID]: {
      type: 'final',
    },
  },
});

/** Starts a fresh actor re-hydrated at `state` via the machine's own `resolveState` (XState v5
 *  API) — never a hand-spread of an internal snapshot shape. */
function actorAt(state: CommissionDailyStatus) {
  const snapshot = commissionDailyMachine.resolveState({ value: state });
  return createActor(commissionDailyMachine, { snapshot });
}

/**
 * True iff `event` is a legal transition from `current` (per the state chart above). Both
 * application-layer commands (../../application/dispute-commission/dispute-commission.ts,
 * ../../application/confirm-commission/confirm-commission.ts) use this INSTEAD OF an if/switch on
 * the status string — CLAUDE.md · AGENT CONSTRAINTS: "No if/switch for state transitions —
 * XState."
 */
export function canTransition(current: CommissionDailyStatus, event: CommissionDailyEventType): boolean {
  const actor = actorAt(current);
  actor.start();
  const can = actor.getSnapshot().can({ type: event });
  actor.stop();
  return can;
}

/** Every event legal from `state` — named in IllegalTransitionError so the caller learns what is
 *  allowed (doc 36 §5-4 #7). */
export function allowedEventsFrom(state: CommissionDailyStatus): CommissionDailyEventType[] {
  return Object.values(COMMISSION_DAILY_EVENTS).filter((event) => canTransition(state, event));
}

/**
 * True iff `state`'s own state node carries `tag` (XState v5 `snapshot.hasTag()`) — the shared
 * machine is the ONLY place a per-status requirement (e.g. "this status requires
 * hr.commission.confirm" or "this status requires the dispute window to have elapsed") is
 * recorded; ConfirmCommission (../../application/confirm-commission/confirm-commission.ts) reads
 * this INSTEAD OF comparing `row.status` against a `COMMISSION_DAILY_STATUS` literal (CLAUDE.md ·
 * ARCHITECTURE: "No if/switch for state transitions — XState", round-1 review finding 1).
 */
export function stateHasTag(state: CommissionDailyStatus, tag: CommissionDailyTag): boolean {
  const actor = actorAt(state);
  actor.start();
  const has = actor.getSnapshot().hasTag(tag);
  actor.stop();
  return has;
}
