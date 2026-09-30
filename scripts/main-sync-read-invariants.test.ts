import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

interface SyncReadBaselineEntry {
  readonly calls: number
  readonly reason: string
}

/**
 * Existing synchronous reads in the shipped main-process source. This is a
 * shrink-only debt register, not an approval list: adding a call or moving one
 * to an unlisted file fails the gate, while removing one requires deleting or
 * reducing its entry so the recorded inventory cannot go stale.
 *
 * The corresponding audit and migration order live in
 * docs/main-process-sync-reads.md.
 */
const BASELINE: Readonly<Record<string, SyncReadBaselineEntry>> = {
  'src/main/app-icon.ts': {
    calls: 1,
    reason: 'One-time startup icon fingerprint before the BrowserWindow is created.',
  },
  'src/main/project-sandbox/orphaned-bridges.ts': {
    calls: 2,
    reason: 'Linux-only startup cleanup reads tiny procfs records for candidate bridge processes.',
  },
  'src/main/services/container-runtime/guest-install.ts': {
    calls: 1,
    reason: 'Short-lived container guest bootstrap reads its workspace manifest once.',
  },
  'src/main/services/container-runtime/thread-container.ts': {
    calls: 6,
    reason:
      'Container preparation and recovery inspect bounded manifests, canaries, and bundle bytes.',
  },
  'src/main/services/container-runtime/worker-entry.ts': {
    calls: 2,
    reason: 'Dedicated worker bootstrap reads its validated run request and attestation once.',
  },
  'src/main/services/mobile/mobile-certificate.ts': {
    calls: 2,
    reason:
      'Certificate bootstrap loads the local root certificate and key when mobile serving starts.',
  },
  'src/main/services/mobile/mobile-devices.ts': {
    calls: 1,
    reason: 'Small serialized device registry; candidate for an async store migration.',
  },
  'src/main/services/mobile/mobile-preference.ts': {
    calls: 1,
    reason: 'Small serialized preference record; candidate for an async store migration.',
  },
  'src/main/services/mobile/mobile-server.ts': {
    calls: 1,
    reason: 'Local mobile HTTP server loads a bounded packaged asset on request.',
  },
  'src/main/services/providers/env-key-detection.ts': {
    calls: 1,
    reason: 'Provider setup probe synchronously samples small user-owned environment files.',
  },
  'src/main/services/roadmap-review-state.ts': {
    calls: 1,
    reason: 'Small serialized checkpoint store; candidate for an async store migration.',
  },
  'src/main/services/security/decision-log-store.ts': {
    calls: 1,
    reason:
      'Security decision lookup is serialized and fail-closed; migrate without weakening ordering.',
  },
  'src/main/services/security/deferred-approval-store.ts': {
    calls: 1,
    reason: 'Approval lookup is serialized and fail-closed; migrate without weakening ordering.',
  },
  'src/main/services/security/git-remotes.ts': {
    calls: 3,
    reason:
      'Security-sensitive Git indirection/config parser performs bounded reads before validation.',
  },
  'src/main/services/security/git-signing-broker.ts': {
    calls: 1,
    reason: "Fixed short-lived sandbox client reads Git's bounded signing buffer before IPC.",
  },
  'src/main/services/ssh-workspace/ssh-config.ts': {
    calls: 1,
    reason:
      'SSH setup parses bounded user config files before connecting; candidate for async loading.',
  },
  'src/main/services/storage/knowledge-attachments.ts': {
    calls: 1,
    reason: 'Attachment payload is returned synchronously by the current knowledge-store contract.',
  },
  'src/main/services/storage/knowledge-store.ts': {
    calls: 4,
    reason:
      'Legacy synchronous knowledge-store API; highest-value store migration after hot-path reads.',
  },
  'src/main/services/storage/long-task-tracker.ts': {
    calls: 1,
    reason: 'Small serialized tracker record; candidate for an async store migration.',
  },
  'src/main/services/supervisor/event-inbox-store.ts': {
    calls: 1,
    reason: 'Serialized durable inbox read whose identity and digest are validated before use.',
  },
  'src/main/services/supervisor/task-store.ts': {
    calls: 3,
    reason: 'Serialized task recovery reads bounded metadata and archive records.',
  },
  'src/main/services/worktree-preparation-plan.ts': {
    calls: 1,
    reason: 'Worktree detector reads one small manifest while building a preparation plan.',
  },
  'src/main/services/worktree-preparation.ts': {
    calls: 2,
    reason: 'Preparation probes read bounded lock/config text before launching package tooling.',
  },
}

function productionTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(path))
      continue
    }
    if (!/\.ts$/.test(entry.name)) continue
    if (/\.(?:test|spec|test-support)\.ts$/.test(entry.name)) continue
    files.push(path)
  }
  return files
}

function currentInventory(): ReadonlyMap<string, number> {
  const inventory = new Map<string, number>()
  for (const file of productionTypeScriptFiles('src/main')) {
    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(
      source,
      /\breadFileSync\s+as\s+\w+/,
      `${file} aliases readFileSync, which would make the shrink-only inventory ambiguous`,
    )
    const calls = [...source.matchAll(/\breadFileSync\s*\(/g)].length
    if (calls > 0) inventory.set(file, calls)
  }
  return inventory
}

describe('main-process synchronous read inventory', () => {
  it('allows no new readFileSync call sites and makes removals shrink the baseline', () => {
    const current = currentInventory()
    const unexpected = [...current]
      .filter(([file, calls]) => BASELINE[file]?.calls !== calls)
      .map(
        ([file, calls]) =>
          `${file}: ${String(calls)} (baseline ${String(BASELINE[file]?.calls ?? 0)})`,
      )
    const stale = Object.entries(BASELINE)
      .filter(([file, entry]) => current.get(file) !== entry.calls)
      .map(
        ([file, entry]) =>
          `${file}: baseline ${String(entry.calls)} (current ${String(current.get(file) ?? 0)})`,
      )

    assert.deepEqual(
      { unexpected, stale },
      { unexpected: [], stale: [] },
      'Synchronous main-process reads are shrink-only. Use async I/O for new work; when removing a call, shrink this baseline and update docs/main-process-sync-reads.md.',
    )
  })

  it('records a concrete audit reason for every grandfathered file', () => {
    const missingReasons = Object.entries(BASELINE)
      .filter(([, entry]) => entry.reason.trim().length < 20)
      .map(([file]) => file)
    assert.deepEqual(missingReasons, [])
  })
  it('keeps the audit headline totals synchronized with the executable baseline', () => {
    const audit = readFileSync('docs/main-process-sync-reads.md', 'utf8')
    const files = Object.keys(BASELINE).length
    const calls = Object.values(BASELINE).reduce((total, entry) => total + entry.calls, 0)
    assert.ok(audit.includes(`**${String(calls)}** \`readFileSync\` call sites`))
    assert.ok(audit.includes(`**${String(files)}**\nproduction files`))
  })
})
