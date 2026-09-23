#!/usr/bin/env python3
"""PG-EOS · gen-briefs.py — generate .claude/briefs/<module>.brief.md from the live schema.

BOOTSTRAP-v5 §6 (QUOTA DISCIPLINE) and §9: one brief per module (15), each ≤ 120 lines,
holding the module's tables, status columns with their allowed values, events/series, its
doc 40 Part C section pointer, its D-blueprint pointers and its golden-slice counterpart
paths. Workers read the brief, not the package.

The briefs are GENERATED. Never hand-edit one: change the schema (under G-01) or this
script, then re-run it. It is idempotent and safe to run any number of times.

Usage
    PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos python3 scripts/gen-briefs.py
    python3 scripts/gen-briefs.py --out .claude/briefs --check

Exit codes: 0 all 15 briefs written and within the line limit · 1 a query or limit failed.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

MAX_LINES = 120
FIELD_SEP = "\x1f"

# ───────────────────────────────────────────────────────────────────────────────
# The fifteen modules of BOOTSTRAP-v5 §7. `fleet` has NO schema of its own: its
# tables live in schema `tms` (vehicles, documents, maintenance, fuel, accidents).
# ───────────────────────────────────────────────────────────────────────────────
FLEET_TABLES = {
    "vehicles", "vehicle_documents", "maintenance_orders", "maintenance_plans",
    "fuel_ledger", "accidents",
}

MODULES: dict[str, dict] = {
    "identity": dict(
        schema="identity", lane="M",
        doc40="Part B §B1 Identity (+ §B2 Audit) — doc 40 has no Part C section for identity",
        blueprints=["07-Governance-Control.md (roles, SoD, delegation)"],
        series=[],
    ),
    "platform": dict(
        schema="platform", lane="M",
        doc40="Part B §B2–§B6 (Audit · Events & Outbox · Documents · Decisions/Automation/"
              "Thresholds/Flags · Alerts and Reports)",
        blueprints=[
            "07-Governance-Control.md (decisions, alerts, thresholds)",
            "15-Focus-Boards-UX.md (platform.my_work — SCR-FB-01)",
        ],
        series=["DOC"],
    ),
    "catalog": dict(
        schema="catalog", lane="M",
        doc40="Part C §C1 M03 Catalog & Pricing (`catalog`)",
        blueprints=["02-Financial-Accounting.md (price lists, service pricing)"],
        series=[],
    ),
    "sales": dict(
        schema="sales", lane="2",
        doc40="Part C §C2 M02 Sales & CRM (`sales`)",
        blueprints=[
            "02-Financial-Accounting.md (quotes → contracts → revenue)",
            "14-Sales-Compensation.md (SCR-SC-01 commission, 13B-SC)",
        ],
        series=["QTE", "CTR", "LEAD", "OPP"],
    ),
    "wms": dict(
        schema="wms", lane="1",
        doc40="Part C §C3 M04 Warehouse (`wms`)",
        blueprints=[
            "03-Operations-Warehouse.md (core warehouse screens)",
            "10-Order-Fulfillment-Scenarios.md (inbound/outbound scenarios)",
            "12-Warehouse-Work-Orders-VAS.md (SCR-WO-01 work orders, 13B-WO)",
            "13-Space-Occupancy-Indicators.md (space indicators, 13B-SP)",
        ],
        series=["INB", "OUT", "CNT", "WO"],
    ),
    "tms": dict(
        schema="tms", lane="2", exclude=FLEET_TABLES,
        doc40="Part C §C4 M05 Delivery (`tms`) & M09 Fleet — delivery half",
        blueprints=["04-Operations-Delivery-Fleet.md (delivery, routes, POD)"],
        series=["TSK", "RTE"],
    ),
    "cc": dict(
        schema="cc", lane="1",
        doc40="Part C §C5 M06 Call Center (`cc`)",
        blueprints=["05-Operations-iMile-CallCenter.md (tickets, switchboard)"],
        series=["TKT"],
    ),
    "billing": dict(
        schema="billing", lane="M",
        doc40="Part C §C6 M07 Finance & Billing (`billing`)",
        blueprints=["02-Financial-Accounting.md (ledger, invoices, allocations)"],
        series=["INV", "CN", "JE", "RCT"],
    ),
    "hr": dict(
        schema="hr", lane="2",
        doc40="Part C §C7 M08 HR (`hr`), Housing (`housing`), Admin (`admin`) — HR part",
        blueprints=[
            "06-Administrative-HR-Housing.md (recruitment, penalties, discipline)",
            "14-Sales-Compensation.md (hr.sales_commission_events — SCR-SC-01)",
        ],
        series=["MPR", "RCR", "DSC", "SCM"],
    ),
    "fleet": dict(
        schema="tms", lane="3", include=FLEET_TABLES,
        doc40="Part C §C4 M05 Delivery (`tms`) & M09 Fleet — fleet half",
        blueprints=["04-Operations-Delivery-Fleet.md (vehicles, maintenance, fuel, accidents)"],
        series=["MNT", "ACC"],
    ),
    "housing": dict(
        schema="housing", lane="1",
        doc40="Part C §C7 M08 HR (`hr`), Housing (`housing`), Admin (`admin`) — Housing part",
        blueprints=["06-Administrative-HR-Housing.md (buildings, rooms, inspections)"],
        series=["HMR", "HIN"],
    ),
    "partners": dict(
        schema="partners", lane="3",
        doc40="Part C §C6 M07 Finance & Billing — Partners (`partners`) paragraph",
        blueprints=["04-Operations-Delivery-Fleet.md (subcontracting, back-to-back SLA)"],
        series=[],
    ),
    "admin": dict(
        schema="admin", lane="3",
        doc40="Part C §C7 M08 HR (`hr`), Housing (`housing`), Admin (`admin`) — Admin part",
        blueprints=["06-Administrative-HR-Housing.md (purchasing, assets, gov transactions)"],
        series=["PRQ", "PO", "PINV", "PCT", "GOV", "APR", "COR"],
    ),
    "imile": dict(
        schema="imile", lane="2",
        doc40="Part C §C8 M11 iMile Operations (`imile`)",
        blueprints=["05-Operations-iMile-CallCenter.md (sorting, DTL, attribution, trust)"],
        series=[],
    ),
    "governance": dict(
        schema="governance", lane="3",
        doc40="Part C §C9 M13 Governance (`governance`)",
        blueprints=["07-Governance-Control.md (KPIs, OKRs, risks, NCR, policies)"],
        series=["NCR"],
    ),
}

# Screens and boards that are NOT a module schema but are named by doc 40 Part C.
PORTAL_POINTER = ("Client portal app `apps/portal`: doc 40 Part C §C10 · "
                  "D-blueprints 11-Client-Store-Integration.md")

STATUS_RE = re.compile(r"(status|state)$|_(status|state)$|^(.*_)?(type)$")
ENUM_RE = re.compile(r"= ANY \(ARRAY\[(.*?)\]\)", re.S)
LITERAL_RE = re.compile(r"'((?:[^']|'')*)'::")


# ───────────────────────────────────────────────────────────────────────────────
# psql access
# ───────────────────────────────────────────────────────────────────────────────
def psql(sql: str) -> list[list[str]]:
    """Run one query through psql and return rows split on a unit separator."""
    env = dict(os.environ)
    env.setdefault("PGDATABASE", "pgeos")
    cmd = ["psql", "-X", "-q", "-A", "-t", "-F", FIELD_SEP,
           "-v", "ON_ERROR_STOP=1", "-c", sql]
    try:
        out = subprocess.run(cmd, env=env, capture_output=True, text=True, check=True).stdout
    except FileNotFoundError:
        sys.exit("gen-briefs: psql not found on PATH. Install the PostgreSQL 16 client.")
    except subprocess.CalledProcessError as exc:
        sys.exit(f"gen-briefs: psql failed.\n{exc.stderr.strip()}")
    return [ln.split(FIELD_SEP) for ln in out.splitlines() if ln.strip()]


SCHEMAS = sorted({m["schema"] for m in MODULES.values()})
SCHEMA_LIST = ", ".join(f"'{s}'" for s in SCHEMAS)


def load_schema_facts() -> dict:
    """One round trip per category, grouped in Python."""
    facts: dict = {}

    facts["tables"] = defaultdict(list)          # schema -> [(table, purpose)]
    for sch, tbl, purpose in psql(f"""
        select n.nspname, c.relname,
               coalesce(obj_description(c.oid, 'pg_class'), '')
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r','p') and n.nspname in ({SCHEMA_LIST})
         order by 1, 2;"""):
        facts["tables"][sch].append((tbl, purpose.strip()))

    facts["entity_id"] = set()                   # {(schema, table)}
    for sch, tbl in psql(f"""
        select table_schema, table_name from information_schema.columns
         where table_schema in ({SCHEMA_LIST}) and column_name = 'entity_id'
         group by 1, 2;"""):
        facts["entity_id"].add((sch, tbl))

    facts["policies"] = defaultdict(list)        # (schema, table) -> [policy]
    for sch, tbl, pol in psql(f"""
        select schemaname, tablename, policyname from pg_policies
         where schemaname in ({SCHEMA_LIST}) order by 1, 2, 3;"""):
        facts["policies"][(sch, tbl)].append(pol)

    facts["rls"] = set()                         # {(schema, table)} with RLS enabled
    for sch, tbl in psql(f"""
        select n.nspname, c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r','p') and c.relrowsecurity and n.nspname in ({SCHEMA_LIST});"""):
        facts["rls"].add((sch, tbl))

    facts["checks"] = defaultdict(dict)          # (schema, table) -> {column: [values]}
    for sch, tbl, col, definition in psql(f"""
        select n.nspname, c.relname, a.attname, pg_get_constraintdef(con.oid)
          from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace
          join unnest(con.conkey) k(attnum) on true
          join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
         where con.contype = 'c' and n.nspname in ({SCHEMA_LIST})
         order by 1, 2, 3;"""):
        # keep only constraints that enumerate THIS column's allowed values
        if not re.search(rf"\b{re.escape(col)}\s*=\s*ANY", definition):
            continue
        match = ENUM_RE.search(definition)
        if not match:
            continue
        values = [v.replace("''", "'") for v in LITERAL_RE.findall(match.group(1))]
        if values:
            facts["checks"][(sch, tbl)][col] = values

    facts["views"] = defaultdict(list)
    for sch, name in psql(f"""
        select table_schema, table_name from information_schema.views
         where table_schema in ({SCHEMA_LIST}) order by 1, 2;"""):
        facts["views"][sch].append(name)

    facts["functions"] = defaultdict(list)
    for sch, name in psql(f"""
        select n.nspname, p.proname
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ({SCHEMA_LIST}) group by 1, 2 order by 1, 2;"""):
        facts["functions"][sch].append(name)

    facts["sequences"] = defaultdict(list)
    for sch, name in psql(f"""
        select sequence_schema, sequence_name from information_schema.sequences
         where sequence_schema in ({SCHEMA_LIST}) order by 1, 2;"""):
        facts["sequences"][sch].append(name)

    facts["counters"] = {}                       # doc_type -> sample prefix
    for doc_type, prefix in psql(
            "select doc_type, min(prefix) from platform.counters group by 1 order by 1;"):
        facts["counters"][doc_type] = prefix

    facts["table_count"] = len(psql(f"""
        select 1 from information_schema.tables
         where table_type = 'BASE TABLE'
           and table_schema not in ('pg_catalog', 'information_schema');"""))
    return facts


