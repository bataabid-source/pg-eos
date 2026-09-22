// WBS 0.15 (pg-tester). RED phase: packages/documents does not exist at all yet — no
// package.json, no src/**, no index.ts (only pg-backend builds those next, per the WBS 0.15
// brief: "Write ONLY: packages/documents/tests/**/*.test.ts"). Every import below fails to
// resolve. That import-resolution failure IS the correct RED for this task — same class of RED
// as WBS 0.11's packages/db suite and WBS 0.12's packages/events suite (see those suites' own
// headers for the precedent this file follows).
//
// Doc-38 acceptance criterion for WBS 0.15 (verbatim, the ONLY acceptance bar for this slice):
// "Arabic/English PDF renders correctly; entity header auto-applied." Doc 40 §B4
// (docs/package/40-Build-Specification-EN.md:160-165, quoted in the WBS 0.15 brief):
// "`document_templates` (Handlebars HTML, bilingual, entity header/footer from
// `platform.entities`) ... Rendering: Chromium headless. Font Cairo. RTL default."
//
// SCOPE (per the WBS 0.15 brief's own "SCOPE DECISION" — do not re-litigate): this slice builds
// the RENDERING ENGINE ITSELF — template + entity + document-specific data -> bilingual PDF with
// the entity's header/footer auto-composed in. It does NOT build `platform.document_bindings`'
// auto-generate-on-state-transition wiring, doc-number allocation, `platform.documents` row
// recording, checksum computation, or file storage. No test in this file touches
// `platform.document_bindings` or `platform.documents` — both out of scope.
//
// `platform.document_templates` DDL (database/schema/01-Data-Model.sql:141-152, quoted verbatim
// in the WBS 0.15 brief — frozen, not touched by this suite except via ordinary insert/delete of
// throwaway rows this suite owns and cleans up itself): id uuid pk, code text unique, name_ar text
// not null, name_en text, entity_id uuid references platform.entities(id) [null = shared
// template], body_html text not null (Handlebars), page_size text default 'A4', orientation text
// default 'portrait', is_bilingual boolean default true, version int default 1, is_active boolean
// default true.
//
// `platform.entities` columns used for the header (from 01-Data-Model.sql:48-68, already known
// from WBS 0.9/0.10, not re-quoted in full — see the WBS 0.15 brief): id, code, name_ar (not
// null), name_en (not null), legal_name_ar (not null), legal_name_en, cr_number, tax_number,
// license_number, address_ar, address_en, phone, email, website, logo_url, base_currency.
//
// LIVE-CHECKED FACT (confirmed against the live local database before writing this file, not
// re-derived from memory — same discipline as WBS 0.10's thresholds-live-read.test.ts): for the
// seeded entity `code = 'PCC'`, `name_ar`, `name_en`, `legal_name_ar` are all populated with real,
// non-empty values; `logo_url`, `address_ar`, `address_en`, `phone`, `email`, `tax_number` are all
// empty/null for every seeded entity today (PCC/PDL/PGH/POR/PST). This suite therefore reads
// name_ar/name_en/legal_name_ar live in beforeAll and asserts against what it actually read — it
// never hardcodes an assumed Arabic or English string — and asserts nothing about
// logo_url/address_*/phone/email/tax_number, which are not populated for any seeded entity today.
//
// Connects to the already-running dev database via PG* env vars, defaulting to the documented
// local values — same convention as every other package's tests (packages/events/tests/
// outbox-write.test.ts, modules/platform/tests/integration/thresholds-live-read.test.ts).

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
// pdf-parse is a lightweight, common PDF-text-extraction devDependency the WBS 0.15 brief
// explicitly calls for ("add it as a devDependency of this package"). Adding it to a
// packages/documents/package.json is out of this task's write scope (Write ONLY:
// packages/documents/tests/**/*.test.ts — package.json is implementation-adjacent scaffolding,
// pg-backend's job next, same as packages/events/package.json was in WBS 0.12). Flagged in this
// suite's REPORT under "Open questions".
import pdfParse from 'pdf-parse';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The package under test. packages/documents/src/render.ts does not exist yet (WBS 0.15 RED) —
// pg-backend builds it next, to the exact contract in the WBS 0.15 brief's "PLANNED SHAPE" section:
//   renderDocument(pool, { templateId, entityId, data }) => Promise<{ html: string; pdf: Buffer }>
//   closeBrowser(): Promise<void>
import { closeBrowser, renderDocument } from '../src/render.js';
import type { RenderDocumentResult } from '../src/render.js';

