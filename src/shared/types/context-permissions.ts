/** Current grants from main-process stores that the Context panel cannot read as settings. */
export interface ContextPermissionSnapshot {
  outsideReadPaths: string[]
  browserOrigins: string[]
  portBindingAllowed: boolean
}
