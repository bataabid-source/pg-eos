# D-125 cleanup candidates — 2026-09-24

GM directive **D-125** (2026-09-24). Master, single lane. No code, no schema.
- Class **A**: external biometric device, credential import or sync. **B**: requirements that are not system behaviour.
  **C(i)**: a line that reopens a "not to be re-argued" GM decision. **C(ii)**: two live options with no owner.
- The governing source for class A is **ADR-0003** (Proposed), which carries GM decision **D-126**.
- Line numbers are as of HEAD before this commit. Package edits use strike-through plus a `SUPERSEDED — <id>` marker. Nothing was deleted.

## 1. APPLIED

| # | Path | Line | Class | Action taken | Reason |
|---|---|---|---|---|---|
| A1 | `docs/package/38-WBS.md` | 170 | A | 5.3 text "attendance from biometrics (I-04)" changed to "captured natively (ADR-0003, D-126 — no I-04 import)". Acceptance "auto-imported; unmatched to manual queue" changed to "recorded natively; unmatched/failed to HR review queue". Deps, lane and owner unchanged | 5.4's dependency chain. The import assumption is removed, and the queue concept is kept per D-126 |
| A2 | `docs/package/38-WBS.md` | 171 | A | 5.4 struck and marked **SUPERSEDED — ADR-0003 (D-126; D-125)**. The row is kept (132 count), and the acceptance cell notes that PLT-50 stays | WBS 5.4 is the named target of D-125 A |
| A3 | `tasks/MASTER_BACKLOG.md` | 161–162 | A | regenerated from doc 38 (5.3 and 5.4 text). 5.4 status set to `SUPERSEDED — ADR-0003 (D-126), D-125`. `SUPERSEDED` added to the status legend in `scripts/gen-backlog.py` | mirror of A1 and A2 |
| A4 | `docs/package/23-Integration-Register.md` | 17 | A | I-04 register row struck and marked SUPERSEDED | the I-04 integration no longer exists |
| A5 | `docs/package/23-Integration-Register.md` | 94 | A | §I-04 heading marked SUPERSEDED, plus a note: no device, credentials, Firebase or photos. **What remains:** the review-queue concept (now the HR review queue) and the PLT-50 gate. The other rows are historical | D-126 keeps the queue and PLT-50 and drops everything else |
| A6 | `docs/package/23-Integration-Register.md` | 166 | A | "biometric sync failed → N-16" monitoring row struck and marked SUPERSEDED | there is no sync to monitor |
| A7 | `docs/package/25-Alerts-Reports-NFR.md` | 59 | A | N-16 alert row struck and marked SUPERSEDED, with a pointer to the SCR-HR-ATT-01 §4 removal | same |
| A8 | `docs/package/25-Alerts-Reports-NFR.md` | 206 | A | N-16 SQL comment marked SUPERSEDED. The query is left for the record | same. The live seed is in 13B → G-01 (row A-G1) |
| A9 | `docs/package/EXECUTION-MASTER-v4.md` | 340 | A | Lane-A plan entry "5.4 [biometric credentials …]" changed to "5.4 [SUPERSEDED — ADR-0003 · D-126 · D-125]" | mirror of A2 |
| A10 | `docs/package/00-Master-Blueprint.md` | 168 | A | "البصمة" (fingerprint) struck in the integrations list and marked SUPERSEDED | it is no longer an integration |
| A11 | `docs/package/D-blueprints/01-Enterprise-Map.md` | 443 | A | I-04 row struck and marked SUPERSEDED | mirror of A4 |
| A12 | `docs/package/D-blueprints/01-Enterprise-Map.md` | 466 | A | Mermaid node label changed to "I-04 البصمة · SUPERSEDED ADR-0003" | same |
| A13 | `docs/package/D-blueprints/05-Operations-iMile-CallCenter.md` | 981 | A | N-16 row struck and marked SUPERSEDED | mirror of A7 |
| A14 | `docs/package/D-blueprints/06-Administrative-HR-Housing.md` | 1086 | A | N-16 row struck and marked SUPERSEDED | same |
| A15 | `docs/package/D-blueprints/07-Governance-Control.md` | 955 | A | N-16 row struck and marked SUPERSEDED | same |
| A16 | `docs/package/D-blueprints/15-Focus-Boards-UX.md` | 674 | A | "N-16 مزامنة بصمة" (N-16 fingerprint sync) struck on the SYSADMIN board and marked SUPERSEDED | same |
| A17 | `docs/package/D-blueprints/04-Operations-Delivery-Fleet.md` | 1171 | A | "التكامل I-04 للبصمة" (the I-04 fingerprint integration) struck in gap #3, with a pointer to ADR-0003 and SCR-HR-ATT-01 | the gap remains. Only the import requirement is gone |
| A18 | `docs/package/D-blueprints/09-Gap-Register.md` | 52 | A | "التكامل I-04" (the I-04 integration) struck in gap #17, with a pointer to SCR-HR-ATT-01 | same |
| A-G1 | `database/schema/13B-Schema-Reference-Consolidation.sql` | 2977–2983, 5345 | A | **not edited**. The G-01 removal request was filed as SCR-HR-ATT-01 §4 (the N-16 seed row and its category mapping) | D-125: file G-01 and do not touch `database/schema/*`. **No table exists only for the import**, so there is nothing to drop |
| C1 | `docs/package/EXECUTION-MASTER-v4.md` | 439 | C(i) | "scribe haiku" changed to "scribe ~~haiku~~ **sonnet** [SUPERSEDED — GM 2026-09-23 "no haiku", CHANGELOG-v4 §13; D-125]" | reopens the model routing (sonnet default, no haiku) |
| C2 | `docs/package/EXECUTION-MASTER-v4.md` | 451 | C(i) | "~10% haiku (scribe)" changed to "~~haiku~~ sonnet … [SUPERSEDED — …]" | same |
| C3 | `docs/package/D-blueprints/01-Enterprise-Map.md` | 545 | C(i) | "٥ لغات … ar en hi ur bn" (5 languages) changed to "~~٥~~ ٦ لغات … am" (6 languages) [SUPERSEDED — D-001] | reopens the 6 field languages. SCR-I18N-01 missed this line |
| C4 | `docs/package/36-Technical-Architecture-Audit.md` | 550 | C(i) | the i18n tree comment "٥ لغات" (5 languages) changed to "٦ لغات (…am — D-001؛ SUPERSEDED)" | same |
| C5 | `docs/package/35-Driver-App-v2.md` | 118 | C(i) | `tms.contact_log.cost numeric(10,4)` changed to `numeric(14,3)`, with the comment "SUPERSEDED by the GM decision of 23/09/2026 (all money is numeric(14,3), CHANGELOG-v4 §12; 13B)" | reopens numeric(14,3). 13B was already corrected; the doc was not |

