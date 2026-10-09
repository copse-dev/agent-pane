import type {} from 'webdriverio'

declare module 'webdriverio' {
  interface CustomInstanceCommands<T> {
    /** WDIO supports inherited protocol overrides; its command-key union omits deleteSession. */
    overwriteCommand(
      name: 'deleteSession',
      func: (
        this: T,
        originalCommand: WebdriverIO.Browser['deleteSession'],
        ...args: Parameters<WebdriverIO.Browser['deleteSession']>
      ) => Promise<unknown>,
    ): void
  }
}

declare global {
  namespace WebdriverIO {
    interface Capabilities {
      /** ChromeDriver accepts this documented Chromium vendor extension. */
      'goog:loggingPrefs'?: import('@wdio/types').Capabilities.LoggingPreferences
    }
  }
}
