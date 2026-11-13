import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../services/registry-bootstrap.ts'
import { setSetting } from '../services/storage/settings.ts'
import { SANDBOX_TOOLS } from '../services/security/permission-policy.ts'
import {
  BROWSER_TOOLS,
  READ_ONLY_BROWSER_TOOLS,
} from '../services/browser/browser-origin-policy.ts'
import { browserScreenshotTool, browserShowTool, browserTypeTool } from './browser-tools.ts'
import {
  getBrowserSession,
  setBrowserSessionPlatform,
} from '../services/browser/session-manager.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../services/thread-execution-context.ts'
import { resolveCaptureHandle } from '../services/visual-evidence/capture-handle-store.ts'
import { ToolRegistry, setPermissionGateForTests } from '../services/tool-registry.ts'
import { copseToolPermissionId } from '../services/security/tool-permissions.ts'
import { setApprovalHandler } from '../services/approval.ts'
import { runWithAgentRunReadonly } from '../services/agent-run-readonly.ts'

const THREAD_CONTEXT: ThreadExecutionContext = {
  projectId: 'project-a',
  threadId: 'thread-a',
  projectRoot: '/project',
  root: '/project',
  checkoutMode: 'shared',
  branch: 'main',
}

describe('browser_type form entry', () => {
  it('accepts several fields from one page snapshot in one native call', () => {
    const fields = [
      { ref: 'e2', text: 'Harbor release' },
      { ref: 'e3', text: 'Keep the user draft' },
      { ref: 'e4', text: 'high' },
    ]
    const parsed = browserTypeTool.parameters.safeParse({ fields, viewId: 'tab-1' })
    assert.equal(parsed.success, true, 'one form should not require a tool invocation per field')
    assert.deepEqual(parsed.data, { fields, viewId: 'tab-1' })
  })

  it('keeps the existing single-field input supported', () => {
    assert.equal(
      browserTypeTool.parameters.safeParse({ ref: 'e2', text: 'Harbor release' }).success,
      true,
    )
  })

  it('rejects mixing a single field and a form before editing the page', () => {
    assert.equal(
      browserTypeTool.parameters.safeParse({
        ref: 'e2',
        text: 'First value',
        fields: [{ ref: 'e3', text: 'Second value' }],
      }).success,
      false,
    )
  })
})

describe('browser_type grouped-entry permission boundary', () => {
  const args = { fields: [{ ref: 'e1', text: 'Manual draft' }] }
  const signal = new AbortController().signal
  function registry(): ToolRegistry {
    const result = new ToolRegistry()
    result.register(browserTypeTool)
    setPermissionGateForTests(null)
    return result
  }

  afterEach(async () => {
    setApprovalHandler(null)
    setPermissionGateForTests(null)
    await setSetting('toolPermissionOverrides', {})
  })

  it('publishes the fields on the existing object-shaped MCP tool schema', () => {
    const tools = registry().toMcpTools()
    assert.equal(tools.length, 1)
    const tool = tools.at(0)
    assert.ok(tool)
    assert.equal(tool.name, 'browser_type')
    assert.equal(tool.inputSchema['type'], 'object')
    assert.ok(JSON.stringify(tool.inputSchema).includes('"fields"'))
  })

  it('honors Block without touching the native page or prompting', async (t) => {
    const entry = t.mock.method(getBrowserSession(), 'typeFields', async () => 'Entered 1 fields')
    await setSetting('toolPermissionOverrides', {
      [copseToolPermissionId('browser_type')]: 'block',
    })
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: true, remember: false }
    })
    const result = await registry().execute('browser_type', args, signal)
    assert.match(typeof result === 'string' ? result : result.result, /blocked/i)
    assert.equal(entry.mock.callCount(), 0)
    assert.equal(prompts, 0)
  })

  it('asks for each grouped call and a rejection leaves the page untouched', async (t) => {
    const entry = t.mock.method(getBrowserSession(), 'typeFields', async () => 'Entered 1 fields')
    await setSetting('toolPermissionOverrides', { [copseToolPermissionId('browser_type')]: 'ask' })
    let prompts = 0
    setApprovalHandler(async () => {
      prompts++
      return { approved: prompts === 1, remember: false }
    })
    const tools = registry()
    await tools.execute('browser_type', args, signal)
    await tools.execute('browser_type', args, signal)
    assert.equal(prompts, 2)
    assert.equal(entry.mock.callCount(), 1)
  })

  it('keeps grouped page edits out of a read-only run', async (t) => {
    const entry = t.mock.method(getBrowserSession(), 'typeFields', async () => 'Entered 1 fields')
    const tools = registry()
    const result = await runWithAgentRunReadonly(true, () =>
      tools.execute('browser_type', args, signal),
    )
    assert.match(typeof result === 'string' ? result : result.result, /read.only/i)
    assert.equal(entry.mock.callCount(), 0)
  })
})

