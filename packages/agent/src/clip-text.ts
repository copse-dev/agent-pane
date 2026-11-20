// Length caps on prompt text that respect UTF-16 surrogate pairs.
//
// `String.prototype.slice` counts code units, so a cap that lands inside an
// astral character (an emoji, a CJK extension ideograph) keeps half of it. The
// lone surrogate survives `JSON.stringify` as an escape, and providers then
// reject the whole request ("no low surrogate in string"). Every cap applied to
// text that reaches a provider goes through these instead.

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff
}

/** `text.slice(0, maxLength)`, one unit shorter when that would split a surrogate pair. */
export function clipStart(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  if (maxLength <= 0) return ''
  const splitsPair =
    isHighSurrogate(text.charCodeAt(maxLength - 1)) && isLowSurrogate(text.charCodeAt(maxLength))
  return text.slice(0, splitsPair ? maxLength - 1 : maxLength)
}

/** `text.slice(-maxLength)`, one unit shorter when that would split a surrogate pair. */
export function clipEnd(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  if (maxLength <= 0) return ''
  const start = text.length - maxLength
  const splitsPair =
    isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))
  return text.slice(splitsPair ? start + 1 : start)
}
