import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import extractZip from 'extract-zip'

/**
 * The Chrome for Testing build the browser tier renders with. Without a pin,
 * WebdriverIO uses whatever Google Chrome the runner image has installed, so a
 * GitHub image update changes every PR's demo run at once: on 2026-11-25,
 * Chrome 157 -> 158 failed `landing-cupcake-walkthrough` on every open PR
 * (#4506), and a new build can move browser reference screenshots that no PR
 * touched.
 *
 * CI installs this build with `node scripts/install-demo-chrome.mts`, which
 * checks both zips against the sha256 values below. WebdriverIO's own install
 * (`@puppeteer/browsers` without `expectedHash`) verifies nothing.
 *
 * Bump it in its own PR:
 * 1. Pick a version from
 *    https://googlechromelabs.github.io/chrome-for-testing/known-good-versions.json.
 * 2. Set `version`, then run `node scripts/install-demo-chrome.mts --print-hashes`
 *    on a trusted machine and copy the two sha256 values it prints into
 *    `sha256`. Chrome for Testing publishes no hashes of its own, so these
 *    record what you downloaded; CI then refuses any other bytes.
 * 3. Let CI render it, fix any spec it breaks, and accept the screenshot
 *    candidates it produces in that PR.
 */
export const DEMO_CHROME_PIN = {
  version: '158.0.8127.36',
  sha256: {
    'chrome-linux64': 'dba9cc838e1ce269c33ea68170881127bd15d078fc3ca5891c90802819a4d7c7',
    'chromedriver-linux64': 'd20e70d69d68c5c983e2526452ed0779fd65dc4ade5d6741f1bb3d0d82754d3a',
  },
} as const

export type DemoChromeAsset = keyof typeof DEMO_CHROME_PIN.sha256

export interface DemoChromePin {
  version: string
  sha256: Readonly<Record<DemoChromeAsset, string>>
}

export interface DemoChromeInstall {
  chrome: string
  chromedriver: string
}

export interface InstallOptions {
  /** Directory the zips and unpacked builds live under. */
  root: string
  pin?: DemoChromePin
  fetchImpl?: typeof fetch
  log?: (line: string) => void
  /** Runs `<binary> --version` and resolves its stdout. */
  readVersion?: (binary: string) => Promise<string>
}

const ASSETS: readonly DemoChromeAsset[] = ['chrome-linux64', 'chromedriver-linux64']
const BINARY: Readonly<Record<DemoChromeAsset, string>> = {
  'chrome-linux64': 'chrome-linux64/chrome',
  'chromedriver-linux64': 'chromedriver-linux64/chromedriver',
}

export function demoChromeUrl(version: string, asset: DemoChromeAsset): string {
  return `https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/${asset}.zip`
}

export function defaultDemoChromeRoot(cwd: string = process.cwd()): string {
  return resolve(cwd, '.cache/demo-chrome')
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function fetchBytes(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`Download failed (${String(response.status)}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Hash the download before anything touches disk; only matching bytes are written. */
async function downloadVerified(
  url: string,
  dest: string,
  expected: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const bytes = await fetchBytes(url, fetchImpl)
  const actual = sha256Of(bytes)
  if (actual !== expected) {
    throw new Error(
      `sha256 mismatch for ${url}: expected ${expected}, got ${actual}. ` +
        'Refusing to unpack it. If you are bumping DEMO_CHROME_PIN, record the new hash in ' +
        'scripts/lib/demo-chrome.mts.',
    )
  }
  const partial = `${dest}.partial`
  try {
    await writeFile(partial, bytes)
    await rename(partial, dest)
  } finally {
    await rm(partial, { force: true })
  }
}

/** Download both zips for `version` and report their sha256, for a pin bump. */
export async function demoChromeHashes(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<DemoChromeAsset, string>> {
  return {
    'chrome-linux64': sha256Of(
      await fetchBytes(demoChromeUrl(version, 'chrome-linux64'), fetchImpl),
    ),
    'chromedriver-linux64': sha256Of(
      await fetchBytes(demoChromeUrl(version, 'chromedriver-linux64'), fetchImpl),
    ),
  }
}

const execFileAsync = promisify(execFile)

async function binaryVersion(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 30_000 })
  return stdout
}

/**
 * Install the pinned Chrome for Testing build and its chromedriver under
 * `root`. A zip already on disk is re-hashed and reused only if it still
 * matches; the unpacked tree is always rebuilt from verified zips, so nothing
 * a previous job left behind is trusted.
 */
export async function installDemoChrome(options: InstallOptions): Promise<DemoChromeInstall> {
  const pin = options.pin ?? DEMO_CHROME_PIN
  const fetchImpl = options.fetchImpl ?? fetch
  const log =
    options.log ??
    ((line: string): void => {
      console.log(line)
    })
  const readVersion = options.readVersion ?? binaryVersion
  const versionDir = join(resolve(options.root), pin.version)
  const unpacked = join(versionDir, 'unpacked')
  await mkdir(versionDir, { recursive: true })
  await rm(unpacked, { recursive: true, force: true })

  for (const asset of ASSETS) {
    const expected = pin.sha256[asset]
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`DEMO_CHROME_PIN has no valid sha256 for ${asset}`)
    }
    const zip = join(versionDir, `${asset}.zip`)
    if (existsSync(zip) && (await sha256OfFile(zip)) === expected) {
      log(`[demo-chrome] reusing verified ${asset}.zip`)
    } else {
      await rm(zip, { force: true })
      const url = demoChromeUrl(pin.version, asset)
      log(`[demo-chrome] downloading ${url}`)
      await downloadVerified(url, zip, expected, fetchImpl)
    }
    log(`[demo-chrome] ${asset}.zip sha256 ${expected} verified`)
    await extractZip(zip, { dir: unpacked })
  }

  const install: DemoChromeInstall = {
    chrome: join(unpacked, BINARY['chrome-linux64']),
    chromedriver: join(unpacked, BINARY['chromedriver-linux64']),
  }
  for (const binary of [install.chrome, install.chromedriver]) {
    const reported = await readVersion(binary)
    if (!reported.includes(pin.version)) {
      throw new Error(`${binary} reports ${JSON.stringify(reported.trim())}, not ${pin.version}`)
    }
  }
  return install
}
