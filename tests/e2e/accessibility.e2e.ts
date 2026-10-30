import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { $, browser, expect } from '@wdio/globals'
import {
  A11Y_BASELINE_PATH,
  a11yBaselineSchema,
  compareSurface,
  type RuleCounts,
} from '../../scripts/lib/a11y-baseline.mts'
import { decodeWithSchema, safeJsonParse } from '../../scripts/lib/safe-json.mts'
import { scanAccessibility, type AxeScan, type AxeViolationNode } from './helpers/axe.ts'
import { submitComposer } from './helpers/composer.ts'
import { prepareMockToolTurn } from './helpers/mock-scenario.ts'
import {
  resetUserData,
  seedEmptyProject,
  seedStableWorkspace,
  writeSeedConfig,
  writeSettings,
} from './helpers/seed-config.ts'

// The accessibility acceptance lane (docs/accessibility.md, #1369): axe-core
// WCAG A/AA scans of representative surfaces against a shrink-only baseline,
// plus keyboard-only journeys that a DOM scan cannot prove.

const baseline = safeJsonParse(
  readFileSync(A11Y_BASELINE_PATH, 'utf8'),
  decodeWithSchema(a11yBaselineSchema),
)
if (!baseline) throw new Error(`${A11Y_BASELINE_PATH} does not match its schema`)

/** Every surface's observed counts, written out so a fix can shrink the baseline. */
const observed: Record<string, RuleCounts> = {}

function describeNodes(nodes: readonly AxeViolationNode[], rule: string): string {
  return nodes
    .filter((node) => node.rule === rule)
    .map((node) => `    - [${node.impact}] ${node.target}`)
    .join('\n')
}

function sameCounts(a: RuleCounts, b: RuleCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((rule) => a[rule] === b[rule])
}

/**
 * Scan until two consecutive results agree. Sections such as Settings'
 * connections fill in after the dialog is shown, and a half-loaded surface
 * would make the baseline flap.
 */
async function settledScan(root: string, exclude: readonly string[]): Promise<AxeScan> {
  let previous = await scanAccessibility(root, exclude)
  for (let attempt = 0; attempt < 6; attempt++) {
    await browser.pause(500)
    const next = await scanAccessibility(root, exclude)
    if (sameCounts(previous.counts, next.counts)) return next
    previous = next
  }
  throw new Error(`Accessibility scan of ${root} never settled`)
}

async function expectSurface(
  surface: string,
  root: string,
  exclude: readonly string[] = [],
): Promise<void> {
  if (!baseline) throw new Error('unreachable: baseline checked at load')
  const scan = await settledScan(root, exclude)
  observed[surface] = scan.counts
  const { added, stale } = compareSurface(baseline, surface, scan.counts)
  const lines: string[] = []
  for (const entry of added) {
    const help = scan.nodes.find((node) => node.rule === entry.rule)?.help ?? ''
    lines.push(
      `  NEW ${entry.rule}: ${String(entry.observed)} node(s), baseline allows ${String(entry.allowed)} — ${help}`,
      describeNodes(scan.nodes, entry.rule),
    )
  }
  for (const entry of stale) {
    lines.push(
      `  FIXED ${entry.rule}: ${String(entry.observed)} node(s), baseline records ${String(entry.allowed)} — lower it in ${A11Y_BASELINE_PATH}`,
    )
  }
  if (lines.length > 0) {
    throw new Error(`Accessibility baseline mismatch on "${surface}":\n${lines.join('\n')}`)
  }
}

/** Whether the focused element is inside `selector` (false for body/no focus). */
async function focusInside(selector: string): Promise<boolean> {
  return browser.execute((root) => {
    const active = document.activeElement
    const container = document.querySelector(root)
    return active !== null && active !== document.body && container?.contains(active) === true
  }, selector)
}

