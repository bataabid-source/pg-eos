// packages/contracts/_shared/serialize.ts — WBS 0.13 (rework round 2, reviewer finding 17).
//
// The on-disk serialization format for an OpenAPI document was a literal (`JSON.stringify(doc,
// null, 2) + '\n'`) duplicated wherever it was needed. One exported function, used by
// scripts/generate-openapi.ts's `writeOpenApiDocument`, so the format is defined exactly once.

import type { OpenApiDocument } from './registry.js';

const JSON_SERIALIZATION_INDENT = 2;

/** Serializes an OpenAPI document to the exact on-disk format: JSON indented with two spaces,
 * followed by a single trailing newline. */
export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, JSON_SERIALIZATION_INDENT)}\n`;
}
