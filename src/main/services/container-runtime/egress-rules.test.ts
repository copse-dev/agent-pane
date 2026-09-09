import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  egressRuleAllows,
  findEgressRule,
  formatEgressRule,
  parseEgressRule,
  parseEgressTarget,
} from './egress-rules.ts'

describe('egress rules', () => {
  it('parses exact and wildcard rules and round-trips them', () => {
    assert.deepEqual(parseEgressRule('api.example.com:443'), {
      host: 'api.example.com',
      wildcard: false,
      port: 443,
    })
    assert.deepEqual(parseEgressRule('*.Anthropic.com:443'), {
      host: 'anthropic.com',
      wildcard: true,
      port: 443,
    })
    for (const text of ['api.example.com:443', '*.anthropic.com:443', '127.0.0.1:1234']) {
      assert.equal(formatEgressRule(parseEgressRule(text)), text)
    }
  })

  it('rejects everything that is not host:port or *.suffix:port', () => {
    for (const bad of [
      'api.example.com',
      'http://x:1',
      'x:70000',
      'x:0',
      '*:443',
      '*.com:443',
      '*.:443',
      'a..b:443',
      '-a.b:443',
      'a b:443',
      '',
    ]) {
      assert.throws(() => parseEgressRule(bad), `accepted "${bad}"`)
    }
  })

  it('matches a wildcard on the dot boundary only', () => {
    const rule = parseEgressRule('*.anthropic.com:443')
    assert.equal(egressRuleAllows(rule, 'api.anthropic.com', 443), true)
    assert.equal(egressRuleAllows(rule, 'a.b.anthropic.com', 443), true)
    assert.equal(egressRuleAllows(rule, 'API.ANTHROPIC.COM', 443), true)
    // The bare suffix is not a subdomain of itself.
    assert.equal(egressRuleAllows(rule, 'anthropic.com', 443), false)
    // A substring is not a suffix.
    assert.equal(egressRuleAllows(rule, 'evilanthropic.com', 443), false)
    assert.equal(egressRuleAllows(rule, 'anthropic.com.evil', 443), false)
    // The port is part of the rule.
    assert.equal(egressRuleAllows(rule, 'api.anthropic.com', 8443), false)
  })

  it('matches an exact rule exactly', () => {
    const rule = parseEgressRule('api.openai.com:443')
    assert.equal(egressRuleAllows(rule, 'api.openai.com', 443), true)
    assert.equal(egressRuleAllows(rule, 'Api.OpenAI.com', 443), true)
    assert.equal(egressRuleAllows(rule, 'evil.api.openai.com', 443), false)
    assert.equal(egressRuleAllows(rule, 'api.openai.com', 80), false)
  })

  it('finds the first admitting rule, or nothing', () => {
    const rules = [parseEgressRule('127.0.0.1:1234'), parseEgressRule('*.openai.com:443')]
    assert.equal(findEgressRule(rules, 'api.openai.com', 443), rules[1])
    assert.equal(findEgressRule(rules, '127.0.0.1', 1234), rules[0])
    assert.equal(findEgressRule(rules, 'github.com', 443), null)
    assert.equal(findEgressRule([], 'api.openai.com', 443), null)
  })

  it('parses a CONNECT-style target and refuses the rest', () => {
    assert.deepEqual(parseEgressTarget('API.openai.com:443'), { host: 'api.openai.com', port: 443 })
    assert.equal(parseEgressTarget('api.openai.com'), null)
    assert.equal(parseEgressTarget('api.openai.com:99999'), null)
    assert.equal(parseEgressTarget('a:1 b:2'), null)
  })
})
