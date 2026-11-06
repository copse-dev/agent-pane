import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  resetUserData,
  seedEmptyProject,
  writeSeedConfig,
  readSeededSettings,
} from './helpers/seed-config.ts'
import { readFixtureJsonObject } from './helpers/fixture-json.ts'
import { getCopseUserDataDir, agentIsIdle } from './helpers.ts'
import { installMockScenario } from './helpers/mock-scenario.ts'
import { setComposerValue, submitComposer } from './helpers/composer.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'

const roots: string[] = []
const A = 'e2e-port-project-a'
const B = 'e2e-port-project-b'
function initProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'copse-port-grant-'))
  roots.push(root)
  writeFileSync(
    join(root, 'server.cjs'),
    "const http=require('node:http');const server=http.createServer((q,r)=>r.end('synthetic'));server.listen(0,'127.0.0.1',()=>console.log('http://localhost:'+server.address().port));setTimeout(()=>server.close(),1500);\n",
  )
  execFileSync('git', ['init', '-b', 'main'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@copse.invalid',
      'commit',
      '-m',
      'Synthetic local server fixture',
    ],
    { cwd: root },
  )
  return root
}
function thread(id: string): Record<string, unknown> {
  return {
    id,
    title: id,
    status: 'idle',
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    createdAt: 1,
    updatedAt: 1,
  }
}

async function startServer(prompt: string, decision?: 'remember' | 'reject'): Promise<number> {
  const scenario = await installMockScenario({
    title: 'Synthetic local preview',
    turns: [
      {
        user: prompt,
        responses: [
          {
            toolCalls: [
              {
                name: 'run_background',
                args: {
                  action: 'start',
                  command: 'node server.cjs',
                  allow_port_binding: true,
                  timeout_ms: 10_000,
                  wake_on_completion: false,
                },
              },
            ],
          },
          { text: 'The preview request is handled.' },
        ],
      },
    ],
  })
  await setComposerValue(prompt)
  await submitComposer()
  let portPrompts = 0
  await browser.waitUntil(
    async () => {
      const dialog = $('#approval-dialog')
      if ((await dialog.isExisting()) && (await dialog.getProperty('open')) === true) {
        const heading = await dialog.$('.approval-heading').getText()
        if (heading === 'Allow this project to bind a local port?') {
          portPrompts++
          if (decision === undefined)
            throw new Error('a saved project grant unexpectedly asked again')
          await expect(dialog.$('.approval-remember')).toHaveText(
            'Always allow local port binding in this project',
            { containing: true },
          )
          if (decision === 'remember') {
            await dialog.$('.approval-remember-input').click()
            await dialog.$('.approval-approve').click()
          } else await dialog.$('.approval-reject').click()
        } else await dialog.$('.approval-approve').click()
      }
      return agentIsIdle()
    },
    { timeout: 45_000, interval: 100, timeoutMsg: 'local preview request did not settle' },
  )
  await scenario.waitForComplete()
  await scenario.assertComplete()
  return portPrompts
}
async function switchProject(id: string): Promise<void> {
  await $(`.project-entry[data-project-id="${id}"] .project-row`).click()
  await $(`.project-entry[data-project-id="${id}"] .chat-row.selected`).waitForExist({
    timeout: 15_000,
  })
}

describe('remember and revoke project local-port consent', function () {
  this.timeout(180_000)
  before(async () => {
    const first = initProject()
    const second = initProject()
    resetUserData()
    seedEmptyProject(first, A, { subagentsEnabled: false, model: 'claude-sonnet-4-6' })
    const config = readFixtureJsonObject(join(getCopseUserDataDir(), 'config.json'))
    writeSeedConfig({
      ...config,
      projects: [
        { id: A, name: 'Preview A', path: first },
        { id: B, name: 'Preview B', path: second },
      ],
      activeProjectId: A,
      activeThreadId: 'port-thread-a',
      [`threads:${A}`]: [thread('port-thread-a')],
      [`threads:${B}`]: [thread('port-thread-b')],
    })
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
  })
  after(() => {
    resetUserData()
    for (const root of roots) removeE2eTree(root)
  })

  it('remembers only project A, asks in B, revokes from Context and asks again after restart', async () => {
    assert.equal(
      await startServer('Start a local preview and remember consent for project A.', 'remember'),
      1,
    )
    assert.equal(await startServer('Start another preview in the same project.'), 0)
    await switchProject(B)
    assert.equal(await startServer('Start a preview in project B.', 'reject'), 1)
    assert.deepEqual(readSeededSettings()['portBindingAllowedRoots'], [roots[0]])
    await switchProject(A)
    await $('[aria-label="Open thread context"]').click()
    await $('.thread-context').waitForDisplayed({ timeout: 10_000 })
    await saveAppScreenshot('project-port-grant-before-revoke.png')
    const revoke = $('[data-action="revoke-port-binding"]')
    await expect(revoke).toBeDisplayed()
    await expect(revoke).toHaveAttribute(
      'title',
      'Ask again before future tasks can bind a local port. Stop running tasks separately.',
    )
    await revoke.click()
    await browser.waitUntil(
      async () => !(await $('[data-action="revoke-port-binding"]').isExisting()),
      { timeout: 10_000 },
    )
    await saveAppScreenshot('project-port-grant-revoked.png')
    assert.deepEqual(readSeededSettings()['portBindingAllowedRoots'], [])
    await browser.reloadSession()
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    assert.equal(await startServer('Start a preview after reopening project A.', 'reject'), 1)
    await saveAppScreenshot('project-port-grant-asks-again.png')
  })
})
