import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  BUG_FORM_PLATFORMS,
  buildAppHelpMenuItems,
  reportIssueUrl,
  type ReportIssueContext,
} from './app-menu-help-items.ts'

const RELEASE_MAC: ReportIssueContext = {
  version: '0.1.0-beta.12',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  systemVersion: '26.0.1',
}

function params(context: ReportIssueContext): URLSearchParams {
  const url = new URL(reportIssueUrl(context))
  assert.equal(url.origin + url.pathname, 'https://github.com/copse-dev/agent-pane/issues/new')
  return url.searchParams
}

describe('reportIssueUrl', () => {
  it('opens the bug form with the version and platform filled in', () => {
    const query = params(RELEASE_MAC)
    assert.equal(query.get('template'), 'bug.yml')
    assert.equal(query.get('version'), '0.1.0-beta.12')
    assert.equal(query.get('platform'), BUG_FORM_PLATFORMS.macArm64)
  })

  it('carries nothing but the template, version, and platform', () => {
    assert.deepEqual([...params(RELEASE_MAC).keys()].sort(), ['platform', 'template', 'version'])
  })

  it('picks the Intel option and the unsupported-macOS option', () => {
    assert.equal(params({ ...RELEASE_MAC, arch: 'x64' }).get('platform'), BUG_FORM_PLATFORMS.macX64)
    assert.equal(
      params({ ...RELEASE_MAC, systemVersion: '15.6' }).get('platform'),
      BUG_FORM_PLATFORMS.macOlder,
    )
  })

  it('marks a source build and maps source-only platforms', () => {
    const linux = params({ ...RELEASE_MAC, packaged: false, platform: 'linux', arch: 'x64' })
    assert.equal(linux.get('version'), '0.1.0-beta.12 (source build)')
    assert.equal(linux.get('platform'), BUG_FORM_PLATFORMS.linux)
    assert.equal(
      params({ ...RELEASE_MAC, platform: 'win32' }).get('platform'),
      BUG_FORM_PLATFORMS.windows,
    )
  })

  it('leaves the platform for the user to choose when it is unknown', () => {
    assert.equal(params({ ...RELEASE_MAC, platform: 'freebsd' }).has('platform'), false)
    // An unreadable macOS version must not label the reporter "unsupported".
    assert.equal(params({ ...RELEASE_MAC, systemVersion: '' }).has('platform'), false)
    assert.equal(params({ ...RELEASE_MAC, arch: 'ia32' }).has('platform'), false)
  })
})

describe('BUG_FORM_PLATFORMS', () => {
  it('matches the bug form’s Platform options exactly, so the prefill selects one', () => {
    const form = readFileSync(resolve('.github/ISSUE_TEMPLATE/bug.yml'), 'utf8')
    const options = [...form.matchAll(/^ {8}- (.+)$/gm)].map((match) => match[1])
    for (const platform of Object.values(BUG_FORM_PLATFORMS)) {
      assert.ok(options.includes(platform), `bug.yml has no Platform option "${platform}"`)
    }
    assert.match(form, /^ {4}id: version$/m)
    assert.match(form, /^ {4}id: platform$/m)
  })
})

describe('buildAppHelpMenuItems', () => {
  it('keeps Keyboard Shortcuts and adds Report an Issue…', () => {
    const calls: string[] = []
    const items = buildAppHelpMenuItems({
      showKeyboardShortcuts: () => calls.push('shortcuts'),
      reportIssue: () => calls.push('report'),
    })
    const labels = items.map((item) => item.label ?? item.type)
    assert.deepEqual(labels, ['Keyboard Shortcuts', 'separator', 'Report an Issue…'])
    assert.equal(items[0]?.accelerator, 'CmdOrCtrl+/')
    for (const item of items) {
      if (item.click) Reflect.apply(item.click, undefined, [])
    }
    assert.deepEqual(calls, ['shortcuts', 'report'])
  })
})
