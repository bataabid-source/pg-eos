// modules/imile/application/pull-shipments/pull-shipments.ts — WBS 3.14 (part 2).
//
// ONE withIdempotentContext transaction per outcome (portal reachable or not) — step 0 (the
// idempotency advisory lock + platform.idempotency_keys upsert, ../../../../packages/db/src/
// idempotency.ts's withIdempotentContext) runs first whenever the command's own input carries an
// `idem`, ahead of everything this file does (same discipline as report-agent-health, this
// module's own part-1 precedent). A replay (same key, same body) never re-runs this command's own
// work at all — withIdempotentContext short-circuits BEFORE `fn` is even invoked and resolves
// with the STORED response from the first call (packages/db/src/idempotency.ts); this file's own
// `fn` callback is therefore the only place `deps.portal.fetchShipments()` is ever called, and
// `withIdempotentContext`'s own return value is what this command hands back to its caller — never
// a fixed `ZERO_RESULT` (reviewer finding 3, 2026-09-25: the earlier version threw away that
// return value and always answered ZERO_RESULT, and called the portal BEFORE the idempotency
// check ran at all, so a replay re-contacted the portal every time).
//
// Steps, per pull cycle:
//   0. the idempotency check (above) — a replay short-circuits here, before ANY portal call.
//   1. deps.clock.now() is read EXACTLY ONCE (`reportedAt`) — every row this call writes
//      (imile.shipments.last_sync_at, imile.agent_health.reported_at/last_pull_at) shares that
//      one instant, never a fresh `new Date()` per row (CLAUDE.md · AGENT CONSTRAINTS: no
//      Date.now()/new Date() in domain/, and here in application/ the clock port is still the
//      only time source).
//   2. deps.portal.fetchShipments() — the ONLY data source for shipment fields (brief, Contract
//      line). A thrown PortalUnreachableError is caught HERE: the pull cycle does not throw past
//      its own boundary — it writes one failed imile.agent_health row (session_valid=false,
//      error_message set) plus its own audit row, and returns a PullShipmentsResult of all-zero
//      counts (brief, Scenario "The portal is unreachable"). Any OTHER thrown value (a
//      programming/config error — e.g. PortalNotConfiguredError, or an untyped error) is NOT
//      caught here: it propagates past the command boundary, same as any other unexpected error
//      (api layer maps it to a generic 500 —
//      modules/imile/tests/pull-shipments/handlers.test.ts, "an unknown error maps to 500").
//   3. On a successful fetch: for every raw record, validate
//      (../../domain/pull-shipments/invariants.ts's validatePortalRecord) — a malformed record
//      (no/blank tracking_no) is skipped and counted, never fatal to the rest of the cycle
//      (brief, Scenario "A malformed portal record is skipped, not fatal"). A validated record
//      with no local match is INSERTed (internal_status/station_code stay at their table
//      defaults — never overridden here), with its own audit row (reviewer finding 5). A
//      validated record that DOES match a local row is compared field-by-field
//      (iMileChangedFieldKeys, is_fresh normalized to IS_FRESH_DEFAULT on both sides — reviewer
//      finding 4); no keys differ -> counted unchanged, no write; some differ -> deps.onBeforeUpdate()
//      (test-only seam, reviewer finding 9) then UPDATE the iMile-sourced columns ONLY,
//      `WHERE id=$1 AND version=$2` (migration 0024) plus a before/after audit row that carries
//      ONLY the keys that actually differ in VALUE: iMileChangedFieldKeys's own return, PLUS
//      `raw`/`last_sync_at` whenever THEIR values also differ (checked independently —
//      `rawChanged`/`lastSyncAtChanged` below; the UPDATE statement writes both columns every
//      time it runs, but the audit row reflects the true diff, not which columns the SQL
//      statement happened to name — reviewer finding 3 round 2 + finding 2 round 3, 2026-09-25).
//      `changedFields` on the audit row mirrors this same key set
//      (`platform.audit_log.changed_fields text[]`) — zero rows affected on the UPDATE means
//      another concurrent pull cycle already advanced the version, and THIS throws a
//      StaleVersionError that DOES propagate past the command boundary (brief, Scenario "Two
//      concurrent pull cycles racing on the same shipment" — not caught, unlike
//      PortalUnreachableError above).
//   4. The imile.agent_health row, last — one row per pull cycle, success or portal failure
//      (brief: "Every pull cycle (success or portal failure) writes one imile.agent_health row"),
//      plus its own audit row (reviewer finding 5, same discipline as report-agent-health part 1).

import { isDeepStrictEqual } from 'node:util';
import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';

import {
  validatePortalRecord,
  iMileChangedFieldKeys,
  IS_FRESH_DEFAULT,
} from '../../domain/pull-shipments/invariants.js';
import { PortalUnreachableError, StaleVersionError, MissingActorError } from '../../domain/pull-shipments/errors.js';
import type { PullShipmentsDeps } from './ports.js';

