# Reading archives as files (`read_archive`)

A zip is the wrong shape for a model twice over. Its bytes are compressed, so
inlining them tells the model nothing; and its interesting part is usually three
files out of four hundred, so a tool that streamed the contents back would spend
a context window on a directory listing the model did not ask for.

So Copse never sends an archive to the model. An archive attached to a chat is
stored next to the thread and the agent is handed its path; `read_archive`
unpacks it **into the thread's own directory** and returns a listing. From that
point the contents are ordinary files, and the agent reads the ones it wants
with `read_file`, `search_code`, `list_dir` or `explore`.

That last step is the whole design. The extraction root sits inside the chat
store, and [`resolveReadablePath`](../src/main/services/workspace.ts) already
accepts absolute paths there — the same authority that lets the agent explore an
`@`-referenced past conversation. So unpacking an archive grants no new
filesystem reach: it puts files somewhere the read tools could already look.

## Attaching an archive

Drop a `.zip` on the composer (or pick it with the paperclip). It appears as a
file-archive chip with the file's size. Only `.zip` is supported — the reader is
[`zip-reader.ts`](../src/main/services/storage/zip-reader.ts), not a general
archiver — and the cap is 128 MB.

Where the file goes depends on where it came from, exactly as for videos:

| Source                               | What happens                                          |
| ------------------------------------ | ----------------------------------------------------- |
| Dropped from the desktop             | Copied into `<thread>/blobs/media/` in the chat store |
| Dragged from the workspace file tree | Referenced where it lies; nothing is copied           |

The prompt gains a short reference block naming the path, saying that the
archive is not in context, and saying that unpacking is a **one-shot step** —
without that second half a model tends to call the tool once per entry rather
than unpacking once and reading files.

`read_archive` is withheld from threads that have never had an archive attached,
the same bargain [`video_frames`](video-frames.md) strikes: most conversations
never see a zip and should not pay for the schema every turn. An agent that
needs to open a zip sitting in the repo still has `run_shell`.

## Where it unpacks

```
~/.copse/workspace/<projectId>/<threadId>/blobs/archives/<name>-<hash>/
```

The directory is named for the archive plus a hash of its contents, so:

- unpacking the same archive twice **reuses** the first extraction, which makes
  a re-read in a later turn free; and
- a changed archive of the same name gets its own directory rather than mixing
  old and new files.

Extraction goes to a `.partial` sibling and is renamed into place, so a crash or
a tripped limit never leaves a half-archive at the path a later call would reuse.
Deleting the thread deletes its extractions with it.

## What the extractor refuses

Every part of an archive is attacker-controlled — it may have been downloaded,
mailed, or handed over by a third party — so
[`archive-extract.ts`](../src/main/services/archive/archive-extract.ts) treats
all of it as hostile input:

| Guard                  | Behaviour                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Path traversal**     | Entries named `../x`, `/etc/passwd`, `C:\…`, or containing a backslash or NUL are skipped and reported |
| **Symlinks**           | Skipped — never recreated, so nothing can point out of the extraction root                             |
| **Total size**         | Stops at `MAX_EXTRACTED_BYTES` (512 MB) and says the result is partial                                 |
| **Entry count**        | Stops at `MAX_ARCHIVE_ENTRIES` (20,000)                                                                |
| **Zip bombs**          | Aborts if the archive expands past `MAX_COMPRESSION_RATIO` (200x), checked as it extracts              |
| **Corruption**         | Every entry's CRC is verified; a mismatch names the entry rather than returning wrong bytes            |
| **zip64 / encryption** | Refused by name, so an unsupported archive never looks like an empty one                               |

Skipped entries are reported in the tool result rather than dropped silently: an
archive that tried to escape is worth telling the user about.

## Why not sanitise unsafe paths?

Rewriting `../escape.txt` to `escape.txt` would extract it "safely" and hand the
model a file under a name the archive never used. An archive doing that is not
one whose author wanted a different filename; it is one doing something it should
not. `isUnsafeEntryPath` rejects, and the result says which entries and why.
