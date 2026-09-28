// modules/billing/application/dimensions/ports.ts — WBS 4.1b PART 2 (lane 2).
//
// application/ layer: the ports the dimensions use case programs against (golden-slice shape,
// modules/wms/application/receive-inbound/ports.ts). Every command takes ONE `deps: DimensionsDeps`
// and never imports infrastructure/. ../../infrastructure/dimensions/repository.ts implements
// `DimensionValueRepository`; ../../api/dimensions/composition.ts wires it.

import type { Clock } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type { DimensionValueStatus } from '../../domain/dimensions/machine.js';

/** Everything a command needs, injected by the composition root. No id generator: the value's id is
 *  the database default (gen_random_uuid()), returned by the insert. */
export interface DimensionsDeps {
  readonly clock: Clock;
  readonly repo: DimensionValueRepository;
}

/** A billing.dimension_values row, as the deactivate command reads it under lock. `status` is the
 *  adapter's mapping of is_active onto ../../domain/dimensions/machine.ts's states. */
export interface DimensionValueRow {
  readonly id: string;
  readonly entityId: string;
  readonly dimensionTypeId: string;
  readonly status: DimensionValueStatus;
  readonly version: number;
}

export interface NewDimensionValue {
  readonly entityId: string;
  readonly dimensionTypeId: string;
  readonly code: string;
  readonly name: string;
}

/** Every DB statement the dimensions use case needs — run against the `tx` a caller's own
 *  withContext(ctx, fn) opened, so entity_scope RLS applies to each one. */
export interface DimensionValueRepository {
  /** Inserts an active value at version 1; returns the stored id and version. */
  insertValue(tx: NodePgDatabase, value: NewDimensionValue): Promise<{ readonly id: string; readonly version: number }>;
  /** `select ... for update` on the one value row, FIRST. Throws DimensionValueNotFoundError when no
   *  row is visible (absent, or hidden by RLS). */
  getValueForUpdate(tx: NodePgDatabase, dimensionValueId: string): Promise<DimensionValueRow>;
  /** Writes the new status and bumps version by one on the row already locked; returns the new
   *  version. */
  updateValueStatus(tx: NodePgDatabase, dimensionValueId: string, status: DimensionValueStatus): Promise<number>;
  /** One platform.audit_log row for a billing.dimension_values write, in the caller's transaction. */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly entityId: string;
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
