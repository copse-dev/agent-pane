import { z } from 'zod'
import { defineTool } from '@shared/types'
import { runCheckupText } from '../services/diagnostics/checkup.ts'

/**
 * Read-only setup health check ("doctor"). Takes no parameters — it inspects the
 * live Copse setup (LLM providers/API keys and their at-rest encryption, MCP
 * servers, skills, model context window, semantic search, command permissions,
 * app version, workspace/git, and the terminal helper) and returns a report of
 * findings grouped by severity with a suggested fix for each actionable item.
 * Applies no changes itself — the agent proposes fixes for the user to approve.
 * Backs the `/checkup` skill.
 */
export const runCheckupTool = defineTool({
  name: 'run_checkup',
  description:
    'Backs the /checkup skill — run ONLY when the user explicitly asks for a checkup/doctor, never on your own initiative. Read-only Copse setup health check: inspects LLM providers/API keys (and whether keys are encrypted at rest), MCP servers, skills, model context window, semantic search, command permissions, app version, workspace/git, and the terminal helper. Returns findings grouped by severity (errors, warnings, healthy) with a suggested fix for each actionable item. Makes no changes — surface the findings to the user and offer to apply fixes.',
  parameters: z.object({}),
  async execute() {
    return await runCheckupText()
  },
})
