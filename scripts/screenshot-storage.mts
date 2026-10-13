/** Stage the Git-to-R2 migration without deleting any reference screenshots. */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDirectExecution } from './lib/direct-execution.mts'
import {
  buildScreenshotManifest,
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  serializeScreenshotManifest,
  screenshotObjectKey,
  verifyScreenshot,
} from './lib/screenshot-manifest.mts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} before using R2 storage`)
  return value
}

function r2(args: string[]): void {
  const account = required('SCREENSHOT_R2_ACCOUNT_ID')
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid SCREENSHOT_R2_ACCOUNT_ID')
  execFileSync(
    'aws',
    [
      '--endpoint-url',
      `https://${account}.r2.cloudflarestorage.com`,
      '--region',
      'auto',
      's3api',
      ...args,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: required('SCREENSHOT_R2_ACCESS_KEY_ID'),
        AWS_SECRET_ACCESS_KEY: required('SCREENSHOT_R2_SECRET_ACCESS_KEY'),
        AWS_SESSION_TOKEN: '',
        AWS_PAGER: '',
      },
    },
  )
}

export async function screenshotStorage(command: string | undefined): Promise<void> {
  if (command === 'manifest') {
    writeFileSync(
      SCREENSHOT_MANIFEST,
      serializeScreenshotManifest(buildScreenshotManifest(SCREENSHOT_DIRECTORY)),
    )
    console.log(
      `Wrote ${SCREENSHOT_MANIFEST}; PNGs remain tracked until the review workflow migrates.`,
    )
    return
  }
  if (!['check', 'upload', 'download', 'verify'].includes(command ?? '')) {
    throw new Error('Usage: screenshot-storage.mts manifest|check|upload|download|verify')
  }
  const manifest = parseScreenshotManifest(readFileSync(SCREENSHOT_MANIFEST, 'utf8'))
  const entries = Object.entries(manifest.screenshots)
  if (command === 'check' || command === 'upload') {
    // Validate the complete input before any remote writes.
    for (const [name, entry] of entries) {
      const path = join(SCREENSHOT_DIRECTORY, name)
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error(`Not a regular screenshot: ${name}`)
      verifyScreenshot(readFileSync(path), entry)
    }
    if (command === 'check') {
      const actual = buildScreenshotManifest(SCREENSHOT_DIRECTORY)
      if (serializeScreenshotManifest(actual) !== serializeScreenshotManifest(manifest)) {
        throw new Error('Screenshot manifest is stale; run pnpm screenshots:manifest')
      }
      console.log(`Verified ${String(entries.length)} local screenshots`)
      return
    }
  }
  const publicUrl = process.env['SCREENSHOT_R2_PUBLIC_URL']?.trim()
  const bucket = command === 'upload' || !publicUrl ? required('SCREENSHOT_R2_BUCKET') : ''
  const staging = mkdtempSync(join(tmpdir(), 'copse-screenshots-'))
  try {
    const seen = new Set<string>()
    for (const [name, entry] of entries) {
      const key = screenshotObjectKey(entry)
      const local = join(SCREENSHOT_DIRECTORY, name)
      const temporary = join(staging, entry.sha256)
      if (command === 'download' && existsSync(local)) {
        if (!lstatSync(local).isFile() || lstatSync(local).isSymbolicLink())
          throw new Error(`Not a regular screenshot: ${name}`)
        // Preserve locally rendered candidates; never silently overwrite them.
        verifyScreenshot(readFileSync(local), entry)
        continue
      }
      if (!seen.has(key)) {
        if (command === 'upload') {
          try {
            r2([
              'put-object',
              '--bucket',
              bucket,
              '--key',
              key,
              '--body',
              local,
              '--content-type',
              'image/png',
              '--cache-control',
              'public, max-age=31536000, immutable',
              '--if-none-match',
              '*',
            ])
          } catch (error) {
            // Existing immutable objects are verified below, never overwritten.
            if (!(error instanceof Error) || !/PreconditionFailed/.test(error.message)) throw error
          }
        }
        if (publicUrl && command !== 'upload') {
          const base = new URL(`${publicUrl.replace(/\/$/, '')}/`)
          if (base.protocol !== 'https:') throw new Error('SCREENSHOT_R2_PUBLIC_URL must use HTTPS')
          const response = await fetch(new URL(key, base), { signal: AbortSignal.timeout(60_000) })
          if (!response.ok)
            throw new Error(`Screenshot download failed: HTTP ${String(response.status)}`)
          writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
        } else {
          r2(['get-object', '--bucket', bucket, '--key', key, temporary])
        }
        verifyScreenshot(readFileSync(temporary), entry)
        seen.add(key)
      }
      if (command === 'download') {
        mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true })
        const pending = join(SCREENSHOT_DIRECTORY, `.${name}.download`)
        writeFileSync(pending, readFileSync(temporary), { flag: 'wx' })
        renameSync(pending, local)
      }
    }
    console.log(
      `Verified ${String(entries.length)} screenshots${command === 'download' ? ' and restored missing PNGs' : ' in R2'}`,
    )
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (isDirectExecution(import.meta.url, 'screenshot-storage')) {
  screenshotStorage(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Screenshot storage failed')
    process.exitCode = 1
  })
}
