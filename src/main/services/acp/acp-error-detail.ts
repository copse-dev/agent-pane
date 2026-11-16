import { errorMessage } from '@shared/errors.ts'

const ACP_ERROR_DETAIL_LIMIT = 2_000

function truncateAcpErrorDetail(value: string): string {
  return value.length <= ACP_ERROR_DETAIL_LIMIT
    ? value
    : `${value.slice(0, ACP_ERROR_DETAIL_LIMIT)}...`
}

function acpErrorDataDetail(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    const data = Reflect.get(err, 'data')
    if (typeof data === 'string') return truncateAcpErrorDetail(data)
    if (typeof data === 'object' && data !== null && 'details' in data) {
      const details = Reflect.get(data, 'details')
      if (typeof details === 'string') return truncateAcpErrorDetail(details)
    }
    try {
      const encoded = JSON.stringify(data)
      return typeof encoded === 'string' ? truncateAcpErrorDetail(encoded) : null
    } catch {
      return null
    }
  }
  if (err instanceof Error && err.cause) return acpErrorDataDetail(err.cause)
  return null
}

/**
 * An ACP failure's message plus its JSON-RPC `error.data` detail (the adapter's
 * stderr, typically), searched through the `cause` chain and truncated.
 */
export function acpErrorMessage(err: unknown): string {
  const message = errorMessage(err)
  const detail = acpErrorDataDetail(err)
  if (!detail || message.includes(detail)) return message
  return `${message}: ${detail}`
}
