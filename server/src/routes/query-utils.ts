import { HttpError } from "../errors.js";

/**
 * Coerces a query-param value to boolean.
 * Accepts `true`, `"true"`, and `"1"` as truthy; everything else is false.
 */
export function parseBooleanQuery(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/**
 * Parses a query-param string value to a `Date`.
 * Returns `undefined` for absent / blank values.
 * Throws HTTP 400 if the value is present but not a valid date.
 */
export function parseDateQuery(value: unknown, field: string): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `Invalid ${field} query value`);
  }
  return parsed;
}
