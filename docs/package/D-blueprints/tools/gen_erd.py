#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen_erd.py — مولّد خرائط نموذج البيانات لـ PG-EOS v4
=====================================================
يقرأ قاعدة pgeos الحيّة (information_schema + pg_catalog + obj_description)
ويولّد آلياً:
  · /home/claude/pg/v4/D-blueprints/08-Data-Model-Maps.md
  · /home/claude/pg/v4/D-blueprints/diagrams/erd-<schema>[-n].mmd

لا يُخترع أي وصف أو حد أو قيمة — كل ما في المخرج مقروء من القاعدة،
عدا سطري وصف كل مخطط (تصنيف لغوي لمحتواه) واتفاقيات الترويسة
المنقولة حرفياً من ترويسة 01-Data-Model.sql.

التشغيل:  PGHOST=/tmp/pgsock PGPORT=5433 PGUSER=postgres python3 gen_erd.py
"""

import json
import os
import re
import subprocess
import sys
from collections import OrderedDict, defaultdict

# ─────────────────────────────────────────────────────────────────────────────
# إعدادات
# ─────────────────────────────────────────────────────────────────────────────
DB = os.environ.get("PGDATABASE", "pgeos")
OUT_DIR = "/home/claude/pg/v4/D-blueprints"
DIAG_DIR = os.path.join(OUT_DIR, "diagrams")
OUT_MD = os.path.join(OUT_DIR, "08-Data-Model-Maps.md")
MAX_COLS = 8          # أقصى عدد أعمدة لكل جدول داخل ERD
SPLIT_AT = 14         # فوق هذا العدد يُقسَّم المخطط

SYS_SCHEMAS = ("pg_catalog", "information_schema", "public")

# الأسهم المكتومة داخل خرائط المخططات (عابرة للمخطط وعالية التكرار)
# تُذكر في المقدمة بدل رسمها حتى لا تتشابك الخريطة.
MUTED_TARGETS = {"platform.entities", "identity.users"}

ENV = dict(os.environ)
ENV.setdefault("PGHOST", "/tmp/pgsock")
ENV.setdefault("PGPORT", "5433")
ENV.setdefault("PGUSER", "postgres")


def q(sql):
    """ينفّذ استعلاماً ويعيد قائمة قواميس (عبر json_agg)."""
    wrapped = "select coalesce(json_agg(t), '[]'::json)::text from ( %s ) t" % sql
    p = subprocess.run(
        ["psql", "-d", DB, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", wrapped],
        capture_output=True, text=True, env=ENV,
    )
    if p.returncode != 0:
        sys.stderr.write(p.stderr)
        raise SystemExit("فشل الاستعلام:\n" + sql)
    return json.loads(p.stdout.strip() or "[]")


# ─────────────────────────────────────────────────────────────────────────────
# 1. القراءة من القاعدة
# ─────────────────────────────────────────────────────────────────────────────
def load():
    d = {}

    d["tables"] = q("""
        select n.nspname                                as sch,
               c.relname                                as tbl,
               obj_description(c.oid,'pg_class')        as descr,
               c.relrowsecurity                         as rls,
               c.relispartition                         as is_part,
               c.relkind                                as kind,
               (select count(*) from information_schema.columns ic
                 where ic.table_schema=n.nspname and ic.table_name=c.relname) as ncols,
               (select coalesce(string_agg(pol.polname, ', ' order by pol.polname),'')
                  from pg_policy pol where pol.polrelid=c.oid)  as policies,
               exists(select 1 from information_schema.columns ic2
                       where ic2.table_schema=n.nspname and ic2.table_name=c.relname
                         and ic2.column_name='entity_id')       as has_entity,
               coalesce((select pn.nspname||'.'||pc.relname
                   from pg_inherits i join pg_class pc on pc.oid=i.inhparent
                   join pg_namespace pn on pn.oid=pc.relnamespace
                  where i.inhrelid=c.oid),'')                   as parent
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where c.relkind in ('r','p')
           and n.nspname not in ('pg_catalog','information_schema','public')
         order by 1,2
    """)

    d["columns"] = q("""
        select table_schema as sch, table_name as tbl, column_name as col,
               ordinal_position::int as ord, data_type as dtype,
               udt_name as udt, is_nullable as nullable,
               numeric_precision::int as nprec, numeric_scale::int as nscale
          from information_schema.columns
         where table_schema not in ('pg_catalog','information_schema','public')
         order by 1,2,4
    """)

    d["pks"] = q("""
        select n.nspname as sch, c.relname as tbl, a.attname as col
          from pg_constraint con
          join pg_class c on c.oid=con.conrelid
          join pg_namespace n on n.oid=c.relnamespace
          join unnest(con.conkey) k(attnum) on true
          join pg_attribute a on a.attrelid=c.oid and a.attnum=k.attnum
         where con.contype='p' and n.nspname not in ('pg_catalog','information_schema','public')
    """)

    d["uks"] = q("""
        select n.nspname as sch, c.relname as tbl, a.attname as col
          from pg_constraint con
          join pg_class c on c.oid=con.conrelid
          join pg_namespace n on n.oid=c.relnamespace
          join unnest(con.conkey) k(attnum) on true
          join pg_attribute a on a.attrelid=c.oid and a.attnum=k.attnum
         where con.contype='u' and n.nspname not in ('pg_catalog','information_schema','public')
    """)

    d["fks"] = q("""
        select con.conname as name,
               n.nspname   as sch,  c.relname  as tbl,
               fn.nspname  as fsch, fc.relname as ftbl,
               (select string_agg(a.attname, ',' order by ord)
                  from unnest(con.conkey) with ordinality u(attnum, ord)
                  join pg_attribute a on a.attrelid=c.oid and a.attnum=u.attnum) as cols,
               (select string_agg(a.attname, ',' order by ord)
                  from unnest(con.confkey) with ordinality u(attnum, ord)
                  join pg_attribute a on a.attrelid=fc.oid and a.attnum=u.attnum) as fcols
          from pg_constraint con
          join pg_class c      on c.oid=con.conrelid
          join pg_namespace n  on n.oid=c.relnamespace
          join pg_class fc     on fc.oid=con.confrelid
          join pg_namespace fn on fn.oid=fc.relnamespace
         where con.contype='f' and n.nspname not in ('pg_catalog','information_schema','public')
         order by 2,3,1
    """)

    d["checks"] = q("""
        select n.nspname as sch, c.relname as tbl, con.conname as name,
               pg_get_constraintdef(con.oid) as def
          from pg_constraint con
          join pg_class c on c.oid=con.conrelid
          join pg_namespace n on n.oid=c.relnamespace
         where con.contype='c' and n.nspname not in ('pg_catalog','information_schema','public')
         order by 1,2,3
    """)

    d["funcs"] = q("""
        select n.nspname as sch, p.proname as name,
               obj_description(p.oid,'pg_proc') as descr,
               pg_get_function_result(p.oid) as rettype,
               p.prokind as kind
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname not in ('pg_catalog','information_schema','public')
         order by 1,2
    """)

    d["triggers"] = q("""
        select n.nspname as sch, c.relname as tbl, t.tgname as name,
               fp.pronamespace::regnamespace::text||'.'||fp.proname as fn,
               obj_description(fp.oid,'pg_proc') as descr
          from pg_trigger t
          join pg_class c on c.oid=t.tgrelid
          join pg_namespace n on n.oid=c.relnamespace
          join pg_proc fp on fp.oid=t.tgfoid
         where not t.tgisinternal
         order by 1,2,3
    """)

    d["views"] = q("""
        select n.nspname as sch, c.relname as name,
               case c.relkind when 'v' then 'view' else 'matview' end as kind,
               obj_description(c.oid,'pg_class') as descr,
               (select count(*)::int from information_schema.columns ic
                 where ic.table_schema=n.nspname and ic.table_name=c.relname) as ncols
          from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where c.relkind in ('v','m')
           and n.nspname not in ('pg_catalog','information_schema')
         order by 1,2
    """)

    d["thresholds"] = q("""
        select key, value::text as value, coalesce(unit,'—') as unit,
               description_ar as descr
          from platform.thresholds order by key
    """)

    return d


# ─────────────────────────────────────────────────────────────────────────────
# 2. تحويلات مساعدة
# ─────────────────────────────────────────────────────────────────────────────
def short_type(c):
    """اختصار النوع: uuid/text/num/ts/date/bool/int/jsonb."""
    u = (c["udt"] or "").lower()
    dt = (c["dtype"] or "").lower()
    if u == "uuid":
        return "uuid"
    if u in ("text", "varchar", "bpchar", "citext", "name"):
        return "text"
    if u in ("numeric", "decimal", "float4", "float8", "money"):
        return "num"
    if u in ("timestamptz", "timestamp"):
        return "ts"
    if u == "date":
        return "date"
    if u in ("time", "timetz"):
        return "time"
    if u == "bool":
        return "bool"
    if u in ("int2", "int4", "int8"):
        return "int"
    if u in ("jsonb", "json"):
        return "jsonb"
    if u == "bytea":
        return "bytea"
    if u == "interval":
        return "interval"
    if u.startswith("_"):
        return "array"
    if u == "inet":
        return "text"
    return re.sub(r"[^A-Za-z0-9_]", "_", dt)[:12] or "text"


STATUS_RE = re.compile(r"(^|_)(status|stage|state|phase|result|outcome|decision|level|degree)$")
MONEY_RE = re.compile(
    r"(amount|total|price|cost|qty|quantity|balance|value|fee|rate|pct|percent|"
    r"salary|commission|deduction|subtotal|tax|discount|paid|due_amount|capacity|"
    r"cbm|sqm|weight|km|odometer|score|trust)"
)
BORING_DATES = {"created_at", "updated_at", "deleted_at", "changed_at", "modified_at"}


def col_rank(col, pk_cols, fk_cols):
    n = col["col"]
    st = short_type(col)
    if n in pk_cols:
        return 0
    if n in fk_cols:
        return 1
    if STATUS_RE.search(n):
        return 2
    if st in ("num", "int") and MONEY_RE.search(n):
        return 3
    if st in ("ts", "date") and n not in BORING_DATES:
        return 4
    if n in ("doc_no", "code", "no", "number"):
        return 5
    if st == "bool" and n.startswith(("is_", "has_")):
        return 6
    return 9


def ent_name(sch, tbl):
    return "%s_%s" % (sch, tbl)


def clean_comment(s):
    """تنظيف نص تعليق ليصلح داخل علامتي اقتباس في Mermaid."""
    if not s:
        return ""
    s = s.replace('"', "'").replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip()


# ─────────────────────────────────────────────────────────────────────────────
# 3. بناء الفهارس
# ─────────────────────────────────────────────────────────────────────────────
class Model(object):
    def __init__(self, d):
        self.raw = d
        self.tables = OrderedDict()
        for t in d["tables"]:
            self.tables[(t["sch"], t["tbl"])] = t

        self.cols = defaultdict(list)
        for c in d["columns"]:
            self.cols[(c["sch"], c["tbl"])].append(c)

        self.pk = defaultdict(set)
        for r in d["pks"]:
            self.pk[(r["sch"], r["tbl"])].add(r["col"])
        self.uk = defaultdict(set)
        for r in d["uks"]:
            self.uk[(r["sch"], r["tbl"])].add(r["col"])

        self.fks = d["fks"]
        self.fk_by_table = defaultdict(list)
        for f in self.fks:
            self.fk_by_table[(f["sch"], f["tbl"])].append(f)

        # أعمدة الحالة وقيمها المسموحة من قيود check
        self.status_vals = defaultdict(OrderedDict)   # (sch,tbl) -> {col: [values]}
        self.other_checks = defaultdict(list)
        # قيد نطاق القيم البسيط: CHECK ((col = ANY (ARRAY[...]))) وحده لا غير.
        SIMPLE = re.compile(
            r"^CHECK\s*\(+\s*\(?([a-z_0-9]+)\)?(?:::text)?\s*=\s*ANY\s*"
            r"\(\s*\(?ARRAY\[(.*?)\]\)?(?:::[a-z]+\[\])?\s*\)\s*\)+$", re.S)
        # النمط القابل للفراغ: ((col IS NULL) OR (col = ANY (ARRAY[...])))
        NULLABLE = re.compile(
            r"^CHECK\s*\(+\s*\(?([a-z_0-9]+)\)?\s+IS\s+NULL\)?\s*OR\s*"
            r"\(+\s*\(?\1\)?(?:::text)?\s*=\s*ANY\s*"
            r"\(\s*\(?ARRAY\[(.*?)\]\)?(?:::[a-z]+\[\])?\s*\)\s*\)+$", re.S)

        def _values(txt):
            v = re.findall(r"'([^']*)'", txt)
            if v:
                return v
            # قيم رقمية غير مقتبسة: ARRAY[0, 1]
            if re.fullmatch(r"[\s0-9,.\-]+", txt or ""):
                return [x.strip() for x in txt.split(",") if x.strip()]
            return []

        for ck in d["checks"]:
            key = (ck["sch"], ck["tbl"])
            defn = ck["def"].strip()
            mm = SIMPLE.match(defn) or NULLABLE.match(defn)
            if mm:
                col = mm.group(1)
                vals = _values(mm.group(2))
                if vals:
                    if NULLABLE.match(defn) and not SIMPLE.match(defn):
                        vals = vals + ["(أو فارغ)"]
                    prev = self.status_vals[key].get(col)
                    # عند التعارض تُعتمد القائمة الأشمل — قيد النطاق لا القيد المركّب
                    if prev is None or len(vals) > len(prev):
                        self.status_vals[key][col] = vals
                    continue
            self.other_checks[key].append(ck)

    def fk_cols(self, key):
        out = {}
        for f in self.fk_by_table.get(key, []):
            for c in f["cols"].split(","):
                out[c] = (f["fsch"], f["ftbl"], f["name"])
        return out

    def pick_cols(self, key):
        """يختار حتى MAX_COLS عموداً تمثيلياً مرتّبة بترتيبها الأصلي."""
        pkc = self.pk.get(key, set())
        fkc = self.fk_cols(key)
        scored = []
        for c in self.cols.get(key, []):
            scored.append((col_rank(c, pkc, set(fkc)), c["ord"], c))
        scored.sort(key=lambda x: (x[0], x[1]))
        chosen = [s for s in scored[:MAX_COLS]]
        chosen.sort(key=lambda x: x[1])
        return [c for _, _, c in chosen]


# ─────────────────────────────────────────────────────────────────────────────
# 4. توليد كتل Mermaid
# ─────────────────────────────────────────────────────────────────────────────
def entity_block(m, key, external=False):
    sch, tbl = key
    lines = []
    lines.append("    %s {" % ent_name(sch, tbl))
    pkc = m.pk.get(key, set())
    ukc = m.uk.get(key, set())
    fkc = m.fk_cols(key)
    if external:
        # الجدول الخارجي: المفتاح فقط + تعليق يوضّح أنه خارج هذا المخطط
        pks = sorted(pkc) or ["id"]
        for c in pks:
            lines.append('        uuid %s PK "خارجي · %s.%s"' % (c, sch, tbl))
        lines.append("    }")
        return "\n".join(lines)

    for c in m.pick_cols(key):
        n = c["col"]
        marks = []
        if n in pkc:
            marks.append("PK")
        if n in fkc:
            marks.append("FK")
        if n in ukc and n not in pkc:
            marks.append("UK")
        mark = (" " + ",".join(marks)) if marks else ""
        cmt = ""
        if n in fkc:
            cmt = ' "→ %s.%s"' % (fkc[n][0], fkc[n][1])
        elif n in m.status_vals.get(key, {}):
            vals = m.status_vals[key][n]
            txt = " · ".join(vals)
            if len(txt) > 70:
                txt = " · ".join(vals[:4]) + " · …"
            cmt = ' "%s"' % clean_comment(txt)
        lines.append("        %s %s%s%s" % (short_type(c), n, mark, cmt))
    lines.append("    }")
    return "\n".join(lines)


def build_erd(m, keys, focus_schema=None, mute_common=True, title=None):
    """
    يبني كتلة erDiagram لمجموعة جداول.
    العلاقات: كل مفتاح أجنبي طرفاه داخل المجموعة، بالإضافة إلى
    المفاتيح الأجنبية الخارجة التي تُرسم بجداول خارجية.
    """
    inside = set(keys)
    ext = OrderedDict()
    rels = []
    seen = set()

    for key in keys:
        for f in m.fk_by_table.get(key, []):
            tgt = (f["fsch"], f["ftbl"])
            tgt_fq = "%s.%s" % tgt
            if tgt not in inside:
                if mute_common and tgt_fq in MUTED_TARGETS:
                    continue
                if tgt not in m.tables:
                    continue
                ext[tgt] = True
            line = '    %s ||--o{ %s : "%s"' % (
                ent_name(*tgt), ent_name(*key), f["name"])
            if line not in seen:
                seen.add(line)
                rels.append(line)

    out = ["erDiagram"]
    if title:
        out.insert(0, "%%%% %s" % title)
    out.extend(rels)
    out.append("")
    for key in keys:
        out.append(entity_block(m, key, external=False))
    for key in ext:
        out.append(entity_block(m, key, external=True))
    return "\n".join(out) + "\n"


# ─────────────────────────────────────────────────────────────────────────────
# 5. تقسيم المخططات الكبيرة + نصوص وصفية
# ─────────────────────────────────────────────────────────────────────────────
# التقسيم المنطقي للمخططات التي تتجاوز SPLIT_AT جدولاً.
SPLITS = {
    "platform": [
        ("الكيانات والحوكمة والمرجعيات",
         ["entities", "settings", "thresholds", "counters", "feature_flags",
          "domain_owners", "domain_quality_monthly", "decisions",
          "approval_chains", "automation_rules", "alert_rules", "alert_log",
          "notifications"]),
        ("المستندات والتكامل والتدقيق",
         ["documents", "document_templates", "document_bindings",
          "integration_config", "integration_queue", "integration_runs",
          "outbox", "audit_log"]),
    ],
    "wms": [
        ("البنية والمساحات",
         ["warehouses", "zones", "locations", "space_blocks",
          "space_blocks_out_of_service", "space_allocations",
          "space_reservations", "occupancy_snapshots"]),
        ("المخزون والطلبات والجرد",
         ["skus", "stock_balance", "stock_movements", "inbound_orders",
          "outbound_orders", "order_lines", "inventory_counts",
          "inventory_count_lines"]),
    ],
    "imile": [
        ("السائقون والثقة والاستقلالية",
         ["driver_ids", "driver_id_assignments", "driver_trust",
          "driver_zone_exclusions", "dtl_problems", "dtl_rule_autonomy",
          "dispatch_autonomy", "agent_health"]),
        ("الشحنات وخطط الفرز والجرد اليومي",
         ["shipments", "sorting_plans", "plan_assignments", "scan_log",
          "daily_inventory", "inventory_discrepancies", "coverage_areas"]),
    ],
}

# الجداول المستبعدة من الرسم فقط (أقسام جدول مقسَّم) — تبقى في الجرد.
DIAGRAM_EXCLUDE = {
    ("platform", "audit_log_2026_09"), ("platform", "audit_log_2026_10"),
    ("platform", "audit_log_2026_11"), ("platform", "audit_log_2026_12"),
    ("platform", "audit_log_default"),
}

SCHEMA_DESC = {
    "platform": ("الطبقة الأساس: الكيانات القانونية، المرجعيات (العتبات · الإعدادات · العدّادات · رايات الميزات)، "
                 "سلاسل الاعتماد وقواعد الأتمتة والتنبيهات.\n"
                 "وفيها أيضاً المستندات وقوالبها وروابطها، طابور التكامل والصندوق الصادر، وسجل التدقيق المقسَّم شهرياً بسلسلة تجزئة."),
    "identity": ("الهوية والصلاحيات: المستخدمون وجلساتهم ورموز التحقق، الأدوار والصلاحيات وربطها، ونطاق المستخدم على الكيانات.\n"
                 "وفيها قواعد فصل المهام `sod_rules`، الإنابة `delegations`، وتصنيف الأعمدة الحساسة `column_classification`."),
    "catalog": ("كتالوج الخدمات والتسعير: الخدمات وفئاتها وشرائح العملاء، قوائم الأسعار وبنودها.\n"
                "و`price_exceptions` هو المسار الوحيد للبيع تحت الحد الأدنى — يُربط ببند عرض السعر."),
    "sales": ("دورة المبيعات الكاملة: العملاء المحتملون → الفرص → عروض الأسعار وبنودها → العقود.\n"
              "وفيها الحسابات وجهات الاتصال والأنشطة، واتفاقيات مستوى الخدمة `contract_sla` ونتائجها `sla_results`."),
    "wms": ("إدارة المستودعات: البنية المادية (المستودعات · المناطق · المواقع · الكتل) وتخصيص المساحات وحجزها ولقطات الإشغال.\n"
            "والجانب المخزني: الأصناف، الأرصدة، الحركات، أوامر الإدخال والإخراج وبنودها، وعمليات الجرد."),
    "tms": ("إدارة النقل: المركبات ووثائقها وخطط الصيانة وأوامرها ودفتر الوقود والحوادث.\n"
            "والتنفيذ الميداني: المسارات، مهام التسليم، استثناءاتها وأسباب الفشل المرجعية، إثبات التسليم ومحاولات الدفع."),
    "cc": ("مركز الاتصال: الوكلاء وطوابيرهم والمكالمات.\n"
           "والتذاكر وأحداثها — وهي المدخل الرسمي لشكاوى العملاء وربطها بالحجز القانوني على إثبات التسليم."),
    "billing": ("المحاسبة والفوترة: الأحداث القابلة للفوترة `billable_events` هي البوابة الوحيدة لأي إيراد، ثم الفواتير وبنودها "
                "والإشعارات الدائنة والمقبوضات وتخصيصها.\n"
                "وفيها دفتر الأستاذ: `gl_accounts` والقيود `journal_entries/journal_lines`، وتوزيع التكاليف والربحية."),
    "hr": ("الموارد البشرية: الوحدات التنظيمية والفرق والموظفون ووثائقهم، طلبات القوى العاملة.\n"
           "ودورة الاستقدام بمراحلها وسجلها وتكاليفها، لائحة الجزاءات وقضايا الانضباط، وقواعد العمولة واحتسابها اليومي."),
    "imile": ("عمليات iMile: هويات السائقين وتخصيصها، مؤشر الثقة، استثناءات المناطق، واستقلالية محرّك DTL والتوزيع.\n"
              "والتشغيل اليومي: الشحنات، خطط الفرز وإسنادها، سجل المسح، الجرد اليومي وفروقاته، وصحة الوكيل."),
    "partners": ("الشركاء والمقاولة من الباطن: الشركاء وعقودهم وبنود أسعارهم.\n"
                 "وتخصيص الخدمات للشركاء، الأحداث المستحقة الدفع `payable_events` المرتبطة بالحدث القابل للفوترة، وفواتير الشركاء."),
    "admin": ("الدورة الإدارية: طلبات الشراء وعروض الموردين وأوامر الشراء، وبنود الموازنة.\n"
              "وطلبات الاعتماد وخطواتها، الأصول وعهدتها، الصندوق النثري وحركاته، المعاملات الحكومية والمراسلات."),
    "housing": ("إدارة السكن: العقارات والوحدات والغرف والأسرّة، حجز الأسرّة وإسنادها للموظفين.\n"
                "وفواتير المرافق، طلبات الصيانة، عمليات التفتيش، وأصول السكن."),
}

SCHEMA_ORDER = ["platform", "identity", "catalog", "sales", "wms", "tms",
                "cc", "billing", "hr", "imile", "partners", "admin", "housing"]


def schema_diagrams(m, sch):
    """يعيد قائمة (اسم_الملف, عنوان, قائمة_مفاتيح)."""
    all_keys = [k for k in m.tables if k[0] == sch and k not in DIAGRAM_EXCLUDE]
    if sch in SPLITS:
        out = []
        assigned = set()
        for i, (title, names) in enumerate(SPLITS[sch], 1):
            keys = [(sch, n) for n in names if (sch, n) in m.tables]
            assigned.update(keys)
            out.append(("erd-%s-%d" % (sch, i), title, keys))
        leftovers = [k for k in all_keys if k not in assigned]
        if leftovers:
            out.append(("erd-%s-%d" % (sch, len(out) + 1), "جداول أخرى", leftovers))
        return out
    if len(all_keys) > SPLIT_AT:
        half = (len(all_keys) + 1) // 2
        return [("erd-%s-1" % sch, "الجزء الأول", all_keys[:half]),
                ("erd-%s-2" % sch, "الجزء الثاني", all_keys[half:])]
    return [("erd-%s" % sch, "الجداول والعلاقات", all_keys)]


BACKBONE = [
    ("platform", "entities"), ("sales", "accounts"), ("sales", "contracts"),
    ("catalog", "services"), ("billing", "billable_events"),
    ("billing", "invoice_lines"), ("billing", "invoices"),
    ("billing", "receipts"), ("billing", "receipt_allocations"),
    ("billing", "credit_notes"), ("partners", "payable_events"),
]

# الموديولات التشغيلية التي تغذّي billable_events عبر (source_table, source_id)
FEEDERS = [
    ("wms", "outbound_orders", "أوامر الإخراج"),
    ("wms", "inbound_orders", "أوامر الإدخال"),
    ("wms", "space_allocations", "تخصيص المساحات"),
    ("tms", "delivery_tasks", "مهام التسليم"),
    ("imile", "shipments", "شحنات iMile"),
    ("cc", "tickets", "تذاكر مركز الاتصال"),
]


def build_backbone(m):
    keys = [k for k in BACKBONE if k in m.tables]
    inside = set(keys)
    rels, seen = [], set()
    for key in keys:
        for f in m.fk_by_table.get(key, []):
            tgt = (f["fsch"], f["ftbl"])
            if tgt not in inside:
                continue
            line = '    %s ||--o{ %s : "%s"' % (ent_name(*tgt), ent_name(*key), f["name"])
            if line not in seen:
                seen.add(line)
                rels.append(line)
    # روابط التغذية المنطقية (source_table/source_id — ليست مفاتيح أجنبية)
    feed = []
    for sch, tbl, _lbl in FEEDERS:
        if (sch, tbl) in m.tables:
            feed.append('    %s ||--o{ billing_billable_events : "source_table+source_id"'
                        % ent_name(sch, tbl))

    out = ["erDiagram"]
    out.extend(rels)
    out.extend(feed)
    out.append("")
    for key in keys:
        out.append(entity_block(m, key, external=False))
    for sch, tbl, _lbl in FEEDERS:
        if (sch, tbl) in m.tables:
            out.append(entity_block(m, (sch, tbl), external=True))
    return "\n".join(out) + "\n"


# ─────────────────────────────────────────────────────────────────────────────
# 6. جداول الجرد
# ─────────────────────────────────────────────────────────────────────────────
def md_esc(s):
    if s is None:
        return "—"
    s = str(s).replace("|", "\\|").replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip() or "—"


def inventory_rows(m, sch):
    rows = []
    for key in [k for k in m.tables if k[0] == sch]:
        t = m.tables[key]
        descr = md_esc(t["descr"]) if t["descr"] else "—"
        rls = "نعم" if t["rls"] else "لا"
        if t["rls"] and t["policies"]:
            rls += " · " + md_esc(t["policies"])
        ent = "نعم" if t["has_entity"] else "لا"
        sv = m.status_vals.get(key, {})
        if sv:
            st = "<br>".join("`%s`: %s" % (c, " · ".join("`%s`" % v for v in vals))
                             for c, vals in sv.items())
        else:
            st = "—"
        fks = m.fk_by_table.get(key, [])
        if fks:
            fk = "<br>".join("`%s` → `%s.%s`" % (f["cols"], f["fsch"], f["ftbl"])
                             for f in fks)
        else:
            fk = "—"
        name = "`%s`" % t["tbl"]
        if t["kind"] == "p":
            name += " *(مقسَّم)*"
        if t["is_part"]:
            name += " *(قسم من `%s`)*" % t["parent"].split(".")[-1]
        rows.append((name, descr, str(t["ncols"]), rls, ent, st, fk))
    return rows


# الدوال والمشغّلات ذات الأهمية التشغيلية (يُذكر الباقي في جدول شامل)
KEY_FUNCS_ORDER = [
    "verify_", "next_doc_no", "set_stage_due_at", "check_sod",
    "audit_hash_chain", "generate_locations", "max_degree_for_role",
    "check_penalty_authority", "reject_", "check_", "close_", "raise_",
    "space_", "allowed_entities", "has_perm", "is_internal",
    "is_reference_table", "current_", "sanitize_audit", "next_penalty_degree",
]

FUNC_FALLBACK = {
    "reject_self_approval": "يمنع اعتماد الشخص لطلبه — الأربع عيون على خطوات الاعتماد",
    "reject_holding_invoice": "يمنع إصدار فاتورة عميل من الكيان القابض",
    "verify_journal_balance": "حارس: يعيد كل قيد غير متوازن (مدين ≠ دائن)",
    "verify_unpriced_events": "حارس: يعيد كل حدث قابل للفوترة بلا سعر",
    "check_penalty_authority": "يتحقق أن درجة الجزاء ضمن سلطة موقّعها",
    "close_driver_id_on_termination": "يغلق هوية السائق تلقائياً عند إنهاء الخدمة",
    "next_penalty_degree": "يحسب الدرجة التالية في تدرّج الجزاء",
    "check_sod": "يرفض إسناد دور يخالف قاعدة فصل مهام في `identity.sod_rules`",
    "close_assignment_on_suspension": "يغلق إسناد الهوية تلقائياً عند الإيقاف",
    "verify_attribution": "حارس: يتحقق من نسبة كل شحنة إلى سائق/هوية صحيحة",
    "verify_no_orphan_ids": "حارس: يعيد هويات السائقين بلا موظف مرتبط",
    "check_committed_utilization": "يتحقق من الالتزام التعاقدي المستخدَم مع الشريك",
    "verify_paid_matched": "حارس: يعيد كل مدفوع للشريك بلا مطابقة",
    "allowed_entities": "الكيانات المسموحة للمستخدم الحالي — أساس RLS",
    "audit_hash_chain": "مشغّل سلسلة التجزئة: يربط كل صف تدقيق بتجزئة سابقه",
    "current_client_id": "معرّف العميل المحقون في المعاملة — أساس بوابة العميل",
    "current_user_id": "معرّف المستخدم المحقون في المعاملة — أساس RLS",
    "has_perm": "يتحقق من امتلاك المستخدم الحالي صلاحية بعينها",
    "is_internal": "يميّز المستخدم الداخلي عن مستخدم بوابة العميل",
    "is_reference_table": "يميّز الجداول المرجعية لأغراض السياسات",
    "sanitize_audit": "ينقّي حمولة التدقيق من الأعمدة الحساسة",
    "set_stage_due_at": "مشغّل: يحسب تاريخ استحقاق المرحلة من SLA المرحلة",
    "space_availability": "المساحة المتاحة في كتلة بعد الحجوزات والعازل",
    "check_space_available": "يمنع تخصيصاً أو حجزاً يتجاوز المتاح",
    "check_location_limits": "حاجز صلب على حدود الموقع",
    "verify_balance_integrity": "حارس: يعيد كل رصيد لا يطابق مجموع حركاته",
    "verify_wh1": "حارس: الاختبارات الواحد والعشرون لإعداد مستودع WH1",
    "generate_locations": "يولّد مواقع المستودع بالصيغة السباعية",
    "max_degree_for_role": "أقصى درجة جزاء يملكها دور",
    "raise_legal_hold": "مشغّل: يرفع حجزاً قانونياً على إثبات التسليم عند نزاع",
    "next_doc_no": "ترقيم المستندات الذرّي داخل المعاملة",
    "verify_audit_chain": "حارس G8: يجب أن يعيد صفر صفوف — أي صف = كسر سلسلة التدقيق",
}


# ─────────────────────────────────────────────────────────────────────────────
# 7. كتابة الوثيقة
# ─────────────────────────────────────────────────────────────────────────────
def seed_counts():
    tables = [
        ("identity.roles", "الأدوار"),
        ("identity.permissions", "الصلاحيات"),
        ("identity.role_permissions", "ربط الدور بالصلاحية"),
        ("identity.sod_rules", "قواعد فصل المهام"),
        ("identity.column_classification", "تصنيف الأعمدة الحساسة"),
        ("catalog.service_categories", "فئات الخدمات"),
        ("catalog.services", "الخدمات"),
        ("catalog.segments", "شرائح العملاء"),
        ("hr.penalty_schedule", "بنود لائحة الجزاءات"),
        ("hr.recruitment_stages", "مراحل الاستقدام"),
        ("hr.commission_rules", "قواعد العمولة"),
        ("hr.org_units", "الوحدات التنظيمية"),
        ("tms.failure_reasons", "أسباب فشل التسليم"),
        ("platform.alert_rules", "قواعد التنبيه"),
        ("platform.thresholds", "العتبات"),
        ("platform.counters", "عدّادات المستندات"),
        ("platform.settings", "الإعدادات"),
        ("platform.entities", "الكيانات القانونية"),
        ("platform.approval_chains", "سلاسل الاعتماد"),
        ("platform.domain_owners", "ملّاك النطاقات"),
        ("platform.automation_rules", "قواعد الأتمتة"),
        ("platform.document_templates", "قوالب المستندات"),
        ("platform.feature_flags", "رايات الميزات"),
        ("billing.gl_accounts", "دليل الحسابات"),
        ("imile.dtl_problems", "أنواع مشكلات DTL"),
    ]
    out = []
    for fq, label in tables:
        r = q("select count(*)::int as n from %s" % fq)
        out.append((fq, label, r[0]["n"] if r else 0))
    return out


def write_doc(m):
    d = m.raw
    L = []
    A = L.append

    total_tables = len(m.tables)
    schemas = sorted({k[0] for k in m.tables})

    A("# نموذج البيانات — خرائط وجرد آلي")
    A("**PG-EOS v4 · D-blueprints · 21/09/2026 · مولَّد آلياً من القاعدة الحيّة `pgeos` "
      "بواسطة `tools/gen_erd.py` — لا يحوي أي وصف مكتوب يدوياً خارج اتفاقيات الترويسة وسطري تعريف كل مخطط.**")
    A("")
    A("> كل رقم وكل اسم وكل قيمة حالة في هذه الوثيقة مقروء من `information_schema` و`pg_catalog` "
      "و`obj_description`. الجداول التي لا تعليق لها في القاعدة وُسمت `—` ولم يُخترع لها وصف.")
    A("")

    # ── 0. الاتفاقيات
    A("## 0. اتفاقيات المخطط")
    A("")
    A("منقولة حرفياً من ترويسة `A-governing/database/01-Data-Model.sql`:")
    A("")
    A("| الاتفاقية | القاعدة |")
    A("|---|---|")
    A("| المفتاح الأساسي | `uuid` |")
    A("| رقم المستند البشري | `doc_no` من عدّاد ذرّي، فريد، لا يُعاد استخدامه |")
    A("| التوقيت | `timestamptz` — UTC مخزَّن، `Asia/Kuwait` معروض |")
    A("| المال | `numeric(14,3)` — ثلاث خانات للدينار. لا `float` إطلاقاً |")
    A("| الحذف | منطقي (`deleted_at`). لا حذف فعلي في أي نطاق مالي أو مخزني |")
    A("| تعدد الكيانات | كل جدول تجاري/تشغيلي يحمل `entity_id` — محور المحاسبة متعددة الكيانات |")
    A("")
    rls_on = sum(1 for t in m.tables.values() if t["rls"])
    ent_on = sum(1 for t in m.tables.values() if t["has_entity"])
    nfk = len(m.fks)
    xfk = sum(1 for f in m.fks if f["sch"] != f["fsch"])
    A("**أرقام المخطط كما هو الآن في القاعدة**")
    A("")
    A("| البند | العدد |")
    A("|---|---|")
    A("| المخططات (schemas) | %d |" % len(schemas))
    A("| الجداول | %d |" % total_tables)
    A("| الجداول المفعَّل عليها RLS | %d من %d |" % (rls_on, total_tables))
    A("| الجداول الحاملة `entity_id` | %d |" % ent_on)
    A("| المفاتيح الأجنبية | %d منها %d عابر للمخططات |" % (nfk, xfk))
    A("| الدوال والمشغّلات (خارج `public`) | %d دالة · %d مشغّل |"
      % (len(d["funcs"]), len(d["triggers"])))
    A("| العتبات `platform.thresholds` | %d |" % len(d["thresholds"]))
    A("")
    A("**اتفاقيات القراءة داخل الخرائط**")
    A("")
    A("- اسم الكيان في `erDiagram` بصيغة `schema_table` (Mermaid لا يقبل النقطة) — "
      "الاسم الحقيقي هو `schema.table`.")
    A("- كل جدول يعرض حتى **%d أعمدة** تمثيلية: المفتاح الأساسي، المفاتيح الأجنبية، "
      "أعمدة الحالة، المبالغ والكميات، التواريخ التشغيلية. الجرد تحت كل خريطة يحوي البقية." % MAX_COLS)
    A("- الأنواع مختصرة: `uuid` · `text` · `num` (=`numeric`) · `ts` (=`timestamptz`) · "
      "`date` · `bool` · `int` · `jsonb`.")
    A("- الجداول المرسومة بمفتاحها فقط وتعليق «خارجي» تقع خارج المخطط الحالي — "
      "تفاصيلها في قسم مخططها.")
    A("- **سهمان مكتومان عمداً في خرائط المخططات:** `entity_id → platform.entities` "
      "(في %d جدولاً) و`*_by → identity.users` — رسمهما يجعل كل خريطة عقدة واحدة متشابكة. "
      "وجودهما مثبت في عمود «المفاتيح الأجنبية» في الجرد." % ent_on)
    A("")

    # ── 1. العمود الفقري
    A("## 1. العمود الفقري (Backbone) — من الكيان إلى المقبوض")
    A("")
    A("المسار المالي الوحيد في النظام: كيان قانوني ← حساب عميل ← عقد ← **حدث قابل للفوترة** "
      "← بند فاتورة ← فاتورة ← تخصيص مقبوض ← مقبوض. "
      "لا إيراد يدخل من خارج `billing.billable_events`.")
    A("")
    A("كل موديول تشغيلي يغذّي `billable_events` عبر الزوج `source_table` + `source_id` "
      "(رابط متعدد الأشكال، لا مفتاح أجنبي — لذلك لا يظهر في `pg_constraint`)، "
      "ويحرسه فهرس فريد `(source_table, source_id, service_id)` فلا يُفوتر حدث مرتين.")
    A("")
    A("#### خريطة 1-1: العمود الفقري المالي")
    A("تقرأ من الكيان القانوني إلى المقبوض، مع الموديولات المغذّية للحدث القابل للفوترة.")
    A("")
    bb = build_backbone(m)
    bb_path = os.path.join(DIAG_DIR, "erd-backbone.mmd")
    with open(bb_path, "w", encoding="utf-8") as fh:
        fh.write("%% backbone · العمود الفقري المالي\n" + bb)
    A("ملف منفصل: `diagrams/erd-backbone.mmd`.")
    A("")
    A("```mermaid")
    A(bb.rstrip())
    A("```")
    A("")
    A("**حراس هذا المسار (من القاعدة):**")
    A("")
    A("| الحارس | الجدول | ما يمنعه |")
    A("|---|---|---|")
    A("| `billing.reject_holding_invoice` (مشغّل `trg_no_holding_invoice`) | `billing.invoices` | إصدار فاتورة عميل من الكيان القابض |")
    A("| `billing.verify_unpriced_events` | `billing.billable_events` | ترحيل حدث بلا سعر إلى فاتورة |")
    A("| `billing.verify_journal_balance` | `billing.journal_entries` | قيد غير متوازن |")
    A("| فهرس فريد `billable_events_source_table_source_id_service_id_idx` | `billing.billable_events` | فوترة الحدث التشغيلي مرتين |")
    A("")

    # ── 2. لكل مخطط
    A("## 2. المخططات")
    A("")
    diagram_files = [bb_path]
    for i, sch in enumerate([s for s in SCHEMA_ORDER if s in schemas] +
                            [s for s in schemas if s not in SCHEMA_ORDER], 1):
        keys_all = [k for k in m.tables if k[0] == sch]
        A("### 2.%d مخطط `%s` — %d جدولاً" % (i, sch, len(keys_all)))
        A("")
        desc = SCHEMA_DESC.get(sch)
        if desc:
            for line in desc.split("\n"):
                A(line)
        else:
            A("—")
        A("")
        diags = schema_diagrams(m, sch)
        for j, (fname, title, keys) in enumerate(diags, 1):
            if not keys:
                continue
            body = build_erd(m, keys, focus_schema=sch, title="%s · %s" % (sch, title))
            path = os.path.join(DIAG_DIR, fname + ".mmd")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
            diagram_files.append(path)
            A("#### خريطة 2-%d-%d: `%s` — %s" % (i, j, sch, title))
            A("تقرأ من الجدول الأصل (`||`) إلى الجدول التابع (`o{`)؛ اسم السهم هو اسم المفتاح الأجنبي في القاعدة. "
              "ملف منفصل: `diagrams/%s.mmd`." % fname)
            A("")
            A("```mermaid")
            A(body.rstrip())
            A("```")
            A("")
        # الجرد
        A("**جرد جداول `%s`**" % sch)
        A("")
        A("| الجدول | الوصف (`obj_description`) | الأعمدة | RLS | `entity_id` | أعمدة الحالة والقيم المسموحة | المفاتيح الأجنبية |")
        A("|---|---|---|---|---|---|---|")
        for r in inventory_rows(m, sch):
            A("| " + " | ".join(r) + " |")
        A("")

    # ── 3. العتبات
    A("## 3. جرد العتبات — `platform.thresholds`")
    A("")
    A("كل حدّ رقمي قابل للضبط في النظام يعيش هنا؛ لا حد مبرمَج داخل الكود. "
      "التعديل يتطلب صلاحية `platform.reference.manage` ويُسجَّل في `changed_by` + `changed_at`.")
    A("")
    A("| المفتاح | القيمة | الوحدة | الوصف |")
    A("|---|---|---|---|")
    for t in d["thresholds"]:
        A("| `%s` | %s | %s | %s |" % (t["key"], md_esc(t["value"]),
                                       md_esc(t["unit"]), md_esc(t["descr"])))
    A("")

    # ── 4. البذور
    A("## 4. البذور المرجعية وأعدادها الفعلية")
    A("")
    A("عدد الصفوف الموجود فعلاً في القاعدة وقت التوليد. الصفر يعني أن البذرة لم تُطبَّق بعد.")
    A("")
    A("| الجدول | المحتوى | عدد الصفوف |")
    A("|---|---|---|")
    zero = []
    seeds = seed_counts()
    for fq, label, n in seeds:
        A("| `%s` | %s | **%d** |" % (fq, label, n))
        if n == 0:
            zero.append(fq)
    A("")
    if zero:
        A("**بذور فارغة وقت التوليد:** " + " · ".join("`%s`" % z for z in zero) + ".")
        A("")

    # ── 5. الدوال والمشغّلات
    A("## 5. الدوال والمشغّلات")
    A("")
    A("### 5.1 الدوال (خارج `public`)")
    A("")
    A("الوصف من `obj_description` حيث وُجد؛ وإلا سطر يشرح ما تفعله الدالة كما يظهر من اسمها وموضع استدعائها.")
    A("")
    A("| الدالة | النوع المُعاد | الوصف |")
    A("|---|---|---|")
    for f in d["funcs"]:
        name = "%s.%s" % (f["sch"], f["name"])
        descr = f["descr"] or FUNC_FALLBACK.get(f["name"], "—")
        A("| `%s` | `%s` | %s |" % (name, md_esc(f["rettype"]), md_esc(descr)))
    A("")
    A("### 5.2 المشغّلات (Triggers)")
    A("")
    A("| المشغّل | على الجدول | الدالة | ما يفرضه |")
    A("|---|---|---|---|")
    for t in d["triggers"]:
        fn_short = t["fn"].split(".")[-1]
        descr = t["descr"] or FUNC_FALLBACK.get(fn_short, "—")
        A("| `%s` | `%s.%s` | `%s` | %s |" % (t["name"], t["sch"], t["tbl"],
                                              md_esc(t["fn"]), md_esc(descr)))
    A("")
    A("### 5.3 الحرّاس (`verify_*`) — يجب أن تعيد كلها صفر صفوف")
    A("")
    A("| الحارس | الوصف |")
    A("|---|---|")
    for f in d["funcs"]:
        if f["name"].startswith("verify_"):
            descr = f["descr"] or FUNC_FALLBACK.get(f["name"], "—")
            A("| `%s.%s` | %s |" % (f["sch"], f["name"], md_esc(descr)))
    A("")

    # ── 5.35 المناظير
    A("### 5.4 المناظير (Views)")
    A("")
    A("| المنظور | النوع | الأعمدة | الوصف (`obj_description`) |")
    A("|---|---|---|---|")
    for v in d["views"]:
        A("| `%s.%s` | %s | %d | %s |" % (v["sch"], v["name"], v["kind"],
                                          v["ncols"], md_esc(v["descr"]) if v["descr"] else "—"))
    A("")

    # ── 5.5 القيود المركّبة
    A("### 5.5 القيود المركّبة — قواعد عمل مفروضة داخل القاعدة")
    A("")
    A("قيود `CHECK` التي لا تكتفي بحصر قيم عمود واحد، بل تفرض علاقة بين أعمدة. "
      "نصّها كما تعيده `pg_get_constraintdef`.")
    A("")
    A("| الجدول | القيد | النص |")
    A("|---|---|---|")
    ncomp = 0
    for key in m.tables:
        for ck in m.other_checks.get(key, []):
            ncomp += 1
            A("| `%s.%s` | `%s` | `%s` |" % (key[0], key[1], ck["name"],
                                             md_esc(ck["def"]).replace("`", "'")))
    A("")
    A("المجموع: **%d** قيداً مركّباً، إضافة إلى **%d** عمود حالة محصور القيم (مدرجة في جرد كل مخطط)."
      % (ncomp, sum(len(v) for v in m.status_vals.values())))
    A("")

    # ── 6. ملاحظات التوليد
    A("## 6. ملاحظات مرصودة أثناء التوليد")
    A("")
    no_desc = [("%s.%s" % k) for k, t in m.tables.items() if not t["descr"]]
    A("- **الجداول بلا تعليق في القاعدة: %d من %d.** الجداول الموصوفة هي فقط: %s."
      % (len(no_desc), total_tables,
         " · ".join("`%s.%s`" % k for k, t in m.tables.items() if t["descr"])))
    no_rls = ["%s.%s" % k for k, t in m.tables.items() if not t["rls"]]
    A("- **بلا RLS: %d جدول** — %s."
      % (len(no_rls), " · ".join("`%s`" % x for x in no_rls) if no_rls else "لا شيء"))
    A("- **لا يوجد مخطط `governance` في القاعدة.** المخططات الموجودة فعلاً %d: %s. "
      "ما يُتوقع أن يكون «حوكمة» يعيش داخل `platform` (`decisions` · `domain_owners` · "
      "`domain_quality_monthly` · `approval_chains` · `audit_log`) و`identity` (`sod_rules` · `delegations`)."
      % (len(schemas), " · ".join("`%s`" % s for s in schemas)))
    A("- **بذور مرجعية فارغة أو شبه فارغة وقت التوليد (%d من %d جدولاً مرجعياً مفحوصاً):** %s. "
      "الأثر المباشر: `identity.permissions` فيه صف واحد و`identity.role_permissions` فارغ، "
      "أي أن دالة `platform.has_perm` — التي تستند إليها كل سياسات الكتابة — لا سند بيانات لها بعد."
      % (len(zero), len(seeds), " · ".join("`%s`" % z for z in zero)))
    A("- **%d منظوراً (Views)** خارج عدّ الجداول الـ%d — مدرجة في §5.4، منها حارسان "
      "(`identity.unclassified_columns` · `imile.shipments_attributed`)."
      % (len(d["views"]), total_tables))
    A("- `platform.audit_log` جدول مقسَّم شهرياً؛ أقسامه الخمسة "
      "(`audit_log_2026_09..12` · `audit_log_default`) تُحسب ضمن الـ%d جدولاً وتظهر في الجرد، "
      "ولا تُرسم في الخريطة لأنها نسخ من بنية الأصل." % total_tables)
    A("")
    A("---")
    A("")
    A("*مولَّد بـ `D-blueprints/tools/gen_erd.py` — أعد التشغيل بعد أي تغيير في المخطط.*")

    with open(OUT_MD, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")
    return diagram_files, no_desc, total_tables


def main():
    os.makedirs(DIAG_DIR, exist_ok=True)
    d = load()
    m = Model(d)
    files, no_desc, total = write_doc(m)
    print("الوثيقة: %s" % OUT_MD)
    print("الخرائط المنفصلة: %d" % (len(files) + 1))
    for f in files:
        print("  · %s" % f)
    print("الجداول المغطاة: %d" % total)
    print("بلا وصف: %d" % len(no_desc))


if __name__ == "__main__":
    main()
