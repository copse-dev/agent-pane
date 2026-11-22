import type { ITerminalOptions } from '@xterm/xterm'

/** Only the emulator boundary is replaced; the terminal pane runs unchanged. */
export class Terminal {
  readonly cols = 80
  readonly rows = 24
  readonly modes = { bracketedPasteMode: false }
  options: ITerminalOptions
  private text = ''
  private readonly rowsElement = document.createElement('div')

  constructor(options: ITerminalOptions = {}) {
    this.options = options
    this.rowsElement.className = 'xterm-rows'
  }

  get buffer(): {
    active: {
      length: number
      getLine: (index: number) => { translateToString: () => string } | undefined
    }
  } {
    const lines = this.text.split(/\r?\n/)
    return {
      active: {
        length: lines.length,
        getLine: (index): { translateToString: () => string } | undefined => {
          const line = lines[index]
          return line === undefined ? undefined : { translateToString: () => line }
        },
      },
    }
  }

  open(container: HTMLElement): void {
    const root = document.createElement('div')
    root.className = 'xterm'
    root.append(this.rowsElement)
    container.append(root)
  }

  write(data: string, callback?: () => void): void {
    // Real xterm parses writes asynchronously and calls back only afterwards.
    queueMicrotask(() => {
      this.text += data
      this.rowsElement.textContent = this.text
      callback?.()
    })
  }

  writeln(data: string, callback?: () => void): void {
    this.write(`${data}\r\n`, callback)
  }

  reset(): void {
    this.text = ''
    this.rowsElement.textContent = ''
  }

  loadAddon(): void {}
  focus(): void {}
  paste(): void {}
  dispose(): void {}
  attachCustomKeyEventHandler(): void {}
  hasSelection(): boolean {
    return false
  }
  getSelection(): string {
    return ''
  }
  onData(): { dispose: () => void } {
    return { dispose: (): void => {} }
  }
  registerLinkProvider(): { dispose: () => void } {
    return { dispose: (): void => {} }
  }
}

export class FitAddon {
  fit(): void {}
  dispose(): void {}
}
