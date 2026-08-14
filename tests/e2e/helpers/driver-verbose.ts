/**
 * Whether to run chromedriver with `--verbose`.
 *
 * Without it the driver log this job uploads is a three-line startup banner plus
 * Electron's own stdout. That tells you the driver started and the app booted —
 * and nothing whatsoever about the session handshake between them, which is
 * where e2e actually fails. The `bind() failed: Address already in use` /
 * `Cannot start http server for devtools` evidence that diagnosed #1606 was only
 * legible because verbose was on *at the moment the failure happened*.
 *
 * That is the whole design constraint. A flag you must remember to switch on
 * before re-running would not have caught it: you would re-run, the failure
 * would move, and you would be reading banners again. So the useful default in
 * CI is **on**, and the setting exists to turn it off (or to turn it on locally,
 * where it is large and usually noise).
 *
 *   COPSE_E2E_DRIVER_VERBOSE=1   force on, including locally
 *   COPSE_E2E_DRIVER_VERBOSE=0   force off, including in CI
 *   unset                        on in CI, off locally
 *
 * **Read only variables that exist at module load.** `wdio.conf.ts` evaluates
 * its `capabilities` when the config module is imported, which is *before*
 * `beforeSession` runs. Gating this on something `beforeSession` sets — such as
 * `COPSE_E2E` — yields a permanently false flag and a log that silently omits
 * everything you added it for. `CI` comes from the runner environment and
 * `COPSE_E2E_DRIVER_VERBOSE` from the invoking shell, so both are already set by
 * the time this is read.
 */

/** Values that read as "off". Anything else present reads as "on". */
const OFF = /^(0|false|no|off)$/i

/**
 * Resolve the verbose setting from an environment.
 *
 * Takes `env` explicitly so the decision is a pure function of it and can be
 * tested without mutating `process.env`.
 */
export function shouldEnableDriverVerbose(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = env['COPSE_E2E_DRIVER_VERBOSE']?.trim()
  if (explicit !== undefined && explicit !== '') return !OFF.test(explicit)
  // GitHub Actions sets CI=true; treat an explicitly falsy CI as "not CI"
  // rather than as "set, therefore truthy".
  const ci = env['CI']?.trim()
  return ci !== undefined && ci !== '' && !OFF.test(ci)
}

/**
 * The `wdio:chromedriverOptions` fragment carrying the verbose flag, spreadable
 * into the capability so the key is absent (rather than `verbose: false`) when
 * off — wdio turns every key in that object into a CLI flag.
 */
export function driverVerboseOptions(env: NodeJS.ProcessEnv = process.env): { verbose?: true } {
  return shouldEnableDriverVerbose(env) ? { verbose: true } : {}
}