// A plain, independent pg.Pool — same PG* env-var convention as every other package's tests
// (packages/events/tests/outbox-write.test.ts, modules/platform/tests/integration/
// thresholds-live-read.test.ts). Passed directly into renderDocument per its planned signature
// (renderDocument(pool, input)) — this package does not go through withContext (it reads
// reference/template data and composes a document, it does not itself write RLS-governed
// business state; same class of exemption WBS 0.12's relayOnce(pool, opts) documents for
// infrastructure reading/writing platform.outbox directly).
const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

// Real seeded row (01-Data-Model.sql:48-68), read live below — never hardcoded.
let pccId: string;
let pccNameAr: string;
let pccNameEn: string;
let pccLegalNameAr: string;

// A second real seeded entity, distinct from PCC, read live (not assumed — the WBS 0.15 brief
// explicitly says "check platform.entities for a second code ... read one live rather than
// assuming which exist"). Used only as "some other real entity" for the mismatch-rejection test;
// its actual code is never asserted on.
let otherEntityId: string;

// The small, real Handlebars body from the WBS 0.15 brief's own "Seed ONE throwaway
// platform.document_templates row" instructions, verbatim.
const HAPPY_PATH_BODY_HTML = [
  '<div class="header">{{entity.nameAr}} / {{entity.nameEn}}</div>',
  '<div class="body"><p>{{greeting}}</p><p>Ref: {{refNo}}</p></div>',
].join('\n');

interface DocumentTemplateRow {
  id: string;
}

async function insertThrowawayTemplate(params: {
  code: string;
  nameAr: string;
  nameEn: string;
  entityId: string | null;
  bodyHtml: string;
  pageSize: string;
  orientation: string;
}): Promise<string> {
  const result: QueryResult<DocumentTemplateRow> = await pool.query(
    `insert into platform.document_templates
       (code, name_ar, name_en, entity_id, body_html, page_size, orientation, is_bilingual, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, true, true)
     returning id`,
    [
      params.code,
      params.nameAr,
      params.nameEn,
      params.entityId,
      params.bodyHtml,
      params.pageSize,
      params.orientation,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`insert into platform.document_templates (code='${params.code}') returned no row`);
  }
  return row.id;
}

async function deleteTemplate(templateId: string): Promise<void> {
  await pool.query('delete from platform.document_templates where id = $1', [templateId]);
}

