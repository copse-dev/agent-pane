/**
 * Reference-screenshot freshness — planner + hard gate.
 *
 * A UI change that the oracle (scripts/test-oracle.mts) maps to a
 * screenshot-producing e2e spec keeps its committed reference PNG(s) in sync
 * one of two ways: the diff refreshes them itself, or the CI `e2e` job re-renders
 * them (the specs write the PNGs as a side effect of the gate run) and the
 * `commit-screenshots` job auto-commits the diff. Reference shots are pixel-
 * rendered on the CI runner, so a contributor can't reliably regenerate them
 * locally — letting CI render and commit them is the sanctioned path.
 *
 * Two modes (both pure static analysis over the diff — no build, no Electron, no
 * extra rerun of the e2e tier):
 *
 *   --plan   Advisory planner. Emits `needs-regen=<true|false>` to GITHUB_OUTPUT
 *            (and prints which shots will be refreshed) but NEVER fails. ci.yml
 *            runs it to annotate the run. Stale shots don't block the PR — the
 *            e2e gate run re-renders them and commit-screenshots auto-commits them.
 *
 *   (default) Hard gate for local/manual use: exits non-zero when shots look
 *            stale and the `update-screenshots` label is absent.
 *
 * needs-regen is true when the change affects reference shots AND either the
 * `update-screenshots` label is set (force-refresh) or some affected shot wasn't
 * already refreshed in the diff (stale). A diff that hand-refreshes every
 * affected PNG needs no regen.
 *
 * Run: UPDATE_SCREENSHOTS_LABEL=<true|false> node scripts/check-screenshots.mts [--plan] --base <ref>
 */
import { appendFileSync } from 'node:fs'
import { changedFiles, computeScreenshotGate } from './test-oracle.mts'

function parseBase(argv: string[]): string {
  const i = argv.indexOf('--base')
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : 'origin/main'
}

/** Set a GitHub Actions step output when running in CI; a no-op locally. */
function emitOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT
  if (file) appendFileSync(file, `${name}=${value}\n`)
}

function main(): void {
  const argv = process.argv.slice(2)
  const base = parseBase(argv)
  const labeled = process.env.UPDATE_SCREENSHOTS_LABEL === 'true'
  const gate = computeScreenshotGate(changedFiles(base), labeled)

  // Regenerate when the change touches reference shots and they aren't already
  // all refreshed in the diff — or whenever the label forces a refresh.
  const needsRegen = gate.affected.length > 0 && (gate.labeled || gate.missing.length > 0)

  if (argv.includes('--plan')) {
    emitOutput('needs-regen', needsRegen ? 'true' : 'false')
    if (!gate.affected.length) {
      console.log('✓ screenshot plan: no reference screenshots affected — no regen needed')
    } else if (needsRegen) {
      const shots = gate.missing.length ? gate.missing : gate.affected
      console.log(
        `screenshot plan: ${shots.length} reference shot(s) will be regenerated and ` +
          'auto-committed on a hosted runner ' +
          (gate.labeled ? '(update-screenshots label present):' : '(stale shots detected):'),
      )
      for (const p of shots) console.log(`      tests/e2e/screenshots/${p}`)
    } else {
      console.log(
        `✓ screenshot plan: ${gate.affected.length} shot(s) affected, all refreshed in this diff — no regen needed`,
      )
    }
    return
  }

  // Hard gate (local/manual): fail on stale-and-unlabeled.
  if (gate.ok) {
    if (!gate.affected.length) console.log('✓ screenshot gate: no reference screenshots affected')
    else if (gate.labeled)
      console.log(
        `✓ screenshot gate: ${gate.affected.length} shot(s) affected; ` +
          'update-screenshots label present (CI will regenerate them)',
      )
    else
      console.log(
        `✓ screenshot gate: ${gate.affected.length} shot(s) affected, all refreshed in this diff`,
      )
    return
  }

  console.error(
    `\n✗ screenshot gate: ${gate.missing.length} reference screenshot(s) look stale.\n\n` +
      '  This change is mapped (by the test oracle) to screenshot-producing e2e\n' +
      '  spec(s), but these committed reference PNGs were not refreshed in the diff:\n',
  )
  for (const p of gate.missing) console.error(`      tests/e2e/screenshots/${p}`)
  console.error(
    '\n  On CI this auto-resolves: the e2e gate run re-renders these shots and the\n' +
      '  commit-screenshots job commits them. To refresh them yourself, add the\n' +
      '  `update-screenshots` label to the PR, or commit the rendered PNGs in the diff.\n',
  )
  process.exit(1)
}

main()
