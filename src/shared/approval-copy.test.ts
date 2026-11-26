import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  browserApprovalDetails,
  projectPortBindingApproval,
  providerApprovalDetails,
  webApprovalDetails,
} from './approval-copy.ts'

it('keeps project port-binding scope and risk copy shared with its one-time action', () => {
  const prompt = projectPortBindingApproval('/projects/harbor-board', 'npm run dev')
  assert.equal(prompt.body, 'npm run dev')
  assert.equal(prompt.approveOnceLabel, 'Allow once')
  assert.equal(prompt.approveLabel, 'Allow for this project')
  assert.equal(prompt.allowRemember, true)
  assert.equal(
    prompt.rememberLabel,
    'Always allow local port binding in this project: /projects/harbor-board',
  )
  assert.match(prompt.bodyAdvice, /Project: \/projects\/harbor-board/)
  assert.match(prompt.bodyFooter, /One-time approval covers this start/)
  assert.match(prompt.bodyFooter, /future tasks and chats in this project/)
  assert.match(prompt.bodyFooter, /including its worktrees, bind on localhost until revoked/)
  assert.match(prompt.bodyFooter, /Other shell permissions still apply/)
  assert.match(prompt.bodyFooter, /Context → Permissions → Project → Local port binding/)
  assert.match(prompt.bodyFooter, /Stop running tasks separately/)
  assert.equal(projectPortBindingApproval('/projects/harbor-board', '').body, '(no command given)')
})

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
