// modules/wms/application/receive-inbound/index.ts — WBS 2.9, THE GOLDEN SLICE.
//
// Barrel for the receive-inbound use case's six commands (application/ layer public surface).

export type { AuditTarget, ClockDeps, InboundOrderRepository, LedgerPort, PostedLedgerMovement, ReceiveInboundDeps } from './ports.js';
export { approveInbound, type ApproveInboundInput, type ApproveInboundResult } from './approve-inbound.js';
export { receiveLine, type ReceiveLineInput, type ReceiveLineResult } from './receive-line.js';
export { suggestLocation, type SuggestLocationInput, type SuggestLocationResult, type LocationCandidate } from './suggest-location.js';
export { confirmPutaway, type ConfirmPutawayInput, type ConfirmPutawayResult } from './confirm-putaway.js';
export { closeInbound, type CloseInboundInput, type CloseInboundResult } from './close-inbound.js';
export { cancelInbound, type CancelInboundInput, type CancelInboundResult } from './cancel-inbound.js';
