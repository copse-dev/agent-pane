#!/usr/bin/env node
/**
 * Regenerate `benchmarks/skillsbench/verifier-deps.json` from a checked-out
 * SkillsBench task tree.
 *
 * 74 of the 87 v1.1 verifiers install their own test runner at grading time.
 * The spike runs with task-container egress off, so those installs fail and the
 * verifier scores 0 even when the task's own solution is correct. The inventory
 * this produces is pre-baked into each task image at build time instead.
 *
 * Usage:
 *   git clone https://github.com/benchflow-ai/skillsbench.git /tmp/skillsbench
 *   git -C /tmp/skillsbench checkout <datasetRevision>
 *   node scripts/extract-skillsbench-verifier-deps.mts /tmp/skillsbench
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DESCRIPTOR = 'benchmarks/skillsbench/dataset-v1.1.json'
const OUTPUT = 'benchmarks/skillsbench/verifier-deps.json'

/** Shell keywords a naive package-name match would otherwise pick up. */
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'fi', 'do', 'done', 'command', 'esac'])
const PIP_FLAG = /^-/

export interface VerifierDeps {
  /** Pinned uv versions fetched via the astral.sh installer. */
  uv: string[]
  /** Exact `uvx --with` pins the verifier resolves at grading time. */
  uvxWith: string[]
  /** Exact `pip install` pins. */
  pip: string[]
  /** `pip install` packages upstream left unpinned; installed latest at build. */
  pipUnpinned: string[]
  /** `apt-get install` packages. */
  apt: string[]
}

/**
 * Join backslash line continuations so a multi-line `pip install ... \` is
 * matched as one command. Missing this silently dropped `court-form-filling`
 * from the inventory, which then graded 0 with no layer staged.
 */
export function joinContinuations(script: string): string {
  return script.replace(/\\\r?\n\s*/g, ' ')
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function extractVerifierDeps(script: string): VerifierDeps {
  const text = joinContinuations(script)
  const uv = unique(
    [...text.matchAll(/astral\.sh\/uv\/([0-9][0-9.]*)\/install\.sh/g)].map((m) => m[1] ?? ''),
  )
  const uvxWith = unique(
    [...text.matchAll(/--with\s+([A-Za-z][A-Za-z0-9_.[\]-]*==[0-9][^\s'"]*)/g)].map(
      (m) => m[1] ?? '',
    ),
  )

  const pip: string[] = []
  const pipUnpinned: string[] = []
  for (const match of text.matchAll(/pip3?\s+install\s+([^\n;&|]*)/g)) {
    for (const token of (match[1] ?? '').split(/\s+/).filter(Boolean)) {
      if (PIP_FLAG.test(token)) continue
      if (/^[A-Za-z][A-Za-z0-9_.[\]-]*==[0-9][^\s'"]*$/.test(token)) pip.push(token)
      // Upstream sometimes leaves a package unpinned (`pip install pytest`).
      // Record it so the pre-bake still stages something; pip then reports the
      // requirement already satisfied at grading time without reaching out.
      else if (/^[A-Za-z][A-Za-z0-9_.[\]-]*$/.test(token) && !SHELL_KEYWORDS.has(token)) {
        pipUnpinned.push(token)
      }
    }
  }

  const apt: string[] = []
  for (const match of text.matchAll(/apt-get\s+install\s+([^\n;&|]*)/g)) {
    for (const token of (match[1] ?? '').split(/\s+/).filter(Boolean)) {
      if (PIP_FLAG.test(token)) continue
      if (/^[a-z0-9][a-z0-9.+-]*$/.test(token) && !SHELL_KEYWORDS.has(token)) apt.push(token)
    }
  }

  return {
    uv,
    uvxWith,
    pip: unique(pip),
    pipUnpinned: unique(pipUnpinned),
    apt: unique(apt),
  }
}

function isEmpty(deps: VerifierDeps): boolean {
  return (
    deps.uv.length === 0 &&
    deps.uvxWith.length === 0 &&
    deps.pip.length === 0 &&
    deps.pipUnpinned.length === 0 &&
    deps.apt.length === 0
  )
}

function descriptorRevision(value: unknown): string {
  if (typeof value !== 'object' || value === null || !('dataset' in value)) {
    throw new Error(`${DESCRIPTOR} is missing its dataset block`)
  }
  const dataset: unknown = value.dataset
  if (typeof dataset !== 'object' || dataset === null || !('revision' in dataset)) {
    throw new Error(`${DESCRIPTOR} is missing dataset.revision`)
  }
  const revision: unknown = dataset.revision
  if (typeof revision !== 'string' || !revision) {
    throw new Error(`${DESCRIPTOR} dataset.revision is not a string`)
  }
  return revision
}

function main(): void {
  const root = process.argv[2]
  if (!root) throw new Error('usage: extract-skillsbench-verifier-deps.mts <skillsbench-checkout>')
  const descriptor: unknown = JSON.parse(readFileSync(DESCRIPTOR, 'utf8'))
  const revision = descriptorRevision(descriptor)

  const tasksRoot = join(root, 'tasks')
  const tasks: Record<string, VerifierDeps> = {}
  for (const name of readdirSync(tasksRoot).sort()) {
    let script: string
    try {
      script = readFileSync(join(tasksRoot, name, 'verifier', 'test.sh'), 'utf8')
    } catch {
      continue
    }
    const deps = extractVerifierDeps(script)
    if (!isEmpty(deps)) tasks[name] = deps
  }

  const union: VerifierDeps = {
    uv: unique(Object.values(tasks).flatMap((d) => d.uv)),
    uvxWith: unique(Object.values(tasks).flatMap((d) => d.uvxWith)),
    pip: unique(Object.values(tasks).flatMap((d) => d.pip)),
    pipUnpinned: unique(Object.values(tasks).flatMap((d) => d.pipUnpinned)),
    apt: unique(Object.values(tasks).flatMap((d) => d.apt)),
  }

  writeFileSync(
    OUTPUT,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        datasetRevision: revision,
        note:
          'Test-time dependencies each SkillsBench verifier fetches from the network. ' +
          'Pre-baked into the task image at build time so the verifier can grade under ' +
          "the spike's no-network run condition. Regenerate with " +
          'scripts/extract-skillsbench-verifier-deps.mts.',
        union,
        tasks,
      },
      null,
      2,
    )}\n`,
  )
  console.log(`wrote ${OUTPUT}: ${String(Object.keys(tasks).length)} tasks need staging`)
}

if (process.argv[1]?.endsWith('extract-skillsbench-verifier-deps.mts')) main()
