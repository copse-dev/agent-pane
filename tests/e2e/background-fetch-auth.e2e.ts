import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import { listenOnFixturePort } from './helpers/fixture-server.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'
import { setComposerValue } from './helpers/composer.ts'
import { expectAssistantReply, installMockScenario } from './helpers/mock-scenario.ts'
import { removeE2eTree } from './helpers/remove-tree.ts'
import { saveAppScreenshot } from './helpers/screenshot.ts'
import {
  resetUserData,
  seedE2eViewport,
  seedStableWorkspace,
  writeSeedConfig,
} from './helpers/seed-config.ts'

const PROJECT = 'background-auth-project'
const THREAD = 'background-auth-thread'

describe('unattended upstream authentication', () => {
  let fixture = ''
  let project = ''
  let cachedTip = ''
  let requests = 0
  const originalEnv = {
    HOME: process.env['HOME'],
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
  }
  const server = createServer((_request, response) => {
    requests += 1
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owned-background-fixture"' })
    response.end('Authentication required')
  })
  const git = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: project,
      encoding: 'utf8',
    }).trim()

  before(async function () {
    this.timeout(90_000)
    resetUserData()
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'copse-background-auth-ui-')))
    const home = join(fixture, 'home')
    mkdirSync(home)
    // No host/global credential helper or live account participates.
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper =\n')
    writeE2eEnv({ HOME: home, XDG_CONFIG_HOME: join(home, '.config') })
    project = seedStableWorkspace({ root: join(fixture, 'project') })
    cachedTip = git(['rev-parse', 'HEAD'])
    git(['update-ref', 'refs/remotes/origin/main', cachedTip])
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const origin = await listenOnFixturePort(server, 43722)
    git(['remote', 'add', 'origin', `${origin}/project.git`])
    const timestamp = Date.UTC(2026, 0, 8, 12)
    writeSeedConfig({
      projects: [{ id: PROJECT, path: project, name: 'Local project', worktreeMode: 'never' }],
      activeProjectId: PROJECT,
      expandedProjectId: PROJECT,
      activeThreadId: THREAD,
      [`threads:${PROJECT}`]: [
        {
          id: THREAD,
          title: 'Local work',
          status: 'idle',
          model: 'claude-sonnet-4-6',
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    })
    seedE2eViewport(
      { width: 1280, height: 800 },
      {
        theme: 'dark',
        model: 'claude-sonnet-4-6',
        subagentsEnabled: false,
        backgroundDefaultBranchFetch: true,
      },
    )
    await browser.reloadSession()
    await $('.prompt-input').waitForDisplayed({ timeout: 30_000 })
  })

  after(async () => {
    resetUserData()
    writeE2eEnv(originalEnv)
    await browser.reloadSession()
    server.closeAllConnections()
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve()
      }),
    )
    if (fixture) removeE2eTree(fixture)
  })

  it('finishes a real startup HTTP401 without a modal and keeps local chat usable', async function () {
    this.timeout(60_000)
    await browser.waitUntil(
      async () => {
        const snapshot = await browser.execute(() => window.api.processManager.snapshot())
        return (
          snapshot.network?.rows.some(
            (row) => row.label === 'git fetch' && row.status === 'failed' && row.endedAt !== null,
          ) ?? false
        )
      },
      {
        timeout: 15_000,
        timeoutMsg: 'real background Git must complete its authentication failure',
      },
    )
    assert.ok(requests > 0, 'startup refresh reached the owned HTTP401 server')
    await expect($('#ssh-prompt-dialog')).not.toBeDisplayed()
    assert.equal(git(['rev-parse', 'refs/remotes/origin/main']), cachedTip)
    assert.equal(git(['rev-parse', 'HEAD']), cachedTip)
    const index = readFileSync(join(project, '.git', 'index'))
    const prompt = 'Can I keep working locally?'
    const reply = 'Yes. Your local work is ready.'
    const scenario = await installMockScenario(
      {
        title: 'Local work after upstream failure',
        turns: [{ user: prompt, responses: [{ text: reply }] }],
      },
      THREAD,
    )
    await setComposerValue(prompt)
    await expect($('.submit-btn')).toBeEnabled()
    await $('.submit-btn').click()
    await expectAssistantReply(reply)
    await scenario.assertComplete()
    await expect($('#ssh-prompt-dialog')).not.toBeDisplayed()
    await expect($('.prompt-input')).toBeDisplayed()
    assert.equal(git(['rev-parse', 'refs/remotes/origin/main']), cachedTip)
    assert.equal(git(['rev-parse', 'HEAD']), cachedTip)
    assert.deepEqual(readFileSync(join(project, '.git', 'index')), index)
    await saveAppScreenshot('background-fetch-auth-local-work.png')
  })
})
