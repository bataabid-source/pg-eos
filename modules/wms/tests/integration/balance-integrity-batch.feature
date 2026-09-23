# GM directive 2026-09-23 phase H — SCR-WMS-01: wms.verify_balance_integrity() batch fix
# (regression tests, BOOTSTRAP-v5 §5).
#
# Prior defect (fixed by 01 §wms.verify_balance_integrity (v1.1), guard G1): the ledger CTE
# folded by (client_id, sku_id, coalesce(to_location_id, from_location_id)) WITHOUT batch_no, then
# joined wms.stock_balance whose key is (client_id, sku_id, location_id, batch_no) (01 wms.stock_balance,
# 01 wms.stock_balance.batch_no default ''). Two batches of one SKU at one location -> each balance row
# was compared to the SUM of both -> false deviations. It also read only ledger -> balance, so a
# non-zero balance row with no ledger rows was never reported (doc 40 INV-C3-2: "Rebuilt balance
# from ledger equals stored balance", docs/package/40-Build-Specification-EN.md:245).
#
# Fixed interface implemented by 01 §wms.verify_balance_integrity (v1.1), tested against here:
# wms.verify_balance_integrity() returns
# (client_id uuid, sku_id uuid, location_id uuid, batch_no text, ledger_qty numeric,
#  balance_qty numeric, diff numeric); ledger batch key = coalesce(stock_movements.batch_no, '');
# full comparison in both directions (a balance row with no ledger rows and qty_on_hand <> 0 is
# reported with ledger_qty 0).
#
# pg-reviewer migration-gate finding (2026-09-23): the OLD function's row has no batch_no column,
# so any query naming batch_no (an ORDER BY or a SELECT list) fails with SQLSTATE 42703 on OLD
# regardless of row count — a schema error, not the behavioural deviation this feature proves.
# Every "returns exactly N row(s)" step below is therefore checked by count(*) keyed only on
# client_id; a detail step naming batch_no runs only once the count step already passed.

Feature: wms.verify_balance_integrity() reconciles per batch_no, in both directions

  Background:
    Given the schema is applied
    And fixture entity PST exists
    And one existing WH1 storage location (is_blocked = false) is used as L1
    And a fixture client exists (sales.accounts, code prefix _h_fixture_, account_type client)
    And a fixture SKU exists (wms.skus) for that client

  Scenario: two batches of one SKU at one location reconcile
    Given a receipt of batch H-A qty 10.000 at L1 with a matching stock_balance row
    And a receipt of batch H-B qty 5.000 at L1 with a matching stock_balance row
    When wms.verify_balance_integrity() is queried for that client, by count(*)
    Then it returns zero rows (OLD reports 2 — false deviation from folding batches together)

  Scenario: a deviation in one batch is reported for that batch only
    Given the two-batch setup above
    And the H-B stock_balance row is tampered to qty_on_hand 6.000
    When wms.verify_balance_integrity() is queried for that client, by count(*)
    Then it returns exactly one row (OLD reports 2 — the join ignores batch_no)
    And, once that count is confirmed, that row has batch_no H-B, ledger_qty 5.000, balance_qty 6.000, diff -1.000

  Scenario: a null ledger batch_no matches the '' balance batch (non-regression)
    Given a receipt with batch_no null qty 4.000 at L1
    And a stock_balance row with batch_no '' qty 4.000 at L1
    When wms.verify_balance_integrity() is queried for that client
    Then it returns zero rows on both the OLD and the NEW function

  Scenario: a balance row with no ledger rows is reported
    Given a stock_balance row with batch_no H-ORPHAN qty 3.000 at L1 and no ledger rows
    When wms.verify_balance_integrity() is queried for that client, by count(*)
    Then it returns exactly one row (OLD reports 0 — it only walks ledger -> balance)
    And, once that count is confirmed, that row has batch_no H-ORPHAN, ledger_qty 0, balance_qty 3.000, diff -3.000

  Scenario: a balance row with qty_on_hand 0 and no ledger rows is not reported (non-regression)
    Given a stock_balance row with batch_no H-ZERO qty 0 at L1 and no ledger rows
    When wms.verify_balance_integrity() is queried for that client
    Then it returns zero rows on both the OLD and the NEW function

  Scenario: a ledger key with no balance row is reported (non-regression)
    Given a receipt of batch H-NOBAL qty 7.000 at L1 with no matching stock_balance row
    When wms.verify_balance_integrity() is queried for that client
    Then it returns exactly one row with ledger_qty 7.000, balance_qty 0, diff 7.000 on both the OLD and the NEW function

  Scenario: a batch_no mismatch between ledger and balance is reported as two rows
    Given a receipt of batch H-A qty 10.000 at L1
    And a stock_balance row with batch_no H-X qty 10.000 at L1 (no matching batch)
    When wms.verify_balance_integrity() is queried for that client, by count(*)
    Then it returns exactly two rows (OLD reports 0 — the un-keyed-by-batch join hides the mismatch)
    And, once that count is confirmed, one row is batch_no H-A (ledger_qty 10.000, balance_qty 0, diff 10.000)
    And the other row is batch_no H-X (ledger_qty 0, balance_qty 10.000, diff -10.000)

  Scenario: the column list is the documented one
    When the result set of wms.verify_balance_integrity() limit 0 is inspected
    Then its field names are exactly client_id, sku_id, location_id, batch_no, ledger_qty, balance_qty, diff
