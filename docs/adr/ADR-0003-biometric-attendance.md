# ADR-0003 — Native biometric attendance (no third-party device, no import)

**Status:** Accepted — GM directive **D-131** (2026-09-24), with the D-126 text unchanged
**Date:** 2026-09-24 (the date the GM gave D-126; the repo clock at drafting read 2026-09-23) · accepted 2026-09-24 (D-131)
**Approved by:** GM — decision **D-126** sets the content; directive **D-131** moves the status to Accepted and resolves every open item by the agent recommendation as written (items with no written recommendation are explicitly carried — see "Resolution under D-131" below)
**Reviewed & accepted: opus** — authored on opus. pg-reviewer (opus): round 1 FAIL (18 findings), round 2 FAIL (6), round 3 PASS. All 24 were fixed (`docs/CHANGELOG.md`)
**References:** GM decision D-126 (verbatim in §Decision, recorded in `docs/DECISION_LOG.md`) · `docs/package/23-Integration-Register.md` I-04 (lines 17, 94–103, 166) ·
`docs/package/38-WBS.md` 5.3, 5.4 (lines 170–171), 5.13 (line 180), 2.16 (line 97), 3.7 (line 116) · `docs/package/EXECUTION-MASTER-v4.md` §1.3 (line 134), §1.4 (line 142), §1.9 G-07 (line 204), Lane-A plan (line 340) ·
`docs/package/30-PDA-App.md` (line 250) · `docs/package/35-Driver-App-v2.md` (line 19, §13) · `docs/package/40-Build-Specification-EN.md` (lines 414, 668) ·
`docs/package/25-Alerts-Reports-NFR.md` N-16 (lines 59, 206–209), retention (line 429) · `D-blueprints/01-Enterprise-Map.md` (lines 443, 466) · `D-blueprints/07-Governance-Control.md` (line 788) ·
`D-blueprints/09-Gap-Register.md` #7 (row at line 35, summary at line 13) and #17 (line 52) · `database/schema/13B-Schema-Reference-Consolidation.sql` N-16 seed (lines 2977–2983, 5345), `legacy_name` (line 1678), ق-44/ق-45 restrictive own-row pattern (lines 4930–4940), `identity.sod_rules` (lines 617–631) ·
`database/schema/01-Data-Model.sql` `hr.employees`, `hr.teams`, `wms.warehouses`, `identity.sessions`, `platform.integration_runs` (line 197) · `.claude/briefs/hr.brief.md` §2–§3 ·
`docs/package/AUDIT-REPORT-v4.md` ADM-11 · `docs/notes/SCR-HR-ATT-01-native-attendance.md` (G-01 request raised with this ADR)

## Context (السياق)

- The package today treats attendance as an **inbound integration**. I-04 is "the fingerprint app (Firebase)": REST plus a key, hourly, owner SYSADMIN, rated critical.
  Its credentials `ATTEND_EMAIL` / `ATTEND_PASS` are entered by the GM, the uniqueness key is `employee_id` plus the punch time, and
  unmatched punches go to a manual queue. Photos live in Firebase and are deleted after 60 days (doc 23 lines 17, 94–103).
- WBS **5.3** (acceptance "Attendance auto-imported; unmatched to manual queue") and **5.4** ("Biometric credentials entered by GM; hourly sync")
  build that import. Alert **N-16** watches it (doc 25 line 59; 13B lines 2977–2983). N-16 is one of the "22 alerts" (EXEC-v4 line 142; doc 38 5.13).
- The field apps already require a **face check at shift start**, with an `offline_start` flag when that fails (doc 30 line 250, doc 35 line 19,
  EXEC-v4 §1.9). G-07 (EXEC-v4 §1.9) already defines **device binding**: one phone per driver, a new device needs supervisor approval, PDAs are
  registry entries, and every device has a signing key. WBS 3.7 builds that binding.
- **Schema fact:** 01 / 13 / 13B / 019 have **no attendance, punch, shift, leave or device-registry table**, and no geofence or site
  coordinates. `hr` has 14 tables (brief §2); `wms.warehouses` has no coordinates; `hr.employees` has no site; `hr.teams.shift` is free text;
  `identity.sessions` has no device column. The gap is already recorded as ADM-11, doc 10 line 48, Gap-Register **#7**, and Gap-Register **#17**
  ("the shift-start face check, `offline_start` and I-04 have no carrier").
- **PLT-50 / EXEC-v4 §1.3:** auto-absence detection stays off until attendance data is ≥ 95% complete for 30 consecutive days. The switch is a
  flag in `platform.feature_flags`.

## Decision (القرار)

GM decision **D-126** (dated by the GM 2026-09-24), verbatim:

> - Capture: the field app (APP-1) on the employee's registered phone and the PDA app for warehouse staff. No third-party attendance device, no credential import, no Firebase sync (doc 23 I-04 SUPERSEDED).
> - Identity: face and fingerprint checks use the device OS biometric API (Android BiometricPrompt Class 3 / iOS Face ID) — the system never stores biometric images or templates; it stores the OS verification result, device attestation, timestamp, GPS + geofence of the assigned site, and writes the punch to the audit chain.
> - Device binding: one registered device per employee; re-registration requires HR_MGR approval and is audited.
> - Unmatched/failed punches go to an HR review queue (keep the queue concept from I-04, drop the import source). Photo retention is not applicable (no photos).
> - PLT-50 stays: automatic absence detection off until attendance data ≥ 95% complete for 30 days.
> - Schema: reuse hr attendance tables from the brief; any missing column (device_id, attestation_hash, geofence_result) goes through G-01, never invented.

**Architectural consequence (why this is an ADR).** Attendance stops being an **external inbound integration**: no pg-boss sync job, no
`integration_runs` source, no credentials in secrets. It becomes a **first-party write use case**. A punch is a command from our own apps: it
carries an Idempotency-Key, runs through `withContext`, writes the state change and a `platform.outbox` event in one transaction, and lands in
the audit chain. I-04 leaves the integration register.

**"Reuse hr attendance tables from the brief" has nothing to reuse.** The brief lists no attendance table. Per D-126's own last clause and
CLAUDE.md AGENT CONSTRAINTS, the carriers go to G-01 (`docs/notes/SCR-HR-ATT-01-native-attendance.md`) and are not invented here. Nothing in
`database/schema/*` changes with this ADR.

## Alternatives rejected (البدائل المرفوضة)

| Alternative | Why rejected |
|---|---|
| Keep I-04 (Firebase fingerprint app, hourly import) | D-126: no third-party device, no credential import, no Firebase sync. It also carries a GM-held external credential, a 48 h blind spot (N-16) and photo custody outside our retention and legal hold |
| Store face or fingerprint templates on the server (in-house matching) | D-126: the system never stores biometric images or templates. That removes a special-category data store and its breach surface |
| Dedicated wall-mounted terminals | D-126: capture is the field app and the PDA only. A terminal would again be a third-party device |

## Consequences (الأثر)

**Positive**
- No external credential, sync job, sync-failure alert or photo store. One fewer 🔴 critical integration.
- The punch carries its own evidence and goes through the audit chain. ATT-07 (punching for a colleague) and ATT-08 (tampering with the
  fingerprint system) cases have evidence behind them.
- It reuses the shift-start face check the driver and PDA apps already do.

**Open items for the GM. None of them is decided here, and the ADR stays Proposed until each is answered or explicitly carried.**
1. **Shared PDA vs "one registered device per employee".** The PDA is a shared kiosk with PIN login (doc 30, WBS 2.16). OS biometric APIs
   prove only that *a biometric enrolled on this device* matched, not *which employee* it was. How a PDA punch is tied to the person is the
   GM's decision. **This blocks the PDA path.**
2. **Several biometrics enrolled on one personal phone.** Both OSes allow a second face or finger, and the OS result cannot tell the owner
   from a colleague (ATT-07). A key that is invalidated when a new biometric is enrolled (see item 7) reduces this risk but does not remove it.
   The GM accepts or mitigates the residual risk.
3. **Routing of offline, out-of-geofence and unregistered-device punches.** D-126 sends only "unmatched/failed" punches to review. Whether
   these three cases count as "failed" is the GM's decision. The OS biometric works offline; attestation and the server geofence check do not.
4. **Which approver, and how many registries.** G-07 already says "new driver device = **supervisor** approval". D-126 says
   re-registration needs **HR_MGR**. The GM decides (a) which rule governs for drivers and (b) whether there is **one device registry, in
   `identity` or `hr`, bound to the G-07 signing key**, with the approval request modelled on `platform.approval_chains`.
5. **Retention of punch records** (OS result, attestation, GPS). Doc 40 line 668 and doc 25 line 429 say "biometrics 12 months", which no
   longer applies. The GM sets the value. There is no default in the meantime.
6. **Site geofence carrier** (SCR-HR-ATT-01 §2.4 (a) or (b)) and the radius, which goes in `platform.thresholds` with a value set by the GM.
7. **Trust chain. These are requirements the build must meet, recorded so the GM can accept them.**
   - The "OS verification result" is a client claim. It becomes evidence only when a **hardware-backed key, usable only after biometric
     authentication, signs a server-issued nonce**: Android Keystore `setUserAuthenticationRequired` with a BiometricPrompt `CryptoObject`;
     iOS a Secure Enclave key with `biometryCurrentSet`.
   - Attestation (Play Integrity / App Attest) is **verified on the server against that nonce**. A stored hash alone proves nothing. The nonce
     is also the anti-replay control, which an Idempotency-Key is not.
   - **PIN or passcode fallback is forbidden** (`DEVICE_CREDENTIAL` / `deviceOwnerAuthentication`). Otherwise a colleague who knows the PIN
     can punch.
   - Keys invalidated on biometric-enrolment change partly mitigate item 2.
8. **Spoofing and clock.** Mock-location GPS, and device-clock tampering on offline punches, because the device time is the only
   `occurred_at` when offline.
9. **Coverage.** Workers without a Class 3-capable phone. Also, D-126 says "face and fingerprint" but names only iOS Face ID; the GM confirms
   whether Touch ID is included.
