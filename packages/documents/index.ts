// packages/documents/index.ts — WBS 0.15.
//
// Barrel: the package's public surface. render-document.test.ts imports directly from
// './src/render.js', not from this barrel — that's fine per the WBS 0.15 brief (same precedent
// as packages/events/index.ts); this barrel exists for future consumers of @pg-eos/documents
// (e.g. a module wiring platform.document_bindings' auto-generate-on-state-transition flow, out
// of this slice's scope per the test file's own "SCOPE" header).

export type { RenderDocumentInput, RenderDocumentResult } from './src/render.js';
export { closeBrowser, renderDocument } from './src/render.js';
