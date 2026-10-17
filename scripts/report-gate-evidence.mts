import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { buildGateReport } from './lib/gate-report.mts'
const manifest = process.argv[2]
if (!manifest) throw new Error('Usage: node scripts/report-gate-evidence.mts manifest.json')
console.log(
  JSON.stringify(
    buildGateReport(readFileSync(manifest, 'utf8'), (path) =>
      readFileSync(resolve(dirname(manifest), path), 'utf8'),
    ),
    null,
    2,
  ),
)
