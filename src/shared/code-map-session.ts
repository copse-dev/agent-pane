/**
 * Partition for the Code Map `<webview>` guest. Distinct from the Browser
 * pane's partitions (`browser-session.ts`) — this guest only ever loads the
 * vendored blockviz build off a loopback server (`code-map-server.ts`), never
 * arbitrary or agent-chosen pages, so it does not go through the Browser
 * pane's untrusted-content session policy.
 */
export const CODE_MAP_SESSION_PARTITION = 'persist:codemap'
