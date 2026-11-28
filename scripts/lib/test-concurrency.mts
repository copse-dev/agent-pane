import { availableParallelism } from 'node:os'

// Several hook/process suites deliberately spawn subprocess trees. Letting
// Node derive file concurrency from a large developer/runner host can put dozens
// of short-lived children in flight and turn fixed 2s safety deadlines into
// load-dependent failures. CI keeps four: its runners have four vCPUs, and its
// timing is what the suite's deadlines are tuned against.
//
// Off CI, four underuses a larger developer machine: on a 10-core Mac the
// suite's test phase took 609 s at four and 364 s at eight. A local run uses
// the cores it has, less two for the subprocess trees and the rest of the
// machine, never fewer than CI's four or more than eight. On a host that other
// work is already loading, `COPSE_TEST_CONCURRENCY=4` reproduces CI's count.
//
// Apple integration files each drive the same host builder from a separate
// process. Apple container 1.5.0 intermittently fails parallel context transfer;
// the product's in-process image queue cannot serialize these test processes.
export const CI_TEST_FILE_CONCURRENCY = 4
export const MAX_LOCAL_TEST_FILE_CONCURRENCY = 8

/** Test files `scripts/run-tests.mts` runs at once. */
export function testFileConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
  warn: (message: string) => void = console.warn,
): number {
  if (env['COPSE_THREAD_CONTAINER_E2E'] === 'apple') return 1
  const override = env['COPSE_TEST_CONCURRENCY']
  if (override !== undefined && override !== '') {
    const value = Number(override)
    if (Number.isInteger(value) && value >= 1) return value
    warn(`[run-tests] ignoring COPSE_TEST_CONCURRENCY=${override}: not a positive integer`)
  }
  if (env['CI']) return CI_TEST_FILE_CONCURRENCY
  return Math.max(CI_TEST_FILE_CONCURRENCY, Math.min(cpus - 2, MAX_LOCAL_TEST_FILE_CONCURRENCY))
}
