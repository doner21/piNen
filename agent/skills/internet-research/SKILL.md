---
name: "internet-research"
description: "PROCEDURE: Search the internet using the Tavily MCP server. Use this to find current information, documentation, or solutions to coding problems."
---

# Internet Research Procedure

> [!IMPORTANT]
> **This is a PROCEDURE, not a tool.** You do **not** have a tool named `web-search` or `internet-research`.
> **Primary search path: the Tavily MCP server** (`tavily` MCP server, connected via `mcp.json`). It provides `tavily_search`, `tavily_extract`, `tavily_crawl`, `tavily_map`, and `tavily_research`. It does NOT require Ollama, Llama, or a local model, and it is not CAPTCHA-blocked.

## Why Tavily, not DuckDuckGo

DuckDuckGo (Lite, HTML, and the `ddgr` CLI) is **CAPTCHA-blocked** for automated access from this environment and returns HTTP 429 / anomaly challenges on every query. Google, Bing, and Brave browser search are similarly blocked. **Do not use `browser_web_search`, `ddgr`, or direct DuckDuckGo navigation as a primary search path** — they will fail.

Tavily is a purpose-built AI search API with a free tier (1,000 credits/month), full web coverage, and no CAPTCHAs. It is configured as the `tavily` MCP server in `mcp.json` and should be the default for all internet research.

## How to Search

1. **Ensure the Tavily MCP server is connected.** If `mcp` status does not list `tavily`, connect it first: `mcp({ connect: "tavily" })`.
2. **Formulate a Query**: Determine the search terms you want to use.
3. **Primary tool path**: Call the Tavily MCP search tool via the `mcp` gateway:

```json
mcp({
  tool: "tavily_tavily_search",
  args: "{\"query\": \"your search query\", \"max_results\": 5, \"search_depth\": \"basic\"}"
})
```

   - Use `search_depth: "basic"` for quick lookups, `"advanced"` for deeper multi-source results.
   - `max_results` defaults to 5; raise to 10 for broader coverage.
4. **Full-page extraction**: When you need the full content of a result URL (not just the snippet), use the Tavily extract tool:

```json
mcp({
  tool: "tavily_tavily_extract",
  args: "{\"urls\": [\"https://example.com/page\"]}"
})
```

5. **Synthesize**: Use result titles, URLs, content snippets, and extracted pages to answer the user's question. Cite URLs for current or externally sourced claims.

## Other Tavily Tools

| Tool | Use When |
|---|---|
| `tavily_tavily_search` | Default web search — titles, URLs, snippets |
| `tavily_tavily_extract` | Need full page content from specific URLs |
| `tavily_tavily_crawl` | Systematically explore a whole site from a base URL |
| `tavily_tavily_map` | Build a structural map of a website's URLs |
| `tavily_tavily_research` | Deep multi-source research on a complex topic (uses more credits) |

## Fallbacks (only if Tavily is unavailable)

- **GitHub Search API** (`api.github.com/search/issues`) — works reliably for code/issue/package questions, no CAPTCHA. Unauthenticated limit: ~60 req/hour; search endpoint: ~10/min.
- **Direct `curl` to known URLs** — works for Wikipedia, Hacker News, and most non-search-engine sites. Reddit blocks default user-agents (403).
- **`browser_navigate` + `browser_snapshot`** — works for direct URLs but NOT for search engine queries (CAPTCHA).

Do **not** fall back to `browser_web_search` or `ddgr` — they are DuckDuckGo-backed and will CAPTCHA-fail.

## Notes

- `web_search` / `web_fetch` are legacy Ollama-backed tools only when `npm:@ollama/pi-web-search` is installed and a local Ollama instance has web search/fetch enabled. Not used here.
- If a DeepSeek-backed subagent performs research, it should also use the Tavily MCP tools, not DuckDuckGo.

## Example

If the user asks about Gemma 4, call the Tavily search tool:

```json
mcp({
  tool: "tavily_tavily_search",
  args: "{\"query\": \"Google Gemma 4 models latest details\", \"max_results\": 5, \"search_depth\": \"basic\"}"
})
```

Then use `tavily_tavily_extract` on authoritative result URLs when you need full-page evidence.
