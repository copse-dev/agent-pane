import { createHash } from 'node:crypto'

/** Reviewed header adapters for exact immutable vendor bytes, never for user/project skills. */
const ADAPTERS = new Map([
  [
    '3fbe439f366ea94e0a756fc7288d2d8bd3f871bed4b97219dc1aee2f8c8ab979',
    {
      relativePath: 'plugins/cursor-sdk/skills/cursor-sdk/SKILL.md',
      description:
        'Guide users integrating the Cursor TypeScript SDK (@cursor/sdk) into apps, scripts, CI pipelines, and automations, including local/cloud runtimes, MCP, streaming, cancellation, and errors.',
      reason:
        'Pinned Cursor SDK header uses a 1045-character description. Copse uses a reviewed bounded catalog summary; the original file and instruction body remain intact.',
    },
  ],
  [
    '2391a06aec1bfb475690a9c386207e009090e35c624b5ca6cace3ea4c6705970',
    {
      relativePath: 'plugins/agent-compatibility/skills/check-agent-compatibility/SKILL.md',
      description:
        'Run the full repository compatibility pass: scanner score, startup path, validation loop, and docs reliability.',
      reason:
        'Pinned agent compatibility header has an unquoted colon. Copse quotes the original description for YAML decoding; vendor bytes remain intact.',
    },
  ],
])

export function adaptBundledSkill(
  raw: string,
  skillPath: string,
): { raw: string; reason?: string } {
  const adapter = ADAPTERS.get(createHash('sha256').update(raw).digest('hex'))
  const normalizedPath = skillPath.replaceAll('\\', '/')
  return adapter && normalizedPath.endsWith(`/${adapter.relativePath}`)
    ? {
        raw: raw.replace(
          /^description:.*$/m,
          `description: ${JSON.stringify(adapter.description)}`,
        ),
        reason: adapter.reason,
      }
    : { raw }
}
