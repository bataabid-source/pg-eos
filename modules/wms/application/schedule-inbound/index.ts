// modules/wms/application/schedule-inbound/index.ts — WBS 2.9b (lane 2).
//
// Barrel for the schedule-inbound use case (application/ layer public surface).

export type {
  ClockDeps,
  Logger,
  LogFields,
  OrderRow,
  ScheduledAppointmentRow,
  ScheduleInboundDeps,
  ScheduleInboundRepository,
  ScheduleInboundUpdateColumns,
} from './ports.js';
export { scheduleInbound, type ScheduleInboundInput, type ScheduleInboundResult } from './schedule-inbound.js';
export {
  listScheduledAppointmentsToday,
  type ListScheduledAppointmentsTodayInput,
} from './list-scheduled-appointments-today.js';
