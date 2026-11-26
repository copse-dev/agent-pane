#!/usr/bin/env node
// The `copse-review` executable. Node strips the TypeScript types of the
// package source on load, so this stays a one-line JavaScript shim; a
// published build would bundle `src/cli.ts` here instead.
//
// `copse-review pr <number|ref>` reviews one pull request in containers on
// this machine (`src/local-pr.ts`); everything else is the review itself.
import { main } from '../src/cli.ts'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    controller.abort()
  })
}

const io = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
}

const argv = process.argv.slice(2)
const args = argv[0] === '--' ? argv.slice(1) : argv
if (args[0] === 'pr') {
  const { localPullRequestMain } = await import('../src/local-pr.ts')
  process.exitCode = await localPullRequestMain(args.slice(1), io)
} else {
  process.exitCode = await main(argv, io)
}
