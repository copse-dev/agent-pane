/**
 * Bundled, in-process MCP server(s) that ship with Copse so features "just work"
 * with zero user configuration — no subprocess, port, or network. Each server is
 * linked to its client over an in-memory transport and connected by the MCP
 * registry exactly like an external server, so its tool results flow through the
 * same flatten / UI-resource extraction path.
 *
 * Today this hosts the experimental canvas: a `render_html_artefact` tool that
 * returns a `text/html` MCP-UI resource for the host to render as a sandboxed
 * artefact. Gated by the `mcpUiArtefactsEnabled` setting.
 */
import { errorMessage } from '@shared/errors.ts'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import { resolveWorkspacePath } from './workspace.ts'

const MAX_ARTEFACT_BYTES = 512 * 1024

/**
 * Resolve the HTML to render from either an inline string or a workspace file
 * path. Reading from a written file is preferred — it keeps the artefact as a
 * real, editable, versioned file rather than an inline blob. Path access is
 * confined to the workspace by `resolveWorkspacePath`.
 */
async function resolveArtefactHtml(input: {
  html?: string | undefined
  path?: string | undefined
  title?: string | undefined
}): Promise<{ html: string; title: string }> {
  if (input.path) {
    const abs = resolveWorkspacePath(input.path) // throws if outside the workspace
    let raw: string
    try {
      raw = await readFile(abs, 'utf8')
    } catch {
      throw new Error(`Could not read artefact file: ${input.path}`)
    }
    if (!raw.trim()) throw new Error(`Artefact file is empty: ${input.path}`)
    if (Buffer.byteLength(raw, 'utf8') > MAX_ARTEFACT_BYTES) {
      throw new Error(`Artefact file is too large (max 512 KB): ${input.path}`)
    }
    const fallbackTitle = basename(input.path).replace(/\.[^.]+$/, '')
    return { html: raw, title: input.title ?? fallbackTitle }
  }
  if (input.html) {
    return { html: input.html, title: input.title ?? 'artefact' }
  }
  throw new Error('Provide either `path` (a workspace HTML file, preferred) or inline `html`.')
}

/** Stable name for the bundled canvas server (shown in Settings → MCP servers). */
export const CANVAS_SERVER_NAME = 'copse-canvas'

/** A bundled server plus the client wired to talk to it over an in-memory pair. */
export interface BundledMcpServer {
  name: string
  server: McpServer
  client: Client
}

function buildCanvasServer(): { name: string; server: McpServer } {
  const server = new McpServer({ name: CANVAS_SERVER_NAME, version: '0.1.0' }, { capabilities: {} })

  server.registerTool(
    'render_html_artefact',
    {
      title: 'Render HTML artefact',
      description:
        'Render a self-contained HTML document as a live, sandboxed artefact in the canvas ' +
        '(Browser pane). Use for demos, charts, dashboards, and small interactive UIs. Prefer ' +
        'writing the HTML to a file in the workspace and passing its `path` (the artefact stays a ' +
        'real, editable, versioned file) — or pass inline `html`. The document runs fully isolated ' +
        "with no access to the user's machine, files, or network beyond what it loads itself; " +
        'include all CSS/JS inline.',
      inputSchema: {
        title: z.string().max(200).optional().describe('Short title for the artefact tab.'),
        path: z
          .string()
          .max(1024)
          .optional()
          .describe(
            'Preferred: workspace-relative path to an HTML file to render (write it first with ' +
              'write_file). Use instead of `html`.',
          ),
        html: z
          .string()
          .max(512 * 1024)
          .optional()
          .describe('Inline, complete HTML document. Alternative to `path`.'),
      },
      // Rendering into the sandbox does not modify the host; no approval needed.
      annotations: { readOnlyHint: true },
    },
    async ({ title, html, path }) => {
      let resolved: { html: string; title: string }
      try {
        resolved = await resolveArtefactHtml({ html, path, title })
      } catch (err) {
        return {
          content: [{ type: 'text', text: errorMessage(err) }],
          isError: true,
        }
      }
      const slug =
        resolved.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'artefact'
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `ui://canvas/${slug}`,
              mimeType: 'text/html',
              text: resolved.html,
            },
          },
          {
            type: 'text',
            text:
              `Rendered "${resolved.title}" in the canvas — it is now visible to the user in the ` +
              `Browser pane. The canvas is a live sandboxed preview, not a browser_* tab, so ` +
              `browser_snapshot / browser_screenshot can't target it (they drive a different ` +
              `browser). To capture it, open the page via its dev-server URL with browser_navigate ` +
              `first; otherwise just tell the user it is displayed.`,
          },
        ],
      }
    },
  )

  return { name: CANVAS_SERVER_NAME, server }
}

/** Factories for every bundled server, so callers connect them uniformly. */
const BUNDLED_SERVER_FACTORIES: ReadonlyArray<() => { name: string; server: McpServer }> = [
  buildCanvasServer,
]

/**
 * Instantiate the bundled servers and connect each to its own in-memory client.
 * The caller (MCP registry) lists/registers the client's tools and owns closing
 * the client. Returns [] on any wiring failure so a bundled-server bug can't take
 * down the rest of MCP loading.
 */
export async function createBundledMcpServers(): Promise<BundledMcpServer[]> {
  const out: BundledMcpServer[] = []
  for (const factory of BUNDLED_SERVER_FACTORIES) {
    const { name, server } = factory()
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'copse-panel', version: '0.1.0' }, { capabilities: {} })
    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)
      out.push({ name, server, client })
    } catch (err) {
      console.error('[MCP] Failed to start bundled server:', err)
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  }
  return out
}
