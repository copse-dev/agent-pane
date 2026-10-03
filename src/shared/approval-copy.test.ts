import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserApprovalDetails,
  providerApprovalDetails,
  webApprovalDetails,
} from './approval-copy.ts'

describe('URL approval details', () => {
  const url = 'https://example.com/docs?topic=approval'
  it('keeps only the variable URL in details and explains request disclosure and grant scope', () => {
    const request = webApprovalDetails('https://example.com:443', url, true)
    assert.equal(request.body, url)
    assert.match(request.bodyAdvice, /data in its URL/)
    assert.match(request.bodyFooter, /once/)
    assert.match(request.bodyFooter, /including other URLs/)
    assert.match(request.bodyFooter, /Settings/)
    const ask = webApprovalDetails(
      'https://example.com:443',
      url,
      false,
      'Queries are sent to the search provider.',
    )
    assert.equal(ask.body, url)
    assert.match(ask.bodyAdvice, /Queries are sent/)
    assert.doesNotMatch(ask.bodyFooter, /Always allow/)
  })
  it('distinguishes browser session access from persistent host approval', () => {
    const browser = browserApprovalDetails('https://example.com:443', url, false)
    assert.equal(browser.body, url)
    assert.match(browser.bodyFooter, /chat’s browser session/)
    assert.doesNotMatch(browser.bodyFooter, /Always allow/)
    const provider = providerApprovalDetails('api.example.com', ' https://api.example.com/v1 ')
    assert.equal(provider.body, 'https://api.example.com/v1')
    assert.match(provider.bodyAdvice, /API key and prompts/)
    assert.match(provider.bodyFooter, /always allows/)
  })
})
