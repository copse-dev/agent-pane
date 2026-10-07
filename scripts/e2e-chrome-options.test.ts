import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  cloneRequestedChromeCapabilities,
  readChromeOptions,
  updateChromeOptions,
} from '../tests/e2e/helpers/chrome-options.ts'

describe('Chrome session capability boundary', () => {
  it('reads requested W3C launch options without changing the original capabilities', () => {
    const capabilities = {
      alwaysMatch: {
        browserName: 'chrome',
        'goog:chromeOptions': { args: ['--lang=en-US'], binary: '/fixture/Electron' },
      },
    }
    const original = structuredClone(capabilities)
    const options = readChromeOptions(capabilities)
    assert.deepEqual(options, original.alwaysMatch['goog:chromeOptions'])
    options.args.push('--new')
    assert.deepEqual(capabilities, original)
  })
  it('updates standalone arguments while preserving Chrome metadata', () => {
    const capabilities = {
      browserName: 'chrome',
      'goog:chromeOptions': { binary: '/fixture/Electron', args: ['--existing'] },
    }
    updateChromeOptions(capabilities, (options) => ({
      ...options,
      args: [...(options.args ?? []), '--new'],
    }))
    assert.deepEqual(capabilities['goog:chromeOptions'], {
      binary: '/fixture/Electron',
      args: ['--existing', '--new'],
    })
  })
  it('updates W3C alwaysMatch without replacing sibling capabilities', () => {
    const capabilities = { alwaysMatch: { browserName: 'chrome' }, firstMatch: [{}] }
    updateChromeOptions(capabilities, (options) => ({ ...options, args: ['--new'] }))
    assert.deepEqual(capabilities, {
      alwaysMatch: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--new'] } },
      firstMatch: [{}],
    })
  })
  it('replaces the launcher binary without losing requested W3C or driver options', () => {
    const requested = {
      alwaysMatch: {
        browserName: 'chrome',
        browserVersion: '152.0.7977.130',
        'wdio:enforceWebDriverClassic': true,
        'goog:loggingPrefs': { browser: 'ALL' },
        'goog:chromeOptions': {
          binary: '/fixture/Electron',
          windowTypes: ['app', 'webview'],
          args: ['--app=/fixture/shell', '--headless=new'],
        },
      },
      firstMatch: [{}],
    }
    const launch = cloneRequestedChromeCapabilities(requested)
    updateChromeOptions(launch, (options) => ({ ...options, binary: '/fixture/link-launcher' }))
    assert.deepEqual(launch, {
      ...requested.alwaysMatch,
      'goog:chromeOptions': {
        ...requested.alwaysMatch['goog:chromeOptions'],
        binary: '/fixture/link-launcher',
      },
    })
    assert.equal(requested.alwaysMatch['goog:chromeOptions'].binary, '/fixture/Electron')
  })
  it('rejects response-only ChromeDriver fields instead of sending them in a new request', () => {
    for (const response of [
      { browserName: 'chrome', chrome: { chromedriverVersion: '152' } },
      { browserName: 'chrome', networkConnectionEnabled: false },
    ]) {
      assert.throws(() => cloneRequestedChromeCapabilities(response), /not a negotiated response/)
    }
  })
  it('rejects invalid sessions and argument arrays before mutation', () => {
    for (const value of [
      undefined,
      {},
      { browserName: 'firefox' },
      { browserName: 'chrome', 'goog:chromeOptions': { args: [1] } },
    ]) {
      assert.throws(() => {
        updateChromeOptions(value, () => ({ args: ['--new'] }))
      })
    }
  })
})
