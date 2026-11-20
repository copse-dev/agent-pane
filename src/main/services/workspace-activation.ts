/** A slow root/SSH preparation must never overwrite a newer window selection. */
export class WorkspaceActivation {
  private generation = 0

  begin(): () => void {
    const generation = ++this.generation
    return (): void => {
      if (generation !== this.generation) throw new Error('Workspace selection superseded')
    }
  }
}
