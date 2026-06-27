/**
 * Browser Picture Search Extension for Pi
 *
 * Registers browser-backed search helper tools with distinct names that do NOT
 * collide with @ollama/pi-web-search (web_search / web_fetch).
 *
 * Tools registered:
 *   browser_web_search          — text search via DuckDuckGo (lite HTML, no JS)
 *   browser_image_search        — image search by query (Google Images)
 *   browser_reverse_image_search — reverse image lookup (Google Lens / Yandex)
 *
 * All three return ready-to-use URLs plus a workplan the LLM can execute using
 * the existing Playwright MCP tools (browser_navigate, browser_snapshot,
 * browser_take_screenshot, browser_click, browser_type).
 *
 * This extension does NOT overwrite web_search from @ollama/pi-web-search and
 * does NOT require or remove the Playwright MCP extension.
 *
 * Google Lens / login / captcha limitations are documented inline.
 *
 * IMPORTANT: This extension assumes the Playwright MCP tools are already
 * registered (via playwright-mcp.ts). If they are not active the LLM will
 * still receive the URL + workplan but must fall back to manual steps.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/** Build a DuckDuckGo Lite search URL (returns HTML, no JS required). */
function ddgLiteUrl(query: string): string {
  const q = encodeURIComponent(query);
  return `https://lite.duckduckgo.com/lite/?q=${q}`;
}

/** Build a Google Images search URL (with udm=2 for images tab, no JS). */
function googleImagesUrl(query: string): string {
  const q = encodeURIComponent(query);
  // udm=2 = image search tab; tbm=isch is the classic image search
  return `https://www.google.com/search?tbm=isch&q=${q}&hl=en`;
}

/** Build a Yandex reverse image search URL (upload form). */
function yandexReverseUrl(): string {
  return "https://yandex.com/images/";
}

/** Build a Google Images reverse-image-search URL (requires upload UI). */
function googleReverseUrl(): string {
  return "https://www.google.com/imghp?hl=en&tbs=sbi";
}

/**
 * Workplan template for browser-based search.
 * The LLM receives the URL + step-by-step Playwright instructions.
 */
function browserWorkplan(label: string, url: string, steps: string[]): string {
  const lines = [
    `## ${label}`,
    ``,
    `**Target URL:** ${url}`,
    ``,
    `**Workplan (use Playwright MCP tools):**`,
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    ``,
    `**Playwright tools available:** browser_navigate, browser_snapshot,`,
    `  browser_take_screenshot, browser_click, browser_type, browser_wait_for,`,
    `  browser_scroll, browser_evaluate, browser_press_key`,
  ];
  return lines.join("\n");
}

/**
 * DuckDuckGo Lite direct-HTTP attempt (no JS, text parse).
 * Returns result or null on failure.
 */
