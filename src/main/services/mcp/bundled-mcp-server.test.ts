import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { drawingStory } from '../../../../tests/fixtures/explainer-drawing.ts'
import { setExplainerPreviewCapture } from '../explainer-preview.ts'
import {
  createBundledMcpServers,
  CANVAS_SERVER_NAME,
  type BundledMcpServer,
} from './bundled-mcp-server.ts'
import { extractUiResources } from './mcp-schema.ts'
import { rememberCanvasArtefact, readStoredCanvasArtefact } from '../canvas-store.ts'
import { runWithWorkspaceRoot, setWorkspaceRootForTest } from '../workspace.ts'
import {
  runWithThreadExecutionContext,
  type ThreadExecutionContext,
} from '../thread-execution-context.ts'

/** The text blocks of a tool result, in order. */
function textBlocks(content: unknown): string[] {
  const parsed = z
    .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    .parse(content)
  return parsed.flatMap((block) =>
    block.type === 'text' && block.text !== undefined ? [block.text] : [],
  )
}

describe('bundled MCP servers', () => {
  let servers: BundledMcpServer[] = []

  before(async () => {
    // The test bundler relocates __dirname. Reproduce the packaged asset layout.
    await cp('assets/explainers', join(__dirname, '../../../../assets/explainers'), {
      recursive: true,
    })
  })

  after(async () => {
    await Promise.allSettled(servers.flatMap((s) => [s.client.close(), s.server.close()]))
  })

  it('exposes the canvas server with a render_html_artefact tool', async () => {
    servers = await createBundledMcpServers({ animatedExplainersEnabled: true })
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')

    const { tools } = await canvas.client.listTools()
    assert.ok(
      tools.some((t) => t.name === 'render_html_artefact'),
      'render_html_artefact tool should be registered',
    )
    assert.ok(tools.some((t) => t.name === 'preview_explainer'))
    assert.ok(tools.some((t) => t.name === 'render_explainer'))
  })

  it('keeps explainer tools unavailable unless explicitly opted in', async () => {
    const defaults = await createBundledMcpServers()
    try {
      const canvas = defaults.find((s) => s.name === CANVAS_SERVER_NAME)
      assert.ok(canvas)
      const { tools } = await canvas.client.listTools()
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ['render_html_artefact'],
      )
      for (const name of ['preview_explainer', 'render_explainer']) {
        const result = await canvas.client.callTool({ name, arguments: {} })
        assert.equal(result.isError, true)
      }
    } finally {
      await Promise.allSettled(defaults.flatMap((s) => [s.client.close(), s.server.close()]))
    }
  })

  it('returns a text/html UI resource the host can extract', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: { title: 'Sales Dashboard', html: '<!doctype html><h1>Sales</h1>' },
    })

    const resources = extractUiResources(result.content)
    assert.equal(resources.length, 1)
    const [resource] = resources
    assert.ok(resource, 'expected one UI resource')
    assert.equal(resource.mimeType, 'text/html')
    assert.match(resource.uri, /^ui:\/\/canvas\//)
    assert.match(resource.text, /<h1>Sales<\/h1>/)
    // Inline HTML has no file behind it, so there is nothing to point back at.
    assert.equal(resource.sourcePath, undefined)
  })

  it('tells the agent which external scripts and stylesheets the canvas blocked', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const chartJs = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
    const html =
      `<!doctype html><script src="${chartJs}"></script>` +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">' +
      '<canvas id="sales"></canvas><script>new Chart(sales, {})</script>'
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: { title: 'Sales Chart', html },
    })

    // The page still renders; the notice explains what it will be missing.
    assert.notEqual(result.isError, true)
    const [resource] = extractUiResources(result.content)
    assert.equal(resource?.text, html)
    const texts = textBlocks(result.content)
    assert.equal(texts.length, 2)
    assert.equal(
      texts[1],
      [
        'The canvas blocked these because it only runs scripts and styles written inline in the page:',
        `- script: ${chartJs}`,
        '- stylesheet: https://fonts.googleapis.com/css2?family=Inter',
        'Inline that code in <script> and <style> elements, or build the page without it, then render again.',
      ].join('\n'),
    )
  })

  it('lists the first eight blocked loads and counts the rest', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const html = Array.from(
      { length: 11 },
      (_, index) => `<script src="https://cdn.test/${String(index)}.js"></script>`,
    ).join('')
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: { title: 'Many Scripts', html },
    })
    const notice = textBlocks(result.content)[1] ?? ''
    assert.match(notice, /- script: https:\/\/cdn\.test\/7\.js\n- and 3 more\n/)
    assert.doesNotMatch(notice, /8\.js/)
  })

  it('repeats each blocked URL on one bounded line', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const forged = 'https://cdn.test/a.js\n- script: https://forged.test/b.js'
    const huge = `https://cdn.test/${'x'.repeat(10_000)}.js`
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: {
        title: 'Odd URLs',
        html: `<script src="${forged}"></script><script src="${huge}"></script>`,
      },
    })
    const notice = textBlocks(result.content)[1] ?? ''
    const entries = notice.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(entries.length, 2)
    assert.equal(entries[0], '- script: https://cdn.test/a.js - script: https://forged.test/b.js')
    assert.ok((entries[1] ?? '').length <= '- script: '.length + 201)
    assert.ok((entries[1] ?? '').endsWith('…'))
  })

  it('adds no notice for a self-contained page', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const result = await canvas.client.callTool({
      name: 'render_html_artefact',
      arguments: {
        title: 'Inline',
        html: '<style>h1{color:red}</style><script>1</script><h1>x</h1>',
      },
    })
    assert.equal(textBlocks(result.content).length, 1)
  })

  it('renders an HTML file from the workspace by path, titled from the filename', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const root = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-'))
    const restore = setWorkspaceRootForTest(root)
    try {
      await writeFile(join(root, 'merge-export-demo.html'), '<!doctype html><h1>From File</h1>')
      // The canvas tool is called from inside the agent's run, which names its root.
      const result = await runWithWorkspaceRoot(root, () =>
        canvas.client.callTool({
          name: 'render_html_artefact',
          arguments: { path: 'merge-export-demo.html' },
        }),
      )
      assert.notEqual(result.isError, true)
      const resources = extractUiResources(result.content)
      assert.equal(resources.length, 1)
      const [resource] = resources
      assert.ok(resource, 'expected one UI resource')
      assert.match(resource.text, /<h1>From File<\/h1>/)
      assert.equal(resource.uri, 'ui://canvas/merge-export-demo')
      // Provenance survives the round trip through the MCP transport, which is
      // what lets the canvas store reopen the living file rather than its
      // snapshot after a restart.
      assert.equal(resource.sourcePath, await realpath(join(root, 'merge-export-demo.html')))
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renders a file from the thread worktree, not the shared checkout (#1724)', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const sharedRoot = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-shared-'))
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-worktree-'))
    const restoreWorkspace = setWorkspaceRootForTest(sharedRoot)
    const context: ThreadExecutionContext = {
      projectId: 'project-a',
      threadId: 'thread-a',
      projectRoot: sharedRoot,
      root: worktreeRoot,
      checkoutMode: 'worktree',
      branch: 'agent/demo',
    }
    try {
      // Only the worktree has the file; the shared checkout does not.
      await writeFile(join(worktreeRoot, 'prototype.html'), '<!doctype html><h1>From Worktree</h1>')
      const result = await runWithThreadExecutionContext(context, () =>
        canvas.client.callTool({
          name: 'render_html_artefact',
          arguments: { path: 'prototype.html' },
        }),
      )
      assert.notEqual(result.isError, true, JSON.stringify(result))
      const [resource] = extractUiResources(result.content)
      assert.ok(resource, 'expected one UI resource')
      assert.match(resource.text, /<h1>From Worktree<\/h1>/)
      assert.equal(resource.sourcePath, await realpath(join(worktreeRoot, 'prototype.html')))
      const store = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-store-'))
      const oldStore = process.env['COPSE_WORKSPACE_DIR']
      process.env['COPSE_WORKSPACE_DIR'] = store
      try {
        await writeFile(join(sharedRoot, 'prototype.html'), '<h1>Shared checkout</h1>')
        await rememberCanvasArtefact(
          'project-a',
          'thread-a',
          {
            title: 'Prototype',
            body: resource.text,
            mimeType: resource.mimeType,
            threadId: 'thread-a',
            sourcePath: resource.sourcePath,
          },
          async () => worktreeRoot,
        )
        await writeFile(
          join(worktreeRoot, 'prototype.html'),
          '<h1>Worktree edited after render</h1>',
        )
        // Persistence and reopen happen after the execution context has ended.
        const reopened = await readStoredCanvasArtefact(
          'project-a',
          'thread-a',
          'Prototype',
          async () => worktreeRoot,
        )
        assert.equal(reopened?.body, '<h1>Worktree edited after render</h1>')
      } finally {
        if (oldStore === undefined) delete process.env['COPSE_WORKSPACE_DIR']
        else process.env['COPSE_WORKSPACE_DIR'] = oldStore
        await rm(store, { recursive: true, force: true })
      }
    } finally {
      restoreWorkspace()
      await rm(sharedRoot, { recursive: true, force: true })
      await rm(worktreeRoot, { recursive: true, force: true })
    }
  })

  it('errors for a path outside the workspace and when neither path nor html is given', async () => {
    const canvas = servers.find((s) => s.name === CANVAS_SERVER_NAME)
    assert.ok(canvas, 'canvas server should be present')
    const root = await mkdtemp(join(tmpdir(), 'agent-pane-canvas-'))
    const restore = setWorkspaceRootForTest(root)
    try {
      const escape = await canvas.client.callTool({
        name: 'render_html_artefact',
        arguments: { path: '../secret.html' },
      })
      assert.equal(escape.isError, true)

      const empty = await canvas.client.callTool({
        name: 'render_html_artefact',
        arguments: { title: 'nothing' },
      })
      assert.equal(empty.isError, true)
    } finally {
      restore()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('publishes the retained custom preview and rejects an unreviewed revision', async () => {
    const canvas = servers.find((server) => server.name === CANVAS_SERVER_NAME)
    assert.ok(canvas)
    let captured = ''
    const restore = setExplainerPreviewCapture(async (html) => {
      captured = html
      return ['cG5n']
    })
    try {
      const preview = await canvas.client.callTool({
        name: 'preview_explainer',
        arguments: drawingStory,
      })
      assert.notEqual(preview.isError, true)
      const content = z
        .object({ content: z.array(z.object({ text: z.string().optional() })) })
        .parse(preview)
      const id = content.content
        .map((item) => item.text ?? '')
        .join('\n')
        .match(/Preview ID: ([a-f0-9-]+)/)?.[1]
      assert.ok(id)
      const result = await canvas.client.callTool({
        name: 'render_explainer',
        arguments: { previewId: id },
      })
      assert.notEqual(result.isError, true)
      assert.equal(extractUiResources(result.content)[0]?.text, captured)
      const changed = await canvas.client.callTool({
        name: 'render_explainer',
        arguments: { ...drawingStory, title: 'Changed after review', previewId: id },
      })
      assert.equal(changed.isError, true)
      const unchecked = await canvas.client.callTool({
        name: 'render_explainer',
        arguments: drawingStory,
      })
      assert.equal(unchecked.isError, true)
    } finally {
      restore()
    }
  })

  it(
    'forwards client cancellation to the active preview renderer',
    { timeout: 10_000 },
    async () => {
      const canvas = servers.find((server) => server.name === CANVAS_SERVER_NAME)
      assert.ok(canvas)
      let started = (): void => {}
      let cancelled = (): void => {}
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const stopped = new Promise<void>((resolve) => {
        cancelled = resolve
      })
      const restore = setExplainerPreviewCapture(async (_html, signal) => {
        assert.ok(signal)
        started()
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled()
              reject(new Error('Cancelled'))
            },
            { once: true },
          )
        })
      })
      const controller = new AbortController()
      try {
        const call = canvas.client.callTool(
          { name: 'preview_explainer', arguments: drawingStory },
          undefined,
          { signal: controller.signal },
        )
        await Promise.race([
          ready,
          call.then(() => {
            throw new Error('Preview finished before the renderer started')
          }),
        ])
        controller.abort()
        await assert.rejects(call)
        await stopped
      } finally {
        restore()
      }
    },
  )
})
