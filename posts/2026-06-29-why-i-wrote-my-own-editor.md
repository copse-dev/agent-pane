---
title: Why I wrote my own editor
date: 2026-06-29
---

The AI coding market is hotting up. Every week there's a new editor, a new agent,
a new pricing tier. What isn't keeping pace is developer freedom. The tools get
flashier while the choices you're allowed to make get narrower — one provider,
one place your code runs, one opinion about what your context window should hold.

So I wrote my own. It's called [Copse](https://github.com/jonathanKingston/agent-pane):
an open-source desktop coding assistant — chat, a real Monaco editor, terminal and
git in one window — that runs on my machine, with my keys, and every write or
command waits for my approval.

## The thing I actually couldn't get anywhere else

I want to fire off a **remote cloud agent** for the long, grindy job and keep
working **locally** at the same time — and I want both to be just another entry
in the same model picker. In Copse the Cursor Cloud Agent sits next to Anthropic,
OpenAI, anything through OpenRouter (Claude, GPT, Gemini, Llama), Mistral, DeepSeek,
and a fully local model via LM Studio. Cloud when it's worth it, local when it
isn't, a different provider when one's having a bad day — without leaving the editor
or rebuilding my setup. As far as I can tell, that blend genuinely isn't possible
in the tools I was using.

## Smaller context, same niceties

The other itch was context. The big editors hide what they're stuffing into the
prompt, then bill you for it. Copse shows a context wheel that breaks the window
down — system prompt, tools, MCP, skills, conversation, your message — so I can
*see* the bloat and cut it: trim history, switch off MCP servers and skills I don't
need for this task. You get a lean window without giving up the things that made
Cursor pleasant to use.

## What's still cooking

There's an Experimental tab for the half-formed ideas, all opt-in and off by default:

- **MCP-UI artefacts** — when an MCP tool returns a UI, render it as a sandboxed
  canvas instead of a wall of text.
- **CI investigator** — a read-only subagent that reads failing CI logs and reports
  the actual root cause.
- **Memories** — `remember` / `recall` tools that persist project conventions and
  gotchas across sessions as portable Open Knowledge Format files.

They're rough, but they're moving.

## Where I'm honestly at

I'm using Copse for maybe 20% of my work right now; the other editors still win the
rest. But that gap closes a little with every annoyance I fix. The point was never
to beat anyone on day one — it was to own the tool, and to keep the freedom the
market seems intent on quietly taking away.
