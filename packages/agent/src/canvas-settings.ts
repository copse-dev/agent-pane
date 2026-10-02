/** Shared policy for Canvas and its separately opted-in explainer experiment. */
export const MCP_UI_CANVAS_PLUGIN_ID = 'copse.mcp-ui-canvas'
export const ANIMATED_EXPLAINERS_SETTING_ID = 'animatedExplainers'

/** Unset and malformed values stay off, including on existing Canvas profiles. */
export function areAnimatedExplainersEnabled(
  readSetting: ((pluginId: string, key: string) => unknown) | undefined,
): boolean {
  return readSetting?.(MCP_UI_CANVAS_PLUGIN_ID, ANIMATED_EXPLAINERS_SETTING_ID) === true
}