# ───────────────────────────────────────────────────────────────────────────────
# rendering
# ───────────────────────────────────────────────────────────────────────────────
def module_tables(module: str, facts: dict) -> list[tuple[str, str]]:
    cfg = MODULES[module]
    rows = facts["tables"][cfg["schema"]]
    if "include" in cfg:
        rows = [r for r in rows if r[0] in cfg["include"]]
    if "exclude" in cfg:
        rows = [r for r in rows if r[0] not in cfg["exclude"]]
    return rows


def shorten(text: str, width: int) -> str:
    text = " ".join(text.split()).replace("|", "/")
    return text if len(text) <= width else text[: width - 1].rstrip() + "…"


def render(module: str, facts: dict, table_cap: int, status_cap: int) -> list[str]:
    cfg = MODULES[module]
    sch = cfg["schema"]
    tables = module_tables(module, facts)
    names = {t for t, _ in tables}
    today = _dt.date.today().isoformat()

    out: list[str] = []
    a = out.append

    a(f"# `{module}` — module brief (generated)")
    a("")
    a(f"Generated {today} by `scripts/gen-briefs.py` from the live schema "
      f"(`{facts['table_count']}` tables, {len(SCHEMAS)} schemas). "
      "**Do not hand-edit** — change the schema under G-01, then re-run the script.")
    a(f"Schema `{sch}` · tables in this module: {len(tables)} · "
      f"default lane: {cfg['lane']} (doc 38 `Lane` column governs).")
    if module == "fleet":
        a("> **`fleet` has no schema of its own — its tables live in schema `tms`.** "
          "Lane 3 owns `fleet`, lane 2 owns `tms` delivery; both write inside schema `tms`, "
          "so a migration touching either is requested from the Master (BOOTSTRAP-v5 §6).")
    if module == "identity":
        a('> **Two identity packages, no rename (GM 2026-09-23, D-109).** `@pg-eos/identity` = `modules/identity/` — the identity module (schema `identity` use cases; scaffold today).')
        a('> `@pg-eos/identity-mechanisms` = `packages/identity/` — the shared WBS 0.17 mechanisms (OTP, sessions, RBAC/SoD evaluation), no endpoint.')
    if module == "tms":
        a("> **Schema `tms` also holds the `fleet` module's tables** "
          "(vehicles · vehicle_documents · maintenance_orders · maintenance_plans · "
          "fuel_ledger · accidents). They are listed in `fleet.brief.md`, not here.")
    a("")

    a("## 1. Where the rules are")
    a(f"- Build spec (governs on conflict): `docs/package/40-Build-Specification-EN.md` — {cfg['doc40']}")
    for bp in cfg["blueprints"]:
        a(f"- Screens / boards / KPIs (binding): `docs/package/D-blueprints/{bp}`")
    a("- Table-level detail beyond this brief: `docs/package/D-blueprints/08-Data-Model-Maps.md`")
    a("- Schema source (the ONLY permitted schema): `database/schema/01 · 13 · 13B · 019`")
    if module in ("identity", "platform"):
        a(f"- {PORTAL_POINTER}")
    a("")

    a("## 2. Tables")
    a("")
    a("| table | row purpose (obj_description) | entity_id | RLS policies |")
    a("|---|---|---|---|")
    shown = tables[:table_cap]
    for tbl, purpose in shown:
        has_ent = "yes" if (sch, tbl) in facts["entity_id"] else "no"
        pols = facts["policies"].get((sch, tbl), [])
        if pols:
            pol_txt = shorten(" · ".join(pols), 46)
        else:
            pol_txt = "RLS on, no policy" if (sch, tbl) in facts["rls"] else "**RLS OFF — G7 red**"
        a(f"| `{tbl}` | {shorten(purpose, 58) if purpose else '—'} | {has_ent} | {pol_txt} |")
    if len(tables) > table_cap:
        a(f"| … | … +{len(tables) - table_cap} more, see 08-Data-Model-Maps | | |")
    a("")

    a("## 3. Status columns and their allowed values (check constraints)")
    a("")
    status_rows: list[str] = []
    other_rows: list[str] = []
    for tbl, _ in tables:
        for col, values in sorted(facts["checks"].get((sch, tbl), {}).items()):
            line = f"| `{tbl}.{col}` | {shorten(' · '.join(values), 84)} |"
            (status_rows if STATUS_RE.search(col) else other_rows).append(line)
    rows = status_rows + other_rows
    if rows:
        a("| column | allowed values |")
        a("|---|---|")
        for line in rows[:status_cap]:
            a(line)
        if len(rows) > status_cap:
            a(f"| … | … +{len(rows) - status_cap} more, see 08-Data-Model-Maps |")
    else:
        a("None in this module — no enumerated check constraint on any of its columns.")
    a("")

    a("## 4. Document series and counters")
    if cfg["series"]:
        a("")
        a("| doc_type | prefix (per entity) |")
        a("|---|---|")
        for code in cfg["series"]:
            a(f"| `{code}` | `{facts['counters'].get(code, '—')}` |")
        a("")
        a("Allocation is `platform.next_doc_no(entity_id, doc_type)` only — it is the atomic "
          "allocator guard G13 measures. Never format a document number in application code.")
    else:
        a("")
        a("This module allocates no document series of its own "
          "(`platform.counters` holds none for it).")
    seqs = [s for s in facts["sequences"].get(sch, [])
            if any(s.startswith(t + "_") for t in names)]
    if seqs:
        a(f"Sequences in `{sch}` owned by this module: " + " · ".join(f"`{s}`" for s in seqs) + ".")
    a("")

    a("## 5. Views and functions in this schema")
    views = facts["views"].get(sch, [])
    funcs = facts["functions"].get(sch, [])
    a("")
    a("- Views: " + (" · ".join(f"`{sch}.{v}`" for v in views) if views else "none"))
    a("- Functions: " + (" · ".join(f"`{f}()`" for f in funcs) if funcs else "none"))
    if module in ("tms", "fleet"):
        a("  (schema `tms` is shared by the `tms` and `fleet` modules — the lists above are "
          "the whole schema's.)")
    a("")

    a("## 6. Golden-slice counterpart paths")
    a("")
    a("filled by bootstrap after 2.9 — every file this module delivers must have a counterpart "
      "in the golden slice `modules/wms/{domain,application,infrastructure,api,tests}/"
      "receive-inbound`. Replicate with `scripts/new-slice.sh " + module + " <use-case>`; "
      "a hand-made file tree is a review FAIL.")
    a("")

    a("## 7. How a worker uses this brief")
    a("")
    a("- This brief replaces the package. Read a package document only where section 1 points "
      "to a section this brief does not already carry.")
    a("- A table, column or rule you need and cannot find here or in 01 / 13 / 13B / 019 / 40: "
      "**STOP and report** — file a schema-change request under EXECUTION-MASTER-v4 §1.11 (G-01). "
      "Never invent one.")
    a("- Write only inside the paths the slice brief's `Write ONLY` line names. This module's "
      f"home is `modules/{module}/` (+ `tests/`).")
    a("- Domain events go to `platform.outbox` in the same transaction as the state change; "
      "`platform.domain_events` is retired.")
    return out


