import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseOpenFenceContent } from './block-patterns.ts'

describe('parseOpenFenceContent', () => {
  it('extracts lang and body from an open fence', () => {
    assert.deepEqual(parseOpenFenceContent('```yaml\nstatic_resources:\n  listeners:'), {
      lang: 'yaml',
      code: 'static_resources:\n  listeners:',
    })
  })

  it('returns an empty body for a lone opener line', () => {
    assert.deepEqual(parseOpenFenceContent('```ts'), { lang: 'ts', code: '' })
  })

  it('strips a closing fence line when present', () => {
    assert.deepEqual(parseOpenFenceContent('```js\nconst x = 1\n```'), {
      lang: 'js',
      code: 'const x = 1',
    })
  })
})
