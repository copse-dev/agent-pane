import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decodeGitHubFileContent } from './pr-file-content.ts'

describe('decodeGitHubFileContent', () => {
  it('decodes text blobs as UTF-8', () => {
    assert.deepEqual(
      decodeGitHubFileContent('src/app.ts', Buffer.from('hello\n').toString('base64')),
      {
        text: 'hello\n',
        image: null,
      },
    )
  })

  it('preserves image blobs as data URLs instead of UTF-8 mojibake', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
    assert.deepEqual(decodeGitHubFileContent('screenshots/result.PNG', `${png}\n`), {
      text: '',
      image: `data:image/png;base64,${png}`,
    })
  })
})
