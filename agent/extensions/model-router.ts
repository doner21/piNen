/**
 * Model Router Extension
 *
 * Exposes an LLM-callable `model_router` tool so an orchestrator/planner model
 * can switch Pi's active model before the next assistant turn.
 *
 * Config files, merged with project overriding global:
 *   ~/.pi/agent/model-router.json
 *   <cwd>/.pi/model-router.json
 *
 * Example config:
 * {
 *   "allowDirectSet": true,
 *   "routes": {
 *     "planner": { "provider": "deepseek", "model": "deepseek-v4-pro", "thinkingLevel": "high" },
 *     "executor": { "provider": "openai-codex", "model": "gpt-5.5", "thinkingLevel": "high" }
 *   }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type ModelRoute = {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  description?: string;
};

type RouterConfig = {
  allowDirectSet?: boolean;
  routes?: Record<string, ModelRoute>;
};

const DEFAULT_CONFIG: RouterConfig = {
  allowDirectSet: true,
  routes: {
    planner: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinkingLevel: "high",
      description: "Deep planning and architecture reasoning",
    },
    executor: {
      provider: "openai-codex",
      model: "gpt-5.5",
      thinkingLevel: "high",
      description: "Implementation and code-editing execution",
    },
  },
};

function readJson(path: string): RouterConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RouterConfig;
  } catch (error) {
    console.error(`[model-router] Failed to read ${path}:`, error);
    return {};
  }
}

function mergeConfig(base: RouterConfig, override: RouterConfig): RouterConfig {
  return {
    ...base,
    ...override,
    routes: {
      ...(base.routes ?? {}),
      ...(override.routes ?? {}),
    },
  };
}

function loadConfig(cwd: string): RouterConfig {
  const globalConfig = readJson(join(getAgentDir(), "model-router.json"));
  const projectConfig = readJson(join(cwd, ".pi", "model-router.json"));
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function modelLabel(route: Pick<ModelRoute, "provider" | "model">): string {
  return `${route.provider}/${route.model}`;
}

function currentLabel(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function parseProviderModel(value: string): Pick<ModelRoute, "provider" | "model"> | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return undefined;
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

async function applyRoute(pi: ExtensionAPI, ctx: ExtensionContext, route: ModelRoute) {
  const target = ctx.modelRegistry.find(route.provider, route.model);
  if (!target) {
    throw new Error(`Model not found: ${modelLabel(route)}`);
  }

  const previous = currentLabel(ctx);
  const ok = await pi.setModel(target);
  if (!ok) {
    throw new Error(`No API key available for ${modelLabel(route)}`);
  }

  if (route.thinkingLevel) {
    pi.setThinkingLevel(route.thinkingLevel);
  }

  if (route.tools?.length) {
    const knownTools = new Set(pi.getAllTools().map((tool) => tool.name));
    const validTools = route.tools.filter((tool) => knownTools.has(tool));
    if (validTools.length) pi.setActiveTools(validTools);
  }

  return {
    previous,
    next: modelLabel(route),
    thinkingLevel: pi.getThinkingLevel(),
    tools: pi.getActiveTools(),
  };
}

export default function modelRouterExtension(pi: ExtensionAPI) {
  let config: RouterConfig = DEFAULT_CONFIG;
  let activeRoute: string | undefined;

  function routeSummary(): string {
    const routes = config.routes ?? {};
    const entries = Object.entries(routes);
    if (!entries.length) return "No routes configured.";
    return entries
      .map(([name, route]) => {
        const parts = [`${name}: ${modelLabel(route)}`];
        if (route.thinkingLevel) parts.push(`thinking=${route.thinkingLevel}`);
        if (route.tools?.length) parts.push(`tools=${route.tools.join(",")}`);
        if (route.description) parts.push(`- ${route.description}`);
        return parts.join(" ");
      })
      .join("\n");
  }

  async function availableModelSummary(ctx: ExtensionContext, query?: string): Promise<{ text: string; models: Array<{ provider: string; id: string; name?: string }> }> {
    const available = await ctx.modelRegistry.getAvailable();
    const needle = query?.trim().toLowerCase();
    const filtered = available.filter((model) => {
      if (!needle) return true;
      return `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(needle);
    });

    const shown = filtered.slice(0, 80).map((model) => {
      const label = `${model.provider}/${model.id}`;
      return model.name && model.name !== model.id ? `${label} — ${model.name}` : label;
    });

    const suffix = filtered.length > shown.length ? `\n...and ${filtered.length - shown.length} more. Use query to narrow results.` : "";
    return {
      text: shown.length ? shown.join("\n") + suffix : `No available models matched ${JSON.stringify(query ?? "")}.`,
      models: filtered.map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
    };
  }

  function updateStatus(ctx: ExtensionContext) {
    const route = activeRoute ? ` route:${activeRoute}` : "";
    ctx.ui.setStatus("model-router", `🤖 ${currentLabel(ctx)}${route}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.registerCommand("route-model", {
    description: "Switch model route: /route-model [route|provider/model]",
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix ?? "";
      return Object.entries(config.routes ?? {})
        .filter(([name]) => name.startsWith(normalizedPrefix))
        .map(([name, route]) => ({
          value: name,
          label: `${name.padEnd(14)} ${modelLabel(route)}${route.description ? ` — ${route.description}` : ""}`,
        }));
    },
    handler: async (args, ctx) => {
      config = loadConfig(ctx.cwd);
      const arg = args.trim();

      if (!arg) {
        ctx.ui.notify(`Current: ${currentLabel(ctx)}\n\nRoutes:\n${routeSummary()}`, "info");
        return;
      }

      const route = (config.routes ?? {})[arg] ?? parseProviderModel(arg);

      if (!route) {
        ctx.ui.notify(`Unknown route or model: ${arg}\n\nRoutes:\n${routeSummary()}`, "error");
        return;
      }

      try {
        const result = await applyRoute(pi, ctx, route);
        activeRoute = (config.routes ?? {})[arg] ? arg : undefined;
        updateStatus(ctx);
        ctx.ui.notify(`Model routed: ${result.previous} → ${result.next} (thinking: ${result.thinkingLevel})`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "model_router",
    label: "Model Router",
    description:
      "Switch Pi's active model for the next assistant turn, list/search available models, list configured routes, or inspect the current model. Use this when orchestrating planner/executor/verifier handoffs.",
    promptSnippet: "Route Pi to another model or role before the next assistant turn",
    promptGuidelines: [
      "Use model_router when a planning/orchestration phase should hand off to a different model for execution or verification.",
      "After model_router switches models, the current tool result is returned to the newly selected model on the next assistant turn; the already-running response cannot be retroactively changed.",
    ],
    parameters: Type.Object({
      action: StringEnum(["current", "list", "models", "route", "set"] as const, {
        description: "current = show active model, list = show configured routes, models = search/list available /model entries, route = use named route, set = direct provider/model switch",
      }),
      route: Type.Optional(Type.String({ description: "Named route from model-router.json, e.g. planner, executor, verifier" })),
      provider: Type.Optional(Type.String({ description: "Provider for direct set, e.g. deepseek, openai-codex, anthropic" })),
      model: Type.Optional(Type.String({ description: "Model id for direct set, e.g. deepseek-v4-pro. May contain slashes for providers like OpenRouter." })),
      query: Type.Optional(Type.String({ description: "Optional search text for action=models, e.g. claude, deepseek, gpt-5" })),
      thinkingLevel: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
        description: "Optional thinking level override for this switch",
      })),
      reason: Type.Optional(Type.String({ description: "Short reason for the handoff, included in logs/tool result" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = loadConfig(ctx.cwd);

      if (params.action === "current") {
        return {
          content: [{ type: "text", text: `Current model: ${currentLabel(ctx)}\nThinking: ${pi.getThinkingLevel()}\nActive route: ${activeRoute ?? "(none)"}` }],
          details: { model: ctx.model, thinkingLevel: pi.getThinkingLevel(), activeRoute },
        };
      }

      if (params.action === "list") {
        return {
          content: [{ type: "text", text: `Configured model routes:\n${routeSummary()}\n\nDirect set allowed: ${config.allowDirectSet !== false}` }],
          details: { routes: config.routes ?? {}, allowDirectSet: config.allowDirectSet !== false },
        };
      }

      if (params.action === "models") {
        const summary = await availableModelSummary(ctx, params.query);
        return {
          content: [{ type: "text", text: `Available models${params.query ? ` matching ${JSON.stringify(params.query)}` : ""}:\n${summary.text}` }],
          details: { models: summary.models, query: params.query },
        };
      }

      let route: ModelRoute | undefined;
      let routeName: string | undefined;

      if (params.action === "route") {
        routeName = params.route;
        if (!routeName) throw new Error("model_router action=route requires route");
        route = (config.routes ?? {})[routeName];
        if (!route) throw new Error(`Unknown route: ${routeName}. Available: ${Object.keys(config.routes ?? {}).join(", ") || "(none)"}`);
      }

      if (params.action === "set") {
        if (config.allowDirectSet === false) {
          throw new Error("Direct model setting is disabled by model-router.json; use a named route instead.");
        }
        if (!params.provider || !params.model) throw new Error("model_router action=set requires provider and model");
        route = {
          provider: params.provider,
          model: params.model,
          thinkingLevel: params.thinkingLevel as ThinkingLevel | undefined,
        };
      }

      if (!route) throw new Error(`Unsupported action: ${params.action}`);
      if (params.thinkingLevel) route = { ...route, thinkingLevel: params.thinkingLevel as ThinkingLevel };

      const result = await applyRoute(pi, ctx, route);
      activeRoute = routeName;
      updateStatus(ctx);

      const reason = params.reason ? `\nReason: ${params.reason}` : "";
      return {
        content: [
          {
            type: "text",
            text: `Model routed: ${result.previous} → ${result.next}\nThinking: ${result.thinkingLevel}\nActive route: ${activeRoute ?? "(direct)"}${reason}\n\nThis takes effect on the next assistant turn.`,
          },
        ],
        details: { ...result, activeRoute, reason: params.reason },
      };
    },
  });
}
