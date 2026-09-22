// packages/documents/src/render.ts — WBS 0.15.
//
// renderDocument(pool, input) — doc 38 acceptance criterion (verbatim, the ONLY acceptance bar
// for this slice): "Arabic/English PDF renders correctly; entity header auto-applied." doc 40
// §B4: "`document_templates` (Handlebars HTML, bilingual, entity header/footer from
// `platform.entities`) ... Rendering: Chromium headless. Font Cairo. RTL default."
//
// `pool` is a plain pg.Pool passed in by the caller — this package reads reference/template data
// (platform.document_templates, platform.entities) and composes a document; it does not itself
// write RLS-governed business state, so it does not go through withContext(ctx, fn). Same class
// of exemption packages/events' relayOnce(pool, opts) documents for infrastructure reading/
// writing platform.outbox directly (see render-document.test.ts's own header for this
// precedent). The `local/no-db-outside-with-context` lint rule only tracks the `db` binding
// exported from @pg-eos/db — this file never imports that package, so the rule does not (and
// should not) fire here.
//
// SCOPE (per the WBS 0.15 brief's own "SCOPE DECISION"): this is the rendering engine itself —
// template + entity + document-specific data -> bilingual PDF with the entity's header/footer
// auto-composed in. It does NOT touch platform.document_bindings' auto-generate wiring, doc-
// number allocation, platform.documents row recording, checksum computation, or file storage.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import Handlebars from 'handlebars';
import type { Pool, QueryResult } from 'pg';
import puppeteer from 'puppeteer';
import type { Browser, PDFOptions } from 'puppeteer';

const require = createRequire(import.meta.url);

export interface RenderDocumentInput {
  /** platform.document_templates.id */
  readonly templateId: string;
  /** platform.entities.id — whose header/footer to apply */
  readonly entityId: string;
  /** document-specific fields merged into the Handlebars context */
  readonly data: Record<string, unknown>;
}

export interface RenderDocumentResult {
  readonly html: string;
  readonly pdf: Buffer;
}

interface DocumentTemplateRow {
  body_html: string;
  page_size: string;
  orientation: string;
  is_bilingual: boolean;
  template_entity_id: string | null;
}

interface EntityRow {
  id: string;
  code: string;
  name_ar: string;
  name_en: string;
  legal_name_ar: string;
  legal_name_en: string | null;
  cr_number: string | null;
  tax_number: string | null;
  license_number: string | null;
  address_ar: string | null;
  address_en: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
}

// ── shared, lazily-initialized headless Chromium instance ──────────────────────────────────
//
// Same pattern packages/db/src/client.ts uses for its shared pg Pool: launch once on first use,
// reuse across every renderDocument call in this process, never launch-and-close per call.
let sharedBrowser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) {
    return sharedBrowser;
  }
  if (!launchPromise) {
    launchPromise = puppeteer
      .launch({ headless: true })
      .then((browser) => {
        sharedBrowser = browser;
        return browser;
      })
      .catch((error: unknown) => {
        // A failed launch (no cached Chromium, missing shared library, sandbox denial, ...)
        // must not permanently wedge the package — clear launchPromise back to null so the
        // NEXT renderDocument() call gets a fresh launch attempt instead of re-awaiting this
        // same rejected promise forever.
        launchPromise = null;
        throw error;
      });
  }
  return launchPromise;
}

/**
 * Closes the shared headless Chromium instance, if one was launched, and resets internal state
 * so a later renderDocument() call launches a fresh one. Mirrors render-document.test.ts's own
 * afterAll — lets the test process exit cleanly without a leaked Chromium process.
 */
export async function closeBrowser(): Promise<void> {
  if (launchPromise) {
    // A launch is still in-flight: wait for it to settle before tearing down, otherwise the
    // in-flight puppeteer.launch() completes AFTER this function returns and its resulting
    // Browser is never closed — a leaked Chromium process. If the launch itself fails, there is
    // nothing to close.
    const inFlight = launchPromise;
    sharedBrowser = null;
    launchPromise = null;
    try {
      const browser = await inFlight;
      await browser.close();
    } catch {
      // launch failed — nothing was produced, nothing to close.
    }
    return;
  }
  const browser = sharedBrowser;
  sharedBrowser = null;
  launchPromise = null;
  if (browser) {
    await browser.close();
  }
}

// ── Cairo font, embedded offline ────────────────────────────────────────────────────────────
//
// doc 40 §B4: "Font Cairo." Embedded as base64 data URIs (read once, at module load, from the
// @fontsource/cairo package's own bundled .woff2 files) so the printed PDF has no network/CDN
// font dependency — must work offline/in CI. Two subsets cover both scripts this package renders
// (Arabic entity header/footer text plus Latin document-specific data); font-weight 400 is the
// only weight this slice's HTML uses.
const CAIRO_ARABIC_WOFF2_BASE64 = readFileSync(
  require.resolve('@fontsource/cairo/files/cairo-arabic-400-normal.woff2'),
).toString('base64');
const CAIRO_LATIN_WOFF2_BASE64 = readFileSync(
  require.resolve('@fontsource/cairo/files/cairo-latin-400-normal.woff2'),
).toString('base64');

