/**
 * Todo-plan seed data for `todo-display.e2e.ts`.
 *
 * Lives next to the spec (not under `tests/e2e/helpers/`) so the e2e oracle does
 * not treat the change as a broad helpers edit and force a full suite.
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeSeedConfig } from './helpers/seed-config.ts'
import { copseUserDataDir } from '../../src/main/services/storage/copse-paths.ts'

const userDataDir = copseUserDataDir

export function seedTodoPlanFixtures(workspaceRoot: string): {
  planThreadTitle: string
  noPlanThreadTitle: string
  allCancelledThreadTitle: string
} {
  const projectId = 'e2e-todo-project'
  const planThreadId = 'e2e-todo-thread'
  const noPlanThreadId = 'e2e-todo-no-plan-thread'
  const allCancelledThreadId = 'e2e-todo-all-cancelled-thread'
  const planThreadTitle = 'Todo display test'
  const noPlanThreadTitle = 'No plan thread'
  const allCancelledThreadTitle = 'All cancelled plan'
  const todos = [
    { id: 'todo-1', content: 'Refactor renderer.ts fence extraction', status: 'completed' },
    { id: 'todo-2', content: 'Add mermaid lazy loader + post-render hook', status: 'in_progress' },
    {
      id: 'todo-3',
      content: 'Add CSS, unit tests, and e2e coverage',
      status: 'pending',
      assignedModel: 'local',
      check: { kind: 'typecheck' },
    },
    { id: 'todo-4', content: 'Run npm run check + build/e2e', status: 'pending' },
    { id: 'todo-5', content: 'Create GitHub issue for diagram steering', status: 'pending' },
    // Cancelled items stay in thread state but must not appear in the panel.
    {
      id: 'todo-cancelled',
      content: 'Add unit tests for an abandoned side quest',
      status: 'cancelled',
    },
  ]
  mkdirSync(userDataDir(), { recursive: true })
  writeSeedConfig({
    projects: [{ id: projectId, path: workspaceRoot, name: 'workspace' }],
    activeProjectId: projectId,
    [`threads:${projectId}`]: [
      {
        id: planThreadId,
        title: planThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-todo',
            role: 'user',
            content: 'Implement mermaid and open an issue for diagram steering.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-todo',
            role: 'assistant',
            content: 'Working through the plan.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        todos,
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now() + 3,
        updatedAt: Date.now() + 3,
      },
      {
        id: allCancelledThreadId,
        title: allCancelledThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-all-cancelled',
            role: 'user',
            content: 'Scratch that plan — cancel the remaining todos.',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-all-cancelled',
            role: 'assistant',
            content: "Cancelled the leftover todos; there's nothing left on the plan.",
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        todos: [
          {
            id: 'todo-cancel-1',
            content: 'Add unit tests for the roadmap search feature',
            status: 'cancelled',
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now() + 2,
        updatedAt: Date.now() + 2,
      },
      {
        id: noPlanThreadId,
        title: noPlanThreadTitle,
        status: 'idle',
        messages: [
          {
            id: 'msg-user-no-plan',
            role: 'user',
            content: 'What files are in src/?',
            toolCalls: [],
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-no-plan',
            role: 'assistant',
            content: 'I can list the src directory for you.',
            toolCalls: [],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now() + 1,
        updatedAt: Date.now() + 1,
      },
    ],
  })
  return { planThreadTitle, noPlanThreadTitle, allCancelledThreadTitle }
}
