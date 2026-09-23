# حالة المستودع — PG-EOS (بالعربية)
**آخر تحديث: 23 سبتمبر 2026 · المسار: `C:\Users\Mohammed\Desktop\PG-EOS\claude-kit\` (المجلد الأعلى أُعيدت تسميته من `New sys` إلى `PG-EOS` يوم 22/9) · هذا المجلد (`claude-kit/`) هو جذر مستودع التنفيذ — لا يُنقل ولا يُعاد ترتيبه من خارج Claude Code**

## أين وصل البناء (المصدر: `docs/PROJECT_STATE.md` و`tasks/MASTER_BACKLOG.md`، يحدّثهما pg-scribe فقط)
| المهمة | الحالة | الـcommit |
|---|---|---|
| SETUP-000 — استيراد الحزمة v4 + الطقم | ✅ | `bab005a` |
| BOOTSTRAP-001 — التحقق من الطقم (BOOTSTRAP-v5 §9) | ✅ | `aca1b16` |
| 0.4 — pnpm · Turborepo · TS strict · حدود ESLint | ✅ | `05674b5` |
| SCR-I18N-01 — الأمهرية لغة سادسة | ✅ | `8d62747` |
| 0.9 — `platform` (outbox، audit_log بالسلسلة، next_doc_no) | ✅ | `aa46787` (إصلاح SCR-AUDIT-01 لاحقاً @ `e5bff15`) |
| 0.13 — `packages/contracts` (Zod → OpenAPI · Registry · Problem · Idempotency-Key) | ✅ | `50055f8` / `335b5db` |
| 0.14 — `packages/domain-kit` (Money, Quantity, Clock, IdGenerator) | ✅ | `a8f4899` |
| 0.17 — الهوية (آليات فقط: OTP، جلسات، RBAC/SoD) | ✅ | `c90dd6e` |
| 0.18 — عزل RLS بين العملاء (43/43) + حارس G14 | ✅ | `f03e160` |
| 2.1 — منطقة WH1 وثماني كتل مساحة (إثبات) | ✅ | `0d546d5` |
| 2.8 — دفتر أستاذ المخزون + رصيد مشتق + verify_balance_integrity | ✅ | `b5da282` |
| 1.5 — حسابات العملاء (شريحة إثبات، ADR-0001) + SCR-TRGM-01 خيار A | ✅ (إثبات) | `f790da7` |
| X — قرارات GM 2026-09-23 (D-105…D-112): توحيد الصورة، نقل الملخصات، بيئة turbo، كلمة مرور pgAdmin، تزامن الوثائق | ✅ | `0260778` |
| 2.6 — آلية تسجيل `wms.skus`، رفض خلط SKU بين العملاء | ✅ | `e38370e` |
| X — قرارات GM 2026-09-23 (D-103…D-121): إعادة تسمية الأوامر، تزامن الوثائق | ⏭️ المهمة الحالية | `<هذا الالتزام>` |

**المرحلة:** 0 — الأساس → 2 — المستودع (بدأت 2.1). الشريحة الذهبية 2.9 لم تُبنَ بعد. المسارات المتوازية لا تُفتح قبل الشريحة الذهبية.

## المهام الثلاث التالية (من `docs/PROJECT_STATE.md`)
1. 2.6 `wms.skus` — جاهزة (READY)، خارج نطاق التوجيه الحالي، بانتظار GM
2. 2.2 مسح ميداني → 2.3 → 2.4 (بانتظار GM)
3. 0.6 CI (بانتظار 0.5)

## الأدوات على جهازك
- ✅ pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 · psql 16.15 — **مثبّتة**، لم تعد عائقاً.
- ✅ **Claude Code CLI مثبّت عالمياً** (`npm install -g`) — قائمة أدوات `check-setup.sh` كاملة الآن.
- `bash scripts/check-setup.sh` → **READY — all files present, all tools installed.**

## صورة قاعدة البيانات (D-105، قرار GM 2026-09-23)
الصورة المعتمدة للتطوير والطبقة صفر: `postgres:16` (Debian/glibc) — توحيد إزالة لتفرّع glibc/musl في تصنيف الأحرف العربية لـ`pg_trgm` (انظر SCR-TRGM-01).

## ما عليك فعله (بالترتيب)
1. من Git Bash داخل `claude-kit/`:
   `docker compose -f infra/docker/docker-compose.yml up -d postgres`
   ثم `PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos bash database/schema/apply.sh --recreate`
   المتوقع: صفر أخطاء · 175 جدولاً · G7 = 0 · G-SEED = 0.
2. `claude` → `/model sonnet` → `/pg-resume` — **دائماً من داخل `claude-kit/`** وليس من المجلد الأعلى `PG-EOS/`.

## تثبيت النماذج (GM 2026-09-23، بلا haiku)
`pg-reviewer` → **opus** فقط. `pg-backend` / `pg-frontend` / `pg-tester` / `pg-scribe` → **sonnet**. جلسة الـMaster تعمل على نموذج الجلسة (opus عند الحاجة للتصعيد). لا يُستخدم haiku في أي وكيل.

## حادثة 21/9 (مُغلقة)
عملية «تنظيف» من خارج Claude Code (جلسة Cowork على مجلد `New sys/`) حذفت هيكل 0.4 وملفات 0.13 غير المُلتزَمة ونقلتها إلى `_TO_DELETE/` (commit `a901a04`). جلسة Claude Code أعادت الملفات (`1bc09f7`) وأعادت بناء 0.13 (`50055f8`). **لا فقد دائم.** التفصيل: `docs/notes/2026-09-21-incident-a901a04-root-cause.md`.
- مجلد `PG-EOS/_TO_DELETE/` يحتوي الآن نسخاً مكرّرة فقط (node_modules قديم · pg-eos-repo · تقارير غير دقيقة) — **يمكنك حذفه بأمان**.
- القاعدة: لا تُنظَّم ملفات `claude-kit/` يدوياً ولا عبر مساعد خارجي؛ ملفات `package.json · pnpm-workspace.yaml · turbo.json · packages/ · modules/ · apps/ · tests/` هي ناتج البناء وليست بقايا.

## مشروع Claude.ai «PG-EOS»
تعليماته والوثائق الحاكمة لرفعها مجهّزة في `PG-EOS/PG-EOS-project-upload/` (الملف `00-INSTRUCTIONS-PASTE-INTO-PROJECT.md` يُلصق في خانة التعليمات، والباقي يُرفع كملفات معرفة).

## ترتيب القراءة عند أي تعارض
`docs/package/40` → `36` → `EXECUTION-MASTER-v4` → `42` → `38` → `22` → `database/schema/01 · 13 · 13B · 019` → `BOOTSTRAP-v5` (تعليمات تشغيل فقط) → `D-blueprints/` (ملزمة للشاشات واللوحات والمؤشرات) → المرجعية.
