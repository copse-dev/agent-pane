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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { z } from 'zod'

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
        '(Browser pane). Use for demos, charts, dashboards, and small interactive UIs. The HTML ' +
        "runs fully isolated with no access to the user's machine, files, or network beyond what " +
        'the document itself loads. Include all CSS/JS inline.',
      inputSchema: {
        title: z.string().max(200).optional().describe('Short title for the artefact tab.'),
        html: z
          .string()
          .min(1)
          .max(512 * 1024)
          .describe('A complete, self-contained HTML document.'),
      },
      // Rendering into the sandbox does not modify the host; no approval needed.
      annotations: { readOnlyHint: true },
    },
    async ({ title, html }) => {
      const slug = (title ?? 'artefact')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
      return {
        content: [
          {
            type: 'resource',
            resource: {
              uri: `ui://canvas/${slug || 'artefact'}`,
              mimeType: 'text/html',
              text: html,
            },
          },
          {
            type: 'text',
            text:
              `Rendered "${title ?? 'artefact'}" in the canvas — it is now visible to the user in ` +
              `the Browser pane. The canvas is a separate sandboxed preview, not a browser_* tab, ` +
              `so do NOT call browser_snapshot or browser_screenshot on it (those drive a different ` +
              `browser and will report "unknown browser tab"). You already have the HTML you sent, ` +
              `so there is nothing more to capture; just tell the user it is displayed.`,
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
