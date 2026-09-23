#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# PG-EOS · apply.sh — تطبيق المخطط الكامل ثم تشغيل الحراسة
# الإصدار 4.0 · 21/09/2026 · المصدر: 40-Build-Specification-EN.md Part I
#
#   01 → 13 → 13B → 019   ثم   ../migrations/*.sql   بـ -v ON_ERROR_STOP=1
#   ثم   guards.sql
#   «No database object exists outside them.» (40 Part I)
#   الهجرات الأمامية (database/migrations/NNNN_<lane>_<slug>.sql) تُطبَّق بعد
#   ملفات الأساس بترتيب الرقم (sort -V)، وهي جزء من المخطط لا من الحراسة:
#   --no-guards لا يعطّلها. لا هجرات؟ تُتخطّى الخطوة بصمت.
#
#   ⚠️ WBS 0.15: كل ملف يُطبَّق عبر إعادة توجيه stdin (`psql ... < file`)، لا
#   عبر `-f file`. الحقيقة المؤكَّدة، لا التفسير: في جلسة عمل واحدة معيَّنة على
#   هذا الجهاز (psql 16.15، Windows)، أُعيد إنتاج نفس النتيجة أربع مرات متتالية
#   بقواعد بيانات فارغة جديدة في كل مرة: `psql -f 01-Data-Model.sql` يُنتج
#   `platform.entities.name_ar='PCC'` تالفاً («ط¨ط±ظٹظ…ظٹظˆظ… CC» بدل «بريميوم
#   CC»، مؤكَّد على مستوى البايت عبر عميل pg لا عبر عرض طرفية psql)، بينما
#   `psql < 01-Data-Model.sql` على نفس الملف يُنتج القيمة الصحيحة — نفس القاعدة
#   الفارغة حديثاً، نفس متغيرات PG*. أُعيد الاختبار أيضاً بعد تثبيت ترميز الطرفية
#   على 65001 (UTF-8) صراحة؛ استمر التلف — فالسبب ليس ترميز الطرفية النشط وحده.
#   **لم يُحسَم السبب الجذري.** مراجعة مستقلة (pg-reviewer) على جلسة عمل أخرى
#   على نفس الجهاز **لم تستطع** إعادة إنتاج التلف بنفس الاستدعاء الحرفي — ما
#   يرجّح أن الشرط المُطلِق بيئي دقيق (نسخة/مسار psql.exe المحدَّد فعلياً، أو
#   حالة طرفية/console لهذه الجلسة تحديداً) لا خللاً عاماً في psql على وندوز.
#   القرار: الإبقاء على stdin كإجراء احترازي مُتحقَّق منه في بيئة العمل الفعلية
#   لهذه الجلسات — صفر أثر جانبي وظيفي (كل الحرّاس وكل مجموعات اختبارات
#   0.9-0.12 ما زالت خضراء بعده)، بثمن معروف ومقبول: رسائل خطأ psql تفقد اسم
#   الملف/رقم السطر الدقيقين (raw stdin لا `-f` نفسه). لتشخيص خطأ نحوي في ملف
#   معيَّن يدوياً، شغِّل `psql -f <file>` مباشرة لأغراض التشخيص فقط، لا للتطبيق
#   الفعلي. لا تُرجع أياً من استدعاءات psql هنا إلى `-f` كإجراء تطبيق افتراضي
#   دون إعادة اختبار هذا مباشرة على الجهاز الذي سيُشغَّل عليه.
#
# الاستعمال:
#   ./apply.sh                          # على PGDATABASE أو pgeos
#   PGDATABASE=pgeos_test ./apply.sh
#   PGHOST=/tmp/pgsock PGPORT=5433 PGUSER=postgres PGDATABASE=pgeos ./apply.sh
#   ./apply.sh --recreate               # dropdb + createdb (UTF8 · ctype C.UTF-8 · collate C — SCR-TRGM-01) قبل التطبيق
#   ./apply.sh --no-guards              # تطبيق بلا حراسة
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PGHOST="${PGHOST:-/var/run/postgresql}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-pgeos}"
# SCR-TRGM-01 (قرار GM 23/09/2026، الخيار A): تصنيف الحروف UTF-8 كي تُولِّد pg_trgm trigrams للعربية
# (تحت ctype = C تُهمَل كل الحروف العربية وsimilarity() = 0)، والترتيب يبقى C كما كان.
readonly PG_LC_CTYPE="C.UTF-8"
readonly PG_LC_COLLATE="C"
# إخفاء NOTICE («المشغّل غير موجود، تخطٍّ») — التحذيرات والأخطاء تبقى ظاهرة
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

RECREATE=0
RUN_GUARDS=1
for arg in "$@"; do
  case "$arg" in
    --recreate)  RECREATE=1 ;;
    --no-guards) RUN_GUARDS=0 ;;
    -h|--help)   sed -n '2,11p;33,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "خيار غير معروف: $arg" >&2; exit 2 ;;
  esac
done

