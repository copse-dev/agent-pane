import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { describeToolArgError } from './tool-arg-error.ts'

// Regression for the reported failure: a smaller model produced a plan whose
// first todo carried no `content`, and the transcript showed the ZodError's
// own message — the pretty-printed issues array — as the tool result:
//
//   Error: [ { "expected": "string", "code": "invalid_type",
//              "path": [ "todos", 0, "content" ], "message": "…" } ]
//
// The user reads a wall of JSON, and the model reads a payload instead of an
// instruction it can act on.

/** The schema shape `update_todos` uses, reduced to the fields under test. */
const todosSchema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().optional(),
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
      }),
    )
    .min(1),
})

function errorFor(value: unknown): unknown {
  try {
    todosSchema.parse(value)
  } catch (err) {
    return err
  }
  throw new Error('sanity: the schema was expected to reject this value')
}

describe('describeToolArgError', () => {
  it('names the field for the reported missing-content plan', () => {
    const err = errorFor({ todos: [{ id: 't1', status: 'in_progress' }] })
    const msg = describeToolArgError('update_todos', err)
    assert.ok(msg)
    assert.match(msg, /^update_todos: the arguments did not match/)
    assert.match(msg, /todos\[0\]\.content/)
    assert.match(msg, /expected string, received undefined/)
    assert.match(msg, /call the tool again/)
    // The JSON dump this replaces must not survive into the message.
    assert.doesNotMatch(msg, /[{}[]"]/)
    assert.equal(msg.includes('\n'), false, 'stays one line for the transcript')
  })

  it('drops the redundant "Invalid input" prefix zod puts on each issue', () => {
    const err = errorFor({ todos: [{ content: 'x', status: 'nope' }] })
    const msg = describeToolArgError('update_todos', err)
    assert.ok(msg)
    assert.doesNotMatch(msg, /Invalid input/i)
  })

  it('lists several bad fields but caps the list with a count', () => {
    const todos = Array.from({ length: 9 }, () => ({ status: 'pending' }))
    const msg = describeToolArgError('update_todos', errorFor({ todos }))
    assert.ok(msg)
    assert.match(msg, /and 4 more/)
    assert.equal((msg.match(/todos\[/g) ?? []).length, 5, 'reports at most five fields')
  })

  it('reports a wholly wrong argument object without a field path', () => {
    const msg = describeToolArgError('update_todos', errorFor('not an object'))
    assert.ok(msg)
    assert.match(msg, /expected object/)
  })

  it('returns null for an execution error, leaving its own message alone', () => {
    assert.equal(
      describeToolArgError('run_shell', new Error('command not found: frobnicate')),
      null,
    )
    assert.equal(describeToolArgError('run_shell', 'a thrown string'), null)
  })
})
