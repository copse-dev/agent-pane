# Bounded project-context retrieval prototype

Tracking: [#3358](https://github.com/copse-dev/agent-pane/issues/3358).
Implementation starts from `95dd2bd701472f40adb2a18d68d23d5d82817da7`.

## Outcome and acceptance

Agents can explicitly search stored project evidence and enabled OKF memories, then
read a selected source by its content revision. This slice adds no automatic attachment,
extraction, inference backfill, or provider call. It does not close the tracking issue.

- Empty and non-Git projects work without configuration.
- The calling turn supplies project identity, never a tool argument or the active window.
- Fixed source bytes, request and limits produce the same ordering and excerpts.
- Every result identifies a source file, content fingerprint, kind and authorship.
- Foreign IDs, path traversal, symlink descendants and unsupported/private files yield no content.
- Responses and filesystem work have independent hard limits with visible omissions.
- Existing conversation consent and the memory master switch remain authoritative,
  including revocation before delivery.
- A native Electron scenario proves search/read results reach the model boundary and
  their source metadata appears in the actual tool cards.

## Surfaces

`search_project_context(query, kinds?, scope?, limit?, cursor?)` searches all whitespace-separated
terms, case-insensitively after NFC normalization. It searches message/title text, tool-result
text and Memory-note title/body. Ranking prefers the calling thread, then title matches,
then the stable source ID. Recency does not confer relevance. An empty match is valid.

`read_project_context(id, revision?, scope?, cursor?)` returns a bounded source page.
IDs include a kind and a project-bound digest; neither IDs nor cursors contain usable paths.
A supplied revision must still match. Cursors bind the result snapshot or source revision;
edits invalidate them instead of shifting pages silently. They are not authorization tokens.

The default evidence scope is the current project, using the existing **Read your other
threads?** permission. `scope: "thread"` narrows evidence to the current conversation and
its explicitly declared follow-up parent without prompting. A memory-only search/read
does not acquire conversation consent. Memory results require `copse.okf-memories`.
The tools are available in native read-only runs, through the ordinary registry and gates.
ACP exposure is deliberately deferred to avoid overlapping active bridge work.

Results enter the existing external-content envelope. Historical approvals are data and
cannot change permissions. Memory authorship is reported as unknown: this prototype does
not invent author identities or turn agent-supplied citations into verified provenance.
Evidence is labelled historical; memory freshness is unknown. A recorded starting commit
and dirty flag, when present on a message, are historical facts, not current validation.

## Storage and bounds

The service reads authoritative files directly; it creates no index, duplicated transcript,
briefing or persistent cache. Existing OKF parsing is shared with the knowledge store.
Only message bodies and declared textual tool-result files are evidence sources. Reasoning,
provider history, credentials, session bindings, tool arguments, images and nested subagent
stores are not indexed. Archived threads and notes marked deleted/forgotten/superseded
are excluded. Legacy notes and memory schema versions 1 and 2 remain readable;
unknown memory schema versions are omitted.
Existing knowledge-index deletion tombstones exclude leftover files, even after orphan
healing. Missing indexes permit legacy notes; corrupt, inaccessible or oversized indexes
fail closed for memories. The index is rechecked before publishing memory results.

| Resource                            | Initial bound                                            |
| ----------------------------------- | -------------------------------------------------------- |
| Directory enumeration               | 4,096 entries; larger directories are omitted as a whole |
| Thread scan                         | 64 directories in stable name order                      |
| Evidence records                    | 512                                                      |
| Memory files                        | 128 in stable name order                                 |
| Individual content or metadata file | 256 KiB                                                  |
| Thread spine                        | 1 MiB                                                    |
| Existing knowledge index            | 1 MiB                                                    |
| Aggregate bytes read per call       | 8 MiB, including consistency rereads                     |
| Search page                         | Default 8 records, maximum 20                            |
| Search excerpt                      | 700 characters plus ellipses                             |
| Read page                           | At most 4,000 characters                                 |
| Serialized JSON response            | 24,000 bytes, including metadata and paging              |

The standard provenance envelope adds its fixed framing and tag escaping after this JSON
limit. Existing host-added tool reminders are separate. Oversized or unavailable sources,
scan limits, content-hash failures and in-progress history edits are reported as omissions.
The service checks file type/size before bounded reads, rejects symlink descendants and
non-regular files, checks message/tool content hashes, and rechecks the thread metadata/spine.
Work is capped by counts and bytes rather than a timing-dependent partial ranking.

These limits make an explicit-tool prototype safe to exercise; they do not establish the
proposed 200 ms automatic-send deadline. Large histories can be omitted even when they contain
a relevant source. The same record may require a narrower thread or kind scope when a project
hits a scan limit. The next indexing phase should remove that limitation, not raise these
limits without measurement.

## Evidence and remaining milestones

The focused corpus tests create real thread-store fixtures and OKF notes. They cover empty
folders, Unicode queries, messages/tool results, noise, same-name sources across projects,
declared thread scope, symlinks, stale revisions/cursors, deletion, archive, malformed sources,
unknown schemas, injected instructions, oversized Unicode/control-character bodies and cancellation.
Native-boundary tests cover a project switch while consent is open, refusal, non-inherited grants,
revocation, memory disable and provenance framing. These establish contract behavior, not
real-model task quality or a held-out relevance score.

The Electron spec uses a scripted provider but real native tool execution, persisted source
threads, the composer, and result cards. It asserts that the provider receives the selected
source, then reads its revision and saves a screenshot. Local macOS captures are evidence,
not Linux baseline replacements. Exact commands/results belong in the PR's Validation section.

Still required for #3358:

1. Rebuildable worker index, broader evidence kinds, applicability/path filters and measured
   retrieval quality/latency on a larger held-out corpus.
2. Versioned same-task briefings that preserve later user steering through restart and
   compaction without duplicating restored history. Keep those briefings with their thread.
3. Atomic revision-aware memory writes across every writer, host-verified source relationships,
   freshness checks, authorship protection and durable forget/re-extraction suppression.
4. Project opt-in for automatic cross-thread attachment, token-budget assembly, actual-send
   manifests and Context used. Automatic attachment stays off in this slice.
5. Fresh/resumed ACP and hosted-adapter parity, delegated-scope tests and device evidence.
6. Optional budgeted extraction only after deterministic relevance is measured.

Active PRs #4210 (conversation reads), #4110 (hosted transcript confinement), #4155/#4200
(bridge tool delivery), and #4209 (unfinished-run continuity) were inspected before starting.
This slice leaves their implementation files alone; registration/readonly-list integration
may need straightforward reconciliation as those changes land.
