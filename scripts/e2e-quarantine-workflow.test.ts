import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const workflow = readFileSync(resolve('.github/workflows/e2e-quarantine.yml'), 'utf8')
const ci = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8')

function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`)
  assert.ok(start >= 0, `expected step ${name}`)
  const rest = workflow.slice(start + 1)
  const next = rest.search(/^ {6}- (?:name|uses):/m)
  return next >= 0 ? rest.slice(0, next) : rest
}

describe('nightly quarantine workflow', () => {
  it('runs nightly and on demand, with a capped job and read-only token', () => {
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: '47 7 \* \* \*'$/m)
    assert.match(workflow, /^ {2}workflow_dispatch:$/m)
    assert.match(workflow, /^ {4}timeout-minutes: \d+$/m)
    assert.match(workflow, /^permissions:\n {2}contents: read\n {2}actions: read\n\n/m)
    assert.match(
      workflow,
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
    )
  })

  it('never affects a conclusion: the spec step is advisory and no CI gate needs it', () => {
    const run = step('Run quarantined specs (advisory, no retry)')
    assert.match(run, /^ {8}continue-on-error: true$/m)
    assert.match(run, /COPSE_E2E_ATTEMPT=1/)
    assert.match(run, /npm run test:e2e:quarantine/)
    assert.doesNotMatch(run, /for attempt/)
    assert.doesNotMatch(ci, /e2e-quarantine/)
  })

  it('skips the suite cleanly when nothing is quarantined but still reports', () => {
    for (const name of [
      'Install Linux sandbox dependencies',
      'Build',
      'Run quarantined specs (advisory, no retry)',
    ])
      assert.match(step(name), /steps\.specs\.outputs\.count != '0'/, name)
    for (const name of ['Report pass streaks', 'Retain the streak record'])
      assert.doesNotMatch(step(name), /outputs\.count/, name)
  })

  it('counts only scheduled runs on main toward streaks', () => {
    assert.match(
      workflow,
      /COUNTED: \$\{\{ github\.event_name == 'schedule' && github\.ref == 'refs\/heads\/main' \}\}/,
    )
    assert.match(
      step('Fetch the previous streak record'),
      /e2e-quarantine\.yml\/runs\?event=schedule&branch=main&status=completed/,
    )
    assert.match(step('Report pass streaks'), /counted=\(--counted\)/)
  })

  it('reads only the latest scheduled run, so a night without a record restarts streaks', () => {
    const fetch = step('Fetch the previous streak record')
    assert.match(fetch, /status=completed&per_page=1"/)
    assert.doesNotMatch(fetch, /\bfor id in\b/)
    assert.equal(fetch.split('gh run download').length - 1, 1)
  })
})
