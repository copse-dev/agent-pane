// Entry point of the standalone `dist/main/package-firewall.js` bundle, run as
// `ELECTRON_RUN_AS_NODE=1 <Copse> package-firewall.js <command> [args…]`.
import { FIREWALL_LOG_PREFIX, runPackageFirewall } from './run.ts'

const log = (line: string): void => {
  process.stderr.write(`${line}\n`)
}

runPackageFirewall(process.argv.slice(2), process.env, log).then(
  (status) => {
    process.exitCode = status
  },
  (error: unknown) => {
    log(`${FIREWALL_LOG_PREFIX} failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 70
  },
)
