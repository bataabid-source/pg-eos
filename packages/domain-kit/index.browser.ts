// WBS 0.14 — packages/domain-kit/index.browser.ts
//
// Browser barrel: re-exports the public API of Money, Quantity and Clock only.
//
// id-generator.ts imports `node:crypto` (createHash, randomUUID), which browser bundlers such as
// Vite cannot resolve and externalise, breaking apps/admin and apps/pda builds that only need
// Money/Quantity. This entry mirrors index.ts's export list minus id-generator so bundlers that
// honour the `browser` exports condition (packages/domain-kit/package.json) never reach
// node:crypto. Node consumers keep resolving `default` -> dist/index.js, which still exports
// IdGenerator/UuidGenerator/SequentialIdGenerator unchanged.

export * from './money.js';
export * from './quantity.js';
export * from './clock.js';
