# modules/wms/tests/integration/rebuild-balance-lock.feature — pg-reviewer slice-close round 2
# finding 1: before this slice, postMovement/postTransfer/reverseMovement did not coordinate with
# rebuildBalance at all — a rebuild could run concurrently with a posting against the SAME (client,
# sku) and race it (partial fold vs. a fold started before/after the posting's own balance write;
# doc 40 P4: balances are derived and rebuildable with zero diff, which a torn read of the ledger
# cannot guarantee). The fix (pg-backend, this slice): every posting takes
# `pg_advisory_xact_lock_shared(hashtextextended(<key>, 0))` for each (client, sku) it touches
# BEFORE its existing per-balance-key locks; rebuildBalance takes the SAME key's lock in EXCLUSIVE
# mode (`pg_advisory_xact_lock`) before folding the ledger — so postings and postings never block
# each other (both take the shared lock), but a rebuild excludes every posting (and every other
# rebuild) for that (client, sku) for the duration of its fold, and a posting excludes a concurrent
# rebuild for the duration of its own transaction. `balanceRebuildLockKey(clientId, skuId)` (new
# export, modules/wms/index.ts) is the single source of that key text:
# `'wms.stock_balance.rebuild|' + clientId + '|' + skuId`.

Feature: postings and rebuildBalance serialize on the (client, sku) rebuild lock

  Background:
    Given a fixture entity (platform.entities code PST), a fixture client (sales.accounts) and a
      fixture SKU (wms.skus)
    And one existing WH1 storage location (is_blocked = false) is used as L1
    And an initial receipt has already been posted, so a wms.stock_balance row exists at L1

  Scenario: a posting waits while a rebuild holds the (client, sku) lock
    Given a separate database session has opened a transaction and holds
      pg_advisory_xact_lock(hashtextextended(balanceRebuildLockKey(client, sku), 0)) — the
      exclusive mode rebuildBalance takes
    When postMovement posts a receipt of 1.000 at L1, without being awaited yet
    Then it has not settled after a short wait
    When the separate session commits (releasing the lock)
    Then the posting resolves, and on-hand at L1 has increased by exactly 1.000

  Scenario: a rebuild waits while a posting holds the shared lock
    Given a separate database session holds
      pg_advisory_xact_lock_shared(hashtextextended(balanceRebuildLockKey(client, sku), 0)) — the
      shared mode a posting takes
    When rebuildBalance is called for (client, sku), without being awaited yet
    Then it has not settled after a short wait
    When the separate session commits (releasing the lock)
    Then rebuildBalance resolves, and wms.verify_balance_integrity() for that client returns zero
      rows

  Scenario: postings on the same (client, sku) do not block each other on the shared lock
    Given a separate database session holds
      pg_advisory_xact_lock_shared(hashtextextended(balanceRebuildLockKey(client, sku), 0))
    When postMovement posts a receipt of 1.000 at L1
    Then it settles within a short wait (shared locks do not block other shared lock holders)

  Scenario: 20 postings and 3 rebuilds interleaved all settle with a clean guard
    Given the same fixture (client, sku, L1)
    When 20 postMovement receipts and 3 rebuildBalance calls are all started together
    Then every one of them settles (no unexpected rejection)
    And wms.verify_balance_integrity() for that client returns zero rows
