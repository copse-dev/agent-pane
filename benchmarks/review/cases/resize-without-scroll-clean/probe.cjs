const assert = require('node:assert/strict')
const { create } = require(require('node:path').resolve(process.argv[2], 'src/state.cjs'))
;(async () => { const host = { width: 400, height: 300 }; const layer = create(host); host.width = 800; layer.kick(0, 0); layer.kick(0, 0); assert.deepEqual(layer.viewBox(), [0, 0, 800, 300]) })().catch(error => { console.error(error); process.exitCode = 1 })