async function ddgDirectSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<{ title: string; url: string; snippet: string }[] | null> {
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!resp.ok) return null;

    const html = await resp.text();

    // DuckDuckGo Lite renders results as:
    //   <a rel="nofollow" href="...">Title</a>
    //   <span class="link-text">display URL</span>
    //   with snippet text (non-semantic HTML, hard to parse reliably)
    // We extract link/title pairs and best-effort snippets.
    const results: { title: string; url: string; snippet: string }[] = [];

    // Match result blocks: a link with rel="nofollow" class="result-link"
    const linkRe =
      /<a[^>]*rel="nofollow"[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = linkRe.exec(html)) !== null) {
      if (results.length >= maxResults) break;

      const rawUrl = match[1]
        .replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "")
        .replace(/&rut=[^&]*/, ""); // clean redirect wrapper if present
      const decodedUrl = decodeURIComponent(
        rawUrl.startsWith("http") ? rawUrl : match[1],
      );
      const title = match[2]
        .replace(/<[^>]*>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim();

      if (!title) continue;

      results.push({
        title,
        url: decodedUrl,
        snippet: "", // Lite HTML doesn't expose snippets reliably
      });
    }

    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function browserPictureSearch(pi: ExtensionAPI) {
  // ── browser_web_search ──────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_web_search",
    label: "Browser Web Search",
    description:
      "Search the web via DuckDuckGo Lite (no JS, no Ollama dependency). " +
      "Attempts direct HTTP fetch first; falls back to browser-automation " +
      "workplan using Playwright MCP tools if direct fetch fails. " +
      "Distinct from 'web_search' (Ollama).",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
      max_results: Type.Optional(
        Type.Number({
          description: "Max results (default: 5, max: 10)",
          default: 5,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const maxResults = Math.min(params.max_results ?? 5, 10);
      const query = params.query;

      // 1. Try direct HTTP parse
      const direct = await ddgDirectSearch(query, maxResults, signal);

      if (direct && direct.length > 0) {
        const formatted = direct
          .map(
            (r, i) =>
              `${i + 1}. **${r.title}**\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text:
                `[browser_web_search] Direct results for "${query}":\n\n${formatted}\n\n` +
                `Tip: Use **browser_navigate** to open any of these URLs in the Playwright browser ` +
                `for full page inspection and screenshot capture.`,
            },
          ],
          details: { results: direct },
        };
      }

      // 2. Fallback: browser workplan
      const url = ddgLiteUrl(query);
      const steps = [
        `Call **browser_navigate** with url="${url}"`,
        `Call **browser_snapshot** to read the page structure`,
        `Identify result links and snippets in the snapshot text`,
        `For interesting results, call **browser_navigate** with the result URL`,
        `Call **browser_take_screenshot** to capture visual evidence`,
        `Alternatively use **browser_evaluate** for custom JS extraction`,
      ];

      return {
        content: [
          {
            type: "text" as const,
            text: `[browser_web_search] Direct HTTP search did not return parseable results.\n\n` +
              browserWorkplan("Browser Web Search", url, steps),
          },
        ],
      };
    },
  });

  // ── browser_image_search ─────────────────────────────────────────────────

  pi.registerTool({
    name: "browser_image_search",
    label: "Browser Image Search",
    description:
      "Search for images by keyword/query via Google Images. " +
      "Returns a URL + browser-automation workplan. " +
      "Use with Playwright MCP tools to navigate, screenshot, and extract image URLs. " +
      "Distinct from 'web_search' (Ollama).",
    parameters: Type.Object({
      query: Type.String({ description: "Image search keywords/query" }),
      safe_search: Type.Optional(
        Type.Boolean({
          description: "Enable SafeSearch (default: true)",
          default: true,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = params.query;
      const safe = params.safe_search !== false;
      let url = googleImagesUrl(query);
      if (safe) url += "&safe=active";

      const gSteps = [
        `Call **browser_navigate** with url="${url}"`,
        `Wait for results: call **browser_wait_for** with selector="img" or use **browser_snapshot**`,
        `Call **browser_take_screenshot** to capture the grid of image results`,
        `To extract individual image URLs, use **browser_evaluate** with JS:`,
        `  Array.from(document.querySelectorAll('img')).map(i => i.src)`,
        `Click on a result image: **browser_click** on the desired element`,
        `Take another screenshot of the expanded image/details panel`,
      ];

      const yandexUrl = `https://yandex.com/images/search?text=${encodeURIComponent(query)}`;
      const yandexSteps = [
        `Call **browser_navigate** with url="${yandexUrl}"`,
        `Call **browser_snapshot** to read results`,
        `Call **browser_take_screenshot** to capture visual results`,
        `Yandex Images is less aggressive with CAPTCHAs than Google.`,
      ];

      return {
        content: [
          {
            type: "text" as const,
            text:
              `[browser_image_search] Image search for: **${query}**\n\n` +
              `## Primary: Google Images\n\n` +
              browserWorkplan("Google Image Search", url, gSteps) +
              `\n\n---\n\n` +
              `## Alternative: Yandex Images (fewer CAPTCHAs)\n\n` +
              browserWorkplan("Yandex Image Search", yandexUrl, yandexSteps) +
              `\n\n---\n\n` +
              `**⚠ Google Images Limitations:**\n` +
              `- Google may show a consent/login page before results. If so, use **browser_click** to dismiss.\n` +
              `- Frequent automated searches may trigger CAPTCHA challenges (especially on Google).\n` +
              `- If CAPTCHA appears, switch to the Yandex alternative above.\n` +
              `- Image hotlinking URLs are temporary and may expire within hours.`,
          },
        ],
        details: { google_url: url, yandex_url: yandexUrl, query },
      };
    },
  });

  // ── browser_reverse_image_search ─────────────────────────────────────────

  pi.registerTool({
    name: "browser_reverse_image_search",
    label: "Browser Reverse Image Search",
    description:
      "Find visually similar images or identify an image via reverse search. " +
      "Returns direct upload URLs (Google Images, Yandex, TinEye) plus " +
      "browser-automation workplan. " +
      "For local image files, use google_upload_url + browser workflow to upload. " +
      "Google Lens login/CAPTCHA limitations documented. " +
      "Distinct from 'web_search' (Ollama).",
    parameters: Type.Object({
      image_url: Type.Optional(
        Type.String({
          description:
            "Publicly accessible URL of the image to reverse-search. " +
            "If omitted, use the file-upload workplan with a local image.",
        }),
      ),
      engine: Type.Optional(
        Type.String({
          description:
            "Search engine: 'google', 'yandex', 'tineye', or 'all' (default: 'all')",
          default: "all",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const imageUrl = params.image_url;
      const engine = params.engine ?? "all";

      const sections: string[] = [];

      // ── Google Images reverse search ──────────────────────────────────
      if (engine === "all" || engine === "google") {
        const gUrl = googleReverseUrl();
        const gSteps = imageUrl
          ? [
              `Call **browser_navigate** with url="${gUrl}"`,
              `Use **browser_type** to paste "${imageUrl}" into the search-by-URL field (or click the camera icon first)`,
              `Press Enter or click the search button`,
              `Call **browser_snapshot** to read the results page`,
              `Call **browser_take_screenshot** to capture matched images`,
            ]
          : [
              `Call **browser_navigate** with url="${gUrl}"`,
              `Locate the "upload an image" button/link (camera icon) on the page`,
              `**Limitation:** Automated file upload to Google Images reverse search is unreliable due to Google's anti-bot measures.`,
              `**Workaround:** Manually upload the image to a public host (imgur.com, etc.) and use the URL-based flow above.`,
              `Alternatively, use the Yandex flow below which is more automation-friendly.`,
              `To upload manually in the browser window: click the camera icon → "upload an image" → select file.`,
            ];
        sections.push(
          browserWorkplan(
            "Google Images Reverse Search" +
              (imageUrl ? "" : " (file upload — limited automation)"),
            gUrl,
            gSteps,
          ),
        );
      }

      // ── Yandex reverse search ─────────────────────────────────────────
      if (engine === "all" || engine === "yandex") {
        const yUrl = yandexReverseUrl();
        const ySteps = imageUrl
          ? [
              `Call **browser_navigate** with url="${yUrl}"`,
              `Click the camera/search-by-image icon in the search bar`,
              `Use **browser_type** to enter "${imageUrl}" into the URL field`,
              `Wait for results: **browser_wait_for** or **browser_snapshot**`,
              `Call **browser_take_screenshot** to capture results`,
              `Yandex shows: visually similar images, different sizes, pages that contain the image`,
            ]
          : [
              `Call **browser_navigate** with url="https://yandex.com/images/"`,
              `Click the camera icon in the search bar`,
              `Select the "Upload" tab to open the file picker`,
              `**Note:** File upload via browser_type may work with the file input; try browser_evaluate to set the input value.`,
              `Alternatively, host the image first and use the URL-based flow.`,
              `Call **browser_take_screenshot** to capture results`,
            ];
        sections.push(
          browserWorkplan(
            "Yandex Reverse Image Search" +
              (imageUrl ? " (URL)" : " (upload)"),
            yUrl,
            ySteps,
          ),
        );
      }

      // ── TinEye reverse search ─────────────────────────────────────────
      if (engine === "all" || engine === "tineye") {
        const tUrl = imageUrl
          ? `https://tineye.com/search?url=${encodeURIComponent(imageUrl)}`
          : "https://tineye.com/";
        const tSteps = imageUrl
          ? [
              `Call **browser_navigate** with url="${tUrl}" (TinEye with pre-filled URL)`,
              `Call **browser_snapshot** to read matches`,
              `Call **browser_take_screenshot** to capture results`,
            ]
          : [
              `Call **browser_navigate** with url="https://tineye.com/"`,
              `Click the upload button or drag-drop area`,
              `**Limitation:** Direct file upload automation is difficult without user interaction.`,
              `Upload the image manually in the browser window or host it first.`,
            ];
        sections.push(
          browserWorkplan(
            "TinEye Reverse Image Search" +
              (imageUrl ? " (URL pre-filled)" : " (upload)"),
            tUrl,
            tSteps,
          ),
        );
      }

      // ── Google Lens caveats ───────────────────────────────────────────
      const lensCaveats =
        `\n---\n\n` +
        `**⚠ Google Lens / Reverse Search Limitations:**\n` +
        `- **Google Lens** (lens.google.com) requires JavaScript-heavy browser and often shows a login prompt. Direct automation is unreliable.\n` +
        `- **Google CAPTCHA:** Multiple automated reverse searches in a session may trigger CAPTCHA challenges.\n` +
        `- **File upload automation:** Playwright can theoretically interact with file inputs, but Google/Yandex often use custom upload widgets that block scripted uploads.\n` +
        `- **Best practice for local images:** Upload the image to a quick host (imgur.com, postimages.org, catbox.moe) using their APIs or manual upload, then use the public URL for reverse search.\n` +
        `- **Yandex** is more automation-friendly and less CAPTCHA-aggressive than Google for reverse image search.\n` +
        `- **TinEye** works well for URL-based lookups but has a smaller index.\n` +
        `- **Bing Visual Search** (https://www.bing.com/images/search?q=imgurl:...) is another option that accepts image URLs via query parameter.\n`;

      const text = sections.join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text:
              `[browser_reverse_image_search] ${
                imageUrl
                  ? `Reverse search for image: ${imageUrl}`
                  : "Reverse search (upload workflow)"
              }\n\n` +
              text +
              lensCaveats,
          },
        ],
        details: {
          engines_included:
            engine === "all"
              ? ["google", "yandex", "tineye"]
              : [engine],
          image_url: imageUrl ?? null,
        },
      };
    },
  });

  console.log("[browser-picture-search] Registered 3 browser search tools.");
}
