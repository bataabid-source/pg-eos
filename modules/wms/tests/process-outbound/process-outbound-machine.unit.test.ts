// modules/wms/tests/process-outbound/process-outbound-machine.unit.test.ts — WBS 2.11 part 1 +
// part 2 (_slice-2.11.brief.md, part 2, Master decision 1).
//
// Domain-layer unit tests for modules/wms/domain/process-outbound/machine.ts — pure, no DB, no I/O
// (CLAUDE.md · ARCHITECTURE: "No if/switch for state transitions — XState"). Part 1's own edges:
//   draft --RUN_CHECKS_PASS--> checks_pending
//   draft --RUN_CHECKS_CREDIT_FAIL--> credit_rejected
//   checks_pending --APPROVE--> approved
//   {draft, checks_pending, credit_rejected, approved} --CANCEL--> cancelled
// Part 2 ADDS (brief Master decision 1 — RED until pg-backend edits machine.ts):
//   approved --ALLOCATE_FULL--> allocated
//   approved --ALLOCATE_PARTIAL--> partially_allocated
//   {allocated, partially_allocated} --CANCEL--> cancelled
// (CancelOutbound is now legal from six statuses total, not four — every other status
// (picking...delivered) still has NO producing edge, 2.12's job.)
// `chk_outbound_orders_status` (13B:2326-2327) is the full 14-value enum this part's
// OUTBOUND_ORDER_STATUS must carry verbatim.
//
// Expected exports (mirrors ../../domain/receive-inbound/machine.ts's own shape, "REPLACE-ON-COPY"):
//   OUTBOUND_ORDER_STATUS, OUTBOUND_ORDER_EVENTS, canTransition(current, event): boolean,
//   advanceOutboundOrder(current, events): status (THROWS IllegalTransitionError on the first
//   illegal event), allowedEventsFrom(status): event[].

import { describe, expect, it } from 'vitest';

import {
  OUTBOUND_ORDER_EVENTS,
  OUTBOUND_ORDER_STATUS,
  advanceOutboundOrder,
  allowedEventsFrom,
  canTransition,
  type OutboundOrderStatus,
} from '../../domain/process-outbound/machine.js';
import { IllegalTransitionError } from '../../domain/process-outbound/errors.js';

// chk_outbound_orders_status (13B-Schema-Reference-Consolidation.sql:2326-2327), verbatim.
const ALL_14_STATUSES: readonly OutboundOrderStatus[] = [
  'draft',
  'checks_pending',
  'credit_rejected',
  'approved',
  'allocated',
  'partially_allocated',
  'picking',
  'picked',
  'checked',
  'packed',
  'loaded',
  'dispatched',
  'delivered',
  'cancelled',
];

describe('OUTBOUND_ORDER_STATUS — verbatim 14-value chk_outbound_orders_status', () => {
  it('carries exactly the 14 values, no more, no fewer', () => {
    const values = Object.values(OUTBOUND_ORDER_STATUS).sort();
    expect(values).toEqual([...ALL_14_STATUSES].sort());
  });
});

describe('the four edges this part builds', () => {
  it('draft --RUN_CHECKS_PASS--> checks_pending', () => {
    expect(canTransition(OUTBOUND_ORDER_STATUS.DRAFT, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS)).toBe(true);
    expect(
      advanceOutboundOrder(OUTBOUND_ORDER_STATUS.DRAFT, [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS]),
    ).toBe(OUTBOUND_ORDER_STATUS.CHECKS_PENDING);
  });

  it('draft --RUN_CHECKS_CREDIT_FAIL--> credit_rejected', () => {
    expect(canTransition(OUTBOUND_ORDER_STATUS.DRAFT, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL)).toBe(true);
    expect(
      advanceOutboundOrder(OUTBOUND_ORDER_STATUS.DRAFT, [OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL]),
    ).toBe(OUTBOUND_ORDER_STATUS.CREDIT_REJECTED);
  });

  it('checks_pending --APPROVE--> approved', () => {
    expect(canTransition(OUTBOUND_ORDER_STATUS.CHECKS_PENDING, OUTBOUND_ORDER_EVENTS.APPROVE)).toBe(true);
    expect(
      advanceOutboundOrder(OUTBOUND_ORDER_STATUS.CHECKS_PENDING, [OUTBOUND_ORDER_EVENTS.APPROVE]),
    ).toBe(OUTBOUND_ORDER_STATUS.APPROVED);
  });

  it.each([
    OUTBOUND_ORDER_STATUS.DRAFT,
    OUTBOUND_ORDER_STATUS.CHECKS_PENDING,
    OUTBOUND_ORDER_STATUS.CREDIT_REJECTED,
    OUTBOUND_ORDER_STATUS.APPROVED,
  ])('%s --CANCEL--> cancelled', (from) => {
    expect(canTransition(from, OUTBOUND_ORDER_EVENTS.CANCEL)).toBe(true);
    expect(advanceOutboundOrder(from, [OUTBOUND_ORDER_EVENTS.CANCEL])).toBe(OUTBOUND_ORDER_STATUS.CANCELLED);
  });
});

// --- part 2's own three edges (Master decision 1) --------------------------------------------

