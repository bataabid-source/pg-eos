# حالة المستودع — PG-EOS (بالعربية)
**آخر تحديث: 21 سبتمبر 2026 · هذا المجلد (`claude-kit/`) هو جذر مستودع التنفيذ — لا يُنقل ولا يُعاد ترتيبه من خارج Claude Code**

## أين وصل البناء (المصدر: `docs/PROJECT_STATE.md`، يحدّثه pg-scribe فقط)
| المهمة | الحالة | الـcommit |
|---|---|---|
| SETUP-000 — استيراد الحزمة v4 + الطقم | ✅ | `bab005a` |
| BOOTSTRAP-001 — التحقق من الطقم (BOOTSTRAP-v5 §9) | ✅ | `aca1b16` |
| 0.4 — pnpm · Turborepo · TS strict · حدود ESLint | ✅ | `05674b5` |
| SCR-I18N-01 — الأمهرية لغة سادسة | ✅ | `8d62747` |
| 0.13 — `packages/contracts` (Zod → OpenAPI · Registry · Problem · Idempotency-Key) | ✅ | `50055f8` / `335b5db` |
| **0.14 — `packages/domain-kit`** (المسار C) | ⏭️ المهمة الحالية — لا تحتاج قاعدة بيانات | — |
| 0.9 — `platform` (المسار B) | ⛔ محجوبة: تحتاج `psql` | — |

**المرحلة:** 0 — الأساس. الشريحة الذهبية 2.9 لم تُبنَ بعد. المسارات المتوازية لا تُفتح قبل الشريحة الذهبية.

## الأدوات على جهازك (كما رصدتها جلسة Claude Code يوم 21/9)
- ✅ pnpm 9.15.9 · Node 25.2.1 · Docker 29.0.1 — **مثبّتة** (التحذيرات السابقة عن pnpm وDocker كانت من فحص داخل بيئة Cowork وليست من جهازك).
- ❌ **psql 16 غير موجود** — وهذا الآن العائق الوحيد: `apply.sh --recreate` لم يُشغَّل، الحُرّاس G1–G18 لم يُشغَّلوا، والمهمة 0.9 محجوبة.

## ما عليك فعله (بالترتيب)
1. **ثبّت عميل PostgreSQL 16** (المثبّت الرسمي → اختر Command Line Tools على الأقل) ثم تحقّق: `psql --version`.
2. من Git Bash داخل `claude-kit/`:
   `docker compose -f infra/docker/docker-compose.yml up -d postgres`
   ثم `PGHOST=localhost PGPORT=5432 PGUSER=postgres PGDATABASE=pgeos bash database/schema/apply.sh --recreate`
   المتوقع: صفر أخطاء · 175 جدولاً · G7 = 0 · G-SEED = 0.
3. `claude` → `/model sonnet` → `/resume` — **دائماً من داخل `claude-kit/`** وليس من `New sys/`.

## حادثة 21/9 (مُغلقة)
عملية «تنظيف» من خارج Claude Code (جلسة Cowork على مجلد `New sys/`) حذفت هيكل 0.4 وملفات 0.13 غير المُلتزَمة ونقلتها إلى `_TO_DELETE/` (commit `a901a04`). جلسة Claude Code أعادت الملفات (`1bc09f7`) وأعادت بناء 0.13 (`50055f8`). **لا فقد دائم.** التفصيل: `docs/notes/2026-09-21-incident-a901a04-root-cause.md`.
- مجلد `New sys/_TO_DELETE/` يحتوي الآن نسخاً مكرّرة فقط (node_modules قديم · pg-eos-repo · تقارير غير دقيقة) — **يمكنك حذفه بأمان**.
- القاعدة: لا تُنظَّم ملفات `claude-kit/` يدوياً ولا عبر مساعد خارجي؛ ملفات `package.json · pnpm-workspace.yaml · turbo.json · packages/ · modules/ · apps/ · tests/` هي ناتج البناء وليست بقايا.

## ترتيب القراءة عند أي تعارض
`docs/package/40` → `36` → `EXECUTION-MASTER-v4` → `42` → `38` → `22` → `database/schema/01 · 13 · 13B · 019` → `BOOTSTRAP-v5` (تعليمات تشغيل فقط) → `D-blueprints/` (ملزمة للشاشات واللوحات والمؤشرات) → المرجعية.
