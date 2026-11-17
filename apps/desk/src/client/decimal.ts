/** Exact fractions of decimal integers. Division (JPY conversion and average) stays exact. */
export interface Decimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}
export function fraction(numerator: bigint, denominator = 1n): Decimal {
  if (denominator === 0n) throw new Error("division by zero");
  if (denominator < 0n) return fraction(-numerator, -denominator);
  let first = numerator < 0n ? -numerator : numerator;
  let second = denominator;
  while (second) [first, second] = [second, first % second];
  return { numerator: numerator / first, denominator: denominator / first };
}
export const zero = fraction(0n);
export function decimal(value: string): Decimal {
  const [whole = "0", places = ""] = value.split(".");
  return fraction(BigInt(whole + places), 10n ** BigInt(places.length));
}
export const add = (left: Decimal, right: Decimal) =>
  fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
export const negate = (value: Decimal) => fraction(-value.numerator, value.denominator);
export const subtract = (left: Decimal, right: Decimal) => add(left, negate(right));
export const multiply = (left: Decimal, right: Decimal) =>
  fraction(left.numerator * right.numerator, left.denominator * right.denominator);
export const divide = (left: Decimal, right: Decimal) =>
  fraction(left.numerator * right.denominator, left.denominator * right.numerator);
/** Signed round-half-to-even, used only at a presentation boundary or per-pair USD cents. */
export function rounded(value: Decimal, places: number): bigint {
  const scaled = value.numerator * 10n ** BigInt(places);
  const absolute = scaled < 0n ? -scaled : scaled;
  const whole = absolute / value.denominator;
  const remainder = absolute % value.denominator;
  const up =
    remainder * 2n > value.denominator ||
    (remainder * 2n === value.denominator && whole % 2n !== 0n);
  return (whole + BigInt(up)) * (scaled < 0n ? -1n : 1n);
}
export function format(value: Decimal | null, places: number): string {
  if (value === null) return "—";
  const integer = rounded(value, places);
  const digits = (integer < 0n ? -integer : integer).toString().padStart(places + 1, "0");
  return `${integer < 0n ? "-" : ""}${places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits}`;
}
