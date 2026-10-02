import { $, expect } from '@wdio/globals'
import { execFileSync } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { waitForAgentIdle } from '../helpers.ts'
import { setComposerValue } from './composer.ts'
import { installMockScenario } from './mock-scenario.ts'

export function seedCleanFeatureBranch(root: string): void {
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' })
  writeFileSync(join(root, 'README.md'), 'CI follow-up fixture\n', 'utf8')
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' })
  execFileSync(
    'git',
    ['-c', 'user.name=Copse E2E', '-c', 'user.email=e2e@copse.test', 'commit', '-m', 'seed'],
    { cwd: root, stdio: 'ignore' },
  )
  execFileSync('git', ['switch', '-c', 'feature/failing-ci'], { cwd: root, stdio: 'ignore' })
}

export function writeFailingPrGhFixture(binDir: string): void {
  const gh = join(binDir, 'gh')
  const failingPr = JSON.stringify({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'CI / check',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
      },
    ],
  })
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi',
      'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
      `  printf '%s\\n' '${failingPr}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'),
    'utf8',
  )
  chmodSync(gh, 0o755)
}

export async function completeMockTurn(includeDebugCiFollowUp = false) {
  await $('.prompt-input').waitForExist({ timeout: 30_000 })
  const prompt = 'Review my uncommitted changes and suggest any improvements.'
  const scenario = await installMockScenario({
    title: 'Review uncommitted changes',
    turns: [
      {
        user: prompt,
        responses: [
          {
            text: 'Start by checking the diff summary, then run the relevant tests before merging.',
          },
        ],
      },
      ...(includeDebugCiFollowUp
        ? [
            {
              user: 'The pull request for this branch has failing CI checks. Investigate the failures and fix them.',
              responses: [
                {
                  text: 'Start with the first failing CI job, compare its logs with the changed files, and isolate the earliest failing command.',
                },
              ],
            },
          ]
        : []),
    ],
  })
  await setComposerValue(prompt)
  await $('.submit-btn').click()

  await waitForAgentIdle(20_000)
  await expect($('.msg-assistant .message-text')).toHaveText(
    'Start by checking the diff summary, then run the relevant tests before merging.',
    { containing: true },
  )

  await $('.follow-up-bubble').waitForExist({ timeout: 30_000 })
  return scenario
}
