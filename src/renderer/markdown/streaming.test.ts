import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderStreamingMarkdown, splitAtLastNewline } from './streaming.ts'

describe('splitAtLastNewline', () => {
  it('keeps all content pending when no newline has arrived yet', () => {
    assert.deepEqual(splitAtLastNewline('## Title'), {
      complete: '',
      pending: '## Title',
    })
  })

  it('marks lines ending with newline as complete', () => {
    assert.deepEqual(splitAtLastNewline('## Title\n- item\n'), {
      complete: '## Title\n- item\n',
      pending: '',
    })
  })

  it('leaves the final in-progress line pending', () => {
    assert.deepEqual(splitAtLastNewline('## Title\n- item'), {
      complete: '## Title\n',
      pending: '- item',
    })
  })
})

describe('renderStreamingMarkdown', () => {
  it('renders completed lines as markdown while the tail stays plain', () => {
    const html = renderStreamingMarkdown('## Title\n- item')
    assert.match(html, /<h4>Title<\/h4>/)
    assert.match(html, /<span class="stream-pending">- item<\/span>/)
    assert.doesNotMatch(html, /<li>- item<\/li>/)
  })

  it('formats each completed line as newlines arrive', () => {
    const first = renderStreamingMarkdown('## Title\n')
    const second = renderStreamingMarkdown('## Title\n- item one\n')
    assert.match(first, /<h4>Title<\/h4>/)
    assert.match(second, /<li>item one<\/li>/)
  })

  it('matches final markdown render once the last line ends', () => {
    const streaming = renderStreamingMarkdown('## Title\n- item one\n- item two\n')
    assert.match(streaming, /<h4>Title<\/h4>/)
    assert.match(streaming, /<li>item one<\/li>/)
    assert.match(streaming, /<li>item two<\/li>/)
    assert.doesNotMatch(streaming, /stream-pending/)
  })
})
