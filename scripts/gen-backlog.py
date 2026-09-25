#!/usr/bin/env python3
"""gen-backlog.py — generate tasks/MASTER_BACKLOG.md from docs/package/38-WBS.md.

Doc 38 is the ONLY task sequence (precedence rank 5). This script copies its rows
verbatim — IDs, type markers, Depends on, Lane, Owner, Acceptance — and adds a
`Status` column. It never invents a task, a lane or a dependency.

Usage:
    python3 scripts/gen-backlog.py            # (re)writes tasks/MASTER_BACKLOG.md, keeps existing statuses
    python3 scripts/gen-backlog.py --check    # verifies 137 rows, the header line and the X statuses; writes nothing

Status vocabulary (pg-scribe moves rows; nothing else edits this file):
    TODO · READY · ACTIVE · WAITING_GM · BLOCKED · DONE @ <hash> · SUPERSEDED — <ADR/decision>
    · DEFERRED-POST-PILOT — <decision> (D-127: field data, human entry, sign-off, training, naming and
      Tier-0 provisioning wait until the pilot system is complete; listed again under Phase 7)
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Header wording fixed by the GM 2026-09-23 (D-111); count 132 → 133 on 2026-09-24 (D-124 split of 0.6 into
# 0.6a / 0.6b, applied to doc 38 v4.2 under directive D-127…D-134). The X-tasks and 0.19 are inside the 133 rows.
HEADER = "**137 doc-38 tasks (v4.5: 0.6 → 0.6a / 0.6b, D-124; 5.3b added, D-167; 5.5a + 5.18 added, D-173; 2.9b added, D-185) + X.1–X.6 CONTINUOUS + DEFERRED-POST-PILOT rows (D-127)** — eight phases (0–7) + cross-cutting X-tasks; X.1–X.6 are counted inside the 137 (0.19 was DEFERRED until D-172; DONE @ `cd00c51`, D-182). No 18-phase roadmap, no separate database phase (BOOTSTRAP-v4 §8)."
EXPECTED_ROWS = 137
ROW_ID = r"(\d+\.\d+[ab]?|X\.\d+)"
DEFERRED_PP = "DEFERRED-POST-PILOT"
WBS = ROOT / "docs" / "package" / "38-WBS.md"
OUT = ROOT / "tasks" / "MASTER_BACKLOG.md"

def split_row(line: str):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells

def load_existing_status():
    status = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.startswith("| ") and re.match(r"^\| " + ROW_ID + " ", line):
                cells = split_row(line)
                status[cells[0]] = cells[-1]
    return status

def parse():
    phases, current = [], None
    for line in WBS.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^# (Phase \d+ — .+|Cross-Cutting.*)$", line)
        if m:
            current = {"title": m.group(1).strip(), "rows": [], "gate": ""}
            phases.append(current)
            continue
        if current is None:
            continue
        if line.startswith("**Phase gate:**"):
            current["gate"] = line.replace("**Phase gate:**", "").strip()
        if re.match(r"^\| " + ROW_ID + r" \|", line):
            current["rows"].append(split_row(line))
        if line.startswith("## Summary"):
            break
    return phases

def initial_status(cells, phase_title):
    if phase_title.startswith("Cross"):
        return "CONTINUOUS"
    task, typ, deps, lane = cells[1], cells[2], cells[3], cells[4].strip("* ")
    if task.startswith("✅ **Done**"):
        return "DONE (pre-build, GM)"
    if lane == "A":
        return "WAITING_GM"          # GM / manual lane — never blocks a code lane
    if deps in ("—", "-", ""):
        return "READY"               # no dependency: /pg-resume may pick it
    return "TODO"

def render(phases, keep):
    out = []
    out.append("# MASTER_BACKLOG — PG-EOS")
    out.append("")
    out.append("**Generated from `docs/package/38-WBS.md` (Document 38 v4.0) by `scripts/gen-backlog.py` — IDs, type markers, dependencies, lanes, owners and acceptance criteria are copied verbatim; doc 38 governs on any difference.**")
    out.append("")
    out.append(HEADER)
    out.append("")
    out.append("| Status | Meaning |")
    out.append("|---|---|")
    out.append("| `TODO` | dependencies not all DONE |")
    out.append("| `READY` | every dependency DONE with a hash; lane free → `/pg-resume` may pick it |")
    out.append("| `ACTIVE` | claimed in `tasks/LANE_LOCKS.md`; one per lane |")
    out.append("| `WAITING_GM` | 🧑 / 🔧 lane-A task: runbook or script produced, waits for the GM; never blocks a code lane |")
    out.append("| `BLOCKED` | REAL BLOCKER recorded in `docs/PROJECT_STATE.md` |")
    out.append("| `SUPERSEDED — <id>` | row kept for the 137 count; replaced by the named ADR / GM decision, never picked (D-125) |")
    out.append("| `DEFERRED-POST-PILOT — <id>` | pilot-first rule (D-127): field data, human entry, sign-off, training, naming and Tier-0 provisioning wait until the pilot system is complete; the pilot runs on seed 019 + synthetic data only; the row keeps its phase and is listed again under Phase 7; never picked before the pilot |")
    out.append("| `DONE @ <hash>` | acceptance criterion passed, pg-reviewer PASS, gates green — written by pg-scribe in the same commit |")
    out.append("")
    out.append("Type: 🧑 human decision/data · 🤖 AI-buildable slice · 🔧 infra · ✅ verification. Lane: **A** GM/manual · **B · C · 1 · 2 · 3** parallel build lanes · **M** Master (serial). Deps govern over Lane.")
    out.append("")
    total = 0
    deferred_pp = []                      # (id, task, owner, status) — every phase, in doc-38 order
    for ph in phases:
        out.append("---")
        out.append("")
        out.append(f"## {ph['title']}")
        out.append("")
        if ph["title"].startswith("Cross"):
            out.append("| ID | Task | Cadence | Lane | Owner | Status |")
            out.append("|---|---|---|---|---|---|")
        else:
            out.append("| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |")
            out.append("|---|---|---|---|---|---|---|---|")
        for cells in ph["rows"]:
            tid = cells[0]
            st = keep.get(tid) or initial_status(cells, ph["title"])
            out.append("| " + " | ".join(cells + [st]) + " |")
            total += 1
            if st.startswith(DEFERRED_PP):
                deferred_pp.append((tid, cells[1], cells[5] if len(cells) > 5 else cells[4], st))
        if ph["gate"]:
            out.append("")
            out.append(f"**Phase gate:** {ph['gate']}")
        if ph["title"].startswith("Phase 7") and deferred_pp:
            # D-127: every DEFERRED-POST-PILOT row is listed again here, under Phase 7, as a pilot-exit item.
            # The rows keep their own phase above; this list is derived from their status and is not counted.
            out.append("")
            out.append("### Deferred post-pilot (D-127) — pilot-exit items, listed here from every phase (derived from status; not counted)")
            out.append("")
            out.append("| ID | Task | Owner | Status |")
            out.append("|---|---|---|---|")
            for tid, task, owner, st in deferred_pp:
                # "↩ id" so these derived rows never match the `| id |` row pattern of --check / check-setup.sh
                out.append(f"| ↩ {tid} | {task} | {owner} | {st} |")
        out.append("")
    out.append("---")
    out.append("")
    out.append("## Staged — not in doc 38, admitted here once the GM approves the task AND its policy decisions (BOOTSTRAP-v5 §1 item 4). Never counted in the 132.")
    out.append("")
    out.append("| ID | Task | Type | Depends on | Lane | Owner | Acceptance | Status |")
    out.append("|---|---|---|---|---|---|---|---|")
    out.append("| 2.20 | Warehouse work orders & VAS (SCR-WO-01) — `tasks/backlog/2.20-work-orders.md`, source D-12 | 🤖 | 2.9, 2.13 | **1** | WH_MGR | A work order from an outbound line, split into two tasks, assigned to two workers on the PDA, completed with one exception: `qty_done` sums correctly, a complete `work_order_events` timeline, one outbox event per state change in the same transaction, exactly one billing event priced on `qty_done`; G1, G9, G11, G18 green | TODO — admitted 2026-09-23 (D-115): `wo.sla.*` values approved for year 1, mandatory review after 90 operating days; blocked on 2.9 (golden slice) and 2.13 (PDA slice), neither built |")
    out.append("| 2.9b | Schedule inbound (appointment) + logistics terms (handover point · transport by · vehicle type · labour) — `tasks/backlog/2.9b-schedule-inbound.md`, source SCR-WMS-INB-01 §7–§8 | 🤖 | 2.9 | **2** | WH_MGR | A draft ASN scheduled to a future time carries expected_at/scheduled_by/scheduled_at, one `wms.inbound.scheduled` outbox row and one audit row in the same transaction; past time → 422; reschedule bumps version; approve-with-slot emits both events; cancel without reason → 422; WH_SUP board lists today's appointments; G1, G9, G11, G14 green | TODO — staged 2026-09-24 (D-168): first slice replicated from the golden template; migration number issued when it starts |")
    out.append("| 6.2b | Client store connectors (I-12) — `tasks/backlog/6.2b-store-connectors.md`, source D-11 | 🤖 | 6.1, 6.2 | **1** | SYSADMIN + SALES_MGR (shared, D-11 §7 ق-4) | A store order posted by the test connector appears as one PG-EOS order with the D-11 §5-2 minimum fields, idempotent under replay, a forced failure follows the D-11 §5-5 nine-field policy and shows in the integration monitor; client isolation holds (G14) | TODO — admitted 2026-09-23 (D-115): option ③ approved per D-11 §7 (B in Phase 3, A in Phase 6, C = 6.2b); blocked on 6.1, 6.2, neither built; D-11 §5-4 schema additions still need a G-01 filing once 6.2b starts |")
    out.append("| SC-01 | Sales commission activation (SCR-SC-01) — `tasks/backlog/SC-01-sales-commission.md`, source D-14 | 🤖 | 4.9, 1.7 | **2** | SALES_MGR | For a contract signed by one rep and later executed under another, the monthly run splits per `sales.account_ownership_history` exactly as D-14 §3, honours the cap and minimum-margin rule, reverses correctly on a credit note, exposes the statement only to the rep, SALES_MGR, CFO and GM; G2, G11, G14 green, no number written outside `platform.thresholds` | TODO — admitted 2026-09-23 (D-115); dependency on the \"sales contracts slice\" bound to WBS **1.7** (D-123, `docs/package/38-WBS.md` line 68); structure approved (recurring, `collected` basis, 24 months, no cap year 1, half rate 12 months for existing clients, SCR-SC-01 approved); rates and the 0.5% manager share approved provisionally for year 1 with a 6-month review; blocked on 4.9 and 1.7, neither built |")
    out.append("")
    out.append(f"**Rows: {total}** (expected {EXPECTED_ROWS} — `--check` fails otherwise; the four Staged rows above are never part of this count).")
    return "\n".join(out) + "\n", total

def check_existing(counts):
    """--check: the committed file must carry the D-111 header and the statuses it names."""
    if not OUT.exists():
        return [f"{OUT.relative_to(ROOT)} missing"]
    errors = []
    if HEADER not in OUT.read_text(encoding="utf-8").splitlines():
        errors.append("MASTER_BACKLOG header differs from gen-backlog.py HEADER (D-111)")
    st = load_existing_status()
    xs = sorted(k for k in st if k.startswith("X."))
    if len(xs) != 6 or any(st[k] != "CONTINUOUS" for k in xs):
        errors.append(f"X-tasks must be X.1–X.6 CONTINUOUS, found {[(k, st[k]) for k in xs]}")
    # 0.19 DEFERRED rule removed 2026-09-25 (D-182): the row was unblocked by D-172 and is DONE @ cd00c51.
    return errors

def main():
    check = "--check" in sys.argv
    phases = parse()
    text, total = render(phases, {} if check else load_existing_status())
    counts = {ph["title"]: len(ph["rows"]) for ph in phases}
    for k, v in counts.items():
        print(f"{v:3d}  {k}")
    print(f"{total:3d}  TOTAL")
    if total != EXPECTED_ROWS:
        print(f"ERROR: expected {EXPECTED_ROWS} rows", file=sys.stderr)
        sys.exit(1)
    if check:
        errors = check_existing(counts)
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        if errors:
            sys.exit(1)
        waiting = sorted(k for k, v in load_existing_status().items() if v.startswith("WAITING_GM"))
        if waiting:
            print(f"note: WAITING_GM rows: {waiting} (D-127 pilot-first: expected none until the pilot is complete)")
        print("header · X.1–X.6 CONTINUOUS — agree with tasks/MASTER_BACKLOG.md")
    if not check:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(text, encoding="utf-8", newline="\n")   # LF on every platform (D-122 .gitattributes)
        print(f"wrote {OUT.relative_to(ROOT)}")

if __name__ == "__main__":
    main()