## 2. GM CONFIRM — listed, not applied

| # | Path | Line | Class | Proposed action | Why not applied |
|---|---|---|---|---|---|
| G1 | `docs/package/40-Build-Specification-EN.md` | 668 | A | retention "biometrics 12 m" changes to the GM-set retention for punch records | under D-126 no biometric data exists. Only the GM can set the new value (ADR-0003 open item 5). No number is invented |
| G2 | `docs/package/25-Alerts-Reports-NFR.md` | 429 | A | "البصمات الخام ١٢ شهراً" (raw fingerprints 12 months) changes the same way as G1 | same |
| G3 | `docs/package/D-blueprints/diagrams/rendered/01-08.mmd` · `01-08.svg` | 5 · 1 | A | regenerate from `01-Enterprise-Map.md` after A12 | rendered artefacts. Hand-editing the SVG would desync the layout. Needs the diagram renderer |
| G4 | `database/schema/13B…sql` N-16 + EXEC-v4 §1.4 "22 alerts" | 2977 · §1.4 | A | renumber, or keep N-16 as a retired slot | the alert count is a governing number (SCR-HR-ATT-01 §5 item 4) |
| G5 | `docs/package/26-Business-Continuity.md` | 90, 131 | B | paper attendance sheet within 24 h (and the monthly paper-form kit) | this is a business-continuity fallback when the system is down, which is arguably outside system behaviour. It is also the only attendance path during an outage. GM decides |
| G6 | `docs/package/38-WBS.md` X.6 | 234 | B | "Formal API request to iMile" is a vendor dependency | doc 23 names it the root fix for I-01. Removing it changes the iMile strategy |
| G7 | `docs/package/38-WBS.md` 6.6 | 199 | B | "Three real clients onboarded and operating" is a business outcome, not system behaviour | it is part of the Phase-6 exit. GM decides |
| G8 | `docs/package/38-WBS.md` 7.9 | 218 | B | "Data-residency legal review closed" is an external legal action | it is a launch gate. GM decides |
| G9 | `docs/package/38-WBS.md` 2.5 | 86 | B | "Print and apply 3,330 labels" is physical field work | it is a Phase-2 gate item, and PDA scanning (2.9 and 2.16) needs the labels. Too close to the 2.2 exclusion to act alone |
| G10 | `docs/package/38-WBS.md` 7.5 | 214 | B | "Manual fallback kits in four locations; one drill" is a field requirement | it pairs with G5. GM decides |
| G11 | `docs/package/38-WBS.md` 3.21 | 130 | B | "Driver app lab test — must beat iMile by ≥ 2 taps" is a vendor benchmark | it is a verification of our own app against a third-party baseline. Ambiguous |
| G12 | `docs/package/38-WBS.md` 1.1 · 4.1 | 62 · 141 | B | manual data entry (entity legal data · chart of accounts) | the system enforces the result (1.1 acceptance "Zero document with incomplete header"). They look like data gates, so they are kept unless the GM says otherwise |
| G13 | `docs/DECISION_LOG.md` D-104 | 235 | C(i) | 2.9 waits for 0.5, 0.6 and 0.8, but "lane A never blocks code" (doc 38 lines 21, 261) | **not applied**. Doc 38's own Phase-0 gate (line 54) already requires "0.8 restore succeeded", so the conflict is inside the governing package, not a log line reopening a decision. Superseding D-104 would unblock the golden slice without Tier-0 infra. That is the GM's call |

