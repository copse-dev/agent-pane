/** Reject test-control plumbing in the chat transcript and generated titles. */
export function mockConversationLeaks(texts: readonly string[]): string[] {
  const controlSyntax = /\[\[(?:mcp|mock):/
  const fallbackReply =
    /\b(?:Mock respons|Demo response|mock health check)|No conversation scenario is configured/
  return texts.filter((text) => controlSyntax.test(text) || fallbackReply.test(text))
}
