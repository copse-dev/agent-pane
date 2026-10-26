/** Phones and narrow windows: the bars stack and the details panel is a bottom sheet. */
export const NARROW = '(max-width: 760px)';
/** A finger, not a mouse, is the main pointer. */
export const TOUCH = '(pointer: coarse)';

/** Whether a media query matches, right now. */
export function matches(query: string): boolean {
  return window.matchMedia(query).matches;
}

/** Calls `changed` whenever the window's width might have, so a caller can re-measure. */
export function onWindowWidthChange(changed: () => void): () => void {
  window.addEventListener('resize', changed);
  return () => window.removeEventListener('resize', changed);
}
