/**
 * Row lookup shared by the transcript views. Its own module so that
 * tool-card-refresh.ts can use it without an import cycle through
 * transcript-rows.ts.
 */

/** The message element of row `key`, or null when it is not in the list. */
export function transcriptRowElement(list: HTMLElement, key: string): HTMLElement | null {
  // Rows are the list's direct children. A `querySelector`, even with
  // `:scope >`, walks every descendant of every row in document order, so on a
  // long transcript a lookup of the streaming reply (the tail row) paid for the
  // whole DOM on every token. The rows that change are at one end or the other
  // (the live tail, or the history backfill prepending at the head), so walk
  // the children from both ends at once.
  // `getAttribute` rather than `dataset`: a miss (a run's anchor that the
  // newest-first backfill has not drawn yet) visits every row.
  let head = list.firstElementChild
  let tail = list.lastElementChild
  while (head && tail) {
    if (head.getAttribute('data-message-id') === key && head instanceof HTMLElement) return head
    if (tail.getAttribute('data-message-id') === key && tail instanceof HTMLElement) return tail
    if (head === tail || head.nextElementSibling === tail) return null
    head = head.nextElementSibling
    tail = tail.previousElementSibling
  }
  return null
}
