# WBS 2.1 — Register WH1, its zones and its 8 space blocks (proof slice).
# Source of truth: doc 19 §3-1 (lines 111-119, zone location counts for P·G·M·T·X), §2-4
# (lines 93-102, the six operational zones and their location counts), lines 224-240 (the 019
# zones insert tuples: code · name_ar · zone_type), §3-2 (lines 127-135, block · positions · m3),
# lines 256-263 (the 019 space-blocks insert tuples: code · zone · block_type · positions · m3),
# §3-4 (verify_wh1 expectations) and doc 40 line 239 (30 operational · 147 structural). This
# feature file is the permanent, re-runnable Gherkin proof that
# database/schema/019-Warehouse-WH1-Setup.sql delivers exactly what doc 19 §4 describes — nothing
# here is entered by hand.

Feature: WH1 registered exactly as doc 19 §4 describes (WBS 2.1)

  Background: the dev database has database/schema/apply.sh applied (01 · 13 · 13B · 019 + migrations)

  Scenario: the warehouse exists once and belongs to PST
    Then wms.warehouses has exactly one row with code WH1
    And its entity is PST

  Scenario Outline: each of the eight space blocks matches doc 19 §3-2 / lines 256-263
    Then wms.space_blocks has exactly one row with code <block> for WH1
    And that row is in zone <zone>
    And its block_type is <type>
    And its capacity_pallets equals <positions>
    And its capacity_cbm equals <m3>
    And its status is active
    And exactly <positions> wms.locations rows reference it via space_block_id

    Examples: the eight rows of doc 19 §3-2 (positions/m3, lines 127-135) and lines 256-263 (zone/block_type)
      | block | type        | zone | positions | m3      |
      | P-A   | pallet_rack | P    | 288       | 507.384 |
      | P-A1  | pallet_rack | P    | 12        | 21.141  |
      | G-B   | shelf       | G    | 906       | 880.632 |
      | G-C   | shelf       | G    | 45        | 43.740  |
      | M-B   | shelf       | M    | 906       | 880.632 |
      | M-C   | shelf       | M    | 45        | 43.740  |
      | T-B   | shelf       | T    | 906       | 880.632 |
      | T-C   | shelf       | T    | 45        | 43.740  |

  Scenario: the eight blocks are exactly the eight doc-19 codes and no other
    Then the sorted codes of wms.space_blocks for WH1 equal [G-B, G-C, M-B, M-C, P-A, P-A1, T-B, T-C]

  Scenario: totals — Sigma capacity_pallets = 3,153 and Sigma capacity_cbm = 3,301.641 (doc 19 line 135, numeric equality, not float)
    Then the sum of capacity_pallets across WH1's space_blocks equals 3153
    And the sum of capacity_cbm across WH1's space_blocks equals 3301.641

  Scenario Outline: each of the eleven zones matches doc 19 §3-1 / §2-4 / lines 224-240
    Then wms.zones has exactly one row with code <zone> for WH1
    And its zone_type is <type>
    And exactly <locations> wms.locations rows belong to it

    Examples: the eleven rows of doc 19 §3-1 (lines 111-119, 120) · §2-4 (lines 93-102) · lines 224-240 (zone_type)
      | zone | type       | locations |
      | P    | storage    | 300       |
      | G    | storage    | 951       |
      | M    | storage    | 951       |
      | T    | storage    | 951       |
      | RCV  | receiving  | 6         |
      | STG  | staging    | 8         |
      | SHP  | shipping   | 6         |
      | QRT  | quarantine | 4         |
      | RTN  | returns    | 4         |
      | DMG  | damaged    | 2         |
      | X    | structural | 147       |

  Scenario: the zones are exactly the eleven doc-19 codes and no other
    Then the sorted codes of wms.zones for WH1 equal [DMG, G, M, P, QRT, RCV, RTN, SHP, STG, T, X]

  Scenario: operational and structural totals (doc 40 line 239)
    Then the sum of wms.locations across the six operational zones (RCV STG SHP QRT RTN DMG) equals 30
    And the count of wms.locations in zone X equals 147

  Scenario: the schema's own verification agrees — wms.verify_wh1() returns 21 rows, all passed = true
    Then wms.verify_wh1() returns exactly 21 rows
    And every row's passed column is true
    And on failure the failing check_name is printed

  Scenario: nothing was entered by hand — every zone/space_block/location row in the whole database belongs to WH1
    Then no wms.zones row in the whole table has a warehouse_id other than WH1's id
    And no wms.space_blocks row in the whole table has a warehouse_id other than WH1's id
    And no wms.locations row in the whole table has a warehouse_id other than WH1's id
    # Master decision (review finding 5): this is a whole-table check, not scoped to WH1-coded
    # zones or WH1 space_blocks — nothing else may exist yet. It will legitimately go red the day
    # a second warehouse is registered; the slice that registers that warehouse narrows this check
    # to "for WH1" as part of its own acceptance criterion.
