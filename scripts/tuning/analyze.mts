/**
 * Analyze the tuning ledger: per-config pass rates with Wilson intervals, replicate
 * noise, and a verdict for each config against the baseline.
 *
 *   node scripts/tuning/analyze.mts [--ledger path] [--baseline <config id>] [--seed N]
 *     [--min-effect 0.1] [--min-tasks 8] [--min-reps 2] [--iterations 10000] [--json]
 */
import {
  DEFAULT_ANALYSIS_OPTIONS,
  analyzeLedger,
  formatAnalysis,
  type AnalysisOptions,
} from './analysis.mts'
import { DEFAULT_LEDGER_PATH, FileLedger } from './ledger.mts'

function numberFlag(flags: ReadonlyMap<string, string>, name: string, fallback: number): number {
  const raw = flags.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`--${name} must be a non-negative number`)
  return value
}

export function runAnalyze(argv: readonly string[]): string {
  const flags = new Map<string, string>()
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    if (arg === '--json') json = true
    else if (arg.startsWith('--') && argv[index + 1] !== undefined) {
      flags.set(arg.slice(2), argv[index + 1] ?? '')
      index += 1
    } else throw new Error(`Bad argument '${arg}'`)
  }
  const records = new FileLedger(flags.get('ledger') ?? DEFAULT_LEDGER_PATH).read()
  const baselineId = flags.get('baseline')
  const baselineHash =
    baselineId === undefined
      ? undefined
      : records.find((record) => record.config.id === baselineId)?.config.hash
  if (baselineId !== undefined && baselineHash === undefined) {
    throw new Error(`No trial in the ledger belongs to config '${baselineId}'`)
  }
  const options: Partial<AnalysisOptions> & { baselineHash?: string } = {
    iterations: numberFlag(flags, 'iterations', DEFAULT_ANALYSIS_OPTIONS.iterations),
    seed: numberFlag(flags, 'seed', DEFAULT_ANALYSIS_OPTIONS.seed),
    minTasks: numberFlag(flags, 'min-tasks', DEFAULT_ANALYSIS_OPTIONS.minTasks),
    minReps: numberFlag(flags, 'min-reps', DEFAULT_ANALYSIS_OPTIONS.minReps),
    minEffect: numberFlag(flags, 'min-effect', DEFAULT_ANALYSIS_OPTIONS.minEffect),
    ...(baselineHash === undefined ? {} : { baselineHash }),
  }
  const analysis = analyzeLedger(records, options)
  return json ? `${JSON.stringify(analysis, null, 2)}\n` : `${formatAnalysis(analysis)}\n`
}

if (process.argv[1]?.endsWith('analyze.mts')) {
  try {
    process.stdout.write(runAnalyze(process.argv.slice(2)))
  } catch (error) {
    console.error(`tuning:analyze: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
