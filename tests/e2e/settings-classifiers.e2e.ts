import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { decodeWithSchema, safeJsonParse } from '@copse/std/safe-json.ts'
import { copseUserDataDir } from '@copse/store-kit/copse-paths.ts'
import { createServer, type Server } from 'node:http'
import type { listClassifierProfiles } from '../../src/main/services/classifiers/classifier-service.ts'
import { $, browser, expect } from '@wdio/globals'
import { E2E_SCREENSHOT_DIR, saveElementScreenshot } from './helpers/screenshot.ts'
import { resetUserData, seedEmptyProject } from './helpers/seed-config.ts'
import { writeE2eEnv } from './helpers/e2e-env.ts'

/** Exercises the real classifier profile, credential, and invocation IPC against a local server. */
describe('classifier connections settings', () => {
  let server: Server | undefined
  let baseUrl = ''
  let requests = 0
  let lastAuthorization: string | undefined
  let fail = false

  before(async () => {
    mkdirSync(E2E_SCREENSHOT_DIR, { recursive: true })
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: '1',
      TYPESAFE_API_KEY: '',
      FEATHERLESS_API_KEY: '',
    })
    server = createServer((request, response) => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/systemone')
      requests += 1
      lastAuthorization = request.headers.authorization
      request.resume()
      response.writeHead(fail ? 401 : 200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify(
          fail
            ? { error: 'Fixture key rejected' }
            : {
                model: 'kev-fixture-1',
                answers: {
                  color: {
                    type: 'choice',
                    choice: 'red',
                    probabilities: { red: 0.95, blue: 0.05 },
                    confidence: 0.8,
                  },
                },
                usage: { input_tokens: 20, output_tokens: 1 },
              },
        ),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    baseUrl = `http://127.0.0.1:${String(address.port)}/v1`
    resetUserData()
    seedEmptyProject(process.cwd(), 'e2e-classifier-settings')
    await browser.reloadSession()
  })

  after(async () => {
    writeE2eEnv({
      COPSE_ALLOW_PLAINTEXT_SECRETS: undefined,
      TYPESAFE_API_KEY: undefined,
      FEATHERLESS_API_KEY: undefined,
    })
    resetUserData()
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve()
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  async function openClassifiers(): Promise<void> {
    await $('.prompt-input').waitForExist({ timeout: 30_000 })
    await $('[aria-label="Settings"]').click()
    await $('#settings-dialog button[data-section="classifiers"]').click()
    await $('#settings-classifiers-host').waitForDisplayed()
  }

  async function clickAction(name: 'save' | 'test' | 'remove'): Promise<void> {
    const action = $(`.classifier-${name}`)
    await action.scrollIntoView({ block: 'center' })
    await action.click()
  }

  async function toggleOptions(): Promise<void> {
    const summary = $('#settings-classifiers-host .provider-advanced summary')
    await summary.scrollIntoView({ block: 'center' })
    await summary.click()
  }

  async function saveClassifier(): Promise<void> {
    await clickAction('save')
    await browser.waitUntil(
      async () => {
        if (await $('#confirm-dialog[open]').isExisting()) {
          await $('#confirm-dialog .confirm-dialog-confirm').click()
        }
        return /Classifier saved/.test(await $('.classifier-status').getText())
      },
      { timeout: 10_000, timeoutMsg: 'classifier connection and key did not save' },
    )
  }

  it('saves a keyed profile and makes only an explicit test call', async () => {
    await openClassifiers()
    const host = $('#settings-classifiers-host')
    await host.$('[name="classifierPreset"]').selectByAttribute('value', 'typesafe')
    await host.$('.classifier-create').click()
    await host.$('[name="classifierLabel"]').setValue('Hosted classifier fixture')
    await host.$('[name="classifierModel"]').setValue('fixture-model')
    await host.$('[name="classifierUrl"]').setValue(baseUrl)
    await host.$('[name="classifierKey"]').setValue('classifier-e2e-secret')
    await toggleOptions()
    await host.$('[name="classifierKeyEnv"]').setValue('')
    await expect(host.$('label:has([name="classifierKeyEnv"])')).toHaveText(
      expect.stringContaining('COPSE_CLASSIFIER_*'),
    )
    await host.$('[name="classifierTimeout"]').setValue('1.005')
    await saveElementScreenshot(
      '#settings-classifiers-host .provider-advanced',
      'settings-classifiers-options.png',
    )
    await toggleOptions()
    await expect(host.$('.classifier-test')).toBeDisabled()
    assert.equal(requests, 0, 'opening and editing must not call inference')
    await saveClassifier()
    assert.equal(requests, 0, 'saving must not call inference')
    const savedProfiles: ReturnType<typeof listClassifierProfiles> = await browser.execute(
      async () => window.api.classifiers.list(),
    )
    assert.equal(savedProfiles.length, 1)
    assert.equal(savedProfiles[0]?.hasKey, true)
    assert.equal(savedProfiles[0]?.profile.timeoutMs, 1005)
    assert.equal(
      JSON.stringify(savedProfiles).includes('classifier-e2e-secret'),
      false,
      'IPC must never return a saved key',
    )
    await expect(host.$('[name="classifierKey"]')).toHaveValue('')
    assert.match(await host.$('.classifier-key-status').getText(), /Key saved/)
    await clickAction('test')
    await browser.waitUntil(
      async () => /Test succeeded/.test(await $('.classifier-status').getText()),
      { timeout: 10_000 },
    )
    assert.equal(requests, 1)
    assert.equal(lastAuthorization, 'Bearer classifier-e2e-secret')
    assert.match(await host.$('.classifier-status').getText(), /color: red/)
    assert.match(await host.$('.classifier-status').getText(), /kev-fixture-1/)
    await saveElementScreenshot('#settings-dialog', 'settings-classifiers.png')
    await host.$('[name="classifierUrl"]').setValue('https://example.com/v1')
    await expect(host.$('.classifier-destination-note')).toBeDisplayed()
    await expect(host.$('.classifier-destination-note')).toHaveText(
      expect.stringContaining('removes any saved key'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-classifiers-destination.png')
    await host.$('[name="classifierUrl"]').setValue(baseUrl)
  })

  it('persists the connection and its credential across restart without exposing the key', async () => {
    // Relaunch uses the persisted profile and secure-key lookup, with no secret readback to the renderer.
    await browser.reloadSession()
    await openClassifiers()
    const host = $('#settings-classifiers-host')
    await expect(host.$('[name="classifierKey"]')).toHaveValue('')
    await clickAction('test')
    await browser.waitUntil(async () => requests === 2, { timeout: 10_000 })
    assert.equal(lastAuthorization, 'Bearer classifier-e2e-secret')
    await browser.waitUntil(
      async () => /Test succeeded/.test(await $('.classifier-status').getText()),
      { timeout: 10_000 },
    )
  })

  it('runs a saved-profile eval using the persisted credential without changing settings', async () => {
    const savedProfiles: ReturnType<typeof listClassifierProfiles> = await browser.execute(
      async () => window.api.classifiers.list(),
    )
    const profile = savedProfiles[0]?.profile
    assert.ok(profile)
    const directory = await mkdtemp(join(tmpdir(), 'copse-classifier-eval-e2e-'))
    const fixturePath = join(directory, 'fixture.jsonl')
    const outputPath = join(directory, 'result.jsonl')
    const userData = copseUserDataDir()
    assert.ok(userData.includes('.wdio-profile-'), 'saved eval must use the disposable e2e profile')
    const settingsPath = join(userData, 'settings.json')
    const before = await readFile(settingsPath, 'utf8')
    const initialRequests = requests
    try {
      await writeFile(
        fixturePath,
        JSON.stringify({
          id: 'saved-credential',
          state: 'The bicycle is red.',
          questions: {
            color: {
              type: 'choice',
              instructions: 'What color is the bicycle?',
              options: { red: null, blue: null },
            },
          },
        }) + '\n',
      )
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          resolve('scripts/run-classifier-eval.mts'),
          '--profile',
          profile.id,
          '--input',
          fixturePath,
          '--output',
          outputPath,
        ],
        {
          env: {
            ...process.env,
            COPSE_PANEL_USER_DATA: userData,
            TYPESAFE_API_KEY: '',
            FEATHERLESS_API_KEY: '',
          },
          timeout: 30_000,
        },
      )
      const output = await readFile(outputPath, 'utf8')
      const record = safeJsonParse(
        output.trim(),
        decodeWithSchema(
          z.object({
            id: z.literal('saved-credential'),
            result: z.object({
              profileId: z.string(),
              model: z.literal('kev-fixture-1'),
              answers: z.object({ color: z.object({ choice: z.literal('red') }) }),
            }),
          }),
        ),
      )
      assert.ok(record, 'saved eval must return the expected typed result')
      assert.equal(record.result.profileId, profile.id)
      assert.equal(requests, initialRequests + 1)
      assert.equal(lastAuthorization, 'Bearer classifier-e2e-secret')
      assert.equal(
        await readFile(settingsPath, 'utf8'),
        before,
        'eval must not rewrite settings or secrets',
      )
      assert.equal(
        `${stdout}${stderr}${output}`.includes('classifier-e2e-secret'),
        false,
        'eval output must not expose the saved key',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('calls keyless local profiles, reports authentication errors, and removes saved profiles', async () => {
    const host = $('#settings-classifiers-host')
    await host.$('.classifier-add').click()
    await host.$('[name="classifierPreset"]').selectByAttribute('value', 'kev')
    await host.$('.classifier-create').click()
    await host.$('[name="classifierLabel"]').setValue('Kev fixture')
    await host.$('[name="classifierUrl"]').setValue(baseUrl)
    await expect(host.$('.classifier-credentials')).not.toBeDisplayed()
    await saveClassifier()
    await clickAction('test')
    await browser.waitUntil(
      async () => /Test succeeded/.test(await $('.classifier-status').getText()),
      { timeout: 10_000 },
    )
    assert.equal(lastAuthorization, undefined, 'keyless profiles must send no Authorization header')
    assert.equal(requests, 4)
    fail = true
    await clickAction('test')
    await browser.waitUntil(
      async () => await $('.classifier-status [data-status-kind="error"]').isExisting(),
      { timeout: 10_000 },
    )
    assert.match(await host.$('.classifier-status').getText(), /auth|401|key/i)
    await saveElementScreenshot('#settings-dialog', 'settings-classifiers-error.png')
    await clickAction('remove')
    await browser.waitUntil(async () => (await host.$$('[data-classifier-id]')).length === 1, {
      timeout: 10_000,
    })
    await clickAction('remove')
    await browser.waitUntil(async () => (await host.$$('[data-classifier-id]')).length === 0, {
      timeout: 10_000,
    })
  })

  it('keeps a connection removable when its first key save fails validation', async () => {
    const host = $('#settings-classifiers-host')
    await host.$('[name="classifierPreset"]').selectByAttribute('value', 'custom')
    await host.$('.classifier-create').click()
    await host.$('[name="classifierLabel"]').setValue('Key storage retry')
    await host.$('[name="classifierModel"]').setValue('fixture-model')
    await host.$('[name="classifierUrl"]').setValue(baseUrl)
    // A real IPC validation error happens after the separate profile save has succeeded.
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>(
        '#settings-classifiers-host [name="classifierKey"]',
      )
      if (!input) throw new Error('Missing classifier key field')
      input.value = 'x'.repeat(8193)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await clickAction('save')
    await browser.waitUntil(
      async () =>
        /Connection saved; key save failed/.test(await host.$('.classifier-status').getText()),
      { timeout: 10_000 },
    )
    const savedProfiles: ReturnType<typeof listClassifierProfiles> = await browser.execute(
      async () => window.api.classifiers.list(),
    )
    assert.equal(savedProfiles.length, 1)
    assert.equal(savedProfiles[0]?.hasKey, false)
    assert.equal((await host.$$('[data-classifier-id]')).length, 1)
    await expect(host.$('.classifier-remove')).toHaveText('Remove classifier')
    await expect(host.$('.classifier-test')).toBeDisabled()
    await expect(host.$('.classifier-status')).not.toHaveText(
      expect.stringContaining('IpcValidationError'),
    )
    await saveElementScreenshot('#settings-dialog', 'settings-classifiers-key-failure.png')
    await clickAction('remove')
    await browser.waitUntil(async () => (await host.$$('[data-classifier-id]')).length === 0, {
      timeout: 10_000,
    })
    assert.deepEqual(await browser.execute(async () => window.api.classifiers.list()), [])
  })
})
