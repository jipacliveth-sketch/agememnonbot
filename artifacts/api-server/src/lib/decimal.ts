/**
 * Decimal helpers for money and token quantities.
 *
 * Values are represented as fixed-point bigint values while arithmetic is
 * performed. This keeps balance and reservation decisions independent of
 * IEEE-754 rounding. Database numeric columns still receive decimal strings.
 */
export function parseFixed(value: string | number | bigint, scale = 12): bigint {
  const raw = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`Invalid decimal value: ${raw}`);
  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  if (fraction.length > scale) throw new Error(`Too many decimal places for scale ${scale}`);
  const units = BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -units : units;
}

export function formatFixed(value: bigint | string | number, scale = 12, decimals = scale): string {
  const units = typeof value === "bigint" ? value : parseFixed(String(value), scale);
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const factor = 10n ** BigInt(scale);
  const whole = absolute / factor;
  const fraction = (absolute % factor).toString().padStart(scale, "0").slice(0, decimals);
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

export function assertPositive(value: string, scale = 12): bigint {
  const parsed = parseFixed(value, scale);
  if (parsed <= 0n) throw new Error("Amount must be greater than zero.");
  return parsed;
}

export function unsignedDecimal(value: bigint, scale = 12): string {
  return formatFixed(value < 0n ? -value : value, scale, scale);
}

export function signedDecimal(value: bigint, scale = 12): string {
  return formatFixed(value, scale, scale);
}