# doc 38 insertion draft — native biometric attendance (ADR-0003 Proposed, D-126)

**Status: draft only. Nothing here is applied to `docs/package/38-WBS.md`.** It becomes applicable once ADR-0003 is Accepted and SCR-HR-ATT-01
is approved.

GM directive **D-125** (2026-09-24, applied in the commit that follows this draft) marks 5.4 as SUPERSEDED. It also strips the I-04 import
wording from 5.3 directly, ahead of acceptance, by the GM's instruction.

This draft does **not** use `docs/notes/CR-BIO-DSH-v3.md`, which was never in the repo. Every row comes from D-126, ADR-0003 and doc 38.

## 1. Overlaps with existing doc-38 tasks (fold, never duplicate)

| WBS | Today (doc 38) | Action under ADR-0003 |
|---|---|---|
| **5.3** | M08 HR: org units, teams, attendance from biometrics (I-04), leaves · deps 3.3 · lane 2 · HR_MGR | **amend** (§2). The I-04 wording is stripped by D-125. Leaves are split out, because they have no carrier (Gap #7) |
| **5.4** | Biometric credentials entered by GM; hourly sync | **SUPERSEDED** (D-125). The row is kept so the 132 count holds |
| **5.13** | Alerts engine (22 rules — N-01…N-18 plus N-19…N-22) | **acceptance count is affected** if N-16 leaves 13B. The GM decides between renumbering and a retired slot (SCR-HR-ATT-01 §4) |
| **2.16** | PDA app: … kiosk mode, shared-device PIN login | **no row change**. The PDA punch path waits on ADR-0003 item 1 |
| **3.7** | Driver app: core (login, device binding, …) | **no row change**. The single device registry and its approver wait on ADR-0003 item 4 |
| doc 40 line 414 (driver app screen 10: profile/documents/attendance/penalties) | no doc-38 row names this screen | **reads** the punches that 5.3 writes. No row change |
| **5.5** | Shifts and rest rotation (A3) | no change. Shifts stay in Gap #7 |
| **5.7** | Penalty schedule (77 items, including ATT-01…10) | no change. PLT-50 keeps auto-absence off |
| 0.19 · 5.14 · 6.1 · 6.3 · 5.18 (staged) | admin shell · KPI tree · portal · decisions app · focus boards | role dashboards. **Out of D-126's scope** (they belong to the CR half that never arrived) |

## 2. Rows (replacement / staged text)

```
| 5.3 | M08 HR: org units, teams, **native attendance (ADR-0003): punch use case from the field app / PDA — OS biometric result, server-verified attestation, GPS + geofence, audit chain — and the HR review queue** | 🤖 | 3.3 | **2** | HR_MGR | A punch from a registered device inside the site geofence is accepted and audited (outbox + audit_log, same transaction); an unmatched or failed punch lands in the HR review queue, never dropped (routing of offline / out-of-geofence / unregistered-device punches per ADR-0003 item 3, pending GM); zero biometric image or template stored anywhere; the auto-absence flag stays off (PLT-50) |
| <GM-issued ID> (D-126 "APP-1") | Field app — attendance capture on the employee's registered phone: device registration (one active device per employee; re-registration approval per ADR-0003 item 4, audited), OS biometric check bound to a hardware key signing a server nonce (no PIN fallback), attestation verified server-side, GPS + geofence, punch through the 5.3 API with an Idempotency-Key | 🤖 | 5.3 | **2** (GM confirm) | HR_MGR | Registering a second device while one is active is rejected until approved; a punch sends only the OS result, signed nonce, attestation, timestamp and GPS (network capture shows no image/template); a PIN-only unlock cannot produce a punch; the app renders in the six field languages (ar, en, hi, ur, bn, am) |
```

- **Gating that is not a dependency.** Doc 38 deps are *tasks*, per line 17. The gates "SCR-HR-ATT-01 approved" and "ADR-0003 Accepted" live in
  the backlog Status cell and in this note, not in the deps cell.
- **Leaves.** They are removed from 5.3 because no carrier exists or is requested. They return to a task only when the GM decides Gap #7.
  Leaving them in 5.3 would make 5.3 impossible to close as DONE.
- **ID.** "APP-1" is D-126's name for the app, not a doc-38 ID. Doc 38 IDs are Phase.Task (line 16), and the commit-msg hook
  (`.githooks/commit-msg` line 12) accepts only `[0-7]\.[0-9]+` or `X`. **The GM issues a numbered ID.**
- **Provenance.** Type, lane 2 and owner HR_MGR are copied from 5.3, which APP-1 extends. **The lane is for the GM to confirm**, because APP-1
  is an `apps/` deliverable. Whether APP-1 is a new app or the driver app (3.7) extended to every employee is a decision owed by the GM.

## 3. Items the CR names that no source in the repo defines (not drafted)

BIO-3F, BIO-8, D15, D16 and the Appendix A KPIs exist only in the absent `CR-BIO-DSH-v3.md`. They stay open until the CR is in `docs/notes/`.

## 4. Count impact

- 5.4 stays as a row, so the count stays at **132**. Doc 38 line 8 reads "126 in eight phases plus 6 cross-cutting", and both numbers are
  unchanged.
- APP-1 is filed as **`tasks/proposed/APP-1-field-app-attendance.md` (WAITING_GM)**, outside the 132. It gets a MASTER_BACKLOG Staged row only once the GM admits it, which is the path 2.20, 5.18, 6.2b and SC-01 took (BOOTSTRAP-v5 line 175).
- Inserting APP-1 into doc 38 itself would be a separate GM decision. It would move the counts to 133 (127 + 6), and would need
  `gen-backlog.py --check` and the `MASTER_BACKLOG` header updated in the same commit.
