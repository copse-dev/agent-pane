# search-mcp (vendored)

Library extracted from [search-mcp](https://github.com/jonathanKingston/search-mcp) for native Copse tools.

Provides:

- DuckDuckGo web search (`webSearch`)
- URL fetch with Readability + Markdown conversion (`fetchUrlMarkdown`)

Copse registers these as built-in tools (`web_search`, `fetch_url`) instead of MCP servers so the experience stays transparent to users.

Update this vendored copy with `npm run postinstall` (via `scripts/fetch-search-mcp.mts`). The upstream repo is private; clone requires GitHub access (SSH or a token URL via `SEARCH_MCP_GIT_URL`). When clone fails, Copse keeps the bundled copy under `vendor/search-mcp/`.
