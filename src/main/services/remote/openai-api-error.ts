import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const errorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.string().nullish(),
    param: z.string().nullish(),
  }),
})

/** Bounded diagnostics for the user, not an upstream response/body logger. */
export async function openAiApiError(
  response: Response,
  operation: string,
  apiKey: string,
): Promise<Error> {
  const redact = (value: string): string => redactOpenAiDiagnostic(value, apiKey)
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  let detail: z.infer<typeof errorSchema> | null = null
  try {
    if (reader)
      for (;;) {
        const next = await reader.read()
        if (next.done) {
          detail = safeJsonParse(
            Buffer.concat(chunks).toString('utf8'),
            decodeWithSchema(errorSchema),
          )
          break
        }
        bytes += next.value.byteLength
        if (bytes > 64 * 1024) break
        chunks.push(next.value)
      }
  } catch {
    // Preserve the HTTP failure even when its response cannot be read.
  } finally {
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
  const fields = [detail?.error.code, detail?.error.param]
    .filter(Boolean)
    .map((value) => redact(value ?? ''))
  const requestId = response.headers.get('x-request-id')
  const reason = detail?.error.message ? ` ${redact(detail.error.message)}` : ''
  const auth =
    response.status === 401 || response.status === 403 ? ' Check Platform API-key permissions.' : ''
  return new Error(
    `OpenAI Agents API HTTP ${String(response.status)} (${operation}).${reason}${fields.length ? ` (${fields.join('; ')})` : ''}${auth}${requestId ? ` Request ID: ${redact(requestId)}.` : ''}`,
  )
}

export const redactOpenAiDiagnostic = (value: string, apiKey: string): string =>
  value
    .split(apiKey)
    .join('[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/data:[^\s,]+,[A-Za-z0-9+/=]+/g, '[image data]')
    .replace(/https?:\/\/[^\s]+/g, '[URL]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\`*_<>[\]#]/g, '\\$&')
    .slice(0, 600)
