declare module '@novnc/novnc' {
  interface RfbOptions {
    credentials?: { username?: string; password?: string; target?: string }
    shared?: boolean
  }

  interface RfbDisconnectEvent extends Event {
    detail: { clean: boolean }
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: object, options?: RfbOptions)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    background: string
    disconnect(): void
    focus(options?: FocusOptions): void
    addEventListener(
      type: 'connect' | 'credentialsrequired' | 'securityfailure',
      listener: (event: Event) => void,
    ): void
    addEventListener(type: 'disconnect', listener: (event: RfbDisconnectEvent) => void): void
  }
}
