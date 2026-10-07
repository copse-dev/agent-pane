import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BANNED_TERMS, copyStringsIn, userCopyHits } from './lib/user-copy-scan.mts'

/**
 * Keeps protocol and implementation jargon out of the strings users read.
 *
 * "ACP", "stdio", "JSON-RPC", "IPC", "ASRT", "harness" and "capability" mean
 * nothing to someone choosing a coding agent, and the app once told people to
 * open "Settings → ACP agents" — a tab that does not exist. The words belong in
 * code, config keys, docs and developer tooling; the UI says "coding agent".
 * (The scan reads string literals only, so none of those are touched. See
 * `scripts/lib/user-copy-scan.mts` for exactly what counts as copy.)
 *
 * ## When this fails
 *
 * You wrote a banned term in a string. Say it the way a user would instead:
 * "coding agent", "agents on this device", "the connection to the agent", and
 * point at a tab that exists (`Settings → General → Providers`).
 *
 * If the string really is not for users — developer tooling, a prompt aimed at
 * a model, an identifier, an error handed back to the agent — add it to
 * `ALLOWED` with a reason. The allowlist is exact and shrink-only:
 *
 * - a hit with no entry fails, so new jargon cannot ride in beside old;
 * - an entry whose count no longer matches fails, so fixing a string forces its
 *   allowance out in the same change (the same ratchet as
 *   `type-predicate-inventory.test.ts`).
 *
 * Where a user genuinely needs the exact term to troubleshoot, keep it behind a
 * disclosure rather than in the headline — `agent-errors.ts` does this: the raw
 * `ACP error -32603 (Internal error)` lives under a "Technical details" block,
 * while the banner headline reads "The agent reported an error (code …)".
 *
 * Not covered here, deliberately: MCP, OAuth, worktree, sandbox, hook and token
 * are vocabulary the people who use these features already have, and several are
 * the names of the settings sections themselves. They are inventoried in the PR
 * that introduced this test, not banned.
 */

/** Why a group of hits is not user copy. */
const REASON = {
  devTool:
    'developer tooling output (probe CLIs and support/behaviour matrices), not shown in the app',
  containerWorker: 'container worker diagnostics and its CLI, written for developers',
  modelPrompt: 'a prompt or tool description aimed at a model, never rendered to the user',
  identifier: 'a machine identifier, config value or reason code rather than prose',
  agentFacing: 'an error returned to the external agent over the protocol, not to the user',
  technicalDetails: 'the exact protocol code, kept inside the “Technical details” disclosure',
  mcpTransport:
    'the MCP server transport name — MCP servers and plugin manifests are configured by it',
  pluginAuthor: 'a validation message for plugin authors, shown in plugin development',
  advancedSettings:
    'the plugin contribution list in Settings → Customise → Plugins, beside Hooks and MCP chips',
  devApi: 'developer API documentation (headless config schema)',
  containment: 'container containment diagnostics, an advanced run-details panel',
  casing: 'a casing table that keeps acronyms capitalised when humanising identifiers',
} as const

interface Allowance {
  readonly file: string
  readonly term: string
  readonly count: number
  readonly reason: string
}

