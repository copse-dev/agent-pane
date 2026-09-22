const assert = require('node:assert/strict')
const { fetchImageTool, wrapToolResult } = require('./src/tools.cjs')

assert.equal(wrapToolResult(fetchImageTool, fetchImageTool.execute()), '<external>remote bytes</external>')
console.log('ok')