FILES=(
  "01-Data-Model.sql"
  "13-Schema-Additions.sql"
  "13B-Schema-Reference-Consolidation.sql"
  "019-Warehouse-WH1-Setup.sql"
)

echo "═══════════════════════════════════════════════════════════════"
echo " PG-EOS · تطبيق المخطط"
echo " الخادم : ${PGHOST}:${PGPORT}   القاعدة: ${PGDATABASE}   المستخدم: ${PGUSER}"
echo "═══════════════════════════════════════════════════════════════"

for f in "${FILES[@]}"; do
  [[ -f "$DIR/$f" ]] || { echo "✗ ملف مفقود: $DIR/$f" >&2; exit 1; }
done

if [[ "$RECREATE" -eq 1 ]]; then
  echo "→ إعادة إنشاء القاعدة ${PGDATABASE} …"
  dropdb --if-exists "$PGDATABASE"
  createdb -T template0 -E UTF8 --lc-collate="$PG_LC_COLLATE" --lc-ctype="$PG_LC_CTYPE" "$PGDATABASE"
fi

# SCR-TRGM-01: قاعدة منشأة بغير هذا الإعداد تُرفض — الـctype لا يتغيّر إلا بإعادة الإنشاء (--recreate).
DB_LOCALE="$(psql -d "$PGDATABASE" -Atqc "select datctype || '|' || datcollate from pg_database where datname = current_database()")"
if [[ "$DB_LOCALE" != "${PG_LC_CTYPE}|${PG_LC_COLLATE}" ]]; then
  echo "✗ القاعدة ${PGDATABASE} منشأة بـ ctype|collate = ${DB_LOCALE} والمطلوب ${PG_LC_CTYPE}|${PG_LC_COLLATE} (SCR-TRGM-01) — أعد التشغيل بـ --recreate." >&2
  exit 1
fi

step=0
for f in "${FILES[@]}"; do
  step=$((step + 1))
  printf '→ [%d/%d] %s … ' "$step" "${#FILES[@]}" "$f"
  if psql -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q < "$DIR/$f" > /dev/null; then
    echo "تم"
  else
    echo "فشل"
    echo "✗ توقف التطبيق عند $f — لا تكمل. راجع الخطأ أعلاه." >&2
    exit 1
  fi
done

# الهجرات الأمامية — database/migrations/NNNN_<lane>_<slug>.sql بترتيب الرقم.
# لا ملفات .sql؟ تُتخطّى الخطوة بلا ترويسة ولا خطأ.
MIG_DIR="$(dirname "$DIR")/migrations"
MIGRATIONS=()
while IFS= read -r m; do
  [[ -n "$m" ]] && MIGRATIONS+=("$m")
