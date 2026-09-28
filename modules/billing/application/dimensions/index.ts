// modules/billing/application/dimensions/index.ts — WBS 4.1b PART 2 (lane 2).
//
// Barrel for the dimensions use case's two commands (application/ layer public surface).

export type { DimensionValueRepository, DimensionValueRow, DimensionsDeps, NewDimensionValue } from './ports.js';
export {
  createDimensionValue,
  type CreateDimensionValueInput,
  type CreateDimensionValueResult,
} from './create-dimension-value.js';
export {
  deactivateDimensionValue,
  type DeactivateDimensionValueInput,
  type DeactivateDimensionValueResult,
} from './deactivate-dimension-value.js';
