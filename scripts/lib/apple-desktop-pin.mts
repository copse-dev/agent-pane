import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { copseDataRoot } from '@copse/store-kit/copse-paths.ts'
import { safeJsonParse, decodeWithSchema } from '@copse/std/safe-json.ts'

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const receiptSchema = z.object({ version: z.literal(1), digest: digestSchema }).strict()
const imageSchema = z
  .array(
    z.object({
      configuration: z.object({ descriptor: z.object({ digest: digestSchema }) }),
      variants: z.array(
        z.object({
          digest: digestSchema,
          platform: z.object({ architecture: z.string(), os: z.string() }),
        }),
      ),
    }),
  )
  .length(1)

function pinDirectory(env: NodeJS.ProcessEnv): string {
  return join(copseDataRoot(env), 'isolated-desktop')
}

/** Validate the actual local engine response before trusting a completed build. */
export function appleDesktopBuiltImageDigest(json: string): string {
  const image = safeJsonParse(json, decodeWithSchema(imageSchema))?.[0]
  if (
    !image ||
    !image.variants.some(
      (variant) => variant.platform.architecture === 'arm64' && variant.platform.os === 'linux',
    )
  )
    throw new Error('Desktop image inspection lacks a valid Linux arm64 image digest')
  return image.configuration.descriptor.digest
}

/** Only the explicit local builder writes this receipt; guests never receive its directory. */
export async function pinAppleDesktopBuild(
  inspectJson: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const digest = appleDesktopBuiltImageDigest(inspectJson)
  const directory = pinDirectory(env)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, 'image-pin-' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, digest }) + '\n', {
      mode: 0o600,
      flag: 'wx',
    })
    await rename(temporary, join(directory, 'image-pin.json'))
  } finally {
    await rm(temporary, { force: true })
  }
  return digest
}

/** Fail closed on missing, corrupt, linked or other-user receipts. No mutable-tag fallback. */
export async function readAppleDesktopPin(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  try {
    const file = await open(
      join(pinDirectory(env), 'image-pin.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      const stat = await file.stat()
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o022) !== 0
      )
        throw new Error('Desktop image pin must be an owner-controlled regular file')
      const receipt = safeJsonParse(await file.readFile('utf8'), decodeWithSchema(receiptSchema))
      if (!receipt) throw new Error('Desktop image pin is invalid')
      return receipt.digest
    } finally {
      await file.close()
    }
  } catch (error) {
    throw new Error(
      'No trusted desktop image pin; run node scripts/build-apple-desktop.mts for this COPSE_DIR',
      { cause: error },
    )
  }
}

/** Inspect the created, still-stopped container: tag changes cannot substitute another image. */
export function verifyAppleDesktopCreatedImage(inspectJson: string, digest: string): void {
  const schema = z
    .array(
      z.object({
        configuration: z.object({
          image: z.object({ descriptor: z.object({ digest: digestSchema }) }),
          platform: z.object({ architecture: z.literal('arm64'), os: z.literal('linux') }),
        }),
      }),
    )
    .length(1)
  const created = safeJsonParse(inspectJson, decodeWithSchema(schema))?.[0]
  if (!created || created.configuration.image.descriptor.digest !== digestSchema.parse(digest))
    throw new Error('Refusing desktop startup: created image does not match the trusted build pin')
}