// The PDF page geometry (MediaBox) is encoded as literal, human-readable text in the page
// dictionary of an ordinary single-page Chromium-printed PDF (the content STREAM is typically
// compressed; the page object's own dictionary generally is not). This is the "PDF bytes
// themselves, which encode page geometry in a discoverable way" signal the WBS 0.15 brief points
// to as an alternative to pdf-parse's own (limited) metadata for proving orientation was actually
// respected. If a given renderer/Chromium version instead emits a compressed object stream for
// page dictionaries, this regex will find no match and throw a clear, diagnosable error rather
// than silently passing — a genuine GREEN-phase finding to report, not something to paper over.
function extractMediaBoxWidthHeight(pdf: Buffer): { width: number; height: number } {
  const raw = pdf.toString('latin1');
  const match = /\/MediaBox\s*\[\s*([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s*\]/.exec(raw);
  if (!match) {
    throw new Error(
      'no /MediaBox entry found as plain text in the rendered PDF bytes — cannot verify page geometry this way',
    );
  }
  const x0 = Number(match[1]);
  const y0 = Number(match[2]);
  const x1 = Number(match[3]);
  const y1 = Number(match[4]);
  return { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

beforeAll(async () => {
  const entityRead: QueryResult<{
    id: string;
    name_ar: string | null;
    name_en: string | null;
    legal_name_ar: string | null;
  }> = await pool.query(
    `select id, name_ar, name_en, legal_name_ar from platform.entities where code = $1`,
    ['PCC'],
  );
  const pccRow = entityRead.rows[0];
  if (!pccRow) {
    throw new Error(
      "seed entity code='PCC' not found in platform.entities — is database/schema/apply.sh applied to this database?",
    );
  }
  if (!pccRow.name_ar || !pccRow.name_ar.trim()) {
    throw new Error("seed entity 'PCC' has an empty/null name_ar — cannot prove entity-header auto-apply without it");
  }
  if (!pccRow.name_en || !pccRow.name_en.trim()) {
    throw new Error("seed entity 'PCC' has an empty/null name_en — cannot prove entity-header auto-apply without it");
  }
  if (!pccRow.legal_name_ar || !pccRow.legal_name_ar.trim()) {
    throw new Error("seed entity 'PCC' has an empty/null legal_name_ar — cannot prove entity-header auto-apply without it");
  }
  pccId = pccRow.id;
  pccNameAr = pccRow.name_ar;
  pccNameEn = pccRow.name_en;
  pccLegalNameAr = pccRow.legal_name_ar;

  const otherEntityRead: QueryResult<{ id: string }> = await pool.query(
    `select id from platform.entities where code <> $1 order by code limit 1`,
    ['PCC'],
  );
  const otherRow = otherEntityRead.rows[0];
  if (!otherRow) {
    throw new Error(
      'no second seeded platform.entities row besides PCC found — need a real distinct entity for the mismatch-rejection test',
    );
  }
  otherEntityId = otherRow.id;
});

afterAll(async () => {
  // A leaked headless Chromium process is a real, easy-to-hit failure mode for this kind of
  // suite (WBS 0.15 brief) — closeBrowser() releases the shared, lazily-launched instance so the
  // test process can exit cleanly.
  await closeBrowser();
  await pool.end();
});

describe('renderDocument — Arabic/English PDF renders correctly, entity header auto-applied (WBS 0.15, doc 38 acceptance criterion)', () => {
  it("renders a bilingual RTL PDF whose HTML and PDF both contain the real entity header (name_ar/name_en/legal_name_ar, read live, never hardcoded) and the document-specific data merged in via Handlebars", async () => {
    const code = `WBS-0.15-TEST-01-${randomUUID()}`;
    const templateId = await insertThrowawayTemplate({
      code,
      nameAr: 'قالب اختبار WBS 0.15',
      nameEn: 'WBS 0.15 test template',
      entityId: null, // shared template — the more common, less restrictive case
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      orientation: 'portrait',
    });

    try {
      const result: RenderDocumentResult = await renderDocument(pool, {
        templateId,
        entityId: pccId,
        data: { greeting: 'Hello from WBS 0.15', refNo: 'REF-0015-A' },
      });

      // result.pdf is a real PDF: starts with the %PDF magic bytes and has a non-trivial length —
      // a real rendered page, not an empty/error stub.
      expect(result.pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
      expect(result.pdf.length).toBeGreaterThan(1000);

      // "entity header auto-applied" — the exact acceptance wording — proved against the entity's
      // ACTUAL name_ar/name_en/legal_name_ar, read live in beforeAll, never hardcoded here.
      expect(result.html).toContain(pccNameAr);
      expect(result.html).toContain(pccNameEn);
      expect(result.html).toContain(pccLegalNameAr);

      // The document-specific data made it through the Handlebars merge.
      expect(result.html).toContain('Hello from WBS 0.15');
      expect(result.html).toContain('REF-0015-A');

      // RTL default, per doc 40 §B4.
      expect(result.html).toContain('dir="rtl"');

      // Go one level deeper than HTML — prove the PDF itself, not just the pre-render HTML, ACTUALLY
      // contains this content (the acceptance criterion says "PDF renders correctly", a different
      // claim than "HTML renders correctly" — a broken-font/CSS-clipping bug in the Chromium step
      // would only show up here).
      const parsed = await pdfParse(result.pdf);
      expect(parsed.text).toContain('Hello from WBS 0.15');
      expect(parsed.text).toContain('REF-0015-A');
      expect(parsed.text).toContain(pccNameEn);
      // Arabic-script PDF text extraction is a known real-world limitation of many extractors
      // (complex shaping/ligatures/bidi), including pdf-parse/pdf.js. Confirmed by direct
      // reproduction against this suite's own live pccNameAr (read in beforeAll, never
      // hardcoded): pdf-parse extracts RTL text runs in VISUAL (left-to-right glyph placement)
      // order, not LOGICAL (reading) order — e.g. the letters of a word come out reversed. This
      // is documented pdf.js/pdf-parse behavior, not a defect in renderDocument's HTML/PDF
      // pipeline — the `result.html` assertion above (`toContain(pccNameAr)`) already proves the
      // exact, correctly-ordered Arabic string reached the pre-render HTML byte-for-byte; only
      // this one-way text-extraction step back OUT of the finished PDF reorders RTL runs.
      // A literal `toContain(pccNameAr)` on `parsed.text` is therefore not a provable claim for
      // this extractor.
      //
      // An earlier version of this assertion checked only character-SET membership (every
      // distinct non-space character of pccNameAr appears somewhere in parsed.text). That check
      // is vacuous: it also passes on BROKEN renders where entity.nameAr is dropped entirely
      // from the header/body/footer — because pccNameAr's distinct letters happen to also occur
      // in pccLegalNameAr (rendered separately in the same header) and in the Latin word "CC"
      // shared with pccNameEn — and it also passes on scrambled Arabic that reuses the same
      // letter multiset in the wrong order. It cannot actually fail for the claim it exists to
      // guard, so it was rejected.
      //
      // The check below is strictly stronger and is confirmed, provable behavior for this
      // specific extractor: for a SINGLE-RUN RTL string (pccNameAr is one un-broken word/run,
      // unlike the three-word pccLegalNameAr, whose word order — not just character order —
      // also reverses and is therefore not amenable to this same simple reversal), pdf-parse
      // extracts it as the exact character-reversed sequence. Asserting that the reversed
      // sequence appears as a literal substring proves the real glyphs reached the PDF, in the
      // correct (single-run-reversed) order, ruling out both the "name dropped" and the
      // "scrambled" broken-render cases above.
      const reversedPccNameAr = [...pccNameAr].reverse().join('');
      expect(parsed.text).toContain(reversedPccNameAr);
    } finally {
      await deleteTemplate(templateId);
    }
  });

  it('rejects rendering when document_templates.entity_id is set and does not match the given entityId — an entity-specific template used for the wrong entity is a data-integrity bug, not silently rendered', async () => {
    const code = `WBS-0.15-TEST-02-${randomUUID()}`;
    const templateId = await insertThrowawayTemplate({
      code,
      nameAr: 'قالب مقيّد بكيان',
      nameEn: 'entity-scoped template',
      entityId: pccId, // entity-specific this time, not null
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      orientation: 'portrait',
    });

    try {
      // otherEntityId is a real, distinct, live-read seeded entity (never the same as pccId — the
      // template's own owning entity) — asserts renderDocument rejects rather than silently
      // rendering an entity-specific template against the wrong entity.
      expect(otherEntityId).not.toBe(pccId);
      await expect(
        renderDocument(pool, {
          templateId,
          entityId: otherEntityId,
          data: { greeting: 'should never render', refNo: 'REF-0015-B' },
        }),
      ).rejects.toBeTruthy();
    } finally {
      await deleteTemplate(templateId);
    }
  });

  it('allows rendering an entity-scoped template (document_templates.entity_id set) when the given entityId matches that SAME entity — the mismatch guard must not reject the legitimate, matching case', async () => {
    const code = `WBS-0.15-TEST-02B-${randomUUID()}`;
    const templateId = await insertThrowawayTemplate({
      code,
      nameAr: 'قالب مقيّد بكيان - مطابق',
      nameEn: 'entity-scoped template — matching entity',
      entityId: pccId, // entity-specific, same pattern as the mismatch-rejection test above
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      orientation: 'portrait',
    });

    try {
      // entityId equals the template's OWN entity_id (pccId) this time — the positive case the
      // mismatch-rejection test above does not cover on its own.
      const result: RenderDocumentResult = await renderDocument(pool, {
        templateId,
        entityId: pccId,
        data: { greeting: 'same-entity render', refNo: 'REF-0015-B2' },
      });

      expect(result.pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
      expect(result.pdf.length).toBeGreaterThan(1000);
    } finally {
      await deleteTemplate(templateId);
    }
  });

  it("respects page_size/orientation — a 'landscape' template's rendered PDF page geometry (width > height) is observably distinct from an otherwise-identical 'portrait' template's (height > width), both A4", async () => {
    const portraitCode = `WBS-0.15-TEST-03-PORTRAIT-${randomUUID()}`;
    const landscapeCode = `WBS-0.15-TEST-03-LANDSCAPE-${randomUUID()}`;

    const portraitTemplateId = await insertThrowawayTemplate({
      code: portraitCode,
      nameAr: 'قالب طولي',
      nameEn: 'portrait template',
      entityId: null,
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      orientation: 'portrait',
    });
    const landscapeTemplateId = await insertThrowawayTemplate({
      code: landscapeCode,
      nameAr: 'قالب عرضي',
      nameEn: 'landscape template',
      entityId: null,
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      orientation: 'landscape',
    });

    try {
      const portraitResult = await renderDocument(pool, {
        templateId: portraitTemplateId,
        entityId: pccId,
        data: { greeting: 'Portrait check', refNo: 'REF-0015-C' },
      });
      const landscapeResult = await renderDocument(pool, {
        templateId: landscapeTemplateId,
        entityId: pccId,
        data: { greeting: 'Landscape check', refNo: 'REF-0015-D' },
      });

      const portraitGeometry = extractMediaBoxWidthHeight(portraitResult.pdf);
      const landscapeGeometry = extractMediaBoxWidthHeight(landscapeResult.pdf);

      expect(portraitGeometry.height).toBeGreaterThan(portraitGeometry.width);
      expect(landscapeGeometry.width).toBeGreaterThan(landscapeGeometry.height);
      // The two renders must not just individually satisfy their own orientation — they must
      // actually differ from each other in dimensions, proving orientation was READ from the
      // template row per-render rather than a fixed default that happens to satisfy one of the
      // two assertions above by coincidence.
      expect(portraitGeometry).not.toEqual(landscapeGeometry);
    } finally {
      await deleteTemplate(portraitTemplateId);
      await deleteTemplate(landscapeTemplateId);
    }
  });

  it("rejects rendering when document_templates.orientation is an invalid value (e.g. capitalized 'Landscape', a realistic typo) instead of silently rendering with a misinterpreted default", async () => {
    const code = `WBS-0.15-TEST-04-ORIENTATION-${randomUUID()}`;
    const templateId = await insertThrowawayTemplate({
      code,
      nameAr: 'قالب اتجاه غير صالح',
      nameEn: 'invalid orientation template',
      entityId: null,
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A4',
      // Not exactly 'portrait' or 'landscape' — a realistic capitalization typo, not a nonsense
      // string, proving assertValidPageGeometry actually validates against the known set rather
      // than merely rejecting garbage input.
      orientation: 'Landscape',
    });

    try {
      await expect(
        renderDocument(pool, {
          templateId,
          entityId: pccId,
          data: { greeting: 'should never render', refNo: 'REF-0015-E' },
        }),
      ).rejects.toBeTruthy();
    } finally {
      await deleteTemplate(templateId);
    }
  });

  it("rejects rendering when document_templates.page_size is not a key of PAGE_SIZES_MM (e.g. 'A3', not one of 'A4'/'Letter'/'Legal') instead of silently rendering with a misinterpreted default", async () => {
    const code = `WBS-0.15-TEST-05-PAGESIZE-${randomUUID()}`;
    const templateId = await insertThrowawayTemplate({
      code,
      nameAr: 'قالب حجم غير صالح',
      nameEn: 'invalid page_size template',
      entityId: null,
      bodyHtml: HAPPY_PATH_BODY_HTML,
      pageSize: 'A3',
      orientation: 'portrait',
    });

    try {
      await expect(
        renderDocument(pool, {
          templateId,
          entityId: pccId,
          data: { greeting: 'should never render', refNo: 'REF-0015-F' },
        }),
      ).rejects.toBeTruthy();
    } finally {
      await deleteTemplate(templateId);
    }
  });
});
