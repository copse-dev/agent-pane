import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildTextWithAttachments } from '@copse/agent/build-text-with-attachments.ts'
import { BRIDGE_MCP_SERVER_NAME, matchesBridgedToolName } from './acp-bridge-name.ts'

/**
 * The attachment steering blocks name an example namespaced tool
 * (`mcp__copse__video_frames`) so an ACP agent recognises the tool it was
 * actually given (#2513). That example is a string literal in
 * `packages/agent`, which cannot import from `src/main` — the agent package
 * stays free of main-process code on purpose. So the two can drift: rename the
 * bridge's MCP server and the steering would keep naming the old one, quietly
 * sending agents to look for a tool nothing offers.
 *
 * These tests are the seam. They live here because only `src/` may import both
 * sides, and they assert the example is a name the bridge's own matcher would
 * accept rather than merely a plausible-looking string.
 */
describe('attachment steering names the bridge actually offers', () => {
  const videoBlock = (): string =>
    buildTextWithAttachments('', [], [], {
      videoRefs: [{ name: 'r.mov', size: '1 MB', path: '/chat/p/t/blobs/media/r.mov' }],
    })
  const archiveBlock = (): string =>
    buildTextWithAttachments('', [], [], {
      archiveRefs: [{ name: 'b.zip', size: '1 MB', path: '/chat/p/t/blobs/media/b.zip' }],
    })

  const exampleFor = (block: string, tool: string): string => {
    const match = new RegExp(`\`([A-Za-z0-9_.\\-]*${tool})\``, 'g')
    const names = [...block.matchAll(match)].map((m) => m[1] ?? '')
    const namespaced = names.find((name) => name !== tool)
    assert.ok(namespaced, `expected the ${tool} steering to show a namespaced example`)
    return namespaced
  }

  it('shows a video example the bridge matcher recognises', () => {
    const example = exampleFor(videoBlock(), 'video_frames')
    assert.ok(
      matchesBridgedToolName(example, 'video_frames'),
      `steering names "${example}", which matchesBridgedToolName rejects`,
    )
  })

  it('shows an archive example the bridge matcher recognises', () => {
    const example = exampleFor(archiveBlock(), 'read_archive')
    assert.ok(
      matchesBridgedToolName(example, 'read_archive'),
      `steering names "${example}", which matchesBridgedToolName rejects`,
    )
  })

  it('builds those examples from the live bridge server name', () => {
    // The whole point of the seam: renaming BRIDGE_MCP_SERVER_NAME must fail
    // here rather than silently leaving stale copy in front of every agent.
    for (const [block, tool] of [
      [videoBlock(), 'video_frames'],
      [archiveBlock(), 'read_archive'],
    ] as const) {
      assert.match(
        exampleFor(block, tool),
        new RegExp(BRIDGE_MCP_SERVER_NAME),
        `steering example must name the bridge server "${BRIDGE_MCP_SERVER_NAME}"`,
      )
    }
  })
})
