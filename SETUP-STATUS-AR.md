# حالة إعداد المستودع — PG-EOS (بالعربية)
**21 سبتمبر 2026 · هذا المجلد هو جذر مستودع التنفيذ**

## ما أُضيف اليوم (ردّاً على تقرير `/resume`)
| ما أبلغ عنه `/resume` أنه مفقود | أين أصبح | ملاحظة |
|---|---|---|
| `docs/package/` (38-WBS · 40 · EXECUTION-MASTER-v4 · D-blueprints) | `docs/package/` — الحزمة v4 كاملة: 9 وثائق حاكمة + 26 مرجعية + 3 وثائق الغلاف + `tools/` + `D-blueprints/` (16 وثيقة + 172 خريطة مصدر + 153 SVG) | صور PNG حُذفت لتخفيف المستودع؛ SVG كافية |
| `database/schema/` (01 · 13 · 13B · 019 · guards.sql · apply.sh) | `database/schema/` | المخطط الوحيد المسموح؛ `apply.sh --recreate` لم يُشغَّل بعد على جهازك (يحتاج Docker + psql) |
| `tasks/MASTER_BACKLOG.md` | مولَّد من الوثيقة 38 بـ`scripts/gen-backlog.py` — 132 مهمة بحالتها | 0.1 منجزة · مسار A بانتظارك (WAITING_GM) · 0.4 جاهزة (READY) · الباقي TODO |
| `docs/PROJECT_STATE.md` كان قالباً | مُحدَّث: المهمة الحالية BOOTSTRAP-001 ثم 0.4، والعوائق البيئية مسجَّلة | يحدّثه pg-scribe لاحقاً |
| مستودع Git | `git init -b main` + أول commit باسم `SETUP-000` | يظهر في `git log` |
| — (إضافات لتوفير حصة جلسة البوتستراب) | `docs/DECISION_LOG.md` (من EXECUTION-MASTER-v4 الجزء 1) · `docs/CHANGELOG.md` · `tasks/{backlog,active,completed,blocked}/` · `docs/notes/` · `scripts/check-setup.sh` | جلسة البوتستراب تتحقق منها بدل أن تُنشئها |

## ما بقي عليك (لا يمكن تنفيذه عن بُعد)
1. **تثبيت الأدوات** على الجهاز: `pnpm` (`npm i -g pnpm@9`) · Docker Desktop · عميل PostgreSQL 16 (`psql`). بدونها: جلسة البوتستراب تعمل (تكتب ملفات فقط)، لكن المهمة 0.4 تحتاج pnpm، والقسم §3 من دليل الإعداد يحتاج Docker وpsql.
2. **التحقق قبل أي جلسة:** من Git Bash داخل هذا المجلد: `bash scripts/check-setup.sh` — يجب أن ينتهي بـREADY أو FILES READY.
3. **القاعدة المحلية** (بعد Docker): `docker compose -f infra/docker/docker-compose.yml up -d postgres` ثم `PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos database/schema/apply.sh --recreate` — المتوقع: صفر أخطاء · 175 جدولاً · G7 = 0 · G-SEED = 0.
4. **جلسة البوتستراب:** `claude` → `/model sonnet` → الصق نص القسم §4 من `docs/package/PROJECT-SETUP-GUIDE.md`.
5. بعدها كل جلسة: `claude` → `/model sonnet` → `/resume`.

## ترتيب القراءة عند أي تعارض
`docs/package/40` → `36` → `EXECUTION-MASTER-v4` → `42` → `38` → `22` → `database/schema/01 · 13 · 13B · 019` → `BOOTSTRAP-v5` (تعليمات تشغيل فقط) → `D-blueprints/` (ملزمة للشاشات واللوحات والمؤشرات) → المرجعية.
