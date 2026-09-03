#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { buildBenchmarkSite, DEFAULT_LOW_WORK_FLOOR } from './lib/benchmark-catalog.mts'

interface CliOptions {
  append: boolean
  artifactRoots: string[]
  buildOnly: boolean
  minInputTokens: number
  minToolCalls: number
  outputDir: string
  port: number
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
}

function usage(): string {
  return `Usage: pnpm run bench:explore -- --artifacts <directory> [options]

Build and browse SkillsBench and extracted Terminal-Bench run artifacts.

Options:
  --artifacts <directory>      Artifact root; repeat to publish successive runs
  --output <directory>         Static output (default: bench-results/benchmark-site)
  --append                     Merge these runs into an existing output catalog
  --port <number>              Loopback server port (default: 4174)
  --min-input-tokens <number>  Low-work floor (default: ${String(DEFAULT_LOW_WORK_FLOOR.minInputTokens)})
  --min-tool-calls <number>    Low-work floor (default: ${String(DEFAULT_LOW_WORK_FLOOR.minToolCalls)})
  --build-only                 Generate the portable site without serving it
  --help                       Show this help
`
}

function positiveInteger(value: string | undefined, option: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${option} must be a positive integer`)
  return parsed
}

function parseCli(argv: string[]): CliOptions | null {
  if (argv.includes('--help')) return null
  const artifactRoots: string[] = []
  let append = false
  let buildOnly = false
  let minInputTokens = DEFAULT_LOW_WORK_FLOOR.minInputTokens
  let minToolCalls = DEFAULT_LOW_WORK_FLOOR.minToolCalls
  let outputDir = 'bench-results/benchmark-site'
  let port = 4_174
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]
    if (option === '--') continue
    if (option === '--append') append = true
    else if (option === '--build-only') buildOnly = true
    else if (option === '--artifacts') artifactRoots.push(argv[++index] ?? '')
    else if (option === '--output') outputDir = argv[++index] ?? ''
    else if (option === '--port') port = positiveInteger(argv[++index], '--port')
    else if (option === '--min-input-tokens') {
      minInputTokens = positiveInteger(argv[++index], '--min-input-tokens')
    } else if (option === '--min-tool-calls') {
      minToolCalls = positiveInteger(argv[++index], '--min-tool-calls')
    } else throw new Error(`unknown option '${option ?? ''}'`)
  }
  if (artifactRoots.length === 0 || artifactRoots.some((root) => root.trim() === '')) {
    throw new Error('--artifacts is required and may be repeated')
  }
  if (!outputDir.trim()) throw new Error('--output must not be empty')
  return { append, artifactRoots, buildOnly, minInputTokens, minToolCalls, outputDir, port }
}

function serve(root: string, port: number): void {
  const absoluteRoot = resolve(root)
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${String(port)}`)
    const pathname = decodeURIComponent(requestUrl.pathname)
    const target = resolve(absoluteRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
    const targetRelative = relative(absoluteRoot, target)
    if (
      targetRelative.startsWith('..') ||
      targetRelative.includes(sep + '..') ||
      !existsSync(target)
    ) {
      response.writeHead(404).end('Not found')
      return
    }
    if (!statSync(target).isFile()) {
      response.writeHead(404).end('Not found')
      return
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    createReadStream(target).pipe(response)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Copse Benchmarks: http://127.0.0.1:${String(port)}`)
  })
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2))
  if (!options) {
    console.log(usage())
    return
  }
  const data = await buildBenchmarkSite({
    append: options.append,
    artifactRoots: options.artifactRoots,
    outputDir: options.outputDir,
    lowWorkFloor: {
      minInputTokens: options.minInputTokens,
      minToolCalls: options.minToolCalls,
    },
  })
  console.log(
    `Copse Benchmarks: wrote ${String(data.catalog.runs.length)} run(s), ${String(data.runs.reduce((total, run) => total + run.trials.length, 0))} trial(s), ${String(data.catalog.warnings.length)} warning(s) to ${resolve(options.outputDir)}`,
  )
  if (!options.buildOnly) serve(options.outputDir, options.port)
}

if (process.argv[1]?.endsWith('benchmark-explorer.mts')) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
