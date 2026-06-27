/**
 * Todos Extension for Pi Code
 *
 * Provides a /todos slash command with a persistent JSON-backed task list.
 *
 * Usage inside Pi TUI:
 *   /todos               — list all tasks
 *   /todos list          — list all tasks
 *   /todos add <task>    — add a new task
 *   /todos done <n>      — mark task N as done (1-based index)
 *   /todos remove <n>    — delete task N (1-based index)
 *   /todos clear         — remove all tasks (prompts for confirmation)
 *
 * Task data is stored at: ~/.pi/agent/todos.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TodoItem {
  id: string;        // timestamp string e.g. "1712345678901"
  task: string;      // task description
  done: boolean;     // completion status
  createdAt: number; // epoch ms
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function todosExtension(pi: ExtensionAPI) {

  // ─── File Path ───────────────────────────────────────────────────────────────

  const todosPath = join(homedir(), ".pi", "agent", "todos.json");

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function loadTodos(): TodoItem[] {
    if (!existsSync(todosPath)) return [];
    try {
      return JSON.parse(readFileSync(todosPath, "utf-8")) as TodoItem[];
    } catch {
      return [];
    }
  }

  function saveTodos(items: TodoItem[]): void {
    mkdirSync(dirname(todosPath), { recursive: true });
    writeFileSync(todosPath, JSON.stringify(items, null, 2), "utf-8");
  }

  function formatTodos(items: TodoItem[]): string {
    if (items.length === 0) return "No todos.";
    return items.map((item, i) =>
      `${i + 1}. [${item.done ? "x" : " "}] ${item.task}`
    ).join("\n");
  }

  // ─── Command Registration ─────────────────────────────────────────────────────

  pi.registerCommand("todos", {
    description: "Manage persistent task list. /todos [list|add <task>|done <n>|remove <n>|clear]",

    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { value: "list",    label: "list — show all tasks" },
        { value: "add ",    label: "add <task> — add new task" },
        { value: "done ",   label: "done <n> — mark task complete" },
        { value: "remove ", label: "remove <n> — delete task" },
        { value: "clear",   label: "clear — remove all tasks" },
      ];
      if (!prefix) return subcommands;
      return subcommands.filter(s => s.value.startsWith(prefix));
    },

    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();

      // ── list (default) ──
      if (trimmed === "" || trimmed === "list") {
        const items = loadTodos();
        await ctx.ui.notify("Todos:\n\n" + formatTodos(items), "info");
        return;
      }

      // ── add ──
      if (trimmed.startsWith("add ")) {
        const task = trimmed.slice(4).trim();
        if (!task) {
          await ctx.ui.notify("Usage: /todos add <task description>", "warning");
          return;
        }
        const items = loadTodos();
        const now = Date.now();
        items.push({ id: now.toString(), task, done: false, createdAt: now });
        saveTodos(items);
        await ctx.ui.notify(`Added: ${task}\n\nTotal: ${items.length} task(s)`, "info");
        return;
      }

      // ── done ──
      if (trimmed.startsWith("done ")) {
        const indexStr = trimmed.slice(5).trim();
        const index = parseInt(indexStr, 10) - 1;
        const items = loadTodos();
        if (isNaN(index) || index < 0 || index >= items.length) {
          await ctx.ui.notify(`Invalid index "${indexStr}". Use /todos list to see task numbers.`, "warning");
          return;
        }
        items[index].done = true;
        saveTodos(items);
        await ctx.ui.notify(`Done: ${items[index].task}`, "info");
        return;
      }

      // ── remove ──
      if (trimmed.startsWith("remove ")) {
        const indexStr = trimmed.slice(7).trim();
        const index = parseInt(indexStr, 10) - 1;
        const items = loadTodos();
        if (isNaN(index) || index < 0 || index >= items.length) {
          await ctx.ui.notify(`Invalid index "${indexStr}". Use /todos list to see task numbers.`, "warning");
          return;
        }
        const [removed] = items.splice(index, 1);
        saveTodos(items);
        await ctx.ui.notify(`Removed: ${removed.task}\n\nRemaining: ${items.length} task(s)`, "info");
        return;
      }

      // ── clear ──
      if (trimmed === "clear") {
        const confirmed = await ctx.ui.confirm("Clear All Todos", "Remove all tasks? This cannot be undone.");
        if (!confirmed) {
          await ctx.ui.notify("Clear cancelled.", "info");
          return;
        }
        saveTodos([]);
        await ctx.ui.notify("All todos cleared.", "info");
        return;
      }

      // ── unknown subcommand ──
      await ctx.ui.notify(
        "Usage:\n  /todos               — list tasks\n  /todos list          — list tasks\n  /todos add <task>    — add task\n  /todos done <n>      — mark done\n  /todos remove <n>    — delete task\n  /todos clear         — remove all",
        "info"
      );
    }
  });
}
