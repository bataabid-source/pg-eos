# GM directive 2026-09-23 phase C — pg-reviewer gate finding 9: rebuildBalance(ctx, {clientId,
# skuId}, deps) (modules/wms/src/stock-ledger/rebuild-balance.ts) runs inside withContext, so under
# RLS a caller sees ALL wms.stock_balance rows (policy internal_only — 13B §RLS auto-policy loop,
# pattern ② internal_only, "فمستدعٍ داخلي مقيَّد بكيانات يرى كل الرصيد وبعض الدفتر ⇒ «يتامى»
# زائفون") but only the wms.stock_movements rows of its own entities (entity_scope:
# `entity_id = any(platform.allowed_entities())`, allowed_entities() = the caller's identity.
# user_entities — 13B §RLS auto-policy loop, pattern ① entity_scope). It then
# overwrites balances from a partial fold -> corrupts them (doc 40 P4: balances are derived and
# rebuildable with ZERO diff).
#
# Fixed behaviour (pg-backend, this slice): before any write, rebuildBalance checks inside the
# same transaction that the caller sees the WHOLE ledger — the current role is superuser or
# BYPASSRLS, OR platform.allowed_entities() contains every platform.entities id — otherwise it
# throws a new typed `RebuildScopeError` (exported from modules/wms/index.ts) and writes nothing.
#
# This feature: the caller sees only ONE of the two entities that posted movements for the
# client/sku pair being rebuilt. See rebuild-balance-scope-full.feature for the positive control
# (a caller scoped to every entity).

Feature: rebuildBalance refuses to run for a caller who cannot see the whole ledger

  Background:
    Given fixture entities PST and PCC exist in platform.entities
    And one existing WH1 storage location (is_blocked = false) is used as L1
    And a fixture client exists (sales.accounts, code prefix _c9_fixture_, account_type client)
    And a fixture SKU exists (wms.skus) for that client
    And a fixture writer exists (identity.users) with identity.user_entities for ONLY entity PST
    And a LOGIN role pgeos_t_<hex>, NOSUPERUSER NOBYPASSRLS, is granted exactly:
      usage on schema wms, usage on schema platform, select on wms.stock_movements,
      select/insert/update/delete on wms.stock_balance, select on platform.entities
    And, as superuser, a single-sided receipt of qty 10.000 exists under entity PST at L1
    And, as superuser, a single-sided receipt of qty 5.000 exists under entity PCC at L1
    And, as superuser, a matching wms.stock_balance row of qty_on_hand 15.000 exists at L1
    And wms.verify_balance_integrity() for that client returns zero rows before the call

  Scenario: the caller cannot see entity PCC's movements
    When rebuildBalance is called, connected as the restricted role, with ctx
      { userId: <writer id>, clientId: null, isInternal: true }
    Then it rejects with RebuildScopeError, not NegativeStockError, not silent success
    And, checked afterwards as superuser, the wms.stock_balance row at L1 is still qty_on_hand
      15.000 (unchanged)
    And wms.verify_balance_integrity() for that client still returns zero rows (G1 stays clean)
