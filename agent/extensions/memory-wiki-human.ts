/**
 * /memory-wiki human — Generate a human-readable architecture wiki.
 *
 * Two-phase flow in one command:
 *   Phase 1: Generate structural skeleton from graph.json (fast, <1s)
 *   Phase 2: Sends instruction to agent to write narrative content
 *
 * Usage:
 *   /memory-wiki human               — Current project
 *   /memory-wiki human /path/to/proj — Specific project
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const GENERATOR_SCRIPT = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi", "extensions", "generate_wiki.py"
);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("memory-wiki-human", {
    description: "Generate human-readable architecture wiki from graphify graph",

    getArgumentCompletions: (prefix: string) => {
      const options = ["human", "--help"];
      const filtered = options.filter((o) => o.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((o) => ({ value: o, label: o }))
        : null;
    },

    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (trimmed === "--help" || trimmed === "help") {
        ctx.ui.notify(
          "/memory-wiki human [path]\n" +
          "Generates a dual-audience wiki from graphify graph data.\n" +
          "Phase 1: Structural skeleton (instant).\n" +
          "Phase 2: Agent writes narratives (LLM-powered).",
          "info"
        );
        return;
      }

      // --- Resolve target directory ---
      let targetDir = ctx.cwd;
      if (trimmed && trimmed !== "human") {
        targetDir = trimmed;
      }

      const graphifyOut = join(targetDir, "graphify-out");
      const graphJson = join(graphifyOut, "graph.json");
      const graphReport = join(graphifyOut, "GRAPH_REPORT.md");

      // Validate
      if (!existsSync(graphifyOut)) {
        ctx.ui.notify(`No graphify-out/ found in ${targetDir}. Run /graphify first.`, "error");
        return;
      }
      if (!existsSync(graphJson) || !existsSync(graphReport)) {
        ctx.ui.notify(`graph.json or GRAPH_REPORT.md missing in ${graphifyOut}.`, "error");
        return;
      }
      if (!existsSync(GENERATOR_SCRIPT)) {
        ctx.ui.notify(`Generator not found at ${GENERATOR_SCRIPT}. Reinstall it.`, "error");
        return;
      }

      // --- Phase 1: Generate structural skeleton ---
      ctx.ui.setStatus("memory-wiki", "Building structural skeleton...");
      const result = await pi.exec("python", [
        "-X", "utf8", GENERATOR_SCRIPT, graphifyOut
      ], { cwd: targetDir });

      ctx.ui.setStatus("memory-wiki", "");

      if (result.code !== 0) {
        ctx.ui.notify(
          `Skeleton generation failed (code ${result.code}):\n${result.stderr || result.stdout}`,
          "error");
        return;
      }

      const wikiDir = join(graphifyOut, "wiki");
      const pageCount = existsSync(wikiDir) ? countFiles(wikiDir) : 0;
      const nodeCount = getStat(graphJson, "nodes") || "?";
      const edgeCount = getStat(graphJson, "edges") || "?";
      const comCount = getStat(graphJson, "communities") || "?";

      // Get the first few community names for the agent prompt
      const wikiIndex = join(wikiDir, "_INDEX.md");
      const wikiOverview = join(wikiDir, "01_OVERVIEW", "_README.md");
      const wikiArch = join(wikiDir, "01_OVERVIEW", "ARCHITECTURE_AT_A_GLANCE.md");

      ctx.ui.notify(
        `Skeleton built: ${pageCount} pages for ${nodeCount} nodes, ${edgeCount} edges, ${comCount} communities.`,
        "success"
      );

      // --- Phase 2: Instruct the agent to write narratives ---
      // Send a user message that tells the agent to fill in the "For Humans"
      // sections on each community page with real narrative content.

      const projectName = relative(process.env.HOME || "/", targetDir).split(/[\\\/]/).filter(Boolean).pop() || "this project";

      if (ctx.isIdle()) {
        pi.sendUserMessage(
          `The structural wiki skeleton for **${projectName}** has been generated at \`${relative(targetDir, wikiDir)}\` ` +
          `(${pageCount} pages, ${nodeCount} nodes, ${comCount} communities).\n\n` +
          `Now I need you to write the **narrative content** for the "For Humans" sections ` +
          `on each community page under \`02_TOP_COMMUNITIES/\`.\n\n` +
          `## DIAGRAM REQUIREMENTS (critical)\n` +
          `For EVERY community page and the architecture overview, include:\n` +
          `- An **ASCII box diagram** showing the key nodes and their relationships. Use box-drawing characters like:\n` +
          `  \`\`\`\n` +
          `  ┌─────────────┐    ┌─────────────┐\n` +
          `  │  Node A     │───▶│  Node B     │\n` +
          `  │  (function) │    │  (function) │\n` +
          `  └─────────────┘    └─────────────┘\n` +
          `  \`\`\`\n` +
          `- Use \`┌ ┐ └ ┘ │ ─ ▶ ◀ ┬ ┴ ├ ┤ ┼║╔╗╚╝╠╣╦╩╬\` box-drawing characters\n` +
          `- For the **Architecture at a Glance** page (01_OVERVIEW/ARCHITECTURE_AT_A_GLANCE.md):\n` +
          `  Add a **Mermaid flowchart** showing the system architecture:\n` +
          `  \`\`\`mermaid\n` +
          `  graph TD\n` +
          `    A[Component A] --> B[Component B]\n` +
          `    B --> C[Component C]\n` +
          `  \`\`\`\n` +
          `- Also add a **Mermaid mindmap** or **Mermaid flowchart** on the community index page (02_TOP_COMMUNITIES/_README.md)\n` +
          `  showing how the top communities relate to each other\n` +
          `\n` +
          `## NARRATIVE REQUIREMENTS\n` +
          `For each community page:\n` +
          `1. Read the graph data in the page's frontmatter and "For LLMs" section\n` +
          `2. Rewrite the "For Humans" section with:\n` +
          `   - A real-world analogy ("this is like... the filing cabinet, the librarian, etc.")\n` +
          `   - An ASCII box diagram showing the architecture of this community\n` +
          `   - An explanation of what the community does and why it matters\n` +
          `   - Description of the key nodes and their roles\n` +
          `   - Bridge analysis: what connects this community to others\n` +
          `   - The "cohesion" explained in plain language\n` +
          `   - A Mermaid flowchart if the community has clear data flow\n` +
          `3. Also update the "For LLMs" section if there's additional context you can infer\n\n` +
          `Start with the largest community and work down. Do not use placeholders.`
        );
      } else {
        ctx.ui.notify(
          "Agent is busy. When it's idle, tell it: write the wiki narratives",
          "info"
        );
      }
    },
  });
}

function countFiles(dir: string): number {
  let count = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        count += countFiles(full);
      } else if (entry.name.endsWith(".md")) {
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}

function getStat(graphJson: string, key: string): string {
  try {
    const content = readFileSync(join(graphJson, "..", "GRAPH_REPORT.md"), "utf-8");
    const match = content.match(new RegExp(`(\\d+) ${key}`));
    return match ? match[1] : "?";
  } catch { return "?"; }
}
