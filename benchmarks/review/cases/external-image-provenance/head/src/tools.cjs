function defineTool(definition) {
  return { provenance: 'internal', ...definition }
}

const fetchImageTool = defineTool({
  name: 'fetch_image',
  provenance: 'external',
  execute: () => 'remote bytes',
})

const browserScreenshotTool = defineTool({
  name: 'browser_screenshot',
  execute: () => 'page pixels and text',
})

function wrapToolResult(tool, result) {
  return tool.provenance === 'external' ? `<external>${result}</external>` : result
}

module.exports = { browserScreenshotTool, fetchImageTool, wrapToolResult }
