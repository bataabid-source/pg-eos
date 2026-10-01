// modules/tms/tests/create-delivery-task/delivery-task-machine.unit.test.ts — WBS 3.4 part 1.
//
// The XState v5 machine for tms.delivery_tasks.status carries `created` ONLY in part 1 (assignment
// `created -> assigned` is part 2, brief Decision 3): initial state 'created', no other state, no
// event moves it. CLAUDE.md: no if/switch for state transitions.
//
// Expected surface — modules/tms/domain/create-delivery-task/machine.ts:
//   DELIVERY_TASK_STATUS = { CREATED: 'created' } as const
//   deliveryTaskMachine — XState v5 machine, initial DELIVERY_TASK_STATUS.CREATED, one state.

import { createActor } from 'xstate';
import { describe, expect, it } from 'vitest';

import { DELIVERY_TASK_STATUS, deliveryTaskMachine } from '../../domain/create-delivery-task/machine.js';

describe('deliveryTaskMachine (part 1: created only)', () => {
  it('DELIVERY_TASK_STATUS.CREATED is the schema value "created" (chk_delivery_tasks_status)', () => {
    expect(DELIVERY_TASK_STATUS.CREATED).toBe('created');
    expect(Object.values(DELIVERY_TASK_STATUS)).toEqual(['created']);
  });

  it('a new actor starts in "created" and has exactly that one state', () => {
    const actor = createActor(deliveryTaskMachine).start();
    expect(actor.getSnapshot().value).toBe(DELIVERY_TASK_STATUS.CREATED);
    expect(Object.keys(deliveryTaskMachine.config.states ?? {})).toEqual([DELIVERY_TASK_STATUS.CREATED]);
  });
});
