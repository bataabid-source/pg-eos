// modules/billing/application/record-billable-event/index.ts — WBS 4.3 part 1 (lane 2).
//
// Barrel for the record-billable-event use case's subscriber handlers (application/ layer public
// surface; golden slice: modules/wms/application/receive-inbound/index.ts).

export type {
  BillableEventInsert,
  BillableEventRepository,
  BillableServiceRow,
  BillableSource,
  Logger,
  LogFields,
  RecordBillableEventDeps,
  SystemActorPort,
} from './ports.js';
export {
  OutboundCheckedPayloadSchema,
  recordOutboundChecked,
  type OutboundCheckedPayload,
  type RecordOutboundCheckedResult,
} from './record-outbound-checked.js';
