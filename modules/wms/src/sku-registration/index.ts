// modules/wms/src/sku-registration/index.ts — WBS 2.6 (pg-backend).
//
// Barrel for the sku-registration mechanism (brief "Public surface" block, verbatim names).

export {
  PICKING_POLICIES,
  SKU_STATUSES,
  validateSkuInput,
  type PickingPolicy,
  type RegisterSkuInput,
  type SkuStatus,
} from './domain.js';

export {
  CrossClientSkuError,
  DuplicateSkuCodeError,
  InvalidSkuInputError,
  UnknownClientError,
} from './errors.js';

export {
  registerSku,
  type RegisterSkuCommandInput,
  type RegisterSkuDeps,
  type RegisteredSku,
} from './register-sku.js';
