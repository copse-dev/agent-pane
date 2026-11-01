import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArtifactImageError,
  canonicalDownloadOrigin,
  checkDownloadUrl,
  CURSOR_ARTIFACT_DOWNLOAD_ORIGINS,
  isPublicAddress,
  isRetryableArtifactImageError,
  resolveRedirect,
  validateArtifactPath,
  type ArtifactImageErrorCode,
} from './policy.ts'

const ORIGIN = 'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com'
const SIGNED = `${ORIGIN}/agents/bc-1/artifacts/shot.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261030%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Signature=abc123`

function code(fn: () => unknown): ArtifactImageErrorCode {
  try {
    fn()
  } catch (error) {
    assert.ok(
      error instanceof ArtifactImageError,
      `expected ArtifactImageError, got ${String(error)}`,
    )
    return error.code
  }
  assert.fail('expected a policy error')
}

describe('validateArtifactPath', () => {
  it('accepts a plain relative artifacts/ path unchanged', () => {
    assert.equal(validateArtifactPath('artifacts/run 1/shot.png'), 'artifacts/run 1/shot.png')
  })

  for (const hostile of [
    '',
    'shot.png',
    '/artifacts/shot.png',
    'artifacts/../secrets.png',
    'artifacts/a/../../etc/passwd',
    'artifacts/./shot.png',
    'artifacts//shot.png',
    'artifacts/',
    'artifacts\\..\\shot.png',
    'artifacts/%2e%2e/shot.png',
    'artifacts/a%2fb.png',
    'artifacts/a%5cb.png',
    'artifacts/%252e%252e/x.png',
    'artifacts/shot.png\u0000.jpg',
    'artifacts/line\nbreak.png',
    `artifacts/${'a'.repeat(1100)}.png`,
  ]) {
    it(`refuses ${JSON.stringify(hostile.slice(0, 40))}`, () => {
      assert.equal(
        code(() => validateArtifactPath(hostile)),
        'invalid-path',
      )
    })
  }
})

describe('checkDownloadUrl', () => {
  it('approves an exact origin and keeps the signed bytes verbatim', () => {
    const approved = checkDownloadUrl(SIGNED, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)
    assert.equal(approved.href, SIGNED)
    assert.equal(approved.origin, ORIGIN)
    assert.equal(`${approved.origin}${approved.target}`, SIGNED)
    // The %2F escapes are part of the signature and must not be decoded.
    assert.ok(approved.target.includes('AKIA%2F20261030'))
  })

  for (const [label, url] of [
    ['http', SIGNED.replace('https:', 'http:')],
    ['explicit port', SIGNED.replace('.com/', '.com:8443/')],
    ['explicit 443', SIGNED.replace('.com/', '.com:443/').replace('https', 'HTTPS')],
    ['userinfo', SIGNED.replace('https://', 'https://user:pw@')],
    ['fragment', `${SIGNED}#frag`],
    ['IPv4 literal', 'https://52.216.0.1/x.png'],
    ['IPv6 literal', 'https://[2600:1f18::1]/x.png'],
    ['integer IP', 'https://3520528385/x.png'],
    [
      'look-alike suffix',
      'https://cloud-agent-artifacts.s3.us-east-1.amazonaws.com.evil.example/x',
    ],
    ['other bucket', 'https://attacker.s3.us-east-1.amazonaws.com/x.png'],
    ['metadata host', 'http://169.254.169.254/latest/meta-data/'],
    ['javascript', 'javascript:alert(1)'],
    ['not a URL', 'not a url'],
    ['raw space in target', `${ORIGIN}/a b.png`],
    ['raw quote in target', `${ORIGIN}/a".png`],
    ['oversized', `${ORIGIN}/${'a'.repeat(9000)}`],
  ] as const) {
    it(`denies ${label}`, () => {
      assert.equal(
        code(() => checkDownloadUrl(url, CURSOR_ARTIFACT_DOWNLOAD_ORIGINS)),
        'origin-denied',
      )
    })
  }

  it('names only the origin when an unknown origin is denied', () => {
    try {
      checkDownloadUrl('https://evil.example/path?X-Amz-Signature=secret', [ORIGIN])
      assert.fail('expected denial')
    } catch (error) {
      assert.ok(error instanceof ArtifactImageError)
      assert.equal(error.origin, 'https://evil.example')
      assert.doesNotMatch(error.message, /secret|path/u)
    }
  })
})

describe('resolveRedirect', () => {
  const current = checkDownloadUrl(SIGNED, [ORIGIN])

  it('follows a relative redirect within the approved origin', () => {
    assert.equal(
      resolveRedirect(current, '/other.png?sig=1', [ORIGIN]).href,
      `${ORIGIN}/other.png?sig=1`,
    )
  })

  for (const [label, location] of [
    ['downgrade to http', SIGNED.replace('https:', 'http:')],
    ['private address', 'https://10.0.0.5/x.png'],
    ['loopback', 'https://127.0.0.1/x.png'],
    ['localhost name', 'https://localhost/x.png'],
    ['metadata service', 'https://169.254.169.254/latest/meta-data/'],
    ['unapproved origin', 'https://evil.example/x.png'],
    ['userinfo', `https://u@${new URL(ORIGIN).host}/x.png`],
    ['protocol-relative to another host', '//evil.example/x.png'],
    ['other port', `${ORIGIN}:444/x.png`],
  ] as const) {
    it(`refuses a redirect to ${label}`, () => {
      assert.equal(
        code(() => resolveRedirect(current, location, [ORIGIN])),
        'redirect-denied',
      )
    })
  }
})

describe('canonicalDownloadOrigin', () => {
  it('accepts a bare https origin', () => {
    assert.equal(canonicalDownloadOrigin(`${ORIGIN}/`), ORIGIN)
  })
  for (const raw of [
    'http://a.example',
    'https://a.example:8443',
    'https://a.example/path',
    'https://1.2.3.4',
    'https://localhost',
    'https://a.example.',
    'https://*.amazonaws.com',
    'https://a_b.example',
  ]) {
    it(`rejects ${raw}`, () => {
      assert.equal(canonicalDownloadOrigin(raw), null)
    })
  }
})

describe('isPublicAddress', () => {
  for (const address of [
    '52.216.8.10',
    '8.8.8.8',
    '2600:1f18:4a3:6900::1',
    '2a00:1450:4009:81f::200e',
  ]) {
    it(`public: ${address}`, () => {
      assert.equal(isPublicAddress(address), true)
    })
  }
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.170',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:52.216.8.10',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1',
    'not-an-ip',
    '',
  ]) {
    it(`non-public: ${address || '(empty)'}`, () => {
      assert.equal(isPublicAddress(address), false)
    })
  }
})

describe('isRetryableArtifactImageError', () => {
  it('never offers a retry for policy denials', () => {
    for (const denial of [
      'sandbox-unavailable',
      'unlinked-agent',
      'origin-denied',
      'redirect-denied',
      'invalid-path',
    ] as const) {
      assert.equal(isRetryableArtifactImageError(denial), false, denial)
    }
    assert.equal(isRetryableArtifactImageError('timeout'), true)
  })
})