10. **Classification and monitoring.** The `identity.column_classification` level of GPS columns. And **no alert watches the HR review
    queue's age**: N-19 reads only `platform.integration_queue` (13B lines 3005–3011), so "never dropped" has no monitor. A new alert changes
    the "22 alerts" count, which is a GM decision.
11. **Separation of duties.** The reviewer of a punch and the approver of a device must not be its subject. Today no `identity.sod_rules`
    row covers this (13B lines 617–631). SCR-HR-ATT-01 §2.6 requires it, and the enforcement mechanism is for the GM to choose.

**Unchanged:**
- PLT-50.
- The penalty schedule, including ATT-01…ATT-10.
- The `biometrics_security` recruitment stage. That is residency biometrics at PRO, not attendance.
- Module boundaries: attendance lives in `hr`, and the apps call its API.

**Superseded.** GM directive D-125 applies the supersession marks ahead of acceptance. The list with lines is in
`docs/notes/2026-09-24-cleanup-candidates.md`:
- doc 23 I-04 (lines 17, 94, 166)
- WBS 5.4, and the I-04 part of 5.3
- N-16 in doc 25 (lines 59, 206), D-05, D-06, D-07, D-15 and EXEC-v4 line 340
- `D-blueprints/01` lines 443 and 466
- doc 00 line 168

Owed to the GM, **not** marked here:
- retention (doc 40 line 668, doc 25 line 429), item 5
- the "22 alerts" count (EXEC-v4 line 142, doc 38 5.13, line 180) once N-16 leaves 13B
- the 13B N-16 seed (G-01 removal, SCR-HR-ATT-01 §4)

`D-07` line 788 keeps its PLT-50 wording ("من البصمة", "from the fingerprint"): the gate is unchanged, and the source becomes the native punch.

## Resolution under D-131 (2026-09-24)

GM directive D-131: "ADR-0003 → Accepted with D-126 text. SCR-HR-ATT-01 approved. Every open item in ADR-0003 / SCR-HR-ATT-01 resolved by the agent recommendation as written." Applied literally — no value is invented here; an item whose text carries no recommendation is **carried**, as the open-items preamble allows.

| Item | Resolution (as written) |
|---|---|
| 1 shared PDA | No written recommendation → **carried**; the PDA path stays blocked until answered. The field-app path (APP-1) is not affected |
| 2 multi-enrolment | Mitigation as written in item 7 (keys invalidated on biometric-enrolment change); the residual risk is **carried** |
| 3 routing of offline / out-of-geofence / unregistered punches | No written recommendation → **carried**; until answered only "unmatched/failed" routes to review (D-126 text) |
| 4 approver and registry | (b) **one registry, in `identity`, bound to the G-07 signing key** — SCR-HR-ATT-01 §2.2 "does not propose a second registry beside G-07", approval request modelled on `platform.approval_chains`; (a) which approver rule governs for drivers → **carried** (D-126 says HR_MGR, G-07 says supervisor) |
| 5 retention of punch records | No default exists in the text → **carried**; doc 40 line 668 and doc 25 line 429 stay as listed in `docs/notes/2026-09-24-cleanup-candidates.md` G1/G2 until the GM sets the value |
| 6 geofence carrier and radius | Carrier (a)/(b) and the radius value → **carried**; the radius lives in `platform.thresholds` (SCR §2.5) |
| 7 trust chain | **Accepted as build requirements** exactly as written (hardware-backed key + server nonce, server-verified attestation, no PIN/passcode fallback, key invalidation on enrolment change) |
| 8 spoofing and clock | No written recommendation → **carried** |
| 9 coverage / Touch ID | No written recommendation → **carried** |
| 10 classification and monitoring | **No new alert** (SCR §3: a review-queue age alert is not requested; the "22 alerts" count is unchanged); GPS classification level → **carried** |
| 11 separation of duties | **Requirement accepted** as written in SCR §2.6 (decider ≠ subject, approver ≠ subject); the enforcement mechanism → **carried** |
| SCR §2.1 / §2.3 / §2.5 / §2.6 shapes | **Approved** as shapes; `decision` value list `approved · rejected` **confirmed** as proposed; threshold and flag values → **carried** (none written) |
| SCR §4 N-16 | **Retired slot** — N-16 is disabled in the next forward-only migration and its number is not reused; the "22 alerts" count stays as written (EXEC-v4 line 142, doc 38 5.13). Chosen as the option consistent with D-125 "nothing deleted"; the GM may still order a renumbering |

## Status (الحالة)

Accepted — 2026-09-24 (D-131). Proposed 2026-09-24 (D-126).

## Application / bookkeeping

- The proposed task is `tasks/proposed/APP-1-field-app-attendance.md`, status `WAITING_GM`. It is not admitted and has no `MASTER_BACKLOG` row (BOOTSTRAP-v5 line 175; Staged-section rule). The GM assigns it a numbered WBS ID; "APP-1" is D-126's app name.
- Doc-38 draft: `docs/notes/2026-09-24-38-wbs-bio-attendance-draft.md`.
