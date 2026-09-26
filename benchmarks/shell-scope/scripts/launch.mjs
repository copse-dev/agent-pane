import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { root, scripts, corpus, z, sha, safeJsonParse, decodeWithSchema } from './run.mjs'
const [candidate, version = 'v1', onlySplit] = process.argv.slice(2)
assert.ok(['laya', 'laya-base', 'kev', 'openjev', 'acp', 'jev', 'nimble-demo'].includes(candidate))
assert.match(version, /^[a-z0-9-]+$/)
assert.ok(!onlySplit || ['dev', 'holdout'].includes(onlySplit))
const splits = onlySplit ? [onlySplit] : ['dev', 'holdout']
await mkdir(root, { recursive: true })
const path = resolve(
  root,
  `${candidate}-${version}${onlySplit ? '-' + onlySplit : ''}-execution.json`,
)
const execution = {
  candidate,
  version,
  splits,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  completed: false,
  steps: [],
  error: null,
  runnerHash: sha(await readFile(resolve(scripts, 'run.mjs'))),
  scorerHash: sha(await readFile(resolve(scripts, 'score.mjs'))),
}
await writeFile(path, JSON.stringify(execution, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const persist = () => writeFile(path, JSON.stringify(execution, null, 2) + '\n', { mode: 0o600 })
async function invoke(script, args, logName, timeoutMs) {
  const log = await open(resolve(root, logName), 'wx', 0o600)
  const step = {
    command: [process.execPath, resolve(scripts, script), ...args],
    log: logName,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    timedOut: false,
  }
  execution.steps.push(step)
  await persist()
  console.log(`START ${script} ${args.join(' ')}`)
  try {
    const child = spawn(process.execPath, [resolve(scripts, script), ...args], {
      stdio: ['ignore', log.fd, log.fd],
      detached: true,
    })
    const stop = () => {
      step.timedOut = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
    }
    const timer = setTimeout(stop, timeoutMs)
    const hardTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, timeoutMs + 10000)
    const result = await new Promise((done, fail) => {
      child.once('error', fail)
      child.once('close', (code, signal) => done({ code, signal }))
    })
    clearTimeout(timer)
    clearTimeout(hardTimer)
    step.exitCode = result.code
    step.signal = result.signal
  } finally {
    step.finishedAt = new Date().toISOString()
    await log.close()
    await persist()
  }
  console.log(`END ${script} ${args.join(' ')}: exit ${step.exitCode}, signal ${step.signal}`)
  return step
}
try {
  for (const split of splits) {
    const name = `${candidate}-${split}-${version}`
    if (split === 'holdout') {
      const frozen = safeJsonParse(
        await readFile(resolve(root, `${candidate}-frozen-policy.json`), 'utf8'),
        decodeWithSchema(
          z.object({ candidate: z.string(), datasetHash: z.string(), devInputHash: z.string() }),
        ),
      )
      assert.equal(frozen.candidate, candidate)
      assert.equal(frozen.datasetHash, sha(await readFile(resolve(corpus, 'corpus.jsonl'))))
      assert.equal(
        frozen.devInputHash,
        sha(await readFile(resolve(corpus, 'dev-inputs/dev.jsonl'))),
      )
    }
    const inferred = await invoke(
      'run.mjs',
      [candidate, split, version],
      `${name}.log`,
      ['acp', 'openjev'].includes(candidate) ? 1450000 : 700000,
    )
    if (inferred.timedOut || inferred.signal) throw new Error(`Inference stopped: ${split}`)
    const run = safeJsonParse(
      await readFile(resolve(root, name, 'run.json'), 'utf8'),
      decodeWithSchema(z.looseObject({ runError: z.string().nullable(), unattempted: z.number() })),
    )
    if (run.runError || run.unattempted)
      throw new Error(run.runError ?? `Unattempted cases: ${run.unattempted}`)
    const scored = await invoke('score.mjs', [name], `${name}-analysis.log`, 30000)
    if (scored.exitCode !== 0) throw new Error(`Scoring failed: ${split}`)
  }
  execution.completed = true
} catch (error) {
  execution.error = error instanceof Error ? error.message : 'Unknown execution failure'
  process.exitCode = 1
} finally {
  execution.finishedAt = new Date().toISOString()
  await persist()
}
console.log(JSON.stringify({ path, completed: execution.completed, error: execution.error }))
