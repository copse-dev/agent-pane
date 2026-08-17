import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import {
  acpTurnInterruptionMarker,
  classifyAcpAuthFailure,
  classifyAgentError,
  classifyProviderAccessFailure,
  turnErrorDetail,
} from './agent-errors.ts'
import { AcpTurnFailure } from './acp/acp-agent-service.ts'
import { ThreadWorktreeDetachedError } from './worktree-manager.ts'

describe('classifyAgentError', () => {
  it('maps 401 to API key guidance', () => {
    assert.match(classifyAgentError(new Error('HTTP 401 Unauthorized')), /401/)
    assert.match(classifyAgentError('Unauthorized'), /API key/)
  })

  it('maps ACP authentication failures with error code and agent-specific setup', () => {
    const auth = RequestError.authRequired({ reason: 'token missing' })
    const out = classifyAgentError(auth, { acpAgentId: 'claude-agent-acp' })
    assert.match(out, /ACP error -32000 \(Authentication required\)/)
    assert.match(out, /Claude needs authentication/)
    assert.match(out, /claude setup-token/)
    assert.match(out, /ANTHROPIC_API_KEY/)
    assert.match(out, /Details:.*token missing/)
    assert.match(out, /not automatically shared with external agents/)
    assert.match(out, /> \[!WARNING\]/)
    assert.match(out, /```text/)
    assert.doesNotMatch(out, /^An error occurred:/)
  })

  it('reads RequestError from an AcpTurnFailure cause chain', () => {
    const wrapped = new AcpTurnFailure(RequestError.authRequired(), {
      assistantText: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const out = classifyAgentError(wrapped, { acpAgentId: 'cursor' })
    assert.match(out, /ACP error -32000/)
    assert.match(out, /cursor-agent login/)
  })

  it('maps plain Authentication required text for ACP turns without a RequestError class', () => {
    const out = classifyAgentError(new Error('Authentication required'), { acpAgentId: 'cursor' })
    assert.match(out, /ACP error -32000/)
    assert.match(out, /cursor-agent login/)
  })

  it('maps ACP 401 to agent auth guidance instead of Copse provider keys', () => {
    const out = classifyAgentError(new Error('HTTP 401 Unauthorized'), { acpAgentId: 'cursor' })
    assert.match(out, /cursor-agent login/)
    assert.doesNotMatch(out, /Settings, and that no stale/)
  })

  it('surfaces other ACP JSON-RPC errors with code and optional data', () => {
    const err = new RequestError(-32002, 'Resource not found', { uri: 'file:///missing' })
    const out = classifyAgentError(err, { acpAgentId: 'cursor' })
    assert.match(out, /ACP error -32002 \(Resource not found\)/)
    assert.match(out, /file:\/\/\/missing/)
  })

  // The failure that made re-authentication undiscoverable: Claude's adapter
  // reports a lapsed OAuth token as a generic `-32603 Internal error`, so it
  // used to fall through to the raw "An error occurred: ACP error -32603" text
  // with no mention of signing in.
  it('reads an expired sign-in out of a generic ACP internal error', () => {
    const err = new RequestError(
      -32603,
      'Internal error: Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
      { errorKind: 'authentication_failed' },
    )
    const out = classifyAgentError(err, { acpAgentId: 'claude-agent-acp' })
    assert.match(out, /Claude sign-in expired/)
    assert.match(out, /claude \/login/)
    assert.match(out, /re-send your message/)
    // The agent's own words stay available, below the actionable guidance.
    assert.match(out, /Technical details[\s\S]*ACP error -32603 \(Internal error\)/)
    assert.match(out, /authentication_failed/)
    assert.doesNotMatch(out, /^An error occurred:/)
    // First-run guidance would send the user the wrong way here.
    assert.doesNotMatch(out, /claude setup-token/)
  })

  it('keeps first-run guidance for an agent that was never signed in', () => {
    const out = classifyAgentError(RequestError.authRequired(), { acpAgentId: 'claude-agent-acp' })
    assert.match(out, /needs authentication/)
    assert.match(out, /claude setup-token/)
    assert.doesNotMatch(out, /has expired/)
  })

  it('maps rate limits', () => {
    assert.match(classifyAgentError(new Error('429 rate_limit_exceeded')), /Rate limit/)
  })

  it('surfaces the provider message for billing failures without JSON noise', () => {
    const anthropic = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_011CcKJeWmwCgZe7bhig1aQY"}',
    )
    assert.equal(
      classifyAgentError(anthropic),
      'An error occurred: Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    )
    assert.doesNotMatch(classifyAgentError(anthropic), /request_id|invalid_request_error|[{}]/)
  })

  it('does not mislabel OpenAI insufficient_quota (HTTP 429) as a rate limit', () => {
    const openai = new Error(
      '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
    )
    const out = classifyAgentError(openai)
    assert.doesNotMatch(out, /Rate limit/)
    assert.match(out, /quota|billing/i)
  })

  it('maps overloaded errors from REST (529 / overloaded_error) and ACP text', () => {
    const rest = new Error(
      '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    )
    assert.match(classifyAgentError(rest), /temporarily overloaded/)
    // ACP JSON-RPC failures arrive as opaque text with no status or JSON body.
    const acp = new Error('Internal error: API Error: Overloaded')
    assert.match(classifyAgentError(acp), /temporarily overloaded/)
    assert.doesNotMatch(classifyAgentError(acp), /Internal error/)
  })

  it('extracts the provider message from JSON error blobs', () => {
    const err = new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: 200000 > 64000, which is the maximum allowed."},"request_id":"req_abc"}',
    )
    assert.equal(
      classifyAgentError(err),
      'An error occurred: max_tokens: 200000 > 64000, which is the maximum allowed.',
    )
  })

  it('maps context length errors', () => {
    assert.match(classifyAgentError(new Error('context_length exceeded')), /Conversation too long/)
    assert.match(classifyAgentError('tokens to keep from the initial prompt'), /LM Studio/)
  })

  it('turns an image-input routing failure into recovery guidance', () => {
    assert.equal(
      classifyAgentError(new Error('404 No endpoints found that support image input')),
      'The selected model has no endpoint that supports image input. Choose an image-capable model in the composer and Resend, or use Resend without image on your prompt.',
    )
  })

  it('maps jinja / missing user query failures', () => {
    assert.match(classifyAgentError('No user query found in messages'), /jinja|chat template/i)
  })

  it('turns a detached thread worktree into actionable recovery guidance', () => {
    const result = classifyAgentError(new ThreadWorktreeDetachedError('copse/thread-branch'))

    assert.equal(
      result,
      "This thread's checkout is detached from its branch. Your files are preserved. Reattach it to `copse/thread-branch`, then retry.",
    )
    assert.doesNotMatch(result, /^An error occurred:/)
  })

  it('falls back to error message', () => {
    assert.equal(
      classifyAgentError(new Error('something else')),
      'An error occurred: something else',
    )
  })
})

describe('turnErrorDetail', () => {
  it('keeps the raw ACP code, message, and nested provider detail', () => {
    const provider = new Error('Internal error during token generation')
    const rpc = new RequestError(-32603, 'Internal error', {
      code: 'generation_failed',
      detail: provider.message,
    })
    const wrapped = new AcpTurnFailure(rpc, {
      assistantText: '',
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const detail = turnErrorDetail(wrapped)
    assert.equal(detail.name, 'AcpTurnFailure')
    assert.equal(detail.code, -32603)
    assert.match(detail.message, /Internal error/)
    assert.match(detail.details ?? '', /generation_failed/)
    assert.match(detail.details ?? '', /token generation/)
  })

  it('bounds opaque provider diagnostics', () => {
    const detail = turnErrorDetail(new Error('x'.repeat(5_000)))
    assert.equal(detail.message.length, 4_001)
    assert.match(detail.message, /…$/)
  })
})

describe('classifyAcpAuthFailure', () => {
  const claude = { acpAgentId: 'claude-agent-acp' }

  it('separates an expired sign-in from one that never happened', () => {
    assert.equal(
      classifyAcpAuthFailure(
        new Error('API Error: 401 OAuth access token has expired. Re-authenticate to continue.'),
        claude,
      ),
      'expired',
    )
    assert.equal(classifyAcpAuthFailure(RequestError.authRequired(), claude), 'required')
    assert.equal(classifyAcpAuthFailure(new Error('HTTP 401 Unauthorized'), claude), 'required')
    assert.equal(classifyAcpAuthFailure(new Error('Failed to authenticate'), claude), 'required')
  })

  it('reads the signal out of JSON-RPC error data, not just the message', () => {
    assert.equal(
      classifyAcpAuthFailure(
        new RequestError(-32603, 'Internal error', {
          errorKind: 'authentication_failed',
        }),
        claude,
      ),
      'required',
    )
  })

  it('leaves non-credentials failures alone', () => {
    assert.equal(classifyAcpAuthFailure(new Error('Overloaded'), claude), null)
    assert.equal(classifyAcpAuthFailure(new Error('socket hang up'), claude), null)
    assert.equal(
      classifyAcpAuthFailure(new RequestError(-32002, 'Resource not found'), claude),
      null,
    )
  })

  // Without an agent id the failure belongs to Copse's own provider keys, whose
  // fix is Settings → Providers — not an external agent's login command. Only
  // the unambiguous ACP auth code survives that gate.
  it('does not claim provider failures that have no ACP agent behind them', () => {
    assert.equal(classifyAcpAuthFailure(new Error('HTTP 401 Unauthorized')), null)
    assert.equal(
      classifyAcpAuthFailure(new Error('Your session has expired. Re-authenticate.')),
      null,
    )
    assert.equal(classifyAcpAuthFailure(RequestError.authRequired()), 'required')
  })

  // A revoked token is not a first run: the agent is configured and was signed
  // in, so it needs the login command `expired` points at, not the install
  // guidance `required` hands out.
  it('reads a revoked credential as an expiry, not a missing sign-in', () => {
    assert.equal(
      classifyAcpAuthFailure(
        new Error('Failed to authenticate. API Error: 401 OAuth access token has been revoked.'),
        claude,
      ),
      'expired',
    )
    assert.equal(
      classifyAcpAuthFailure(new Error('Your revoked access token cannot be used'), claude),
      'expired',
    )
  })
})

describe('acpTurnInterruptionMarker', () => {
  const claude = 'claude-agent-acp'

  // The marker's reader is the next turn's model, so the thing under test is
  // whether it says re-running would help. Before this existed every outcome
  // below was written into history as a transient provider error, which told
  // the next turn to retry a dead credential.
  it('tells the next turn that a credentials failure will not fix itself', () => {
    const expired = acpTurnInterruptionMarker('expired', claude)
    assert.match(expired, /Claude’s sign-in is no longer valid/)
    assert.match(expired, /fail the same way until the user signs in again/)

    const required = acpTurnInterruptionMarker('required', claude)
    assert.match(required, /Claude is not authenticated/)
    assert.match(required, /fail the same way until the user signs in/)
  })

  it('does not report a deliberate stop as a failure', () => {
    const aborted = acpTurnInterruptionMarker('aborted', claude)
    assert.match(aborted, /stopped before it completed/)
    assert.doesNotMatch(aborted, /failed|error/i)
  })

  it('keeps a plain provider failure generic', () => {
    assert.match(acpTurnInterruptionMarker('error', claude), /interrupted by a provider error/)
  })

  // "Transient" was the old hardcoded wording, and it is wrong for every
  // outcome here: the retry loop is already spent by the time a marker is
  // written, and a lapsed credential is the opposite of temporary.
  it('never calls an outcome transient', () => {
    for (const outcome of ['expired', 'required', 'aborted', 'error'] as const) {
      assert.doesNotMatch(acpTurnInterruptionMarker(outcome, claude), /transient/i)
    }
  })

  it('falls back to a readable name when the agent is unknown', () => {
    assert.match(acpTurnInterruptionMarker('expired'), /The external agent’s sign-in/)
    assert.match(acpTurnInterruptionMarker('required', 'some-other-agent'), /some-other-agent/)
  })
})

describe('classifyProviderAccessFailure', () => {
  const anthropic = (status: number, body: unknown): Error =>
    new Error(`${String(status)} ${JSON.stringify(body)}`)

  it('classifies a rejected key as auth', () => {
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } }),
      ),
      'auth',
    )
  })

  it('classifies a 403 permission error as auth', () => {
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(403, { type: 'error', error: { type: 'permission_error', message: 'x' } }),
      ),
      'auth',
    )
  })

  it('classifies an exhausted balance as credit, however it is reported', () => {
    assert.equal(classifyProviderAccessFailure(anthropic(402, {})), 'credit')
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(403, { type: 'error', error: { type: 'billing_error', message: 'x' } }),
      ),
      'credit',
    )
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Your credit balance is too low' },
        }),
      ),
      'credit',
    )
  })

  // Retryable failures must not trigger a billing-path switch — waiting fixes
  // these, changing how the turn is billed does not.
  it('returns null for transient failures', () => {
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }),
      ),
      null,
    )
    assert.equal(
      classifyProviderAccessFailure(
        anthropic(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }),
      ),
      null,
    )
    assert.equal(classifyProviderAccessFailure(new Error('socket hang up')), null)
  })
})