describe('browser tools registration', () => {
  afterEach(async () => {
    // Restore the on-by-default state for other suites.
    await setSetting('browserToolsEnabled', true)
  })

  it('registers all browser tools by default (enabled)', async () => {
    await setSetting('browserToolsEnabled', true)
    const registry = createRegistry()
    for (const name of BROWSER_TOOLS) {
      assert.equal(registry.has(name), true, `expected ${name} to be registered`)
    }
  })

  it('omits browser tools when explicitly disabled', async () => {
    await setSetting('browserToolsEnabled', false)
    const registry = createRegistry()
    assert.equal(registry.has('browser_navigate'), false)
    assert.equal(registry.has('browser_snapshot'), false)
  })

  it('keeps browser tools out of the always-auto-run set', () => {
    // Navigation is origin-gated, so it must not be in SANDBOX_TOOLS.
    assert.equal(SANDBOX_TOOLS.has('browser_navigate'), false)
  })

  it('treats browser_show as read-only: it cannot reach a new origin', () => {
    // It only promotes a canvas artefact, or a page already open in this
    // session, so there is nothing for an origin prompt to decide. The
    // already-open check in the tool is what makes that claim true.
    assert.equal(BROWSER_TOOLS.has('browser_show'), true)
    assert.equal(READ_ONLY_BROWSER_TOOLS.has('browser_show'), true)
  })
})

describe('browser_show', () => {
  const signal = new AbortController().signal

  afterEach(() => {
    setBrowserSessionPlatform(null)
  })

  it('refuses a url that is not open in the agent browser', () => {
    // Otherwise this becomes an unprompted way to point the user's visible
    // browser at any origin, bypassing the gate on browser_navigate.
    assert.throws(
      () => browserShowTool.execute({ url: 'https://example.com/', title: undefined }, signal),
      /not open in the agent browser/,
    )
  })

  it('rejects being given both a title and a url', () => {
    assert.throws(
      () =>
        browserShowTool.execute({ title: 'Sales Dashboard', url: 'https://example.com/' }, signal),
      /not both/,
    )
  })

  it('requires one of them', () => {
    assert.throws(
      () => browserShowTool.execute({ title: undefined, url: undefined }, signal),
      /Pass a title/,
    )
  })

  it('promotes a canvas artefact by title', () => {
    const shown: Array<{ title: string; threadId?: string }> = []
    setBrowserSessionPlatform({
      createWindow: () => {
        throw new Error('not used')
      },
      getAgentSession: () => {
        throw new Error('not used')
      },
      showUrl: () => {
        throw new Error('not used')
      },
      showArtefact: (identity) => shown.push(identity),
    })

    const out = browserShowTool.execute({ title: 'Sales Dashboard', url: undefined }, signal)

    assert.deepEqual(shown, [{ title: 'Sales Dashboard' }])
    assert.ok(typeof out === 'string')
    assert.match(out, /Sales Dashboard/)
  })

  it('reports the request rather than an outcome it cannot observe', () => {
    // The artefact tabs live in the renderer and `showArtefact` is a one-way
    // send, so main never learns whether a tab matched. The pane promotes
    // nothing when no tab carries this title for this thread — reachable since
    // artefacts became thread-scoped — and this string is the model's only
    // signal, so it must not read as a completed promotion.
    setBrowserSessionPlatform({
      createWindow: () => {
        throw new Error('not used')
      },
      getAgentSession: () => {
        throw new Error('not used')
      },
      showUrl: () => {
        throw new Error('not used')
      },
      showArtefact: () => {},
    })

    const out = browserShowTool.execute({ title: 'Sales Dashboard', url: undefined }, signal)

    assert.ok(typeof out === 'string')
    assert.doesNotMatch(out, /^Brought /)
    assert.match(out, /changes nothing if this thread never rendered that title/i)
  })
})

describe('browser_screenshot', () => {
  const signal = new AbortController().signal

  it('returns the captured pixels with a thread-scoped handle instead of a path', async (t) => {
    const png = Buffer.from('png pixels')
    const result = await runWithThreadExecutionContext(THREAD_CONTEXT, () => {
      t.mock.method(getBrowserSession(), 'screenshot', async () => ({
        png,
        viewId: 'tab-1',
        title: 'Local preview',
        url: 'http://localhost:3000/',
        width: 1280,
        height: 800,
        capturedAt: 1_000,
      }))
      return browserScreenshotTool.execute({ viewId: 'tab-1' }, signal)
    })
    assert.notEqual(typeof result, 'string')
    if (typeof result === 'string') return

    assert.match(result.result, /Captured a 1280×800 PNG of tab-1/)
    assert.match(result.result, /The screenshot is attached to this tool result/)
    assert.doesNotMatch(result.result, /browser-screenshots|Saved screenshot|\/tmp\//)
    assert.deepEqual(result.images, [
      {
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        name: 'browser-tab-1.png',
        kind: 'screenshot',
      },
    ])

    const id = /capture_[0-9a-f-]+/.exec(result.result)?.[0]
    assert.ok(id)
    const owner = { projectId: THREAD_CONTEXT.projectId, threadId: THREAD_CONTEXT.threadId }
    assert.deepEqual(resolveCaptureHandle(id, owner)?.bytes, png)
    assert.equal(resolveCaptureHandle(id, { ...owner, threadId: 'other-thread' }), null)
  })
})
