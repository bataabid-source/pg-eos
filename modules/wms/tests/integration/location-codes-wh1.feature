# WBS 2.3 — the 3,330 WH1 location codes, seven-character format, X- prefix, sellable capacity.
# Source of truth: doc 19 §4 (execution) and §3-4 (governing numeric table), carried verbatim into
# database/schema/019-Warehouse-WH1-Setup.sql §6-9 and asserted by wms.verify_wh1() (21 checks).
# This is a proof slice, exactly like 2.1's wh1-setup.feature: nothing here is entered by hand —
# database/schema/019-Warehouse-WH1-Setup.sql already generates every code and already defines
# wms.verify_wh1(). The one number doc 38 row 2.3 names that wms.verify_wh1() does not itself
# assert is sellable capacity (3,153 storage locations minus the 7% operational buffer = 2,932),
# derived here from the live wms.space_blocks_out_of_service rows with reason =
# 'operational_buffer' and the platform.thresholds row space.buffer_pct = 7.000 (13B, line 2807).

Feature: WH1 location codes match doc 19 §4, and sellable capacity is 2,932 (WBS 2.3)

  Background: the dev database has database/schema/apply.sh applied (01 · 13 · 13B · 019 + migrations)

  Scenario: the full location-code inventory matches the doc 19 §3-4 governing numeric table
    Then wms.locations for WH1 has 3153 storage locations (300 pallet + 2853 shelf)
    And wms.locations for WH1 has 30 operational locations
    And wms.locations for WH1 has 147 structural locations
    And the total is 3330 location codes
    And wms.verify_wh1() returns exactly 21 rows, all passed = true

  Scenario: storage location codes are seven characters in the fixed section-aisle-position-level format
    Then every pallet and shelf location code in WH1 matches the pattern ^[PGMT][1-9]-[0-9]{2}-[1-9]$
    And every pallet and shelf location code in WH1 is exactly 7 characters long

  Scenario: structural (blocked) location codes carry the X- prefix and a recorded block reason
    Then every structural location code in WH1 starts with X-
    And every structural location in WH1 has is_blocked = true
    And every structural location in WH1 has a non-empty block_reason

  Scenario: sellable capacity equals storage capacity minus the operational buffer (platform.thresholds space.buffer_pct)
    Given 3153 WH1 storage locations as capacity
    And wms.space_blocks_out_of_service rows with reason = 'operational_buffer' for every active WH1 space block,
      each row's qty_pallets already computed by 019 §9 as round(capacity_pallets * space.buffer_pct / 100, 3)
    When the qty_pallets of those rows are summed and the sum is rounded to a whole location count
    Then the rounded buffer equals 221
    And 3153 minus 221 equals 2932 sellable storage locations
