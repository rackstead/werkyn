import { ValidationError } from "../../utils/errors.js";

const MAX_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);
const RANGE_MESSAGE = "Report cost exceeds the supported monetary precision";

interface Decimal {
  coefficient: bigint;
  exponent: number;
}

/** Interpret the persisted Number's decimal spelling, not its binary product. */
function decimal(value: number): Decimal {
  if (!Number.isFinite(value)) throw new ValidationError(RANGE_MESSAGE);
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(value.toString());
  if (!match) throw new ValidationError(RANGE_MESSAGE);
  const fraction = match[3] ?? "";
  return {
    coefficient: BigInt(match[2] + fraction) * (match[1] ? -1n : 1n),
    exponent: Number(match[4] ?? 0) - fraction.length,
  };
}

function power(exponent: number): bigint {
  // Finite Number spellings have bounded exponents; no arbitrary decimal input.
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 800) {
    throw new ValidationError(RANGE_MESSAGE);
  }
  return 10n ** BigInt(exponent);
}

function checkDigits(fractionDigits: number) {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 100) {
    throw new ValidationError(RANGE_MESSAGE);
  }
}

/** Currency minor-unit precision, retaining the existing unknown-code fallback. */
export function currencyFractionDigits(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en-US", { style: "currency", currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
    checkDigits(digits);
    return digits;
  } catch (error) {
    if (error instanceof RangeError) return 2;
    throw error;
  }
}

/** Exact hours × rate, rounded once to currency units; ties go away from zero. */
export function roundedCostUnits(hours: number, rate: number, fractionDigits: number): bigint {
  checkDigits(fractionDigits);
  const left = decimal(hours);
  const right = decimal(rate);
  const coefficient = left.coefficient * right.coefficient;
  const exponent = left.exponent + right.exponent + fractionDigits;
  if (exponent >= 0) return coefficient * power(exponent);
  const divisor = power(-exponent);
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  const quotient = magnitude / divisor;
  const rounded = quotient + (2n * (magnitude % divisor) >= divisor ? 1n : 0n);
  return coefficient < 0n ? -rounded : rounded;
}

/**
 * Keep the numeric report API only where its JSON decimal spelling preserves
 * every rounded unit. Check rows AND accumulated totals; never emit a blank or
 * silently imprecise monetary amount.
 */
export function reportMoneyNumber(units: bigint, fractionDigits: number): number {
  checkDigits(fractionDigits);
  const magnitude = units < 0n ? -units : units;
  if (magnitude > MAX_MINOR_UNITS) throw new ValidationError(RANGE_MESSAGE);
  const digits = magnitude.toString().padStart(fractionDigits + 1, "0");
  const fixed = fractionDigits === 0
    ? digits
    : `${digits.slice(0, -fractionDigits)}.${digits.slice(-fractionDigits)}`;
  const value = Number((units < 0n ? "-" : "") + fixed);
  const spelled = decimal(value);
  const exponent = spelled.exponent + fractionDigits;
  let restored: bigint;
  if (exponent >= 0) {
    restored = spelled.coefficient * power(exponent);
  } else {
    const divisor = power(-exponent);
    if (spelled.coefficient % divisor !== 0n) throw new ValidationError(RANGE_MESSAGE);
    restored = spelled.coefficient / divisor;
  }
  if (restored !== units) throw new ValidationError(RANGE_MESSAGE);
  return value;
}
