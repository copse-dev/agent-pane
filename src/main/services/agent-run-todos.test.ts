import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getAgentRunTodos,
  getTodoToolPostProcess,
  runWithAgentRunTodoContext,
  setAgentRunTodos,
} from './agent-run-todos.ts'
import type { TodoItem } from '@shared/types/todo.ts'

function item(id: string, content: string): TodoItem {
  return { id, content, status: 'pending' }
}

describe('agent-run-todos ALS isolation', () => {
  it('returns empty outside a run context', () => {
    assert.deepEqual(getAgentRunTodos(), [])
    assert.equal(getTodoToolPostProcess(), null)
  })

  it('throws when setting todos outside a run context', () => {
    assert.throws(() => setAgentRunTodos([item('x', 'nope')]), /No agent-run todo context/)
  })

  it('scopes todos and onUpdate to nested run contexts', async () => {
    const aUpdates: TodoItem[][] = []
    const bUpdates: TodoItem[][] = []

    await runWithAgentRunTodoContext(
      {
        initial: [item('a1', 'A plan')],
        onUpdate: (todos) => {
          aUpdates.push(todos)
        },
      },
      async () => {
        assert.equal(getAgentRunTodos()[0]?.content, 'A plan')

        await runWithAgentRunTodoContext(
          {
            initial: [item('b1', 'B plan')],
            onUpdate: (todos) => {
              bUpdates.push(todos)
            },
          },
          async () => {
            assert.equal(getAgentRunTodos()[0]?.content, 'B plan')
            setAgentRunTodos([item('b1', 'B updated')])
            assert.equal(getAgentRunTodos()[0]?.content, 'B updated')
          },
        )

        // Outer store restored after inner scope exits.
        assert.equal(getAgentRunTodos()[0]?.content, 'A plan')
        setAgentRunTodos([item('a1', 'A updated')])
        assert.equal(getAgentRunTodos()[0]?.content, 'A updated')
      },
    )

    assert.deepEqual(getAgentRunTodos(), [])
    assert.equal(aUpdates.length, 1)
    assert.equal(aUpdates[0]?.[0]?.content, 'A updated')
    assert.equal(bUpdates.length, 1)
    assert.equal(bUpdates[0]?.[0]?.content, 'B updated')
  })

  it('keeps concurrent runs isolated across overlapping awaits', async () => {
    const aSeen: string[] = []
    const bSeen: string[] = []
    let releaseB!: () => void
    const bStarted = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let releaseA!: () => void
    const aMayFinish = new Promise<void>((resolve) => {
      releaseA = resolve
    })

    const runA = runWithAgentRunTodoContext(
      {
        initial: [item('a', 'from-A')],
        onUpdate: (todos) => {
          aSeen.push(todos.map((t) => t.content).join(','))
        },
        postProcess: async (_before, after) => ({
          todos: after.map((t) => ({ ...t, content: `${t.content}+A` })),
        }),
      },
      async () => {
        assert.equal(getAgentRunTodos()[0]?.content, 'from-A')
        assert.equal((await getTodoToolPostProcess()?.([], getAgentRunTodos()))?.todos[0]?.content, 'from-A+A')
        releaseB()
        await aMayFinish
        // Still A's plan after B has mutated its own store.
        assert.equal(getAgentRunTodos()[0]?.content, 'from-A')
        setAgentRunTodos([item('a', 'A-final')])
      },
    )

    const runB = (async () => {
      await bStarted
      await runWithAgentRunTodoContext(
        {
          initial: [item('b', 'from-B')],
          onUpdate: (todos) => {
            bSeen.push(todos.map((t) => t.content).join(','))
          },
          postProcess: async (_before, after) => ({
            todos: after.map((t) => ({ ...t, content: `${t.content}+B` })),
          }),
        },
        async () => {
          assert.equal(getAgentRunTodos()[0]?.content, 'from-B')
          assert.equal(
            (await getTodoToolPostProcess()?.([], getAgentRunTodos()))?.todos[0]?.content,
            'from-B+B',
          )
          setAgentRunTodos([item('b', 'B-mid')])
          releaseA()
          assert.equal(getAgentRunTodos()[0]?.content, 'B-mid')
        },
      )
    })()

    await Promise.all([runA, runB])

    assert.deepEqual(aSeen, ['A-final'])
    assert.deepEqual(bSeen, ['B-mid'])
    assert.deepEqual(getAgentRunTodos(), [])
  })

  it('does not let one run finishing clear a sibling run', async () => {
    let releaseInner!: () => void
    const innerGate = new Promise<void>((resolve) => {
      releaseInner = resolve
    })
    let releaseOuterDone!: () => void
    const outerDone = new Promise<void>((resolve) => {
      releaseOuterDone = resolve
    })

    const outer = runWithAgentRunTodoContext(
      {
        initial: [item('outer', 'outer-plan')],
        onUpdate: () => {},
      },
      async () => {
        releaseInner()
        await outerDone
        assert.equal(getAgentRunTodos()[0]?.content, 'outer-plan')
      },
    )

    const inner = (async () => {
      await innerGate
      await runWithAgentRunTodoContext(
        {
          initial: [item('inner', 'inner-plan')],
          onUpdate: () => {},
        },
        async () => {
          assert.equal(getAgentRunTodos()[0]?.content, 'inner-plan')
        },
      )
      // Inner scope ended; outer (sibling concurrent) still has its plan when we
      // only nested — for true siblings, start outer first then sibling:
    })()

    await inner
    releaseOuterDone()
    await outer
  })

  it('binds postProcess per run so concurrent hooks do not cross-wire', async () => {
    const calls: string[] = []
    let releaseB!: () => void
    const bGo = new Promise<void>((r) => {
      releaseB = r
    })
    let releaseA!: () => void
    const aGo = new Promise<void>((r) => {
      releaseA = r
    })

    const a = runWithAgentRunTodoContext(
      {
        initial: [],
        onUpdate: () => {},
        postProcess: async () => {
          calls.push('A')
          return { todos: [] }
        },
      },
      async () => {
        releaseB()
        await aGo
        await getTodoToolPostProcess()?.([], [])
      },
    )

    const b = (async () => {
      await bGo
      await runWithAgentRunTodoContext(
        {
          initial: [],
          onUpdate: () => {},
          postProcess: async () => {
            calls.push('B')
            return { todos: [] }
          },
        },
        async () => {
          await getTodoToolPostProcess()?.([], [])
          releaseA()
        },
      )
    })()

    await Promise.all([a, b])
    assert.deepEqual(calls.sort(), ['A', 'B'])
  })
})
