import { updateScreenshotReadme } from './lib/screenshot-review-manifest.mts'
import { acceptScreenshotManifest } from './lib/screenshot-accept.mts'
/** Stage the Git-to-R2 migration without deleting any reference screenshots. */
import { execFile } from 'node:child_process'
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
import { promisify } from 'node:util'
import { hydrateScreenshots } from './lib/screenshot-hydration.mts'
import { changedLocalScreenshots } from './lib/screenshot-git.mts'
import { isDirectExecution } from './lib/direct-execution.mts'
import {
  buildScreenshotManifest,
  parseScreenshotManifest,
  SCREENSHOT_DIRECTORY,
  SCREENSHOT_MANIFEST,
  serializeScreenshotManifest,
  changedManifestNames,
  type ScreenshotManifest,
  screenshotObjectKey,
  verifyScreenshot,
} from './lib/screenshot-manifest.mts'

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Set ${name} before using R2 storage`)
  return value
}

const runAws = promisify(execFile)

async function r2(args: string[]): Promise<void> {
  const account = required('SCREENSHOT_R2_ACCOUNT_ID')
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error('Invalid SCREENSHOT_R2_ACCOUNT_ID')
  await runAws(
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
      timeout: 180_000,
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

export async function screenshotStorage(
  command: string | undefined,
  options: { directory?: string; manifestPath?: string } = {},
): Promise<void> {
  const directory = options.directory ?? SCREENSHOT_DIRECTORY
  const manifestPath = options.manifestPath ?? SCREENSHOT_MANIFEST
  if (command === 'accept') {
    const index = process.argv.indexOf('--from')
    const ref = process.argv[index + 1]
    const names = process.argv.slice(index + 2)
    if (index < 0 || !ref || !names.length)
      throw new Error('Usage: screenshots:accept --from <ref> <name.png> ...')
    await acceptScreenshotManifest(ref, names)
    return
  }
  if (
    command === 'verify' &&
    (process.env['SCREENSHOT_R2_PUBLIC_URL'] || !process.env['SCREENSHOT_R2_ACCESS_KEY_ID'])
  ) {
    await hydrateScreenshots({ restore: false, verifyRemote: true })
    return
  }
  if (command === 'validate') {
    const manifest = parseScreenshotManifest(readFileSync(manifestPath, 'utf8'))
    console.log(`Validated ${String(Object.keys(manifest.screenshots).length)} screenshot hashes`)
    return
  }
  if (command === 'hydrate') {
    await hydrateScreenshots({
      history: process.argv.includes('--history'),
      restore: !process.argv.includes('--history'),
    })
    return
  }
  if (command === 'changed') {
    for (const path of changedLocalScreenshots(directory)) console.log(path)
    return
  }
  if (command === 'manifest') {
    const before: ScreenshotManifest = existsSync(manifestPath)
      ? parseScreenshotManifest(readFileSync(manifestPath, 'utf8'))
      : { version: 1, screenshots: {} }
    const rendered = buildScreenshotManifest(directory)
    const after = parseScreenshotManifest(
      serializeScreenshotManifest({
        version: 1,
        screenshots: { ...before.screenshots, ...rendered.screenshots },
      }),
    )
    writeFileSync(manifestPath, serializeScreenshotManifest(after))
    if (directory === SCREENSHOT_DIRECTORY && existsSync('README.md'))
      writeFileSync(
        'README.md',
        updateScreenshotReadme(readFileSync('README.md', 'utf8'), before, after),
      )
    console.log(
      `Recorded ${String(changedManifestNames(before, after).length)} screenshot hash changes; upload before committing the manifest`,
    )
    return
  }
  if (!['check', 'upload', 'download', 'verify'].includes(command ?? '')) {
    throw new Error(
      'Usage: screenshot-storage.mts manifest|check|upload|download|verify|hydrate|changed|validate|accept',
    )
  }
  const manifest = parseScreenshotManifest(readFileSync(manifestPath, 'utf8'))
  const entries = Object.entries(manifest.screenshots)
  if (command === 'check' || command === 'upload') {
    // Validate the complete input before any remote writes.
    for (const [name, entry] of entries) {
      const path = join(directory, name)
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error(`Not a regular screenshot: ${name}`)
      verifyScreenshot(readFileSync(path), entry)
    }
    if (command === 'check') {
      const actual = buildScreenshotManifest(directory)
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
    if (command === 'upload') {
      const objects = [
        ...new Map(entries.map(([name, entry]) => [entry.sha256, { name, entry }])).values(),
      ]
      const workers = 4
      let completed = 0
      console.log(
        `Uploading and verifying ${String(objects.length)} unique objects with ${String(workers)} workers`,
      )
      for (let offset = 0; offset < objects.length; offset += workers) {
        // Settle the whole batch before deleting staging on failure. No later
        // batch starts if an object failed upload or integrity verification.
        const results = await Promise.allSettled(
          objects.slice(offset, offset + workers).map(async ({ name, entry }) => {
            const key = screenshotObjectKey(entry)
            try {
              await r2([
                'put-object',
                '--bucket',
                bucket,
                '--key',
                key,
                '--body',
                join(directory, name),
                '--content-type',
                'image/png',
                '--cache-control',
                'public, max-age=31536000, immutable',
                '--if-none-match',
                '*',
              ])
            } catch (error) {
              if (!(error instanceof Error) || !/PreconditionFailed/.test(error.message))
                throw error
            }
            const temporary = join(staging, entry.sha256)
            await r2(['get-object', '--bucket', bucket, '--key', key, temporary])
            verifyScreenshot(readFileSync(temporary), entry)
            completed++
            if (completed <= workers || completed % 25 === 0 || completed === objects.length) {
              console.log(
                `Verified ${String(completed)}/${String(objects.length)} objects (${name})`,
              )
            }
          }),
        )
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason
        }
      }
      console.log(`Verified ${String(entries.length)} screenshots in R2`)
      return
    }
    const seen = new Set<string>()
    for (const [name, entry] of entries) {
      const key = screenshotObjectKey(entry)
      const local = join(directory, name)
      const temporary = join(staging, entry.sha256)
      if (command === 'download' && existsSync(local)) {
        if (!lstatSync(local).isFile() || lstatSync(local).isSymbolicLink())
          throw new Error(`Not a regular screenshot: ${name}`)
        // Preserve locally rendered candidates; never silently overwrite them.
        verifyScreenshot(readFileSync(local), entry)
        continue
      }
      if (!seen.has(key)) {
        if (publicUrl) {
          const base = new URL(`${publicUrl.replace(/\/$/, '')}/`)
          if (base.protocol !== 'https:') throw new Error('SCREENSHOT_R2_PUBLIC_URL must use HTTPS')
          const response = await fetch(new URL(key, base), { signal: AbortSignal.timeout(60_000) })
          if (!response.ok)
            throw new Error(`Screenshot download failed: HTTP ${String(response.status)}`)
          writeFileSync(temporary, Buffer.from(await response.arrayBuffer()))
        } else {
          await r2(['get-object', '--bucket', bucket, '--key', key, temporary])
        }
        verifyScreenshot(readFileSync(temporary), entry)
        seen.add(key)
      }
      if (command === 'download') {
        mkdirSync(directory, { recursive: true })
        const pending = join(directory, `.${name}.download`)
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
  screenshotStorage(process.argv[2], {
    ...(process.argv.includes('--dir')
      ? { directory: process.argv[process.argv.indexOf('--dir') + 1] ?? '' }
      : {}),
    ...(process.argv.includes('--manifest')
      ? { manifestPath: process.argv[process.argv.indexOf('--manifest') + 1] ?? '' }
      : {}),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Screenshot storage failed')
    process.exitCode = 1
  })
}