Kept on purpose (no action): the PLT-50 lines (`DECISION_LOG.md:72`, EXEC-v4:134, D-07:788 and 1263, doc 23 line 4), because D-126 keeps them. `hr.penalty_schedule` ATT-07 and ATT-08. The `biometrics_security` recruitment stage (residency biometrics, not attendance). Doc 29:160 (automation level of attendance, still biometric). Doc 30:250, doc 35:19 and D-04/D-10 face check at shift start, which is native and consistent with D-126. `'biometric'` legacy free text (01:197, 13B:1678, doc 23:76). Historical records: AUDIT-REPORT-v4, CHANGELOG-v4 and `docs/notes/2026-09-23-gm-decision-sheet.md:44`. BOOTSTRAP-v4 haiku lines (114, 131, 149, 244): the whole document is superseded by BOOTSTRAP-v5 (header line 2), which already says sonnet. Briefs: none carries a sync field, and they are generated from the schema. KPI map: none exists; the CR's Appendix A never arrived. Excluded by D-125: 2.2, the M02–M09 data gates, role sign-offs (2.19, 3.22) and 6.2b.

## 3. C(ii) — two live options with no owner (listed, not deleted)

| # | Path | Line | The two options | Status |
|---|---|---|---|---|
| L1 | `docs/package/D-blueprints/12-Warehouse-Work-Orders-VAS.md` | 969 | "إمّا" (either) build the attendance and shifts container in 13B, "وإمّا" (or) measure productivity by active task time only and drop the three indicators | no owner named on the line. **Partly resolved by D-126** (the attendance carrier is now requested, SCR-HR-ATT-01). Shifts are still open. Proposed owner: GM |
| L2 | `docs/package/D-blueprints/09-Gap-Register.md` | 13 | payroll: move it to 13B, or drop every payroll-automation promise | owner is implicitly the GM (the register holds the 22 GM decisions), but the line itself names none. Listed for completeness |
| L3 | `docs/package/18-Warehouse-Layout-Audit.md` | 358 | approve R3 formally, or issue revision R4 | no owner on the line. **Effectively closed by 7.10** ("verified; drawing + licence on file"). Listed so the GM can mark it |
