import { z } from 'zod'
import { signatureGridFor, signatureLength } from '@shared/video/frame-selection.ts'
import { MAX_SAMPLES_PER_CALL, type DecodeFramesResponse } from '@shared/video/decode-contract.ts'

const requestId = z.uuid()
const finiteNonnegative = z.number().nonnegative()
const encodedJpeg = z
  .string()
  .max(20_000_000)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)

const frame = z.strictObject({
  time: finiteNonnegative,
  signature: z.array(z.number().int().min(0).max(255)).max(64 * 64 * 3),
  dataUrl: encodedJpeg.nullable(),
})

const success = z
  .strictObject({
    requestId,
    ok: z.literal(true),
    durationSeconds: z.number().positive(),
    sourceWidth: z.number().int().nonnegative(),
    sourceHeight: z.number().int().nonnegative(),
    frameWidth: z.number().int().positive().max(1920),
    frameHeight: z.number().int().positive().max(1920),
    sampleIntervalSeconds: z.number().positive(),
    frames: z.array(frame).max(MAX_SAMPLES_PER_CALL),
  })
  .refine(
    (result) =>
      result.frames.every(
        (item) =>
          item.signature.length ===
          signatureLength(signatureGridFor(result.frameWidth, result.frameHeight)),
      ),
    { message: 'Frame signature does not match the decoded dimensions' },
  )

const failure = z.strictObject({
  requestId,
  ok: z.literal(false),
  error: z.string().max(8192),
})

const response = z.discriminatedUnion('ok', [success, failure])

/** IPC payloads are untrusted even when they came from the designated decoder frame. */
export function parseDecodeResponse(value: unknown): DecodeFramesResponse | null {
  const parsed = response.safeParse(value)
  return parsed.success ? parsed.data : null
}
