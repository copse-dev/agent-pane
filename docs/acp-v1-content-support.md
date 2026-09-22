# ACP v1 content support

Copse's shipping ACP client uses the stable v1 entry point from
`@agentclientprotocol/sdk` 1.4.0. The experimental v2 adapter remains isolated;
see [ACP v2 readiness](acp-v2-readiness.md). This matrix records every v1
`SessionUpdate`, `ToolCallContent`, and `ContentBlock` disposition so protocol
growth cannot silently fall through the adapter.

## Session updates

| v1 update                                       | Shipping disposition                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_message_chunk`                            | Ignored. Copse already owns and persists the submitted user message.                                                                                                          |
| `agent_message_chunk`                           | Supported: text streams into assistant prose; image, audio, resource link, and embedded resource blocks render and persist. `messageId` changes open a new assistant segment. |
| `agent_thought_chunk`                           | Supported with the same block coverage inside the reasoning disclosure. `messageId` boundaries are preserved.                                                                 |
| `tool_call`                                     | Supported, including initial content, status, `kind`, `title`, programmatic `name`, raw input/output, and locations.                                                          |
| `tool_call_update`                              | Supported as a patch, except `content` and `locations`, which replace their complete collections as required by ACP.                                                          |
| `plan`                                          | Supported. The complete plan replaces Copse's plan and preserves priority/status.                                                                                             |
| `plan_update`, `plan_removed`                   | Deferred. These unstable incremental plan updates are not part of Copse's shipping plan model.                                                                                |
| `available_commands_update`                     | Retained on the live ACP session. Copse's slash-command UI remains host-owned, so agent commands are not mixed into it yet.                                                   |
| `current_mode_update`                           | Retained in the live session's advertised mode state.                                                                                                                         |
| `config_option_update`                          | Retained in the live session's advertised config state and used by later turn configuration.                                                                                  |
| `session_info_update`                           | Retained as ACP-owned live session metadata; not substituted for Copse's thread title.                                                                                        |
| `usage_update`                                  | Supported, including context used/size and cost amount/currency.                                                                                                              |
| `compaction_update`, `compaction_summary_chunk` | Deferred. Copse owns its visible turn recovery and compaction UX.                                                                                                             |

## Tool call content

`content: null` and `content: []` both replace the prior collection with an
empty collection. Consequently a mixed text/image result followed by text-only,
image-only, or empty output cannot leave stale text or media behind.

| v1 `ToolCallContent` | Shipping disposition                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `content`            | Supported for every v1 `ContentBlock` below.                           |
| `diff`               | Supported and persisted; rendered as an expandable before/after block. |
| `terminal`           | Supported and persisted as a terminal-session reference.               |

| v1 `ContentBlock`    | Shipping disposition                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `text`               | Supported as Markdown-derived tool result text or streamed assistant/reasoning text.                                        |
| `image`              | Supported with MIME type and optional URI.                                                                                  |
| `audio`              | Supported with native audio controls.                                                                                       |
| `resource_link`      | Supported with title/name, description, MIME type, size, and URI. HTTP(S) resources use Copse's normal browser-link policy. |
| `resource` with text | Supported as an expandable text resource.                                                                                   |
| `resource` with blob | Supported as a saveable binary resource.                                                                                    |

Structured collections live in referenced `blobs/*.acp-*.json` files in the
thread store. The event spine stores only content refs, and binary/base64 data
is never written into message or reasoning Markdown. The same references are
verified and folded back on reload.

## Experimental v2 boundary

The shipping matrix above is v1 only. The separate v2 prototype may recognize
v2 lifecycle and content shapes for conformance tests, but none of those shapes
are accepted by the main adapter until Copse negotiates protocol v2 and the
migration gates in [ACP v2 readiness](acp-v2-readiness.md) are met.