def fit(module: str, facts: dict) -> list[str]:
    """Render, shrinking the two long tables until the brief fits MAX_LINES."""
    table_cap, status_cap = 40, 30
    lines = render(module, facts, table_cap, status_cap)
    while len(lines) > MAX_LINES and (table_cap > 4 or status_cap > 4):
        if status_cap > 4 and (status_cap >= table_cap or table_cap <= 4):
            status_cap -= 1
        else:
            table_cap -= 1
        lines = render(module, facts, table_cap, status_cap)
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate the 15 PG-EOS module briefs.")
    ap.add_argument("--out", default=".claude/briefs", help="output directory")
    ap.add_argument("--check", action="store_true",
                    help="verify the line limit only; write nothing")
    args = ap.parse_args()

    facts = load_schema_facts()
    out_dir = Path(args.out)
    if not args.check:
        out_dir.mkdir(parents=True, exist_ok=True)

    failed = 0
    for module in MODULES:
        lines = fit(module, facts)
        status = "ok" if len(lines) <= MAX_LINES else "TOO LONG"
        if status != "ok":
            failed += 1
        if not args.check:
            (out_dir / f"{module}.brief.md").write_text("\n".join(lines) + "\n",
                                                        encoding="utf-8")
        print(f"{module:<12} {len(lines):>4} lines  {len(module_tables(module, facts)):>3} tables"
              f"  {status}")

    print(f"\n{len(MODULES)} briefs · limit {MAX_LINES} lines · "
          f"{facts['table_count']} tables in {len(SCHEMAS)} schemas")
    if failed:
        print(f"FAILED: {failed} brief(s) over the limit", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
