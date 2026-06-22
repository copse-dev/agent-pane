# search-mcp (vendored)

Library extracted from [search-mcp](https://github.com/jonathanKingston/search-mcp) for native Copse tools.

Provides:

- DuckDuckGo web search (`webSearch`)
- URL fetch with Readability + Markdown conversion (`fetchUrlMarkdown`)

Copse registers these as built-in tools (`web_search`, `fetch_url`) instead of MCP servers so the experience stays transparent to users.

Update this vendored copy with `npm run postinstall` (via `scripts/fetch-search-mcp.mts`) once the upstream repository is published.
