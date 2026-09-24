// modules/wms/src/stock-ledger/index.ts — WBS 2.8 (pg-backend).
//
// Barrel for the stock-ledger mechanism (brief "Public surface" block, verbatim names).

export {
  MOVEMENT_TYPES,
  balanceKey,
  balanceRebuildLockKey,
  deriveBalances,
  evaluateLocationLimits,
  hasWeightVolumeLimits,
  locationLimitLockKey,
  planReversal,
  planTransfer,
  validateEntry,
  type LedgerEntry,
  type LocationLimitReason,
  type LocationLimitVerdict,
  type MovementType,
} from './domain.js';

export {
  InvalidLedgerEntryError,
  InvalidQuantityError,
  LocationBlockedError,
  LocationLimitExceededError,
  MovementNotFoundError,
  NegativeStockError,
  RebuildScopeError,
} from './errors.js';

export {
  postMovement,
  postMovementInTx,
  postTransfer,
  postTransferInTx,
  reverseMovement,
  type LedgerDeps,
  type PostMovementInput,
  type PostTransferInput,
  type PostedMovement,
} from './post-movement.js';

export { rebuildBalance } from './rebuild-balance.js';
