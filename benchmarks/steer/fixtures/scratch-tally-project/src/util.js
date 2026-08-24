// util module
export function clamp(value, min, max) {
  // TODO: reject NaN explicitly
  return Math.min(Math.max(value, min), max)
}

// TODO: move this next to the only caller
