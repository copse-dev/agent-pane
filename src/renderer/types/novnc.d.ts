declare module '@novnc/novnc' {
  interface RfbOptions {
    credentials?: { username?: string; password?: string; target?: string }
    shared?: boolean
  }

  interface RfbDisconnectEvent extends Event {
    detail: { clean: boolean }
  }

  interface RfbCredentialsRequiredEvent extends Event {
    detail: { types: string[] }
  }

  interface RfbSecurityFailureEvent extends Event {
    detail: { status: number; reason?: string }
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: object, options?: RfbOptions)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    background: string
    disconnect(): void
    focus(options?: FocusOptions): void
    sendCredentials(credentials: { username?: string; password?: string; target?: string }): void
    addEventListener(type: 'connect', listener: (event: Event) => void): void
    addEventListener(
      type: 'credentialsrequired',
      listener: (event: RfbCredentialsRequiredEvent) => void,
    ): void
    addEventListener(
      type: 'securityfailure',
      listener: (event: RfbSecurityFailureEvent) => void,
    ): void
    addEventListener(type: 'disconnect', listener: (event: RfbDisconnectEvent) => void): void
  }
}
