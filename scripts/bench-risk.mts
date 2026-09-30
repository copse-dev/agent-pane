// `pnpm run bench:risk` — see bench-risk-lib.mts and benchmarks/review-risk/README.md.
import { main } from './bench-risk-lib.mts'

process.exit(
  await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
)