done < <(for p in "$MIG_DIR"/*.sql; do [[ -f "$p" ]] && basename "$p"; done | sort -V)

if [[ "${#MIGRATIONS[@]}" -gt 0 ]]; then
  echo
  echo "───────────────────────────────────────────────────────────────"
  echo " الهجرات الأمامية (database/migrations)"
  echo "───────────────────────────────────────────────────────────────"
  step=0
  for m in "${MIGRATIONS[@]}"; do
    step=$((step + 1))
    printf '→ [%d/%d] %s … ' "$step" "${#MIGRATIONS[@]}" "$m"
    if psql -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q < "$MIG_DIR/$m" > /dev/null; then
      echo "تم"
    else
      echo "فشل"
      echo "✗ توقف التطبيق عند الهجرة $m — لا تكمل. راجع الخطأ أعلاه." >&2
      exit 1
    fi
  done
fi

q() { psql -d "$PGDATABASE" -At -c "$1"; }

echo
echo "───────────────────────────────────────────────────────────────"
echo " ملخّص المخطط"
echo "───────────────────────────────────────────────────────────────"
printf '  الجداول           : %s\n' "$(q "select count(*) from information_schema.tables where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')")"
printf '  المواقع (WH1)     : %s   (المتوقع 3330)\n' "$(q "select count(*) from wms.locations")"
printf '  كتل المساحة       : %s   (المتوقع 8)\n'    "$(q "select count(*) from wms.space_blocks")"
printf '  مناطق المستودع    : %s   (المتوقع 11)\n'   "$(q "select count(*) from wms.zones")"
printf '  الأدوار           : %s   (المتوقع 26)\n'   "$(q "select count(*) from identity.roles")"
printf '  قواعد فصل المهام  : %s   (المتوقع 4)\n'    "$(q "select count(*) from identity.sod_rules")"
printf '  الخدمات           : %s   (المتوقع 92)\n'   "$(q "select count(*) from catalog.services")"
printf '  لائحة الجزاءات    : %s   (المتوقع 77)\n'   "$(q "select count(*) from hr.penalty_schedule")"
printf '  مراحل الاستقدام   : %s   (المتوقع 17)\n'   "$(q "select count(*) from hr.recruitment_stages")"
printf '  أسباب الفشل       : %s   (المتوقع 32)\n'   "$(q "select count(*) from tms.failure_reasons")"
printf '  قواعد التنبيه     : %s   (المتوقع 22)\n'   "$(q "select count(*) from platform.alert_rules")"
printf '  العتبات           : %s\n'                  "$(q "select count(*) from platform.thresholds")"

SEED_GAPS="$(q "select count(*) from (
  select 77 as e,(select count(*) from hr.penalty_schedule) a
  union all select 92,(select count(*) from catalog.services)
  union all select 17,(select count(*) from hr.recruitment_stages)
  union all select 32,(select count(*) from tms.failure_reasons)
  union all select 22,(select count(*) from platform.alert_rules)
  union all select 26,(select count(*) from identity.roles)
  union all select  4,(select count(*) from identity.sod_rules)
) t where a <> e")"
if [[ "$SEED_GAPS" == "0" ]]; then
  echo "  ✓ كل البذور المرجعية مكتملة بأعدادها المنصوصة."
else
  echo "  ⚠ $SEED_GAPS بذرة عددها يخالف المنصوص (تقرير فقط — انظر G-SEED في guards.sql)."
fi

echo
echo "───────────────────────────────────────────────────────────────"
echo " اختبارات مخزن WH1 (19 §3-4)"
echo "───────────────────────────────────────────────────────────────"
psql -d "$PGDATABASE" -c "select check_name, expected, actual, passed from wms.verify_wh1() order by passed, check_name"
WH1_OK="$(q "select bool_and(passed) from wms.verify_wh1()")"
if [[ "$WH1_OK" != "t" ]]; then
  echo "✗ فشل اختبار أو أكثر من اختبارات WH1 — يوقف النشر." >&2
  exit 1
fi
echo "✓ كل اختبارات WH1 تمر."

if [[ "$RUN_GUARDS" -eq 1 ]]; then
  echo
  echo "───────────────────────────────────────────────────────────────"
  echo " الحراسة G1–G13 + G18 (40 Part F)"
  echo "───────────────────────────────────────────────────────────────"
  psql -d "$PGDATABASE" -v ON_ERROR_STOP=1 < "$DIR/guards.sql"

  echo
  echo "  عدّ الحرّاس الحمر (G1–G13 مانعة · G18 تقرير فقط):"
  for g in \
    "G1|select count(*) from wms.verify_balance_integrity()" \
    "G2|select count(*) from billing.verify_journal_balance()" \
    "G3|select count(*) from imile.verify_attribution(current_date - 30, current_date)" \
    "G4|select count(*) from imile.verify_no_orphan_ids()" \
    "G5|select count(*) from partners.verify_paid_matched()" \
    "G6|select count(*) from identity.unclassified_columns" \
    "G7|select (select count(*) from pg_class t join pg_namespace n on n.oid=t.relnamespace where t.relkind in ('r','p') and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and not t.relrowsecurity) + (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where p.polname='entity_scope' and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and p.polwithcheck is null) + (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='v' and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and not (coalesce(c.reloptions, array[]::text[]) @> array['security_invoker=true']) and has_table_privilege('pgeos_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) + (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind='r' and c.relispartition and n.nspname in ('platform','identity','catalog','sales','wms','tms','cc','billing','hr','partners','admin','housing','imile','governance') and has_table_privilege('pgeos_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))" \
    "G8|select count(*) from platform.verify_audit_chain()" \
    "G9|with w as (select * from platform.outbox order by id desc limit 1000) select count(*) from w where not exists (select 1 from platform.audit_log a where a.correlation_id = w.correlation_id)" \
    "G10|select count(*) from platform.audit_log where operation in ('reject','void','override') and (reason is null or btrim(reason)='')" \
    "G11|select count(*) from billing.invoice_lines l where not exists (select 1 from billing.billable_events e where e.invoice_line_id = l.id)" \
    "G12|select count(*) from tms.delivery_tasks t where t.status='delivered' and not exists (select 1 from tms.proof_of_delivery p where p.task_id = t.id)" \
    "G18|select count(*) from billing.verify_unpriced_events()"
  do
    name="${g%%|*}"; sql="${g#*|}"
    n="$(q "$sql")"
    if [[ "$n" == "0" ]]; then
      printf '    %-4s %s ✓\n' "$name" "$n"
    elif [[ "$name" == "G18" ]]; then
      printf '    %-4s %s  (غير مانع — تقرير فقط)\n' "$name" "$n"
    else
      printf '    %-4s %s ✗ يوقف النشر\n' "$name" "$n"
    fi
  done
  echo
  echo "  G13: $(q "select count(distinct n) from (select platform.next_doc_no((select id from platform.entities where code='PST'),'INV','ALL') as n from generate_series(1,100)) s") رقماً فريداً من 100 (المتوقع 100)"
  echo "  G14 خارج SQL ويشغّله pnpm guards:run (tests/isolation، WBS 0.18) · G15–G17 لم تُشغَّل بعد: playwright · stryker · test:trace"
fi

echo
echo "═══════════════════════════════════════════════════════════════"
echo " تم."
echo "═══════════════════════════════════════════════════════════════"
