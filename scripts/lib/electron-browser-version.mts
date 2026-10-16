import { execFileSync } from 'node:child_process'

type ReadExecutableVersion = (executable: string, args: string[], env?: NodeJS.ProcessEnv) => string

const CHROMIUM_VERSION = /^\d+\.\d+\.\d+\.\d+$/
const CHROMEDRIVER_VERSION = /^ChromeDriver (\d+\.\d+\.\d+\.\d+)(?:\s|$)/

function readExecutableVersion(
  executable: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): string {
  return execFileSync(executable, args, { encoding: 'utf8', env }).trim()
}

function major(version: string): string {
  return version.slice(0, version.indexOf('.'))
}

/**
 * Resolve the WebDriver capability from the binaries that will actually run.
 *
 * Electron and electron-chromedriver are updated as a package group, but the
 * capability used to repeat a copied version literal. Electron 44 moved to
 * Chromium 152 while that literal stayed on Chromium 150, so ChromeDriver
 * repeatedly launched and tore down Electron during session negotiation on
 * macOS. Reading the runtime also makes a mismatched driver fail before a GUI
 * process is started.
 */
export function resolveElectronBrowserVersion(
  electronBinary: string,
  chromedriverBinary: string,
  readVersion: ReadExecutableVersion = readExecutableVersion,
): string {
  const electronVersion = readVersion(electronBinary, ['-p', 'process.versions.chrome'], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  }).trim()
  if (!CHROMIUM_VERSION.test(electronVersion)) {
    throw new Error(
      `Electron reported an invalid Chromium version: ${electronVersion || '(empty)'}`,
    )
  }

  const driverOutput = readVersion(chromedriverBinary, ['--version']).trim()
  const driverVersion = CHROMEDRIVER_VERSION.exec(driverOutput)?.[1]
  if (!driverVersion) {
    throw new Error(`ChromeDriver reported an invalid version: ${driverOutput || '(empty)'}`)
  }
  if (major(driverVersion) !== major(electronVersion)) {
    throw new Error(
      `Electron Chromium ${electronVersion} requires a matching ChromeDriver major; found ${driverVersion}`,
    )
  }

  return electronVersion
}
