# Customization compatibility

Copse distinguishes a published content format from a discovery convention and from a
vendor adapter. There is no single specification for the complete `.agents/` tree.
This document records the interoperability decision for #1356; it does not declare
all of the linked implementation issues complete.

Reviewed on 4 October 2026: upstream `agentsmd/agents.md#179` remains an open
proposal (last updated 9 September 2026), with unresolved trigger and discovery
questions. Copse will not infer a stable rule contract from that proposal. This
is the current decision; adoption or rejection upstream is the next review trigger.

| Surface                    | Contract and decision                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills                     | Agent Skills `SKILL.md` content and metadata, with explicit vendor extensions. Discovery roots and supported fields are documented in [Cursor plugins](cursor-plugins.md); `.agents/skills` is a discovery convention, not a required part of the content specification. Conformance work is tracked by #1352.                                                                                                |
| Native skill selection     | The native parent model receives metadata only and can activate a relevant eligible skill with `read_skill`, loading its instructions before acting. Explicit `/name` invocation remains the user's primary task. Model selection is bounded to four skills and 128 KiB of instruction context per run, shared across parent continuations; repeat loads are suppressed.                                      |
| Native child runners       | Automatic selection is deliberately limited to the native parent. Fixed exploration, review, CI and worker toolsets do not offer `read_skill`. Custom-agent profiles also withhold it because they do not own an activation catalog or budget; profile skill preloading remains separate P6 work. A child cannot inherit the parent activation allowance or use resource reads to bypass invocation controls. |
| ACP skill selection        | Deliberate capability difference: Copse forwards explicitly invoked skill instructions to ACP agents, but does not send its automatic-selection catalog or bridge `read_skill`. An external agent may independently implement its own skills; that behavior is not Copse skill activation and is not counted against Copse's activation budget.                                                               |
| Instructions               | Root and nested/scoped `AGENTS.md` are supported. Nested instructions activate for applicable file paths with the existing instruction-loading limits (#1354), independently of skill activation.                                                                                                                                                                                                             |
| Custom agents              | Source-path adapters support project and user `.claude/agents`, `.cursor/agents`, and `.copse/agents` Markdown profiles. These normalize into the same internal profile and run only through explicit user selection. See the [custom-subagent decisions and compatibility matrix](plans/custom-subagents.md).                                                                                                |
| Additional agent dialects  | `.github/agents`, `~/.copilot/agents`, Codex TOML profiles, and plugin-declared profiles remain pending explicit adapters. They are not inferred from Markdown contents or silently treated as Claude profiles. #1355 remains open for these adapters and the chosen delegation requirements.                                                                                                                 |
| Automatic agent delegation | Skill activation does not delegate to an agent. Model-selected custom-agent delegation remains deferred under the custom-subagent plan's decision 1 and P4 eval requirement; it is not implicitly enabled by this skill feature.                                                                                                                                                                              |
| Rules                      | `.agents/rules` remains intentionally unsupported while [upstream proposal #179](https://github.com/agentsmd/agents.md/issues/179) has no adopted cross-client contract. Revisit when the proposal is adopted or rejected; the current decision is to retain explicit existing rule adapters.                                                                                                                 |
| Hooks                      | Cursor, Claude and Copse dialects are adapted at their native paths. There is no speculative `.agents/hooks` alias.                                                                                                                                                                                                                                                                                           |
| MCP                        | The MCP protocol and documented configuration adapters are supported. There is no speculative `.agents/mcp.json` alias.                                                                                                                                                                                                                                                                                       |
| Commands and prompts       | Vendor paths may have explicit adapters; there is no generic `.agents/commands`, `.agents/prompts` or `.agents/agents` meaning. Add one only against a published convention or an explicitly adopted Copse format.                                                                                                                                                                                            |
| Lifecycle and runtimes     | General skill install/update/rollback (#1082) and reproducible skill runtimes (#1247) remain separate work. Discovery and activation do not establish those capabilities.                                                                                                                                                                                                                                     |

Imported content can describe a task or narrow an agent's tool surface; it cannot grant
shell, filesystem, network or MCP permissions. Model-selected workspace/plugin skill
instructions retain untrusted-content framing and external-link warnings. Unlike explicit
manual invocation, automatic activation does not grant a thread read-only shell access to
the skill directory. Supporting files are read through `read_skill`; executing a script
still follows ordinary approvals and sandbox policy.

The transcript records each automatic activation as a `read_skill` tool call with the
resolved skill name, source path, trust framing and instruction context estimate in its
result. The four-character token estimate is approximate; UTF-8 bytes enforce the actual
instruction budget. Context management also counts tool results in the conversation.
Unrelated skills are never eagerly loaded, disabled model-invocation skills are rejected
at execution as well as excluded from the catalog, and manual-only eligibility is
independent of manual picker visibility.
