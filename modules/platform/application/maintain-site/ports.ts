// modules/platform/application/maintain-site/ports.ts — WBS 5.5a part 1 (lane 2).
//
// application/ layer: the ports this use case programs against. Every command takes ONE
// `deps: MaintainSiteDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/maintain-site/repository.ts implements `SiteRepository`.
// ../../api/maintain-site/composition.ts wires it. Shape copied from the golden slice's own
// ports.ts (modules/wms/application/receive-inbound/ports.ts) via the hr/register-employee
// precedent (modules/hr/application/register-employee/ports.ts) — this use case has no ledger, no
// documents, so those ports are dropped rather than left unused.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator every command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/maintain-site/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything a command needs, injected by the composition root
 *  (../../api/maintain-site/composition.ts). Commands program only against these ports — the
 *  application layer never imports infrastructure/. */
export interface MaintainSiteDeps extends ClockDeps {
  readonly repo: SiteRepository;
  readonly logger: Logger;
}

export interface SiteRow {
  readonly id: string;
  readonly entityId: string;
  readonly version: number;
  readonly isActive: boolean;
  /** the row's CURRENT kind/accountId — the application layer re-validates the domain invariants
   *  against the EFFECTIVE post-update values (input.kind ?? currentRow.kind, etc.), not just
   *  whatever fields this call happened to supply (brief Facts: the domain re-validates the SAME
   *  rules, not new ones). */
  readonly kind: string;
  readonly accountId: string | null;
}

export interface InsertSiteColumns {
  readonly entityId: string;
  readonly kind: string;
  readonly accountId: string | null;
  readonly warehouseId: string | null;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly address: string | null;
  readonly geoLat: number | null;
  readonly geoLng: number | null;
  /** `undefined` -> the INSERT's own column list omits `radius_m` entirely, so the DB column
   *  default (`platform.att_geofence_radius_m()`) fires (brief D5 — never a literal 500 here). */
  readonly radiusM: number | undefined;
  readonly contactPhone: string | null;
}

export interface UpdateSiteColumns {
  readonly kind: string | undefined;
  readonly accountId: string | null | undefined;
  readonly warehouseId: string | null | undefined;
  readonly nameAr: string | undefined;
  readonly nameEn: string | null | undefined;
  readonly address: string | null | undefined;
  readonly geoLat: number | null | undefined;
  readonly geoLng: number | null | undefined;
  readonly radiusM: number | undefined;
  readonly contactPhone: string | null | undefined;
  readonly isActive: boolean | undefined;
}

export interface InsertedSite {
  readonly id: string;
  readonly version: number;
  readonly radiusM: number;
}

/** Every DB statement the maintain-site use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/maintain-site/repository.ts. */
export interface SiteRepository {
  /** row lock, FIRST — `select ... for update`. Throws SiteNotFoundError (RLS hides a site
   *  outside the caller's entities the same way a missing id does). */
  getSiteForUpdate(tx: NodePgDatabase, siteId: string): Promise<SiteRow>;
  /** Builds the INSERT's own column list conditionally — no `radius_m` key at all when
   *  `columns.radiusM` is undefined (brief D5), so the DB column default fires. */
  insertSite(tx: NodePgDatabase, columns: InsertSiteColumns): Promise<InsertedSite>;
  /** unconditional version bump (brief D7 — every UpdateSite call that passes validation is
   *  treated as a real change). Only the columns the caller actually supplied are written — a
   *  field omitted by the caller keeps its current value. Returns the new version. */
  updateSite(tx: NodePgDatabase, siteId: string, columns: UpdateSiteColumns): Promise<{ readonly version: number }>;
  /** true iff the caller holds at least one of `roleCodes` (`platform.my_roles()`) — brief D3
   *  gates every command on an OR of roles, never a single one. */
  hasAnyRole(tx: NodePgDatabase, roleCodes: readonly string[]): Promise<boolean>;
  /** the caller's own entity (brief D6: "entity_id = ctx.entityId (never caller-supplied)") —
   *  resolved from identity.user_entities via platform.allowed_entities(), never trusted from the
   *  request body. */
  resolveCallerEntityId(tx: NodePgDatabase): Promise<string>;
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
