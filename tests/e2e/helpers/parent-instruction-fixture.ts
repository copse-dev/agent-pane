import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConversationResponse } from './conversation-server.ts'

export const PARENT_INSTRUCTION_PROMPT =
  'Update the two API files after reading their current contents.'
export const PARENT_INSTRUCTION_GUIDANCE =
  '# API instructions\n\nRead these API rules before changing either file. Keep both exported values lowercase.\n'
export const PARENT_INSTRUCTION_DEFERRAL =
  'Edit deferred because newly activated nested AGENTS.md instructions had not reached you ' +
  'yet. Review the newly loaded workspace instructions, then retry the same edit.'
export const PARENT_INSTRUCTION_HOLD = 'instructions-delivered'
export const PARENT_INSTRUCTION_REPLY = 'Both API files now follow the workspace instructions.'

const FIRST_PATH = 'packages/api/first.ts'
const SECOND_PATH = 'packages/api/second.ts'
/** Reused on the performed retries, as providers with per-response ids do. */
export const PARENT_INSTRUCTION_EDITS = [
  { id: 'call_0', path: FIRST_PATH },
  { id: 'call_1', path: SECOND_PATH },
] as const
const FIRST_BEFORE = "export const first = 'before';\n"
const SECOND_BEFORE = "export const second = 'before';\n"
const FIRST_AFTER = "export const first = 'updated';\n"
const SECOND_AFTER = "export const second = 'updated';\n"

export const PARENT_INSTRUCTION_FILES: Record<string, string> = {
  'packages/api/AGENTS.md': PARENT_INSTRUCTION_GUIDANCE,
  [FIRST_PATH]: FIRST_BEFORE,
  [SECOND_PATH]: SECOND_BEFORE,
}

export function assertParentInstructionFiles(workspace: string, updated: boolean): void {
  assert.equal(
    readFileSync(join(workspace, FIRST_PATH), 'utf8'),
    updated ? FIRST_AFTER : FIRST_BEFORE,
    updated ? 'The first retry must land' : 'The first edit must wait for instruction delivery',
  )
  assert.equal(
    readFileSync(join(workspace, SECOND_PATH), 'utf8'),
    updated ? SECOND_AFTER : SECOND_BEFORE,
    updated ? 'The second retry must land' : 'The second edit must wait for instruction delivery',
  )
}

/** One response activates the scope with a read, then attempts both edits. */
export function parentInstructionResponses(workspace: string): ConversationResponse[] {
  const retries = [
    { id: 'call_0', name: 'write_file', args: { path: FIRST_PATH, content: FIRST_AFTER } },
    { id: 'call_1', name: 'write_file', args: { path: SECOND_PATH, content: SECOND_AFTER } },
  ]
  return [
    {
      user: PARENT_INSTRUCTION_PROMPT,
      assertRequest(request): void {
        const system = request.messages.find((message) => message.role === 'system')
        assert.ok(system && typeof system.content === 'string')
        assert.ok(!system.content.includes(PARENT_INSTRUCTION_GUIDANCE))
        assertParentInstructionFiles(workspace, false)
      },
      toolCalls: [{ name: 'read_file', args: { path: FIRST_PATH } }, ...retries],
    },
    {
      user: PARENT_INSTRUCTION_PROMPT,
      assertRequest(request): void {
        const system = request.messages.find((message) => message.role === 'system')
        assert.ok(system && typeof system.content === 'string')
        assert.ok(system.content.includes(PARENT_INSTRUCTION_GUIDANCE))
        assertParentInstructionFiles(workspace, false)
      },
      toolResults: [
        { name: 'read_file', includes: FIRST_BEFORE.trim() },
        { name: 'write_file', includes: PARENT_INSTRUCTION_DEFERRAL },
        { name: 'write_file', includes: PARENT_INSTRUCTION_DEFERRAL },
      ],
      hold: PARENT_INSTRUCTION_HOLD,
      toolCalls: retries,
    },
    {
      user: PARENT_INSTRUCTION_PROMPT,
      assertRequest(request): void {
        const system = request.messages.find((message) => message.role === 'system')
        assert.ok(system && typeof system.content === 'string')
        assert.ok(system.content.includes(PARENT_INSTRUCTION_GUIDANCE))
        assertParentInstructionFiles(workspace, true)
      },
      toolResults: retries.map(({ name, args }) => ({
        name,
        includes: `Applied edit directly to ${args.path}.`,
      })),
      text: PARENT_INSTRUCTION_REPLY,
    },
  ]
}
