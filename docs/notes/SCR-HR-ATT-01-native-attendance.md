# SCR-HR-ATT-01 — carriers for native biometric attendance (ADR-0003 / D-126)

**Status: REQUESTED — WAITING_GM.** Filed under **EXECUTION-MASTER-v4 §1.11 (G-01)** on two criteria:
- **(i) a real schema gap**
- **(iii) a doc 40 requirement that is not modelled**: doc 40 line 414, where the driver app shows "profile/documents/**attendance**"; doc 38 5.3.

Date: 2026-09-24 (the GM's date for D-126). Raised by the Master alongside ADR-0003 (Proposed). Source decision: GM D-126 (`docs/DECISION_LOG.md`).
**Nothing in `database/schema/*` or `database/migrations/*` is touched by this request.** After GM approval the Master issues a migration number,
and pg-reviewer runs its pre-migration review before the file is written (CLAUDE.md · SLICE SEQUENCE).

## 1. Why this is a gap and not an invention

D-126 says "reuse hr attendance tables from the brief". The brief has **none**.

| Needed by D-126 | Present in 01 / 13 / 13B / 019? |
|---|---|
| a punch record (time, OS result, attestation, GPS, geofence) | **no**. None of the 14 `hr` tables (hr brief §2) holds one |
| one registered device per employee, re-registration approved by HR_MGR | **no**. `identity.sessions` has no device column. `device_id text` appears only as a free-text context column on `wms.stock_movements`, `tms.proof_of_delivery`, `imile.scan_log` (01 line 1361), `platform.audit_log` and `wms.work_order_tasks` / `work_order_events`. G-07 device binding (EXEC-v4 §1.9) has no table either |
| the HR review queue for unmatched or failed punches | **no** |
| "the assigned site" and its geofence | **no**. `wms.warehouses` has `address` and `area` but no coordinates; `hr.employees` has no site; `hr.teams.shift` is free text |
| the PLT-50 flag | the `platform.feature_flags` table exists (13B line 152, `enabled` defaults to `false`), but **no key is seeded** |

The gap is already on record in six places:
- ADM-11 (AUDIT-REPORT-v4 line 258)
- doc 10 line 48
- D-06 G-1
- D-04 #3
- D-05 #8
- Gap-Register **#7** (row at line 35, summary at line 13) and **#17** (line 52)

This request closes **only the attendance part**. `hr.shifts`, `hr.leaves` and payroll stay in Gap #7.

## 2. Requested additions

These are shapes for GM approval. The DDL is written only after approval.

Types follow existing precedent: coordinates `numeric(10,7)` and accuracy `numeric(8,2)` as in `tms.proof_of_delivery` (01 line 912), and
`timestamptz` for times. Every table carries `entity_id`, RLS and (where mutable) `version`. Every column is added to
`identity.column_classification`, with GPS columns at a level set by the GM (ADR-0003 item 10).

**2.1 `hr.attendance_punches`** — **append-only**, one row per punch attempt, never updated. Columns:

| Column | Notes |
|---|---|
| `id` | |
| `entity_id` | |
| `employee_id` | → `hr.employees` |
| `occurred_at` | device time |
| `received_at` | server time |
| `device_ref` | → the device registry (see 2.2); null if the device is unregistered |
| `capture_app` | field app · PDA |
| `os_verification_result` | the outcome only, never an image or template |
| `challenge_nonce` | server-issued (ADR-0003 item 7) |
| `nonce_signature` | **proposed**: the hardware key's signature over the nonce, so the punch can be re-verified later (ATT-07 / ATT-08 cases) |
| `signing_key_ref` | **proposed**: → the key registered for the device in 2.2 |
| `attestation_verdict` | server-verified, not only a hash (ADR-0003 item 7) |
| `attestation_hash` | |
| `geo_lat`, `geo_lng`, `geo_accuracy_m` | |
| `site_ref` | |
| `geofence_result` | |
| `offline` | carries the `offline_start` flag (EXEC-v4 §1.9) |
| `idempotency_key` | |

Every insert is written to `platform.audit_log` and `platform.outbox` in the same transaction. This covers D-126's "writes the punch to the
audit chain".

**2.2 Device registry: one registry, placement for the GM.** ADR-0003 item 4 asks the GM to choose between two options. This request does
**not** propose a second registry beside G-07.
- (a) One `identity`-level registry that serves both G-07 and attendance.
- (b) An `hr`-level registry.

Whichever is chosen needs these fields:
- `employee_id` / `user_id`
- `device_id`
- `platform` (android · ios)
- the G-07 signing-key reference
- `registered_at`
- `revoked_at`, `revoke_reason`
- `version`

It also needs:
- **At most one active device per employee**: a partial unique index on `revoked_at is null` (D-126).
- A **re-registration request** modelled on `platform.approval_chains` (13B).
- Every registration, re-registration, approval and revocation is written to `platform.audit_log` and `platform.outbox` in the **same transaction** as the change (D-126: "re-registration … is audited"). The approver role (HR_MGR per D-126, or supervisor per G-07
  for drivers) is ADR-0003 item 4.

**2.3 Review queue — `hr.attendance_punch_reviews`**, append-only. Columns: `id` · `entity_id` · `punch_id` · `decision` · `decided_by` ·
`reason` · `decided_at`.
- Every review insert is written to `platform.audit_log` and `platform.outbox` in the **same transaction**.
- The **queue** is every punch whose routing sends it to review and that has no final review row.
- Which punches route to review: D-126 says "unmatched/failed". Whether offline, out-of-geofence and unregistered-device punches also route
  here is ADR-0003 item 3, for the GM.
- The value list for `decision` is **proposed** as `approved · rejected`, for the GM to confirm. It is not taken from the package.

**2.4 Site geofence: the GM chooses one.** This is recorded as a decision owed.
- (a) coordinates and a radius on `wms.warehouses`, plus an assigned site on `hr.employees`. This covers warehouse staff only.
- (b) a new `hr.work_sites` table (`entity_id`, name, `geo_lat`, `geo_lng`, radius), plus an assigned site on `hr.employees`. This covers
  every employee.

**2.5 Thresholds and flags.** Seed rows; the GM sets the values, none is written here.
- A `platform.thresholds` row for the default geofence radius in metres.
- One `platform.feature_flags` key for automatic absence detection, seeded `enabled = false`. This is PLT-50, unchanged.

**2.6 RLS and separation of duties**
- Use `entity_scope`, **plus an own-row policy declared `as restrictive`**, with a `*.read_all` permission for HR_MGR and GM. This is the
  13B ق-44 / ق-45 pattern (lines 4930–4940). A *permissive* own-row policy would be combined with `entity_scope` by OR, letting any
  entity user see every colleague's punches and GPS. That is the exact defect ق-44 fixed for `own_sales_commission`.
- No client or portal policy.
- **SoD requirement:** the decider of a punch review, and the approver of a device re-registration, must not be the punch's or the device's
  own employee. No `identity.sod_rules` row covers this today (13B lines 617–631). The enforcement mechanism (an `sod_rules` row, a trigger,
  or an approval-chain rule) is for the GM, per ADR-0003 item 11.

## 3. Explicitly NOT requested

- Biometric images, templates or photos.
- `hr.shifts`, `hr.leaves` or payroll (Gap #7).
- Any new penalty rule.
- A review-queue age alert. ADR-0003 item 10 flags it; it would change the "22 alerts" count, which is a GM decision.

## 4. Removal requested (D-125 class A)

| Object | Location | Request |
|---|---|---|
| Alert **N-16** (seed row + category mapping) | 13B lines 2977–2983, line 5345 | Remove or disable in the next forward-only migration. The GM decides whether to renumber or keep a retired slot, because the "22 alerts" count appears in EXEC-v4 line 142 and doc 38 5.13 (line 180) |
| `'biometric'` in `platform.integration_runs.integration` and the `legacy_name` comment | 01 line 197 · 13B line 1678 | **No change.** Historical free text |

No schema table exists **only** for the I-04 import, so no table needs to be dropped.

## 5. Decisions owed by the GM (owner: GM)

1. Approve §2.1, §2.3, §2.5 and §2.6 as shapes.
2. Choose the device-registry placement (§2.2).
3. Confirm the `decision` value list (§2.3).
4. Choose (a) or (b) in §2.4.
5. Decide N-16 (§4).
6. Answer ADR-0003 items 3, 4 and 11, which change §2.2, §2.3 and §2.6.
