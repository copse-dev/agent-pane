import { z } from 'zod'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

export const APPLE_DESKTOP_MAX_REQUEST = 16 * 1024
export const APPLE_DESKTOP_MAX_PNG = 4 * 1024 * 1024
export const appleDesktopRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('screenshot') }).strict(),
  z
    .object({
      action: z.literal('click'),
      x: z.number().int().min(0).max(1279),
      y: z.number().int().min(0).max(799),
      button: z.number().int().min(1).max(3).default(1),
    })
    .strict(),
  z.object({ action: z.literal('type'), text: z.string().max(2000) }).strict(),
  z
    .object({
      action: z.literal('key'),
      key: z
        .string()
        .max(80)
        .regex(
          /^(?:(?:ctrl|alt|shift|super)\+)*(?:[a-zA-Z0-9]|Return|Escape|Tab|BackSpace|Delete|space|Home|End|Left|Right|Up|Down|Page_Up|Page_Down|F(?:[1-9]|1[0-2]))$/,
        ),
    })
    .strict(),
  z.object({ action: z.literal('stop') }).strict(),
])

export function decodeAppleDesktopRequest(line: string): z.infer<typeof appleDesktopRequestSchema> {
  if (Buffer.byteLength(line) > APPLE_DESKTOP_MAX_REQUEST)
    throw new Error('Desktop request is too large')
  const request = safeJsonParse(line, decodeWithSchema(appleDesktopRequestSchema))
  if (!request) throw new Error('Invalid desktop request')
  return request
}
