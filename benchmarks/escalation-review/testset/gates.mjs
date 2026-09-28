// Run Copse's deterministic gates over the test set and score them against the reference tiers.
//
//   node benchmarks/escalation-review/testset/gates.mjs [--check | --update]
//
// Every case is analysed the way the regression set is (product source, anonymised home,
// injected files and trusted hosts). The verdicts are compared with the committed snapshot
// deterministic.jsonl: --check exits non-zero on any drift and says, per changed case, whether
// the gate relaxed or tightened and whether the case is one a person must see. --update rewrites
// the snapshot after a deliberate change. One invariant holds whatever the snapshot says: the
// deterministic tiers (and outside-read proof) never approve a command labelled `ask`, except the
// cases in KNOWN_GAPS. A known gap that closes must be removed from the list, as in the regression
// set. Scope agreement is reported, not enforced: the shell-scope rubric calls package scripts and
// $TMPDIR external, and the product contains both in the OS sandbox on purpose.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeCase, withAnonymisedHome } from '../regression/run.mjs'
import { MODES, approvers, score } from '../scripts/score.mjs'
import { jsonl } from './build.mjs'
import { TESTSET } from './paths.mjs'

export const SNAPSHOT = join(TESTSET, 'deterministic.jsonl')

/** `ask` commands the deterministic tiers approve today, each with the reason it is not fixed. */
export const KNOWN_GAPS = {}

export function loadTestset() {
  return jsonl(join(TESTSET, 'cases.jsonl'))
}

/** The verdict fields the snapshot pins, in the shape score.mjs's approvers read. */
export function verdict(id, result) {
  return {
    id,
    scope: result.scope,
    autoApproval: result.autoApproval,
    readOutside: result.readOutside,
    harm: result.harm,
  }
}

/** Why each gate decided as it did; printed for changed cases, never pinned. */
export function reasons(result) {
  return { scope: result.scopeReasons, read: result.autoApprovalReasons, harm: result.harmReasons }
}

export async function analyzeTestset(cases = loadTestset()) {
  return withAnonymisedHome((guard) =>
    cases.map((c) => {
      const result = analyzeCase(guard, c)
      return { verdict: verdict(c.id, result), reasons: reasons(result) }
    }),
  )
}

// For each field, the value ordering from most to least permissive.
const permissive = {
  scope: (v) => (v === 'sandbox' ? 1 : 0),
  read: (v) => (v ? 1 : 0),
  'local-write': (v) => (v ? 1 : 0),
  'remote-write': (v) => (v ? 1 : 0),
  readOutside: (v) => (v ? 1 : 0),
  harm: (v) => ({ allow: 2, prompt: 1, deny: 0 })[v] ?? 0,
}

const fields = (v) => ({
  scope: v.scope,
  read: v.autoApproval.read,
  'local-write': v.autoApproval['local-write'],
  'remote-write': v.autoApproval['remote-write'],
  readOutside: v.readOutside,
  harm: v.harm,
})

/** Field-level differences between two snapshots, each marked relaxed or tightened. */
export function drift(before, after, tiers) {
  const previous = new Map(before.map((v) => [v.id, v]))
  const out = []
  for (const v of after) {
    const old = previous.get(v.id)
    if (!old) {
      out.push({ id: v.id, field: 'case', from: null, to: 'added', direction: 'new' })
      continue
    }
    const a = fields(old)
    const b = fields(v)
    for (const field of Object.keys(b)) {
      if (a[field] === b[field]) continue
      const direction =
        permissive[field](b[field]) > permissive[field](a[field]) ? 'relaxed' : 'tightened'
      out.push({ id: v.id, field, from: a[field], to: b[field], direction, tier: tiers.get(v.id) })
    }
  }
  const current = new Set(after.map((v) => v.id))
  for (const v of before) {
    if (!current.has(v.id))
      out.push({ id: v.id, field: 'case', from: 'present', to: null, direction: 'removed' })
  }
  return out
}

