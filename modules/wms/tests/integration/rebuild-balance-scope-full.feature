# GM directive 2026-09-23 phase C — pg-reviewer gate finding 9 (see rebuild-balance-scope.feature
# for the full defect writeup). Positive control: a caller whose identity.user_entities covers
# EVERY platform.entities row (not just the entities that happen to have movements for this
# client/sku) is exactly the "sees the whole ledger" case the fix's guard condition allows —
# rebuildBalance must proceed and reconcile normally, and G1 must stay clean.

Feature: rebuildBalance proceeds for a caller scoped to every entity

  Background:
    Given fixture entities PST and PCC exist in platform.entities
    And one existing WH1 storage location (is_blocked = false) is used as L1
    And a fixture client exists (sales.accounts, code prefix _c9_fixture_, account_type client)
    And a fixture SKU exists (wms.skus) for that client
    And a fixture writer exists (identity.users) with identity.user_entities for EVERY row of
      platform.entities
    And a LOGIN role pgeos_t_<hex>, NOSUPERUSER NOBYPASSRLS, is granted exactly:
      usage on schema wms, usage on schema platform, select on wms.stock_movements,
      select/insert/update/delete on wms.stock_balance, select on platform.entities
    And, as superuser, a single-sided receipt of qty 10.000 exists under entity PST at L1
    And, as superuser, a single-sided receipt of qty 5.000 exists under entity PCC at L1
    And, as superuser, a matching wms.stock_balance row of qty_on_hand 15.000 exists at L1
    And wms.verify_balance_integrity() for that client returns zero rows before the call

  Scenario: the caller sees every entity's movements
    When rebuildBalance is called, connected as the restricted role, with ctx
      { userId: <writer id>, clientId: null, isInternal: true }
    Then it resolves with rowsWritten > 0, it does not throw RebuildScopeError
    And, checked afterwards as superuser, wms.verify_balance_integrity() for that client returns
      zero rows (G1 stays clean)