const CAIRO_FONT_FACE_CSS = `
    @font-face {
      font-family: 'Cairo';
      font-style: normal;
      font-weight: 400;
      src: url(data:font/woff2;base64,${CAIRO_ARABIC_WOFF2_BASE64}) format('woff2');
      unicode-range: U+0600-06FF, U+0750-077F, U+0870-088E, U+FB50-FDFF, U+FE70-FEFC;
    }
    @font-face {
      font-family: 'Cairo';
      font-style: normal;
      font-weight: 400;
      src: url(data:font/woff2;base64,${CAIRO_LATIN_WOFF2_BASE64}) format('woff2');
      unicode-range: U+0000-00FF, U+2000-206F;
    }`;

// ── page geometry ────────────────────────────────────────────────────────────────────────────
//
// puppeteer's own `format` + `landscape` combination is not relied on here — explicit width/
// height (in millimetres) is used instead so the rendered PDF's /MediaBox geometry is exactly
// and unambiguously width>height for landscape / height>width for portrait, regardless of any
// per-version quirk in how a given puppeteer/Chromium build interprets `format`+`landscape`.
// US Letter/Legal are defined in inches (8.5x11in / 8.5x14in) — 215.9mm / 279.4mm / 355.6mm are
// the accurate conversions; A4 (210x297mm) is already an exact ISO 216 value.
const PAGE_SIZES_MM: Readonly<Record<string, { widthMm: number; heightMm: number }>> = {
  A4: { widthMm: 210, heightMm: 297 },
  Letter: { widthMm: 215.9, heightMm: 279.4 },
  Legal: { widthMm: 215.9, heightMm: 355.6 },
};

const ORIENTATIONS = ['portrait', 'landscape'] as const;
type Orientation = (typeof ORIENTATIONS)[number];

/**
 * `platform.document_templates.page_size`/`orientation` are plain `text` columns with no CHECK
 * constraint (database/schema/01-Data-Model.sql:147-148), so an invalid or mistyped value (e.g.
 * lowercase `'a4'`, or `'A3'`, or capitalized `'Landscape'`) must be rejected explicitly here
 * rather than silently misinterpreted as a fallback default.
 */
function assertValidPageGeometry(
  pageSize: string,
  orientation: string,
): asserts orientation is Orientation {
  if (!(pageSize in PAGE_SIZES_MM)) {
    throw new Error(
      `renderDocument: invalid page_size='${pageSize}' — allowed values are: ` +
        `${Object.keys(PAGE_SIZES_MM).join(', ')}`,
    );
  }
  if (!(ORIENTATIONS as readonly string[]).includes(orientation)) {
    throw new Error(
      `renderDocument: invalid orientation='${orientation}' — allowed values are: ` +
        `${ORIENTATIONS.join(', ')}`,
    );
  }
}

function toPdfOptions(pageSize: string, orientation: Orientation): PDFOptions {
  const size = PAGE_SIZES_MM[pageSize] as { widthMm: number; heightMm: number };
  const isLandscape = orientation === 'landscape';
  const shortSideMm = Math.min(size.widthMm, size.heightMm);
  const longSideMm = Math.max(size.widthMm, size.heightMm);
  return {
    width: `${isLandscape ? longSideMm : shortSideMm}mm`,
    height: `${isLandscape ? shortSideMm : longSideMm}mm`,
    printBackground: true,
  };
}

// ── HTML composition ────────────────────────────────────────────────────────────────────────

/** Minimal HTML-escaping for entity fields interpolated outside the Handlebars template. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHandlebarsContext(
  entity: EntityRow,
  isBilingual: boolean,
  data: Record<string, unknown>,
): Record<string, unknown> {
  // `data` is spread FIRST so the authoritative entity/isBilingual keys below always win — a
  // caller-supplied data field literally named `entity` or `isBilingual` must never be able to
  // shadow the real, DB-verified entity header read from platform.entities (it would otherwise
  // render caller-controlled content in the body while composeFullHtml's wrapper header/footer
  // still show the real entity — a header/body mismatch with no error).
  return {
    ...data,
    entity: {
      code: entity.code,
      nameAr: entity.name_ar,
      nameEn: entity.name_en,
      legalNameAr: entity.legal_name_ar,
      legalNameEn: entity.legal_name_en,
      crNumber: entity.cr_number,
      taxNumber: entity.tax_number,
      licenseNumber: entity.license_number,
      addressAr: entity.address_ar,
      addressEn: entity.address_en,
      phone: entity.phone,
      email: entity.email,
      website: entity.website,
      logoUrl: entity.logo_url,
    },
    isBilingual,
  };
}

/**
 * Wraps a rendered document body in a full HTML page: Cairo font, RTL-default root, and the
 * entity's header/footer (name_ar / name_en / legal_name_ar) auto-applied — doc 40 §B4's "entity
 * header/footer from platform.entities", proved verbatim by render-document.test.ts.
 */
