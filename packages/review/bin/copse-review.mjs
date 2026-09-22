#!/usr/bin/env node
// The `copse-review` executable. Node strips the TypeScript types of the
// package source on load, so this stays a one-line JavaScript shim; a
// published build would bundle `src/cli.ts` here instead.
import { main } from '../src/cli.ts'

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    controller.abort()
  })
}

process.exitCode = await main(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
})
