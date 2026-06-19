import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import type { ToolRegistry } from './tool-registry.ts'

interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

const activeClients: Client[] = []

export async function loadMcpServers(registry: ToolRegistry): Promise<void> {
  const configPath = join(app.getPath('userData'), 'mcp.json')
  let configs: McpServerConfig[]

  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { servers: McpServerConfig[] }
    configs = parsed.servers ?? []
  } catch {
    return
  }

  for (const cfg of configs) {
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      })
      const client = new Client({ name: 'agent-pane', version: '0.1.0' }, { capabilities: {} })
      await client.connect(transport)
      activeClients.push(client)

      const { tools } = await client.listTools()

      for (const tool of tools) {
        const toolName = `mcp__${cfg.name}__${tool.name}`
        registry.register({
          name: toolName,
          description: `[MCP:${cfg.name}] ${tool.description ?? ''}`,
          parameters: z.unknown(),
          async execute(args, signal) {
            const result = await client.callTool(
              { name: tool.name, arguments: args as Record<string, unknown> },
              undefined,

              { signal: signal as any },
            )
            return (result.content as Array<{ type: string; text?: string }>)
              .map((c) => c.text ?? '')
              .join('\n')
          },
        })
      }

      console.log(`[MCP] Connected to "${cfg.name}" — ${tools.length} tool(s) registered`)
    } catch (err) {
      console.error(`[MCP] Failed to connect "${cfg.name}":`, err)
    }
  }
}

export async function shutdownMcpServers(): Promise<void> {
  await Promise.allSettled(activeClients.map((c) => c.close()))
  activeClients.length = 0
}