async function focusedLabel(): Promise<string> {
  return browser.execute(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return '(none)'
    return `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ''} "${(active.getAttribute('aria-label') ?? active.textContent).trim().slice(0, 40)}"`
  })
}

/** Press Tab (or Shift+Tab) `presses` times, asserting focus never leaves `selector`. */
async function expectTabContained(selector: string, presses: number, shift = false): Promise<void> {
  for (let i = 0; i < presses; i++) {
    await browser.keys(shift ? ['Shift', 'Tab'] : ['Tab'])
    if (!(await focusInside(selector))) {
      throw new Error(
        `${shift ? 'Shift+Tab' : 'Tab'} press ${String(i + 1)} moved focus out of ${selector} to ${await focusedLabel()}`,
      )
    }
  }
}

const TRANSCRIPT_PROJECT = 'e2e-a11y-project'

function seedTranscript(workspace: string, theme: 'light' | 'dark'): void {
  writeSeedConfig({
    projects: [{ id: TRANSCRIPT_PROJECT, path: workspace, name: 'workspace' }],
    activeProjectId: TRANSCRIPT_PROJECT,
    [`threads:${TRANSCRIPT_PROJECT}`]: [
      {
        id: 'e2e-a11y-thread',
        title: 'Accessibility transcript',
        status: 'idle',
        messages: [
          {
            id: 'msg-user-a11y',
            role: 'user',
            content: 'Summarise the greeting module.',
            createdAt: Date.now(),
          },
          {
            id: 'msg-assistant-a11y',
            role: 'assistant',
            content: [
              '## Greeting module',
              '',
              'The module exports one function, `greet`, used by [the entry point](src/index.ts).',
              '',
              '- Takes a **name**',
              '- Returns a template string',
              '',
              '| File | Role |',
              '| --- | --- |',
              '| `src/greeting.ts` | Implementation |',
              '| `src/index.ts` | Caller |',
              '',
              '```ts',
              "greet('world')",
              '```',
            ].join('\n'),
            toolCalls: [
              {
                id: 'tc-a11y-read',
                name: 'read_file',
                args: { path: 'src/greeting.ts' },
                status: 'done',
                result:
                  'export function greet(name: string): string {\n  return `Hello, ${name}!`\n}\n',
              },
            ],
            createdAt: Date.now(),
          },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  })
  writeSettings({ theme })
}

describe('accessibility acceptance lane', () => {
  let workspace = ''

  before(() => {
    workspace = seedStableWorkspace()
  })

  after(() => {
    const dir = join(process.cwd(), 'e2e-failure-artifacts')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'accessibility-observed.json'),
      `${JSON.stringify(observed, null, 2)}\n`,
    )
    resetUserData()
  })

  describe('main window and dialogs (dark)', () => {
    before(async () => {
      resetUserData()
      seedEmptyProject(workspace, TRANSCRIPT_PROJECT, { theme: 'dark', subagentsEnabled: false })
      await browser.reloadSession()
      await $('.prompt-input').waitForExist({ timeout: 30_000 })
    })

    it('scans the empty main window', async () => {
      await expectSurface('main-dark', 'body')
    })

    it('reaches Settings by Tab and keeps keyboard focus inside the dialog', async function () {
      // About 80 key presses, each followed by a focus read.
      this.timeout(120_000)
      const settingsButton = '[aria-label="Settings"]'
      await browser.execute(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      let reached = false
      for (let i = 0; i < 80 && !reached; i++) {
        await browser.keys(['Tab'])
        reached = await browser.execute(
          (selector) => document.activeElement?.matches(selector) === true,
          settingsButton,
        )
      }
      expect(reached).toBe(true)

      await browser.keys(['Enter'])
      const dialog = $('#settings-dialog')
      await dialog.waitForDisplayed({ timeout: 10_000 })
      await browser.waitUntil(() => focusInside('#settings-dialog'), {
        timeout: 5_000,
        timeoutMsg: 'expected Settings to take focus when it opens',
      })
      await expect(dialog).toHaveComputedLabel('Settings')

      await expectTabContained('#settings-dialog', 40)
      await expectTabContained('#settings-dialog', 10, true)

      await browser.keys(['Escape'])
      await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
      await browser.waitUntil(
        () =>
          browser.execute(
            (selector) => document.activeElement?.matches(selector) === true,
            settingsButton,
          ),
        { timeout: 5_000, timeoutMsg: 'expected focus to return to the Settings button' },
      )
    })

    it('scans the Settings dialog', async () => {
      await $('[aria-label="Settings"]').click()
      await $('#settings-dialog').waitForDisplayed({ timeout: 10_000 })
      await $('#settings-dialog form[aria-busy="false"]').waitForExist({ timeout: 10_000 })
      try {
        await expectSurface('settings-general', '#settings-dialog')
      } finally {
        await browser.keys(['Escape'])
        await $('#settings-dialog').waitForDisplayed({ reverse: true, timeout: 10_000 })
      }
    })

    it('focuses, contains and scans the ask_user dialog', async function () {
      this.timeout(60_000)
      await prepareMockToolTurn(
        'Ask me which greeting to use.',
        {
          name: 'ask_user',
          args: {
            questions: [{ question: 'Which greeting should I use?', options: ['Hello', 'Hi'] }],
          },
        },
        'Using the greeting you chose.',
        true,
      )
      await submitComposer()
      const dialog = $('#ask-user-dialog')
      await dialog.waitForDisplayed({ timeout: 30_000 })
      await browser.waitUntil(() => focusInside('#ask-user-dialog'), {
        timeout: 5_000,
        timeoutMsg: 'expected the ask_user dialog to take focus when it opens',
      })
      try {
        await expectTabContained('#ask-user-dialog', 15)
        await expectSurface('ask-user-dialog', '#ask-user-dialog')
      } finally {
        // Escape answers the waiting request, so the run can finish.
        await browser.keys(['Escape'])
        await dialog.waitForDisplayed({ reverse: true, timeout: 10_000 })
      }
    })
  })

  for (const theme of ['dark', 'light'] as const) {
    describe(`transcript with markdown and a tool card (${theme})`, () => {
      before(async () => {
        resetUserData()
        seedTranscript(workspace, theme)
        await browser.reloadSession()
        await $('.tool-card[data-tool-id="tc-a11y-read"]').waitForExist({ timeout: 30_000 })
      })

      it('expands and collapses the tool card from the keyboard', async () => {
        const card = $('.tool-card[data-tool-id="tc-a11y-read"]')
        const summary = card.$('summary.tool-card-header')
        await expect(summary).not.toHaveComputedLabel('')
        await browser.execute(() => {
          const header = document.querySelector<HTMLElement>(
            '.tool-card[data-tool-id="tc-a11y-read"] > summary.tool-card-header',
          )
          header?.focus()
        })
        await expect(summary).toBeFocused()
        const isOpen = (): Promise<boolean> =>
          browser.execute(
            () =>
              document.querySelector<HTMLDetailsElement>('.tool-card[data-tool-id="tc-a11y-read"]')
                ?.open === true,
          )
        const initial = await isOpen()
        await browser.keys(['Enter'])
        await browser.waitUntil(async () => (await isOpen()) !== initial, {
          timeout: 5_000,
          timeoutMsg: 'expected Enter to toggle the tool card',
        })
        await browser.keys(['Space'])
        await browser.waitUntil(async () => (await isOpen()) === initial, {
          timeout: 5_000,
          timeoutMsg: 'expected Space to toggle the tool card back',
        })
        if (!(await isOpen())) await browser.keys(['Enter'])
        await browser.waitUntil(isOpen, { timeout: 5_000, timeoutMsg: 'expected an open card' })
      })

      it('scans the transcript with the tool card expanded', async () => {
        await expectSurface(`transcript-${theme}`, 'body')
      })
    })
  }
})
