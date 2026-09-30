# MIGRATION-REQUEST — lane 3 (integration lane)

Number issued by the Master M12 on 2026-09-29 13:24Z (issue #207; D-203). One row per migration; the RED test paths must exist before the file (lane-guard.sh, D-179).

| number | module | slug | purpose | RED tests |
|---|---|---|---|---|
| 0045 | identity | session-lifetime | X part 5d part 2 item (2): seed `platform.thresholds` `identity.session.lifetime_minutes` = 720 minutes (GM D-203, verbatim «١٢» hours), same form as 0042 (`on conflict (key) do nothing`, all-zero system `changed_by`); `tests/scenarios/fixtures/actors.ts` then stops seeding its own fabricated '43' row | tests/scenarios/migration-0045.spec.ts |
