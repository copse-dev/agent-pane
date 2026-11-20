import { createHash } from 'node:crypto'

/**
 * Lowercase hex SHA-256 of `data`, in one shot. A string is hashed as UTF-8
 * (the `Hash.update` default). Node-only; streaming or multi-part input should
 * keep using `createHash` directly.
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
