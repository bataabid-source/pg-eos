// modules/wms/src/stock-ledger/index.ts — WBS 2.8 (pg-backend).
//
// Barrel for the stock-ledger mechanism (brief "Public surface" block, verbatim names).

export {
  MOVEMENT_TYPES,
  balanceKey,
  deriveBalances,
  planReversal,
  planTransfer,
  validateEntry,
  type LedgerEntry,
  type MovementType,
} from './domain.js';

export {
  InvalidLedgerEntryError,
  InvalidQuantityError,
  MovementNotFoundError,
  NegativeStockError,
} from './errors.js';

export {
  postMovement,
  postTransfer,
  reverseMovement,
  type LedgerDeps,
  type PostMovementInput,
  type PostedMovement,
} from './post-movement.js';

export { rebuildBalance } from './rebuild-balance.js';
