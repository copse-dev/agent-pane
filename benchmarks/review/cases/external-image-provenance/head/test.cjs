const assert = require('node:assert/strict')
const { browserScreenshotTool, fetchImageTool, wrapToolResult } = require('./src/tools.cjs')

assert.equal(wrapToolResult(fetchImageTool, fetchImageTool.execute()), '<external>remote bytes</external>')
assert.equal(browserScreenshotTool.execute(), 'page pixels and text')
console.log('ok')
