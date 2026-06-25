/**
 * Reference-screenshot freshness gate (hard). A UI change that the oracle
 * (scripts/test-oracle.mts) maps to a screenshot-producing e2e spec must either
 * refresh that spec's committed reference PNG(s) in the same diff, or carry the
 * `update-screenshots` label — which makes the e2e-screenshots workflow
 * regenerate and commit the shots on a hosted runner. Without one of those, the
 * committed PNGs silently drift out of sync with the UI they document.
 *
 * It runs in the cheap `lint`/`plan-e2e` tier: pure static analysis over the
 * diff, no build, no Electron, and crucially no rerun of the self-hosted e2e
 * suite. Reference shots are rendered on the Linux CI runner, so regenerating
 * locally produces runner-mismatched pixels — the label is the sanctioned path.
 *
 * Run: UPDATE_SCREENSHOTS_LABEL=<true|false> node scripts/check-screenshots.mts --base <ref>
 */
import { changedFiles, computeScreenshotGate } from './test-oracle.mts'

function parseBase(argv: string[]): string {
  const i = argv.indexOf('--base')
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : 'origin/main'
}

function main(): void {
  const base = parseBase(process.argv.slice(2))
  const labeled = process.env.UPDATE_SCREENSHOTS_LABEL === 'true'
  const gate = computeScreenshotGate(changedFiles(base), labeled)

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
    '\n  Fix — pick one:\n' +
      '    • Add the `update-screenshots` label to the PR (recommended). CI regenerates\n' +
      '      and commits the reference shots on a hosted runner; no self-hosted e2e run.\n' +
      '    • If the diff genuinely cannot change these shots, the oracle matched it via a\n' +
      '      shared selector/import — split that file out, or add the label to acknowledge.\n',
  )
  process.exit(1)
}

main()