/** Deterministic approvals of `ask` commands outside KNOWN_GAPS, and known gaps that closed. */
export function violations(cases, verdicts, knownGaps = KNOWN_GAPS) {
  const reference = new Map(cases.map((c) => [c.id, c]))
  const deterministic = new Map(verdicts.map((v) => [v.id, v]))
  const ids = cases.map((c) => c.id)
  const tiers = approvers(deterministic, [], [])['deterministic tiers (+ outside-read proof)']
  const approved = new Set()
  for (const mode of Object.keys(MODES)) {
    for (const id of score(tiers, mode, ids, reference).mustAsk) approved.add(id)
  }
  const out = []
  for (const id of approved) {
    if (!Object.hasOwn(knownGaps, id))
      out.push(`${id}: the deterministic tiers approve a command labelled ask`)
  }
  for (const id of Object.keys(knownGaps)) {
    if (!approved.has(id)) out.push(`${id}: known gap closed; remove it from KNOWN_GAPS`)
  }
  return out
}

export function scorecard(cases, verdicts) {
  const reference = new Map(cases.map((c) => [c.id, c]))
  const deterministic = new Map(verdicts.map((v) => [v.id, v]))
  const ids = cases.map((c) => c.id)
  const lines = []
  for (const mode of Object.keys(MODES)) {
    lines.push(`\n## ${mode} mode: auto-approve ${MODES[mode].join(', ')}`)
    lines.push('| Approver | Coverage | Over-tier | Must-ask |', '| --- | ---: | ---: | ---: |')
    for (const [name, approve] of Object.entries(approvers(deterministic, [], []))) {
      const { eligible, covered, overTier, mustAsk } = score(approve, mode, ids, reference)
      const pct = eligible ? Math.round((100 * covered) / eligible) : 0
      lines.push(
        `| ${name} | ${covered}/${eligible} (${pct}%) | ${overTier.length} | ${mustAsk.length} |`,
      )
    }
  }
  const scoped = cases.filter((c) => c.scope)
  const wrong = (label, verdict) =>
    scoped.filter((c) => c.scope === label && deterministic.get(c.id).scope === verdict).length
  lines.push(
    `\nScope on ${scoped.length} reviewed cases: ${wrong('sandbox', 'sandbox') + wrong('external', 'external')} agree, ` +
      `${wrong('external', 'sandbox')} wrong sandbox, ${wrong('sandbox', 'external')} wrong external.`,
  )
  return lines.join('\n')
}

const text = (verdicts) => verdicts.map((v) => JSON.stringify(v)).join('\n') + '\n'

export async function main(argv = process.argv.slice(2)) {
  const cases = loadTestset()
  const analysed = await analyzeTestset(cases)
  const verdicts = analysed.map((a) => a.verdict)
  const why = new Map(analysed.map((a) => [a.verdict.id, a.reasons]))
  console.log(`${cases.length} cases`)
  console.log(scorecard(cases, verdicts))
  const problems = violations(cases, verdicts)
  for (const problem of problems) console.error(`invariant: ${problem}`)
  if (argv.includes('--update')) {
    writeFileSync(SNAPSHOT, text(verdicts))
    console.log(`\nWrote ${SNAPSHOT}`)
    return problems.length ? 1 : 0
  }
  let committed = []
  try {
    committed = jsonl(SNAPSHOT)
  } catch {
    // No snapshot yet: every case reports as new.
  }
  const changes = drift(committed, verdicts, new Map(cases.map((c) => [c.id, c.tier])))
  for (const change of changes) {
    const flag =
      change.direction === 'relaxed' && change.tier === 'ask' ? ' ** labelled ask **' : ''
    console.log(
      `${change.direction.padEnd(9)} ${change.id} ${change.field}: ${String(change.from)} -> ${String(change.to)}${flag}`,
    )
    if (change.direction === 'new' || change.direction === 'removed') continue
    const reason = why.get(change.id)?.[
      change.field === 'harm' ? 'harm' : change.field === 'scope' ? 'scope' : 'read'
    ]
    if (reason?.length) console.log(`          ${reason.join('; ')}`)
  }
  if (argv.includes('--check') && (changes.length || problems.length)) {
    console.error(
      `${changes.length} verdict change(s), ${problems.length} invariant violation(s). ` +
        'Fix the gate, or run gates.mjs --update after reviewing every change.',
    )
    return 1
  }
  return problems.length ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main()
}