const ALLOWED: readonly Allowance[] = [
  // Developer tooling: `npm run probe:acp` / `detect:acp` and their reports.
  {
    file: 'src/main/services/acp/acp-behavior-matrix.ts',
    term: 'ACP',
    count: 2,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-behavior-probe.ts',
    term: 'ACP',
    count: 4,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-behavior-probe.ts',
    term: 'capability',
    count: 1,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-capability-probe.ts',
    term: 'capability',
    count: 1,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-long-run-probe.ts',
    term: 'ACP',
    count: 4,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-support-matrix.ts',
    term: 'ACP',
    count: 2,
    reason: REASON.devTool,
  },
  {
    file: 'src/main/services/acp/acp-support-matrix.ts',
    term: 'capability',
    count: 4,
    reason: REASON.devTool,
  },

  // Errors the protocol returns to the agent, which is not the user.
  {
    file: 'src/main/services/acp/acp-client.ts',
    term: 'capability',
    count: 1,
    reason: REASON.agentFacing,
  },

  // The disclosure: exact code for bug reports, never the banner headline.
  {
    file: 'src/main/services/agent-errors.ts',
    term: 'ACP',
    count: 2,
    reason: REASON.technicalDetails,
  },

  // Container worker: logs and the scripted guest agent used by its tests.
  {
    file: 'src/main/services/container-runtime/scripted-acp-agent.ts',
    term: 'ACP',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/scripted-acp-agent.ts',
    term: 'JSON-RPC',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/scripted-acp-agent.ts',
    term: 'stdio',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/thread-container.ts',
    term: 'capability',
    count: 2,
    reason: REASON.containment,
  },
  {
    file: 'src/main/services/container-runtime/thread-container.ts',
    term: 'stdio',
    count: 2,
    reason: REASON.identifier,
  },
  {
    file: 'src/main/services/container-runtime/worker-entry.ts',
    term: 'ACP',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/worker-entry.ts',
    term: 'harness',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/worker-entry.ts',
    term: 'stdio',
    count: 4,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/container-runtime/worker-image-files.ts',
    term: 'ACP',
    count: 1,
    reason: REASON.containerWorker,
  },
  {
    file: 'src/main/services/security/runtime-containment.ts',
    term: 'capability',
    count: 3,
    reason: REASON.containment,
  },
  {
    file: 'src/renderer/views/container-run-control.ts',
    term: 'capability',
    count: 1,
    reason: REASON.containment,
  },

  // Prompts and tool descriptions written for a model.
  {
    file: 'packages/review/src/lenses.ts',
    term: 'capability',
    count: 1,
    reason: REASON.modelPrompt,
  },
  { file: 'packages/review/src/pr-summary.ts', term: 'IPC', count: 1, reason: REASON.modelPrompt },
  {
    file: 'packages/thread-store/src/debug-trace-prompt.ts',
    term: 'ACP',
    count: 1,
    reason: REASON.modelPrompt,
  },
  {
    file: 'src/main/services/agent-execution-guidance.ts',
    term: 'capability',
    count: 1,
    reason: REASON.modelPrompt,
  },
  {
    file: 'src/main/services/coordination-demo.ts',
    term: 'capability',
    count: 1,
    reason: REASON.modelPrompt,
  },

  // Identifiers and reason codes.
  {
    file: 'packages/llm/src/classifiers/http.ts',
    term: 'capability',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'packages/llm/src/classifiers/semif.ts',
    term: 'capability',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'packages/llm/src/classifiers/validation.ts',
    term: 'capability',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'packages/review/src/fake-container-engine.ts',
    term: 'stdio',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'packages/review/src/reproducer-runner.ts',
    term: 'stdio',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'src/main/services/security/permission-gate.ts',
    term: 'capability',
    count: 2,
    reason: REASON.identifier,
  },
  { file: 'src/renderer/demo/demo-api.ts', term: 'stdio', count: 1, reason: REASON.identifier },
  {
    file: 'src/renderer/perf-autopilot.ts',
    term: 'capability',
    count: 1,
    reason: REASON.identifier,
  },
  {
    file: 'src/renderer/views/setup/providers-section.ts',
    term: 'capability',
    count: 2,
    reason: REASON.identifier,
  },
  { file: 'src/shared/humanize-identifier.ts', term: 'ACP', count: 1, reason: REASON.casing },

  // MCP / plugin transport: the name users type into an MCP config.
  {
    file: 'packages/agent/src/plugins/agent-plugin-mcp.ts',
    term: 'stdio',
    count: 3,
    reason: REASON.mcpTransport,
  },
  {
    file: 'packages/plugin-sdk/src/mcp-config.ts',
    term: 'stdio',
    count: 6,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/main/services/apple-development/xcodebuildmcp.ts',
    term: 'stdio',
    count: 1,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/main/services/mcp/mcp-registry.ts',
    term: 'stdio',
    count: 2,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/main/services/plugins/agent-plugin-mcp-runtime.ts',
    term: 'stdio',
    count: 2,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/main/services/plugins/plugin-install-service.ts',
    term: 'stdio',
    count: 4,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/main/services/plugins/plugin-service.ts',
    term: 'stdio',
    count: 2,
    reason: REASON.mcpTransport,
  },
  {
    file: 'src/renderer/views/settings-dialog.ts',
    term: 'stdio',
    count: 2,
    reason: REASON.mcpTransport,
  },

  // Plugin authors and advanced settings.
  {
    file: 'packages/agent/src/plugins/agent-plugin-manifest.ts',
    term: 'ACP',
    count: 1,
    reason: REASON.pluginAuthor,
  },
  {
    file: 'packages/agent/src/plugins/plugin-registry.ts',
    term: 'ACP',
    count: 2,
    reason: REASON.pluginAuthor,
  },
  {
    file: 'src/renderer/views/settings-dialog.ts',
    term: 'capability',
    count: 1,
    reason: REASON.advancedSettings,
  },
  {
    file: 'packages/agent/src/headless-contract.ts',
    term: 'capability',
    count: 1,
    reason: REASON.devApi,
  },
]

