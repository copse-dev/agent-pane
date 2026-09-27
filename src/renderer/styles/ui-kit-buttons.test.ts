// Contract tests for the UI-kit button base and the inline status hues.
//
// happy-dom has no layout engine, so the rendered geometry and computed colours
// are measured in e2e (remote-folder-*.e2e.ts, settings-ssh.e2e.ts,
// settings-classifiers.e2e.ts). These pin the declarations to the selectors that
// own them so a refactor cannot quietly drop them.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES = resolve(process.cwd(), 'src/renderer/styles/global')
const read = (file: string): string =>
  readFileSync(resolve(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Body of the first flat rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[}\\s])${sel}\\s*\\{([^}]*)\\}`).exec(css)
  return match?.[1] ?? ''
}

describe('UI kit buttons', () => {
  it('keeps a kit button on one line and unsqueezed beside long siblings', () => {
    const body = ruleBody(read('ui.css'), '.ui-btn')
    assert.match(body, /white-space:\s*nowrap/, '.ui-btn must not wrap its label')
    assert.match(body, /flex:\s*none/, '.ui-btn must not shrink in a flex row')
  })
})

describe('inline status hues', () => {
  it('paints settled outcomes in their semantic token', () => {
    const css = read('icons.css')
    for (const [kind, token] of [
      ['error', '--error'],
      ['ok', '--success'],
      ['warn', '--warning'],
    ] as const) {
      assert.match(
        ruleBody(css, `.ui-inline-status[data-status-kind='${kind}']`),
        new RegExp(`color:\\s*var\\(${token}\\)`),
        `${kind} inline status must use ${token}`,
      )
    }
  })

  it('leaves in-progress and neutral kinds to inherit the surrounding colour', () => {
    const css = read('icons.css')
    for (const kind of ['pending', 'filled', 'idle']) {
      assert.doesNotMatch(
        ruleBody(css, `.ui-inline-status[data-status-kind='${kind}']`),
        /(?:^|;|\s)color:/,
        `${kind} inline status must not set its own colour`,
      )
    }
  })
})
