// WBS 0.14 — packages/domain-kit/id-generator.ts
//
// Keys: uuid (gen_random_uuid()) (doc 40 §A3). Ids must be well-formed UUID v4 strings matching
// Postgres's format. Uses Node's `crypto` module only — never Math.random().

import { createHash, randomUUID } from 'node:crypto';

export interface IdGenerator {
  next(): string;
}

export class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

// Deterministic, strictly-increasing UUID v4-shaped id generator for tests and reproducible
// fixtures: the seed derives a stable prefix (via SHA-256, not Math.random()), and an
// incrementing counter fills the trailing hex digits — the version (4) and variant (8/9/a/b)
// nibbles stay fixed, and the fixed-width zero-padded counter keeps string ordering strictly
// increasing.
export class SequentialIdGenerator implements IdGenerator {
  readonly #prefixGroup1: string;
  readonly #prefixGroup2: string;
  readonly #prefixGroup3: string;
  readonly #prefixGroup4: string;
  #counter = 0n;

  constructor(seed: number) {
    const digest = createHash('sha256').update(String(seed)).digest('hex');

    this.#prefixGroup1 = digest.slice(0, 8);
    this.#prefixGroup2 = digest.slice(8, 12);
    this.#prefixGroup3 = `4${digest.slice(12, 15)}`;

    const variantSourceNibble = parseInt(digest[15] ?? '0', 16);
    const variantNibble = (variantSourceNibble & 0x3) | 0x8;
    this.#prefixGroup4 = `${variantNibble.toString(16)}${digest.slice(16, 19)}`;
  }

  next(): string {
    const counterHex = this.#counter.toString(16).padStart(12, '0');
    const id = `${this.#prefixGroup1}-${this.#prefixGroup2}-${this.#prefixGroup3}-${this.#prefixGroup4}-${counterHex}`;

    this.#counter += 1n;

    return id;
  }
}
