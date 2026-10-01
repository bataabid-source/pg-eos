// modules/tms/domain/create-delivery-task/machine.ts — WBS 3.4 part 1.
//
// XState v5 machine for tms.delivery_tasks.status (CLAUDE.md: no if/switch for state transitions).
// Part 1 carries `created` ONLY — assignment (`created -> assigned`, INV-C4-1) and every later state
// of chk_delivery_tasks_status (13B:2338-2339) are 3.4 part 2+ (brief Decision 3). No event moves it.

import { setup } from 'xstate';

export const DELIVERY_TASK_STATUS = {
  CREATED: 'created',
} as const;

export type DeliveryTaskStatus = (typeof DELIVERY_TASK_STATUS)[keyof typeof DELIVERY_TASK_STATUS];

/** The status a new tms.delivery_tasks row is written with. Single source: the machine below takes its
 *  `initial` from this constant, so the row's first status and the machine's initial state cannot drift. */
export const INITIAL_DELIVERY_TASK_STATUS: DeliveryTaskStatus = DELIVERY_TASK_STATUS.CREATED;

export const deliveryTaskMachine = setup({}).createMachine({
  id: 'deliveryTask',
  initial: INITIAL_DELIVERY_TASK_STATUS,
  states: {
    [DELIVERY_TASK_STATUS.CREATED]: {},
  },
});
