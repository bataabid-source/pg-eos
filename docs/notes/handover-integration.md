# Handover — integration lane 3 (R3, session_01SThLZenuNFMz5TD2dZVpNe)

Read with CLAUDE.md and docs/PROJECT_STATE.md. Written 2026-09-29.

## State
- Scenario run on main @ a885a99 (pgeos, schema through 0044): 9 tests, 0 passed; every failure is a named
  NOT BUILT (S1, S2, S3, S4, S6, S18). green.json is empty, so none of them counts as a regression under §G15.
- Unmerged R2 branches (Master queue): `lane/3-x5d` @ 00feb4e (X part 5d, PASS(8,2)) and `lane/3-s5` @ 0a56bdb (S5, PASS(6,2)).
  Both carry an M4-approved scenarios dependency; merge x5d first (packet `lane/3-handover-r2`).

## S7 (branch lane/3-s7, wip commit, NOT accepted)
- tests/scenarios/S7.spec.ts: the Given, the price step and the credit_limit step are BACKED through real sales
  handlers (contract create → set price list → sign → activate, noticeDays 14 per doc 05 L335). The alert step
  is NOT BUILT (owner row 6.7 → 6.3 → 0.19, 5.13 part 2).
- Review: round 1 FAIL (2 blocking, 2 nits), fixed; round 2 FAIL (1 blocking, 1 nit), no PASS subset (cap, no round 3).
- Row requested → **S7 part 2** (Master adds it to MASTER_BACKLOG; the lane does not write it):
  1. blocking, S7.spec.ts:209-222. Call resolvePrice BEFORE handleSetContractPriceList (a draft contract is not
     matched, repository.ts:94) and hard-assert unitPriceSource 'standard_list' plus the list id. In Then, add a
     hard SQL assertion that the attached list has segment_id null, client_id null and is_internal false. Update the header L11-13.
  2. nit. CHANGELOG line: "S7 alert date compared as fired_at::date in session TZ — no tz constant exists".
- Other defaults: SEG-F (doc 01 L1620, doc 05 L323). segment_id and cr_number are set by one raw UPDATE (no handler
  writes them; reviewer accepted). credit_limit comes from the schema default 0. A standard price list is inserted and removed by the spec.
- Unverified by the reviewer: `pnpm guards:run` gave no output within 300 s. The tester reports G1 = 0, zero residue and clean tsc/eslint.

## Next
S7 part 2 (above) → S9 → S12 (stream D batch). Lane DB: `bash scripts/lane-db.sh 3`, PGDATABASE=pgeos_lane3 PG_LANE=3.
