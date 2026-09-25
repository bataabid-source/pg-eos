// M04 warehouse (wms) — package shell created by WBS 2.1 (proof slice, replicating the WBS 0.4
// monorepo skeleton pattern used for modules/platform and modules/identity).
// The module's own surface is built by later WBS 2.x tasks; its hexagonal file tree is copied
// from the golden slice (WBS 2.9) by scripts/new-slice.sh — never hand-made (CLAUDE.md).
//
// WBS 2.8 is a mechanism slice (precedent 0.17): no endpoint/UI/XState exists yet, so its code
// lives flat under src/stock-ledger/ instead of a hexagonal tree (brief docs/notes/
// slice-briefs/_slice-2.8.brief.md, "Type of slice"). Re-exported here — the module's public barrel — per the
// brief's Public surface block.
export * from './src/stock-ledger/index.js';

// WBS 2.6 is a mechanism slice (precedent WBS 2.8, WBS 0.17): the schema already delivers
// wms.skus (01-Data-Model.sql); this re-exports the registration mechanism built flat under
// src/sku-registration/ (brief docs/notes/slice-briefs/_slice-2.6.brief.md, "Type of slice").
export * from './src/sku-registration/index.js';

// WBS 2.9 is THE GOLDEN SLICE — the first hexagonal (domain/application/infrastructure/api) use
// case, replicated file-for-file by every later slice via scripts/new-slice.sh. Its public
// surface: the six application-layer commands and their typed domain errors.
export * from './application/receive-inbound/index.js';
export * from './domain/receive-inbound/errors.js';

// WBS 2.13 — count-inventory (INV-C3-7), replicating the golden slice's own file tree. Named
// re-exports (not `export *`): ./domain/receive-inbound/errors.js already exports
// RoleRequiredError / StaleVersionError / IllegalTransitionError / MissingActorError — a wildcard
// re-export from both use cases would collide (same discipline as modules/hr/index.ts's own
// maintain-shift precedent). count-inventory's own error names are aliased with a `CountInventory`
// prefix here so both use cases' typed errors stay reachable from this one module barrel.
export {
  startCount,
  countLocation,
  recount,
  adjustCount,
  type StartCountInput,
  type StartCountResult,
  type CountLocationInput,
  type CountLocationResult,
  type RecountInput,
  type RecountResult,
  type AdjustCountInput,
  type AdjustCountResult,
  type CountInventoryDeps,
  type InventoryCountRepository,
} from './application/count-inventory/index.js';
export {
  AlreadyCountedError,
  NotFlaggedForRecountError,
  CountFilterRequiredError,
  WarehouseNotFoundError,
  CountNotFoundError,
  LineNotFoundError as CountInventoryLineNotFoundError,
  RoleRequiredError as CountInventoryRoleRequiredError,
  StaleVersionError as CountInventoryStaleVersionError,
  IllegalTransitionError as CountInventoryIllegalTransitionError,
  MissingActorError as CountInventoryMissingActorError,
} from './domain/count-inventory/errors.js';

// WBS 2.11 part 1 — process-outbound (create, ten-condition check, approve, cancel), replicating
// the golden slice's own file tree. Named re-exports (not `export *`): ./domain/receive-inbound/
// errors.js already exports StaleVersionError / IllegalTransitionError / RoleRequiredError /
// OrderNotFoundError / MissingActorError / SkuClientMismatchError — a wildcard re-export from both
// use cases would collide (same discipline as count-inventory's own `CountInventory` prefix
// above). process-outbound's own colliding error names are aliased with a `ProcessOutbound` prefix
// here so both use cases' typed errors stay reachable from this one module barrel.
export {
  createOutbound,
  runOutboundChecks,
  approveOutbound,
  cancelOutbound,
  type CreateOutboundInput,
  type CreateOutboundResult,
  type RunOutboundChecksInput,
  type RunOutboundChecksResult,
  type ApproveOutboundInput,
  type ApproveOutboundResult,
  type CancelOutboundInput,
  type CancelOutboundResult,
  type ProcessOutboundDeps,
  type OutboundOrderRepository,
} from './application/process-outbound/index.js';
export {
  ClientNotQualifiedError,
  CancelReasonRequiredError,
  ContractNotActiveError,
  ContractExpiredError,
  CreditHoldError,
  InsufficientStockError,
  ShelfLifeTooShortError,
  SkuBlockedError,
  LocationBlockedError,
  DeliveryAddressIncompleteError,
  NoServicePriceError,
  StaleVersionError as ProcessOutboundStaleVersionError,
  IllegalTransitionError as ProcessOutboundIllegalTransitionError,
  RoleRequiredError as ProcessOutboundRoleRequiredError,
  OrderNotFoundError as ProcessOutboundOrderNotFoundError,
  MissingActorError as ProcessOutboundMissingActorError,
  SkuClientMismatchError as ProcessOutboundSkuClientMismatchError,
  SkuNotFoundError as ProcessOutboundSkuNotFoundError,
} from './domain/process-outbound/errors.js';