// imile.agent_health.agent_id (text, not null) — this internal job's own stable identity, as
// distinct from a human station-agent's own agentId (report-agent-health's caller-supplied
// field). Not a business number — a fixed label identifying which job wrote the row.
const PULL_SHIPMENTS_AGENT_ID = 'imile-pull-shipments';
// imile.agent_health.engine_version (text, nullable) — same fixture convention this module's own
// report-agent-health tests already use for a first release ('1.0.0').
const PULL_SHIPMENTS_ENGINE_VERSION = '1.0.0';
// imile.agent_health.pending_pushes (int, default 0) — this job never queues pushes; always 0.
const PENDING_PUSHES_NONE = 0;

const AUDIT_OPERATION_INSERT = 'insert';
const AUDIT_OPERATION_UPDATE = 'update';

export interface PullShipmentsInput {
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface PullShipmentsResult {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly unchanged: number;
}

export async function pullShipments(
  ctx: WithContextCtx,
  input: PullShipmentsInput,
  deps: PullShipmentsDeps,
): Promise<PullShipmentsResult> {
  // doc 40 P3/P7: every audit row this command writes needs an actor — ctx.userId ONLY, same
  // discipline as this module's own report-agent-health part 1 (reviewer finding 5). Checked
  // before the idempotency context, same order as report-agent-health.ts.
  if (!ctx.userId) throw new MissingActorError('PullShipments requires ctx.userId.');
  const actorId = ctx.userId;

  // Step 0 — the idempotency check runs FIRST: a replay resolves from the stored response and
  // never invokes this callback at all, so the portal is never re-contacted on a replay (reviewer
  // finding 3).
  return withIdempotentContext<PullShipmentsResult>(ctx, input.idem, async (tx) => {
    const reportedAt = deps.clock.now();

    let records: readonly unknown[];
    try {
      records = await deps.portal.fetchShipments();
    } catch (error) {
      if (error instanceof PortalUnreachableError) {
        // Step 2 (failure path) — caught here: the pull cycle does not throw past its own
        // boundary.
        const failedHealth = await deps.repo.insertAgentHealth(tx, {
          agentId: PULL_SHIPMENTS_AGENT_ID,
          sessionValid: false,
          lastPullAt: null,
          pendingPushes: PENDING_PUSHES_NONE,
          engineVersion: PULL_SHIPMENTS_ENGINE_VERSION,
          errorMessage: error.message,
          reportedAt,
        });
        await deps.repo.writeAuditRow(tx, {
          schemaName: 'imile',
          tableName: 'agent_health',
          recordId: failedHealth.id,
          operation: AUDIT_OPERATION_INSERT,
          correlationId: input.correlationId,
          actorId,
          newValue: {
            agentId: PULL_SHIPMENTS_AGENT_ID,
            sessionValid: false,
            lastPullAt: null,
            pendingPushes: PENDING_PUSHES_NONE,
            engineVersion: PULL_SHIPMENTS_ENGINE_VERSION,
            errorMessage: error.message,
          },
          occurredAt: reportedAt,
        });
        return { inserted: 0, updated: 0, skipped: 0, unchanged: 0 };
      }
      // Any other thrown value is unexpected/programming error — propagate past the boundary.
      throw error;
    }

    // Step 3 — every shipment write, inside the same transaction as the idempotency check.
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let unchanged = 0;

    for (const raw of records) {
      const validated = validatePortalRecord(raw);
      if (!validated) {
        skipped += 1;
        continue;
      }

      const existing = await deps.repo.findShipmentByTrackingNo(tx, validated.tracking_no);

      if (!existing) {
        const insertedRow = await deps.repo.insertShipment(tx, {
          trackingNo: validated.tracking_no,
          merchant: validated.merchant ?? null,
          zoneCode: validated.zone_code ?? null,
          area: validated.area ?? null,
          recipientPhone: validated.recipient_phone ?? null,
          isCod: validated.is_cod ?? null,
          codAmount: validated.cod_amount ?? null,
          isFresh: validated.is_fresh ?? IS_FRESH_DEFAULT,
          imileStatus: validated.imile_status ?? null,
          raw: validated.raw ?? null,
          lastSyncAt: reportedAt,
        });
        await deps.repo.writeAuditRow(tx, {
          schemaName: 'imile',
          tableName: 'shipments',
          recordId: insertedRow.id,
          operation: AUDIT_OPERATION_INSERT,
          correlationId: input.correlationId,
          actorId,
          newValue: {
            trackingNo: validated.tracking_no,
            merchant: validated.merchant ?? null,
            zoneCode: validated.zone_code ?? null,
            area: validated.area ?? null,
            recipientPhone: validated.recipient_phone ?? null,
            isCod: validated.is_cod ?? null,
            codAmount: validated.cod_amount ?? null,
            isFresh: validated.is_fresh ?? IS_FRESH_DEFAULT,
            imileStatus: validated.imile_status ?? null,
          },
          occurredAt: reportedAt,
        });
        inserted += 1;
        continue;
      }

      const incomingIMileFields = {
        merchant: validated.merchant ?? null,
        zone_code: validated.zone_code ?? null,
        area: validated.area ?? null,
        recipient_phone: validated.recipient_phone ?? null,
        is_cod: validated.is_cod ?? null,
        cod_amount: validated.cod_amount ?? null,
        is_fresh: validated.is_fresh ?? IS_FRESH_DEFAULT,
        imile_status: validated.imile_status ?? null,
      };
      const existingIMileFields = {
        merchant: existing.merchant,
        zone_code: existing.zoneCode,
        area: existing.area,
        recipient_phone: existing.recipientPhone,
        is_cod: existing.isCod,
        cod_amount: existing.codAmount,
        is_fresh: existing.isFresh ?? IS_FRESH_DEFAULT,
        imile_status: existing.imileStatus,
      };

      const changedKeys = iMileChangedFieldKeys(existingIMileFields, incomingIMileFields);
      if (changedKeys.length === 0) {
        unchanged += 1;
        continue;
      }

      // Test-only seam (reviewer finding 9): fires after the SELECT above, before the UPDATE
      // below — undefined in production, so production behavior is unchanged.
      if (deps.onBeforeUpdate) {
        await deps.onBeforeUpdate();
      }

      const updateResult = await deps.repo.updateShipmentIMileFields(tx, {
        id: existing.id,
        expectedVersion: existing.version,
        merchant: incomingIMileFields.merchant,
        zoneCode: incomingIMileFields.zone_code,
        area: incomingIMileFields.area,
        recipientPhone: incomingIMileFields.recipient_phone,
        isCod: incomingIMileFields.is_cod,
        codAmount: incomingIMileFields.cod_amount,
        isFresh: incomingIMileFields.is_fresh,
        imileStatus: incomingIMileFields.imile_status,
        raw: validated.raw ?? null,
        lastSyncAt: reportedAt,
      });
      if (!updateResult) {
        throw new StaleVersionError(
          `imile.shipments ${validated.tracking_no} (id ${existing.id}) was updated concurrently ` +
            `(expected version ${existing.version}). (Allowed: retry the pull cycle.)`,
        );
      }
      // Before/after audit row (reviewer finding 3 round 2, finding 2 round 3, 2026-09-25): only
      // the columns THIS UPDATE actually changed the VALUE of. `changedKeys` already covers the
      // iMile-sourced fields; `raw` and `last_sync_at` are checked here too — the UPDATE statement
      // (../../infrastructure/pull-shipments/repository.ts's `updateShipmentIMileFields`) writes
      // both unconditionally on every call, but `changed_fields` (13B-Schema-Reference-
      // Consolidation.sql:194, "changed fields only") must reflect the actual VALUE diff, not
      // which columns the SQL statement happened to name. `last_sync_at` differs on effectively
      // every real pull (a fresh clock read each cycle) but is still compared, not assumed. Never
      // the other iMile-sourced fields that happened not to change, never internal_status/
      // cage_code/driver_code/delivery_task_id (never written here at all).
      const newRaw = validated.raw ?? null;
      const rawChanged = !isDeepStrictEqual(existing.raw, newRaw);
      const lastSyncAtChanged =
        existing.lastSyncAt === null || existing.lastSyncAt.getTime() !== reportedAt.getTime();
      const auditChangedFields: string[] = [...changedKeys];
      const oldValue: Record<string, unknown> = {};
      const newValue: Record<string, unknown> = {};
      for (const key of changedKeys) {
        oldValue[key] = existingIMileFields[key];
        newValue[key] = incomingIMileFields[key];
      }
      if (rawChanged) {
        auditChangedFields.push('raw');
        oldValue.raw = existing.raw;
        newValue.raw = newRaw;
      }
      if (lastSyncAtChanged) {
        auditChangedFields.push('last_sync_at');
        oldValue.last_sync_at = existing.lastSyncAt;
        newValue.last_sync_at = reportedAt;
      }
      await deps.repo.writeAuditRow(tx, {
        schemaName: 'imile',
        tableName: 'shipments',
        recordId: existing.id,
        operation: AUDIT_OPERATION_UPDATE,
        correlationId: input.correlationId,
        actorId,
        changedFields: auditChangedFields,
        oldValue,
        newValue,
        occurredAt: reportedAt,
      });
      updated += 1;
    }

    const health = await deps.repo.insertAgentHealth(tx, {
      agentId: PULL_SHIPMENTS_AGENT_ID,
      sessionValid: true,
      lastPullAt: reportedAt,
      pendingPushes: PENDING_PUSHES_NONE,
      engineVersion: PULL_SHIPMENTS_ENGINE_VERSION,
      errorMessage: null,
      reportedAt,
    });
    await deps.repo.writeAuditRow(tx, {
      schemaName: 'imile',
      tableName: 'agent_health',
      recordId: health.id,
      operation: AUDIT_OPERATION_INSERT,
      correlationId: input.correlationId,
      actorId,
      newValue: {
        agentId: PULL_SHIPMENTS_AGENT_ID,
        sessionValid: true,
        lastPullAt: reportedAt.toISOString(),
        pendingPushes: PENDING_PUSHES_NONE,
        engineVersion: PULL_SHIPMENTS_ENGINE_VERSION,
        errorMessage: null,
      },
      occurredAt: reportedAt,
    });

    return { inserted, updated, skipped, unchanged };
  });
}
