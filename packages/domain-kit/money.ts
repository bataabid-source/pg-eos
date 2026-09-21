// WBS 0.14 — packages/domain-kit/money.ts
//
// Money: numeric(14,3), currency KWD, three decimals. Never float (doc 40 §A3).
//
// Represented internally as a bigint scaled by 1000 (3 fractional decimal digits). All parsing
// and arithmetic goes through BigInt/string manipulation — never Number()/parseFloat() on the
// value itself — so there is no IEEE-754 drift.

const SCALE = 1000n;

// Optional sign, 1-11 integer digits, optional '.' + 1-3 fractional digits — matches
// numeric(14,3): at most 11 integer digits + 3 fractional digits = 14 total.
const DECIMAL_PATTERN = /^-?\d{1,11}(?:\.\d{1,3})?$/;

// A looser pattern for the `multiply` scalar: any signed decimal, no digit-count ceiling, since
// the scalar itself is not a stored numeric(14,3) value.
const SCALAR_PATTERN = /^-?\d+(?:\.\d+)?$/;

// The largest scaled magnitude a numeric(14,3) value can hold: 11 integer nines + 3 fractional
// nines, i.e. 99999999999.999 * SCALE. Every constructed amount — parsed or the result of
// arithmetic — must stay within [-MAX_MAGNITUDE, MAX_MAGNITUDE].
const MAX_MAGNITUDE = 99_999_999_999_999n;

const parseAmount = (value: string): bigint => {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new RangeError(
      `Money.of: expected an optional '-', 1-11 integer digits and at most 3 decimal digits ` +
        `(numeric(14,3)); got ${JSON.stringify(value)}`,
    );
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integerPart = '0', fractionalPart = ''] = unsigned.split('.');
  const paddedFraction = fractionalPart.padEnd(3, '0');
  const magnitude = BigInt(integerPart) * SCALE + BigInt(paddedFraction);

  return negative ? -magnitude : magnitude;
};

const formatAmount = (amount: bigint): string => {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const integerPart = absolute / SCALE;
  const fractionalPart = (absolute % SCALE).toString().padStart(3, '0');

  return `${negative ? '-' : ''}${integerPart.toString()}.${fractionalPart}`;
};

const parseScalar = (scalar: string): { unscaled: bigint; scale: bigint } => {
  if (!SCALAR_PATTERN.test(scalar)) {
    throw new RangeError(
      `Money.multiply: expected an optional '-', one or more integer digits and an optional ` +
        `'.' followed by one or more decimal digits; got ${JSON.stringify(scalar)}`,
    );
  }

  const negative = scalar.startsWith('-');
  const unsigned = negative ? scalar.slice(1) : scalar;
  const [integerPart = '0', fractionalPart = ''] = unsigned.split('.');
  const digits = `${integerPart}${fractionalPart}`;
  const unscaled = BigInt(digits);
  const scale = 10n ** BigInt(fractionalPart.length);

  return { unscaled: negative ? -unscaled : unscaled, scale };
};

// Round-half-up on a numerator/denominator pair of bigints (denominator > 0).
const divRoundHalfUp = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator === 1n) {
    return numerator;
  }

  const negative = numerator < 0n;
  const absNumerator = negative ? -numerator : numerator;
  const quotient = absNumerator / denominator;
  const remainder = absNumerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;

  return negative ? -rounded : rounded;
};

export class Money {
  static readonly CURRENCY = 'KWD';

  readonly currency: 'KWD' = Money.CURRENCY;

  readonly #amount: bigint;

  private constructor(amount: bigint) {
    this.#amount = amount;
  }

  // Shared factory every arithmetic method routes through: re-validates the result against the
  // same numeric(14,3) magnitude bound `of()` enforces on parse, so two in-range Money values can
  // never combine into an out-of-range one that a real numeric(14,3) column would reject.
  private static fromResult(amount: bigint, method: string, operandsDetail: string): Money {
    const absolute = amount < 0n ? -amount : amount;

    if (absolute > MAX_MAGNITUDE) {
      throw new RangeError(
        `Money.${method}: result "${formatAmount(amount)}" exceeds numeric(14,3) ` +
          `(max 11 integer digits); ${operandsDetail}`,
      );
    }

    return new Money(amount);
  }

  static of(value: string): Money {
    return new Money(parseAmount(value));
  }

  static zero(): Money {
    return new Money(0n);
  }

  add(other: Money): Money {
    return Money.fromResult(
      this.#amount + other.#amount,
      'add',
      `operands were "${this.toString()}" and "${other.toString()}"`,
    );
  }

  subtract(other: Money): Money {
    return Money.fromResult(
      this.#amount - other.#amount,
      'subtract',
      `operands were "${this.toString()}" and "${other.toString()}"`,
    );
  }

  multiply(scalar: string): Money {
    const { unscaled, scale } = parseScalar(scalar);
    const product = this.#amount * unscaled;

    return Money.fromResult(
      divRoundHalfUp(product, scale),
      'multiply',
      `operand was "${this.toString()}" and scalar was ${JSON.stringify(scalar)}`,
    );
  }

  negate(): Money {
    return Money.fromResult(-this.#amount, 'negate', `operand was "${this.toString()}"`);
  }

  compare(other: Money): -1 | 0 | 1 {
    if (this.#amount < other.#amount) {
      return -1;
    }
    if (this.#amount > other.#amount) {
      return 1;
    }
    return 0;
  }

  equals(other: Money): boolean {
    return this.#amount === other.#amount;
  }

  isZero(): boolean {
    return this.#amount === 0n;
  }

  isNegative(): boolean {
    return this.#amount < 0n;
  }

  isPositive(): boolean {
    return this.#amount > 0n;
  }

  toString(): string {
    return formatAmount(this.#amount);
  }
}