function composeFullHtml(bodyHtml: string, entity: EntityRow): string {
  const nameAr = escapeHtml(entity.name_ar);
  const nameEn = escapeHtml(entity.name_en);
  const legalNameAr = escapeHtml(entity.legal_name_ar);

  // `dir="rtl" lang="ar"` below is hardcoded — RTL is the only supported direction. isBilingual
  // enters the Handlebars context (see buildHandlebarsContext) but this rendering engine never
  // branches on it for direction, because platform.document_templates has no per-template
  // direction-selector column to key off: is_bilingual is a boolean (whether the template
  // carries both languages), not a direction flag. Inventing a new column to support an
  // LTR-primary document would violate CLAUDE.md's "never invent a column" rule (G-01
  // territory) — LTR-primary document support is deferred pending a future schema-change
  // request, not built in this slice.
  return `<!doctype html>
<html dir="rtl" lang="ar">
  <head>
    <meta charset="utf-8" />
    <style>
      ${CAIRO_FONT_FACE_CSS}
      * { font-family: 'Cairo', sans-serif; }
      body { margin: 0; padding: 24px; }
      .pg-document-header {
        border-bottom: 2px solid #333333;
        padding-bottom: 12px;
        margin-bottom: 16px;
      }
      .pg-document-header .pg-name-ar { font-size: 18px; font-weight: 700; }
      .pg-document-header .pg-name-en { font-size: 14px; color: #555555; }
      .pg-document-header .pg-legal-name-ar { font-size: 12px; color: #777777; }
      .pg-document-footer {
        border-top: 1px solid #cccccc;
        margin-top: 24px;
        padding-top: 8px;
        font-size: 10px;
        color: #999999;
      }
    </style>
  </head>
  <body>
    <header class="pg-document-header">
      <div class="pg-name-ar">${nameAr}</div>
      <div class="pg-name-en">${nameEn}</div>
      <div class="pg-legal-name-ar">${legalNameAr}</div>
    </header>
    <main class="pg-document-body">
${bodyHtml}
    </main>
    <footer class="pg-document-footer">
      <span class="pg-name-ar">${nameAr}</span> — <span class="pg-name-en">${nameEn}</span>
    </footer>
  </body>
</html>`;
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────

export async function renderDocument(
  pool: Pool,
  input: RenderDocumentInput,
): Promise<RenderDocumentResult> {
  const templateResult: QueryResult<DocumentTemplateRow> = await pool.query(
    `select body_html, page_size, orientation, is_bilingual, entity_id as template_entity_id
       from platform.document_templates
      where id = $1`,
    [input.templateId],
  );
  const template = templateResult.rows[0];
  if (!template) {
    throw new Error(
      `renderDocument: no platform.document_templates row for id='${input.templateId}'`,
    );
  }

  // Validate early — before any Handlebars/Chromium work — so an unrecognized page_size/
  // orientation value fails loudly instead of being silently misinterpreted (see
  // assertValidPageGeometry's own doc comment).
  assertValidPageGeometry(template.page_size, template.orientation);

  // Mismatch guard: an entity-specific template rendered for a different entity is a real
  // data-integrity rejection, not a silent render — render-document.test.ts's second scenario.
  if (template.template_entity_id !== null && template.template_entity_id !== input.entityId) {
    throw new Error(
      `renderDocument: template '${input.templateId}' is scoped to entity_id='${template.template_entity_id}' ` +
        `but was requested for entityId='${input.entityId}' — refusing to render an entity-specific ` +
        'template for the wrong entity.',
    );
  }

  const entityResult: QueryResult<EntityRow> = await pool.query(
    `select id, code, name_ar, name_en, legal_name_ar, legal_name_en, cr_number, tax_number,
            license_number, address_ar, address_en, phone, email, website, logo_url
       from platform.entities
      where id = $1`,
    [input.entityId],
  );
  const entity = entityResult.rows[0];
  if (!entity) {
    throw new Error(`renderDocument: no platform.entities row for id='${input.entityId}'`);
  }

  const compiledBody = Handlebars.compile(template.body_html);
  const bodyHtml = compiledBody(
    buildHandlebarsContext(entity, template.is_bilingual, input.data),
  );

  const fullHtml = composeFullHtml(bodyHtml, entity);

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    // No external network resources are fetched (the Cairo font is embedded as a data URI above,
    // and templates carry no remote images) — 'load' is the reliable wait condition here;
    // 'networkidle0' adds nothing for content with zero outstanding network requests.
    await page.setContent(fullHtml, { waitUntil: 'load' });
    const pdfBytes = await page.pdf(toPdfOptions(template.page_size, template.orientation));
    return { html: fullHtml, pdf: Buffer.from(pdfBytes) };
  } finally {
    await page.close();
  }
}
