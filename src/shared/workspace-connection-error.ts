/** Marker survives Electron's serialization of errors from an invoke handler. */
export const WORKSPACE_CONNECTION_ERROR_PREFIX = '[workspace-connection] '

export class WorkspaceConnectionError extends Error {}
