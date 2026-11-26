import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { requestsOnlyLoopback } from './loopback-requests.ts'

describe('requestsOnlyLoopback', () => {
  it('accepts curl and wget that name only loopback URLs', () => {
    for (const command of [
      'curl -s -m 3 -o /dev/null -w "%{http_code}\\n" http://localhost:3000/api/rides || echo "not running"',
      'curl -sv http://127.0.0.1:3101/api/rides 2>&1 | head -40',
      "curl -s -X POST http://[::1]:8080/x -H 'Content-Type: application/json' -d '{}'",
      'wget -qO- https://localhost:5173/',
      'curl --url=http://localhost:3000/a',
      'echo "--- rider ---"\ncurl -s http://localhost:3000/api/me\ncurl -s http://localhost:3000/api/rides',
      'BASE=http://localhost:3000\ncurl -s "$BASE/api/rides"',
    ])
      assert.equal(requestsOnlyLoopback(command), true, command)
  })

  it('refuses any remote, hidden or unreadable target', () => {
    for (const command of [
      'curl https://example.com',
      'curl http://localhost:3000 https://example.com',
      'curl http://localhost.example.com/',
      'curl http://user@localhost:3000/',
      'curl file:///etc/passwd',
      'curl -s "$BASE/api/rides"',
      'BASE="http://localhost:3000"\ncurl -s "$BASE/api"',
      'curl $(cat url.txt)',
      'echo http://localhost:3000 | xargs curl',
      'timeout 5 curl http://localhost:3000',
      'curl localhost:3000',
      'ls',
    ])
      assert.equal(requestsOnlyLoopback(command), false, command)
  })
})
