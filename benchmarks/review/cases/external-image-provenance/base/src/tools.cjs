function defineTool(definition) {
  return { provenance: 'internal', ...definition }
}

const fetchImageTool = defineTool({
  name: 'fetch_image',
  provenance: 'external',
  execute: () => 'remote bytes',
})

function wrapToolResult(tool, result) {
  return tool.provenance === 'external' ? `<external>${result}</external>` : result
}

module.exports = { fetchImageTool, wrapToolResult }
