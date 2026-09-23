#!/usr/bin/env python3
"""gen-backlog.py — generate tasks/MASTER_BACKLOG.md from docs/package/38-WBS.md.

Doc 38 is the ONLY task sequence (precedence rank 5). This script copies its rows
verbatim — IDs, type markers, Depends on, Lane, Owner, Acceptance — and adds a
`Status` column. It never invents a task, a lane or a dependency.

Usage:
    python3 scripts/gen-backlog.py            # (re)writes tasks/MASTER_BACKLOG.md, keeps existing statuses
    python3 scripts/gen-backlog.py --check    # verifies 132 rows, the header line and the X / 0.19 statuses; writes nothing

Status vocabulary (pg-scribe moves rows; nothing else edits this file):
    TODO · READY · ACTIVE · WAITING_GM · BLOCKED · DONE @ <hash>
"""
import re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Header wording fixed by the GM 2026-09-23 (D-111). The X-tasks and 0.19 are inside the 132 rows.
HEADER = "**132 doc-38 tasks + X.1–X.6 CONTINUOUS + 0.19 DEFERRED** — eight phases (0–7) + cross-cutting X-tasks; X.1–X.6 and 0.19 are counted inside the 132. No 18-phase roadmap, no separate database phase (BOOTSTRAP-v4 §8)."
WBS = ROOT / "docs" / "package" / "38-WBS.md"
OUT = ROOT / "tasks" / "MASTER_BACKLOG.md"

def split_row(line: str):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return cells

def load_existing_status():
    status = {}
    if OUT.exists():
        for line in OUT.read_text(encoding="utf-8").splitlines():
            if line.startswith("| ") and re.match(r"^\| (\d+\.\d+|X\.\d+) ", line):
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
        if re.match(r"^\| (\d+\.\d+|X\.\d+) \|", line):
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
    out.append("| `DONE @ <hash>` | acceptance criterion passed, pg-reviewer PASS, gates green — written by pg-scribe in the same commit |")
    out.append("")
    out.append("Type: 🧑 human decision/data · 🤖 AI-buildable slice · 🔧 infra · ✅ verification. Lane: **A** GM/manual · **B · C · 1 · 2 · 3** parallel build lanes · **M** Master (serial). Deps govern over Lane.")
    out.append("")
    total = 0
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
        if ph["gate"]:
            out.append("")
            out.append(f"**Phase gate:** {ph['gate']}")
        out.append("")
    out.append("---")
    out.append("")
    out.append("## Staged (not in doc 38 — enter this file only after GM approval)")
    out.append("")
    out.append("| ID | Task | Source | File | Status |")
    out.append("|---|---|---|---|---|")
    out.append("| 2.20 | Warehouse work orders & VAS (SCR-WO-01) | D-12 | `tasks/proposed/2.20-work-orders.md` | WAITING_GM |")
    out.append("| 5.18 | Focus boards on `platform.my_work` (SCR-FB-01) | D-15 | `tasks/proposed/5.18-focus-boards.md` | WAITING_GM |")
    out.append("| 6.2b | Client store connectors (I-12) | D-11 | `tasks/proposed/6.2b-store-connectors.md` | WAITING_GM (option choice) |")
    out.append("| SC-01 | Sales commission activation (SCR-SC-01) | D-14 | `tasks/proposed/SC-01-sales-commission.md` | WAITING_GM (model + rates) |")
    out.append("")
    out.append(f"**Rows: {total}** (expected 132 — `--check` fails otherwise).")
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
    if not st.get("0.19", "").startswith("DEFERRED"):
        errors.append(f"0.19 must be DEFERRED, found {st.get('0.19')!r}")
    return errors

def main():
    check = "--check" in sys.argv
    phases = parse()
    text, total = render(phases, {} if check else load_existing_status())
    counts = {ph["title"]: len(ph["rows"]) for ph in phases}
    for k, v in counts.items():
        print(f"{v:3d}  {k}")
    print(f"{total:3d}  TOTAL")
    if total != 132:
        print("ERROR: expected 132 rows", file=sys.stderr)
        sys.exit(1)
    if check:
        errors = check_existing(counts)
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        if errors:
            sys.exit(1)
        print("header · X.1–X.6 CONTINUOUS · 0.19 DEFERRED — agree with tasks/MASTER_BACKLOG.md")
    if not check:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(text, encoding="utf-8")
        print(f"wrote {OUT.relative_to(ROOT)}")

if __name__ == "__main__":
    main()
