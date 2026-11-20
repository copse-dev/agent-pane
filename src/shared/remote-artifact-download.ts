/** Identity for an explicit, user-initiated artifact download. */
export interface RemoteArtifactDownloadRequest {
  projectId: string
  threadId: string
  agentId: string
  path: string
}