const key = (file: string, term: string): string => `${file}\u0000${term}`

const hits = userCopyHits()

describe('user-facing copy jargon', () => {
  it('has no banned term in a string outside the allowlist', () => {
    const allowed = new Set(ALLOWED.map((entry) => key(entry.file, entry.term)))
    const stray = hits.filter((hit) => !allowed.has(key(hit.file, hit.term)))
    assert.deepEqual(
      stray.map((hit) => `${hit.file}:${String(hit.line)} [${hit.term}] ${hit.text}`),
      [],
      'user-facing copy contains jargon; reword it for a user (see the note at the top of this test)',
    )
  })

  it('keeps every allowance exact, so the list only shrinks', () => {
    const counts = new Map<string, number>()
    for (const hit of hits) {
      counts.set(key(hit.file, hit.term), (counts.get(key(hit.file, hit.term)) ?? 0) + 1)
    }
    const drift = ALLOWED.flatMap((entry) => {
      const actual = counts.get(key(entry.file, entry.term)) ?? 0
      return actual === entry.count
        ? []
        : [`${entry.file} [${entry.term}]: allowed ${String(entry.count)}, found ${String(actual)}`]
    })
    assert.deepEqual(
      drift,
      [],
      'an allowance no longer matches the source; update the count or delete the entry',
    )
  })

  it('lists each allowance once and gives it a reason', () => {
    const seen = new Set<string>()
    for (const entry of ALLOWED) {
      const id = key(entry.file, entry.term)
      assert.ok(!seen.has(id), `duplicate allowance for ${entry.file} [${entry.term}]`)
      seen.add(id)
      assert.ok(entry.reason.length > 0, `${entry.file} needs a reason`)
      assert.ok(
        BANNED_TERMS.some((term) => term.name === entry.term),
        `${entry.file}: ${entry.term} is not a banned term`,
      )
    }
  })
})

describe('user copy scanner', () => {
  const scan = (source: string): string[] =>
    copyStringsIn('fixture.ts', source)
      .map((copy) => copy.text)
      .filter((text) => BANNED_TERMS.some((term) => term.pattern.test(text)))

  it('finds jargon in string, template and multi-line template text', () => {
    assert.deepEqual(scan("const a = 'Open the ACP agent'"), ['Open the ACP agent'])
    assert.deepEqual(scan('const a = `The ${x} stdio pipe`'), [' stdio pipe'])
    assert.deepEqual(scan('const a = `line one\nJSON-RPC line two`'), [
      'line one\nJSON-RPC line two',
    ])
    assert.deepEqual(scan("throw new Error('IPC rejected')"), ['IPC rejected'])
  })

  it('ignores comments, identifiers, keys and import paths', () => {
    assert.deepEqual(scan('// ACP agents speak JSON-RPC over stdio'), [])
    assert.deepEqual(scan('/** The ACP harness. */ const x = 1'), [])
    assert.deepEqual(scan('const acpAgent = new AcpClient()'), [])
    assert.deepEqual(scan("const o = { 'ACP': 1 }"), [])
    assert.deepEqual(scan("const v = parsed['ACP']"), [])
    assert.deepEqual(scan("import { x } from './ACP.ts'"), [])
    assert.deepEqual(scan("type Kind = 'ACP' | 'other'"), [])
  })

  it('ignores developer logs', () => {
    assert.deepEqual(scan("console.warn('[sandbox] ASRT init failed', err)"), [])
    assert.deepEqual(scan('console.log(`ACP ${n} bridges`)'), [])
  })

  it('matches whole words only', () => {
    assert.deepEqual(scan("const a = 'ipcRenderer, acp:codex, JSON, harnessed'"), [])
    assert.deepEqual(scan("const a = 'Test harness'"), ['Test harness'])
    assert.deepEqual(scan("const a = 'acp:codex'"), [])
  })

  it('actually scans the product: the tracked sources are not empty', () => {
    // A scanner that silently found no files would pass every test above.
    assert.ok(hits.length > 0, 'expected at least the allowlisted hits')
    assert.ok(hits.some((hit) => hit.file.startsWith('src/main/')))
    assert.ok(hits.some((hit) => hit.file.startsWith('packages/')))
    assert.ok(hits.some((hit) => hit.file.startsWith('src/renderer/')))
  })
})
