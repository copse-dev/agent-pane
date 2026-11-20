import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import {
  parseNetworkGuardLines,
  renderNetworkReport,
  summariseNetworkGuard,
} from './lib/e2e-network-report.mts'

/**
 * Usage: node scripts/e2e-network-report.mts <wdio log>...
 * Prints the outbound network guard's per-host summary for the given e2e logs
 * and appends it to the GitHub step summary when one is available. Reporting
 * only: the guard itself fails the offending test.
 */
const files = process.argv.slice(2).filter((file) => existsSync(file))
const lines = files.flatMap((file) => parseNetworkGuardLines(readFileSync(file, 'utf8')))
const report = renderNetworkReport(summariseNetworkGuard(lines))
const heading = `### e2e outbound network guard (${String(lines.length)} attempt(s) in ${String(files.length)} log(s))\n\n`
process.stdout.write(heading + report)
const summary = process.env['GITHUB_STEP_SUMMARY']
if (summary) appendFileSync(summary, `${heading}${report}\n`)
