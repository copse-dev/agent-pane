/**
 * Zod helpers for JSON producers that send `null` for an absent field instead
 * of omitting it (`gh --json`, the remote and managed agent APIs). Each folds
 * `null` into `undefined` before validating, so the parsed value is `T |
 * undefined` and callers never see `null`.
 */
import { z } from 'zod'

/** Accept `null` wherever `schema` accepts `undefined`, and parse it as `undefined`. */
export function nullAsUndefined<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value) => (value === null ? undefined : value), schema)
}

/** An optional string field that may arrive as `null`. */
export const optionalString = nullAsUndefined(z.string().optional())

/** An optional number field that may arrive as `null`. */
export const optionalNumber = nullAsUndefined(z.number().optional())
