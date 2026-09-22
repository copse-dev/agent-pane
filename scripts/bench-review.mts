// `pnpm run bench:review` — see bench-review-lib.mts.
import { main } from './bench-review-lib.mts'

process.exit(
  await main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }),
)
