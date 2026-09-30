// modules/tms/application/create-delivery-task/index.ts — WBS 3.4 part 1.
//
// Barrel for the create-delivery-task use case (application/ layer public surface).

export type {
  AuditTarget,
  ClockDeps,
  CreateDeliveryTaskDeps,
  DeliveryTasksRepository,
  InsertDeliveryTaskColumns,
  LogFields,
  Logger,
  OutboundOrderRow,
} from './ports.js';
export { createDeliveryTask, type CreateDeliveryTaskInput, type CreateDeliveryTaskResult } from './create-delivery-task.js';