describe('the three edges part 2 adds', () => {
  it('approved --ALLOCATE_FULL--> allocated', () => {
    expect(canTransition(OUTBOUND_ORDER_STATUS.APPROVED, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL)).toBe(true);
    expect(
      advanceOutboundOrder(OUTBOUND_ORDER_STATUS.APPROVED, [OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL]),
    ).toBe(OUTBOUND_ORDER_STATUS.ALLOCATED);
  });

  it('approved --ALLOCATE_PARTIAL--> partially_allocated', () => {
    expect(canTransition(OUTBOUND_ORDER_STATUS.APPROVED, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL)).toBe(true);
    expect(
      advanceOutboundOrder(OUTBOUND_ORDER_STATUS.APPROVED, [OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL]),
    ).toBe(OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED);
  });

  it.each([OUTBOUND_ORDER_STATUS.ALLOCATED, OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED])(
    '%s --CANCEL--> cancelled (extended source set, six statuses total)',
    (from) => {
      expect(canTransition(from, OUTBOUND_ORDER_EVENTS.CANCEL)).toBe(true);
      expect(advanceOutboundOrder(from, [OUTBOUND_ORDER_EVENTS.CANCEL])).toBe(OUTBOUND_ORDER_STATUS.CANCELLED);
    },
  );
});

describe('every other transition is illegal', () => {
  it.each([
    // draft cannot APPROVE (checks were never run) or receive RUN_CHECKS_CREDIT_FAIL twice in a row.
    [OUTBOUND_ORDER_STATUS.DRAFT, OUTBOUND_ORDER_EVENTS.APPROVE],
    // checks_pending cannot re-run RUN_CHECKS_PASS/RUN_CHECKS_CREDIT_FAIL.
    [OUTBOUND_ORDER_STATUS.CHECKS_PENDING, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS],
    [OUTBOUND_ORDER_STATUS.CHECKS_PENDING, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL],
    // credit_rejected cannot APPROVE or re-run checks — cancel only.
    [OUTBOUND_ORDER_STATUS.CREDIT_REJECTED, OUTBOUND_ORDER_EVENTS.APPROVE],
    [OUTBOUND_ORDER_STATUS.CREDIT_REJECTED, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS],
    // approved cannot re-run checks or APPROVE again.
    [OUTBOUND_ORDER_STATUS.APPROVED, OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS],
    [OUTBOUND_ORDER_STATUS.APPROVED, OUTBOUND_ORDER_EVENTS.APPROVE],
    // cancelled is terminal — nothing is legal from it.
    [OUTBOUND_ORDER_STATUS.CANCELLED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.CANCELLED, OUTBOUND_ORDER_EVENTS.APPROVE],
    // part 2's own picking-onward statuses still have NO edge — 2.12's job. Cancel is now legal
    // from `allocated`/`partially_allocated` (the two edges just above) but NOT from any status
    // reachable only past allocation.
    [OUTBOUND_ORDER_STATUS.PICKING, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.PICKED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.CHECKED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.PACKED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.LOADED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.DISPATCHED, OUTBOUND_ORDER_EVENTS.CANCEL],
    [OUTBOUND_ORDER_STATUS.DELIVERED, OUTBOUND_ORDER_EVENTS.CANCEL],
    // ALLOCATE_FULL/ALLOCATE_PARTIAL are legal ONLY from `approved` — every other status, including
    // `allocated`/`partially_allocated` themselves (no re-allocation), rejects both.
    [OUTBOUND_ORDER_STATUS.DRAFT, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.CHECKS_PENDING, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.CREDIT_REJECTED, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.ALLOCATED, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.CANCELLED, OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL],
    [OUTBOUND_ORDER_STATUS.DRAFT, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
    [OUTBOUND_ORDER_STATUS.CHECKS_PENDING, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
    [OUTBOUND_ORDER_STATUS.CREDIT_REJECTED, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
    [OUTBOUND_ORDER_STATUS.ALLOCATED, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
    [OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
    [OUTBOUND_ORDER_STATUS.CANCELLED, OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL],
  ] as const)('canTransition(%s, %s) is false', (from, event) => {
    expect(canTransition(from, event)).toBe(false);
  });

  it('advanceOutboundOrder throws IllegalTransitionError for an illegal event and names the allowed ones', () => {
    expect(() => advanceOutboundOrder(OUTBOUND_ORDER_STATUS.DRAFT, [OUTBOUND_ORDER_EVENTS.APPROVE])).toThrow(
      IllegalTransitionError,
    );
  });

  it('allowedEventsFrom("draft") is exactly [RUN_CHECKS_PASS, RUN_CHECKS_CREDIT_FAIL, CANCEL]', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.DRAFT).sort()).toEqual(
      [
        OUTBOUND_ORDER_EVENTS.RUN_CHECKS_PASS,
        OUTBOUND_ORDER_EVENTS.RUN_CHECKS_CREDIT_FAIL,
        OUTBOUND_ORDER_EVENTS.CANCEL,
      ].sort(),
    );
  });

  it('allowedEventsFrom("cancelled") is empty — terminal state', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.CANCELLED)).toEqual([]);
  });

  it('allowedEventsFrom("approved") is exactly [ALLOCATE_FULL, ALLOCATE_PARTIAL, CANCEL] (part 2)', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.APPROVED).sort()).toEqual(
      [
        OUTBOUND_ORDER_EVENTS.ALLOCATE_FULL,
        OUTBOUND_ORDER_EVENTS.ALLOCATE_PARTIAL,
        OUTBOUND_ORDER_EVENTS.CANCEL,
      ].sort(),
    );
  });

  it('allowedEventsFrom("allocated") is exactly [CANCEL] (part 2 adds the release path)', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.ALLOCATED)).toEqual([OUTBOUND_ORDER_EVENTS.CANCEL]);
  });

  it('allowedEventsFrom("partially_allocated") is exactly [CANCEL] (part 2 adds the release path)', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.PARTIALLY_ALLOCATED)).toEqual([OUTBOUND_ORDER_EVENTS.CANCEL]);
  });

  it('allowedEventsFrom("picking") is empty — 2.12\'s job, no edge yet', () => {
    expect(allowedEventsFrom(OUTBOUND_ORDER_STATUS.PICKING)).toEqual([]);
  });
});
