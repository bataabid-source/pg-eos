# SCR-I18N-01 — Amharic (`am`) as a sixth field-app language

**Status: APPROVED (GM)** — raised under **EXECUTION-MASTER-v4 §1.11 (G-01)**, recorded as **D-001** in `docs/DECISION_LOG.md`.
Date: 2026-09-21 · Type: rule change to the governing package (single-lane Master task, CLAUDE.md · PARALLELISM).

---

## 1. The request

Add Amharic (`am`) to the i18n language set. Field apps (`apps/driver`, `apps/pda`, worker-facing
training material) ship **six**: `ar, en, hi, ur, bn, am`. The admin console is unchanged and stays
**`ar / en`** — the GM directive is about the workforce, not about back-office users.

**Rationale.** Ethiopian staff in delivery and warehouse operations. Doc 28 §4 already states the
principle this rests on: training in a language the trainee does not understand is training that did
not happen. The same logic governs a PDA step (doc 30 §W7, "in the worker's language") — a control a
worker cannot read is not a control.

## 2. Why this needed a rule change rather than an edit

Commit `42c72ba` added `am` to `CLAUDE.md`, the five files under `.claude/agents/` and
`docs/DECISION_LOG.md`, and to nothing else. Those files are all **downstream** of the package:

- `docs/DECISION_LOG.md` line 106 sits under the heading `## Seed — EXECUTION-MASTER-v4 PART 1 (verbatim)`.
  It is a transcription of `EXECUTION-MASTER-v4.md:168`. Editing the transcript while leaving the
  source alone desynchronised a section whose whole contract is that it is verbatim.
- The language list itself originates in the **doc 40 closing note** — rank **1** on the R-01
  precedence ladder, the document that governs on conflict. A rank-1 statement cannot be amended by
  editing files that cite it; under R-01 the higher document governs and the lower one is the one
  that gets corrected.
- `CLAUDE.md` and `.claude/*` are frozen paths (CLAUDE.md · PARALLELISM) — changed only by a
  single-lane Master task. This SCR is that task.

The count was also **already settled once**: audit finding **OPS-46** raised the training card from
four languages to five, and doc 28 records the correction (`v4: كانت أربعاً هنا`). A second change to
the same number is a governance event, not a typo fix.

## 3. Scope applied — 16 lines across 12 files

**Governing sources (the ones that make the rule):**

| Rank | File | Line | Change |
|---|---|---|---|
| 1 | `docs/package/40-Build-Specification-EN.md` | 714 | closing note → `(ar, en, hi, ur, bn, am)` |
| 3 | `docs/package/EXECUTION-MASTER-v4.md` | 168 | §1.4 row → "6 languages in field apps", list + `am`, cites D-001 |
| 3 | `docs/package/EXECUTION-MASTER-v4.md` | 585 | agent constraint → `+ am` |
| 5 | `docs/package/38-WBS.md` | 131 | task 3.22 driver training → "6 languages" |
| 8 | `docs/package/BOOTSTRAP-v4.md` | 211 | agent constraint → `+ am` |

**Reference documents brought into line (rank 9):**

`19-PST-Warehouse-Setup.md:506` (A5 aisle card) · `28-Adoption-Compliance-Launch.md:62,204` ·
`30-PDA-App.md:37,323` (§W7 and launch decision 3) · `D-blueprints/03-Operations-Warehouse.md:720,873` ·
`D-blueprints/06-Administrative-HR-Housing.md:675` · `D-blueprints/15-Focus-Boards-UX.md:890`.

**Derived / generated:** `docs/DECISION_LOG.md:106` (resynced to its EXEC-v4 source) ·
`tasks/MASTER_BACKLOG.md:122` (mirror of doc 38 / 3.22) · `CLAUDE.md:25` and the five
`.claude/agents/*.md` files (already carried `am` from `42c72ba`; this task is what legitimises them).

Four package files (`19`, `30`, `38`, `40`) carried a filesystem read-only attribute. It was cleared
for the edit and **restored afterwards** — 10 read-only files before, 10 after.

## 4. Deliberately not changed

- **`docs/package/AUDIT-REPORT-v4.md:215`** — the closed record of finding OPS-46 ("training card in
  four languages while the standard is five"). That is a historical audit record and was true when
  written. Rewriting it would falsify the audit trail; the count it refers to is superseded by D-001,
  not retroactively wrong.
- **Doc 29** — contains **no language statement at all**. The "doc 29 §6" citation in the Language
  switcher row points at §6's screen model, which is the basis of the *admin* `ar / en` half of the
  decision. There was no six-language edit to make there, and inventing one would repeat the exact
  fault this SCR corrects. The citation is left as it stands.
- **Doc 40 §A5:82** reads "No embedded Arabic strings — i18n" and carries no list, so docs 28 and 15
  citing "40 §A5" for the language set were already pointing at the wrong section. Their citations
  now point at the doc 40 closing note, where the list actually lives.

## 5. Open items this creates

1. **No translations exist.** `packages/i18n` has not been built (WBS 0.13/0.14 territory; `packages/`
   currently holds only `.gitkeep`). Nothing in code referenced `am` before this change and nothing
   does now — the rule is in place ahead of the implementation, which is the correct order.
2. **Amharic is LTR in Ge'ez script**, unlike `ar` and `ur`. The `packages/i18n` direction map must
   treat it with `en`/`hi`/`bn`, not with the RTL set, and `pg-frontend`'s "RTL is the default
   direction" needs Amharic in the LTR exception list.
3. **PDA font coverage for Ge'ez is unverified** against doc 30 §W6 (readable in low light, large
   type) on the industrial device. Worth confirming before WBS 2.16 (PDA) rather than at launch.
4. **`D-blueprints/15-Focus-Boards-UX.md` D-2 is still ⏳ GM.** It now reads six languages, but the
   underlying question — which card fields get translated (`title`, `action_label`, SLA badge; not
   `ref`, not `kind`) — remains open and is unaffected by this SCR.
5. **Translation sourcing and sign-off for Amharic** has no named owner. Doc 38 / 3.22 covers driver
   training delivery, not translation supply.
