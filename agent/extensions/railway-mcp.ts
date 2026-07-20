/**
 * Railway MCP Extension for Pi Code
 *
 * Registers Railway MCP tool proxies on session start, but defers spawning the
 * Railway MCP server until the first Railway tool invocation. This prevents the
 * Windows console flashes caused by eagerly launching npm .cmd shims during Pi
 * start/reload/subagent creation. Shutdown cleanup also closes the MCP client
 * and terminates the spawned child process so no Railway MCP orphans remain.
 *
 * The Railway MCP server communicates over stdio (JSON-RPC 2.0). This
 * extension uses @modelcontextprotocol/sdk to connect as an MCP client.
 *
 * Prerequisites:
 *   1. Railway CLI installed: npm install -g @railway/cli
 *   2. Railway CLI authenticated: railway login
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerMcpServer, unregisterMcpServer } from "./mcp-status.js";

// ─── Module-level state ───────────────────────────────────────────────────────

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let mcpConnectPromise: Promise<void> | null = null;
let toolsRegistered = false;

const RAILWAY_CLI_PATH =
  "C:\\Users\\doner\\AppData\\Roaming\\npm\\node_modules\\@railway\\cli\\bin\\railway.js";

// Token "area": a gitignored JSON file where the user pastes a non-expiring
// Railway API/project token. Loaded at MCP-spawn time and injected into the
// child process environment, so the Railway MCP no longer depends on the
// OAuth session in ~/.railway/config.json (which silently expires).
const RAILWAY_TOKEN_FILE = join(homedir(), ".pi", "agent", "railway-token.json");

// Environment keys the Railway CLI/MCP honours. RAILWAY_API_TOKEN is an
// account/team token (works across projects); RAILWAY_TOKEN is a project token
// (scoped to one project+environment). The *_ID hints help link operations.
const RAILWAY_ENV_KEYS = [
  "RAILWAY_API_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_PROJECT_ID",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_SERVICE_ID",
] as const;

/**
 * Load Railway auth/config from the token area file and from process.env.
 * Precedence: an explicitly exported process.env value overrides the file, so a
 * temporary shell export can override the persisted token. Placeholder values
 * (empty, or wrapped in <...>) are ignored so the example template is inert.
 */
function loadRailwayTokenEnv(): { env: Record<string, string>; source: string } {
  const env: Record<string, string> = {};
  let fromFile = false;

  if (existsSync(RAILWAY_TOKEN_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(RAILWAY_TOKEN_FILE, "utf8")) as Record<
        string,
        unknown
      >;
      for (const key of RAILWAY_ENV_KEYS) {
        const val = parsed[key];
        if (
          typeof val === "string" &&
          val.trim() &&
          !val.trim().startsWith("<")
        ) {
          env[key] = val.trim();
          fromFile = true;
        }
      }
    } catch (err: any) {
      console.warn(
        `[railway-mcp] Could not parse token file ${RAILWAY_TOKEN_FILE}:`,
        err?.message ?? String(err),
      );
    }
  }

  let fromEnv = false;
  for (const key of RAILWAY_ENV_KEYS) {
    const val = process.env[key];
    if (typeof val === "string" && val.trim()) {
      env[key] = val.trim();
      fromEnv = true;
    }
  }

  const hasToken = Boolean(env.RAILWAY_API_TOKEN || env.RAILWAY_TOKEN);
  const source = !hasToken
    ? "none (falling back to OAuth ~/.railway/config.json)"
    : [fromFile ? "token-file" : null, fromEnv ? "process-env" : null]
        .filter(Boolean)
        .join("+");
  return { env, source };
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const RAILWAY_TOOLS: McpToolDefinition[] = [
  {
    "name": "add_reference_variable",
    "description": "Set reference variables on a service. Each variable value must be a Railway reference expression starting with '${{' (e.g. '${{ Postgres.DATABASE_URL }}').",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        },
        "variables": {
          "description": "Variables to set, each with a name and a reference value starting with \"${{\".",
          "items": {
            "$ref": "#/$defs/ReferenceVariable"
          },
          "type": "array"
        }
      },
      "required": [
        "variables"
      ],
      "$defs": {
        "ReferenceVariable": {
          "properties": {
            "name": {
              "description": "Variable name.",
              "type": "string"
            },
            "value": {
              "description": "Reference value (must start with \"${{\").",
              "type": "string"
            }
          },
          "required": [
            "name",
            "value"
          ],
          "type": "object"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "AddReferenceVariableParams"
    }
  },
  {
    "name": "create_bucket",
    "description": "Create a new object storage bucket in a Railway environment. Default region is sjc. Returns the bucket ID and name.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "name": {
          "default": null,
          "description": "Optional name for the bucket.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "region": {
          "default": null,
          "description": "Region: sjc, iad, ams, or sin (default: sjc).",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "CreateBucketParams"
    }
  },
  {
    "name": "create_environment",
    "description": "Create a new environment in a Railway project. Optionally fork from an existing environment.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "name": {
          "description": "The name for the new environment.",
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "source_environment_id": {
          "default": null,
          "description": "Source environment ID to fork from.",
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "CreateEnvironmentParams"
    }
  },
  {
    "name": "create_project",
    "description": "Create a new Railway project. Returns the project ID and the default environment ID.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "description": {
          "default": null,
          "description": "Optional description for the project.",
          "nullable": true,
          "type": "string"
        },
        "name": {
          "description": "The name for the new project.",
          "type": "string"
        },
        "workspace_id": {
          "default": null,
          "description": "Workspace ID to create the project in. If omitted, uses the user's personal workspace.",
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "CreateProjectParams"
    }
  },
  {
    "name": "create_service",
    "description": "Create a new service in a Railway project. Optionally connect a GitHub repo or Docker image.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "name": {
          "default": null,
          "description": "Name for the new service.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "source_image": {
          "default": null,
          "description": "Docker image to use (e.g. \"nginx:latest\").",
          "nullable": true,
          "type": "string"
        },
        "source_repo": {
          "default": null,
          "description": "GitHub repo to connect (e.g. \"owner/repo\").",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "CreateServiceParams"
    }
  },
  {
    "name": "create_volume",
    "description": "Create a persistent volume and attach it to a service at the given mount path.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "mount_path": {
          "description": "Mount path for the volume (e.g. \"/data\").",
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "mount_path"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "CreateVolumeParams"
    }
  },
  {
    "name": "deploy",
    "description": "Deploy code from a directory to Railway. Creates a tarball, uploads it, and starts a deployment. Returns the deployment ID and URLs. Use get_logs to monitor progress.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "message": {
          "default": null,
          "description": "Message to attach to the deployment.",
          "nullable": true,
          "type": "string"
        },
        "path": {
          "default": null,
          "description": "Path to the directory to deploy. Defaults to current directory.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the linked service or backboard auto-creates one.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "DeployParams"
    }
  },
  {
    "name": "deploy_template",
    "description": "Deploy a Railway template by its code (e.g. 'postgres', 'redis'). Returns the workflow ID to track deployment progress.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "template_code": {
          "description": "Template code to deploy (e.g. \"postgres\", \"redis\").",
          "type": "string"
        }
      },
      "required": [
        "template_code"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "DeployTemplateParams"
    }
  },
  {
    "name": "docs_fetch",
    "description": "Fetch the full markdown content of a Railway documentation page. Accepts a docs URL (e.g. https://docs.railway.com/guides/getting-started) or a slug (e.g. guides/getting-started). Use docs_search first to find the right page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "url": {
          "description": "The documentation page URL (e.g. \"https://docs.railway.com/guides/getting-started\") or slug (e.g. \"guides/getting-started\").",
          "type": "string"
        }
      },
      "required": [
        "url"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "DocsFetchParams"
    }
  },
  {
    "name": "docs_search",
    "description": "Search Railway documentation by keyword. Returns a list of matching page URLs. Use docs_fetch to read the full content of a specific page.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "description": "Search query to find Railway documentation pages.",
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "DocsSearchParams"
    }
  },
  {
    "name": "environment_status",
    "description": "Get the deployment status of all services in a Railway environment. Returns a table of service name, status, replica count, and latest deploy time.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "EnvironmentStatusParams"
    }
  },
  {
    "name": "generate_domain",
    "description": "Add a domain to a service. If 'domain' is provided, creates a custom domain and returns required DNS records. If omitted, generates a Railway service domain (or returns existing domains).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "domain": {
          "default": null,
          "description": "Custom domain to add (e.g. \"api.example.com\"). If omitted, generates a Railway service domain.",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "port": {
          "default": null,
          "description": "Target port for the domain.",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "GenerateDomainParams"
    }
  },
  {
    "name": "get_logs",
    "description": "Get build, deploy, or HTTP logs for a service's deployment. Set log_type to 'build', 'deploy', or 'http'. Supports filtering by level/search for build/deploy logs, and method/status/path/request_id for HTTP logs. If no deployment_id is provided, uses the latest deployment.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deployment_id": {
          "default": null,
          "description": "Specific deployment ID to get logs for. If omitted, uses the latest deployment.",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "level": {
          "default": null,
          "description": "Filter by log level: \"error\", \"warn\", or \"info\" (for build/deploy logs).",
          "nullable": true,
          "type": "string"
        },
        "lines": {
          "default": null,
          "description": "Number of log lines to return (default: 100).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "log_type": {
          "anyOf": [
            {
              "$ref": "#/$defs/LogType"
            },
            {
              "const": null,
              "nullable": true
            }
          ],
          "description": "Type of logs: \"build\", \"deploy\", or \"http\" (default: \"deploy\")."
        },
        "method": {
          "default": null,
          "description": "Filter HTTP logs by request method: GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS (requires log_type: \"http\").",
          "nullable": true,
          "type": "string"
        },
        "path": {
          "default": null,
          "description": "Filter HTTP logs by request path, e.g. \"/api/users\" (requires log_type: \"http\").",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "request_id": {
          "default": null,
          "description": "Filter HTTP logs by request ID (requires log_type: \"http\").",
          "nullable": true,
          "type": "string"
        },
        "search": {
          "default": null,
          "description": "Search string to filter logs (for build/deploy logs).",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        },
        "since": {
          "default": null,
          "description": "Start time filter. Supports relative (\"30m\", \"2h\", \"1d\") or ISO 8601 format.",
          "nullable": true,
          "type": "string"
        },
        "status": {
          "default": null,
          "description": "Filter HTTP logs by status code. Accepts: exact (200), comparison (>=400), or range (500..599) (requires log_type: \"http\").",
          "nullable": true,
          "type": "string"
        },
        "until": {
          "default": null,
          "description": "End time filter. Supports relative (\"30m\", \"2h\", \"1d\") or ISO 8601 format.",
          "nullable": true,
          "type": "string"
        }
      },
      "$defs": {
        "LogType": {
          "enum": [
            "build",
            "deploy",
            "http"
          ],
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "GetLogsParams"
    }
  },
  {
    "name": "get_service_config",
    "description": "Get the current configuration of a service instance including source, build config, start command, and variable count.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "GetServiceConfigParams"
    }
  },
  {
    "name": "http_error_rate",
    "description": "Get the HTTP error rate (4xx + 5xx) as a percentage of total requests from recent HTTP logs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deployment_id": {
          "default": null,
          "description": "Specific deployment ID. If omitted, uses the latest deployment.",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "lines": {
          "default": null,
          "description": "Number of log entries to sample (default: 200).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "HttpObservabilityParams"
    }
  },
  {
    "name": "http_requests",
    "description": "Get HTTP request counts grouped by status code bucket (2xx/3xx/4xx/5xx) from recent HTTP logs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deployment_id": {
          "default": null,
          "description": "Specific deployment ID. If omitted, uses the latest deployment.",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "lines": {
          "default": null,
          "description": "Number of log entries to sample (default: 200).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "HttpObservabilityParams"
    }
  },
  {
    "name": "http_response_time",
    "description": "Get HTTP response time percentiles (p50/p90/p95/p99) in milliseconds from recent HTTP logs.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "deployment_id": {
          "default": null,
          "description": "Specific deployment ID. If omitted, uses the latest deployment.",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "lines": {
          "default": null,
          "description": "Number of log entries to sample (default: 200).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "HttpObservabilityParams"
    }
  },
  {
    "name": "link_environment",
    "description": "Switch the linked environment for the current project directory. If no environment_id or environment_name is provided, lists available environments. Preserves the existing service link.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID to link. If omitted along with environment_name, lists available environments.",
          "nullable": true,
          "type": "string"
        },
        "environment_name": {
          "default": null,
          "description": "The environment name to link. Alternative to environment_id.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "LinkEnvironmentParams"
    }
  },
  {
    "name": "link_service",
    "description": "Link a service to the current project directory for the CLI. If no service_id or service_name is provided, lists available services. Uses a fresh config to write the link.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID to link. If omitted along with service_name, lists available services.",
          "nullable": true,
          "type": "string"
        },
        "service_name": {
          "default": null,
          "description": "The service name to link. Alternative to service_id.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "LinkServiceParams"
    }
  },
  {
    "name": "list_deployments",
    "description": "List recent deployments for a service. Returns deployment IDs, status, timestamps, and commit hashes. If no IDs are provided, uses the currently linked project/service/environment.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "limit": {
          "default": null,
          "description": "Maximum number of deployments to return (default: 20).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "ListDeploymentsParams"
    }
  },
  {
    "name": "list_projects",
    "description": "List all projects in the user's Railway account, grouped by workspace. Returns project names and IDs.",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "list_services",
    "description": "List all services in a Railway project. If no project_id is provided, uses the currently linked project.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "project_id": {
          "default": null,
          "description": "The project ID to use. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "ProjectParams"
    }
  },
  {
    "name": "list_variables",
    "description": "List all environment variables for a service. Returns KEY=VALUE pairs. If no IDs are provided, uses the currently linked project/service/environment.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "ServiceParams"
    }
  },
  {
    "name": "remove_bucket",
    "description": "Remove an object storage bucket from a Railway environment. This is irreversible. Returns a preview first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "bucket_id": {
          "description": "The bucket ID to remove.",
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "bucket_id"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "RemoveBucketParams"
    }
  },
  {
    "name": "remove_service",
    "description": "Remove a service from a Railway project. This is irreversible. Returns a preview first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "RemoveServiceParams"
    }
  },
  {
    "name": "remove_volume",
    "description": "Remove a persistent volume by ID. This is irreversible. Returns a preview first.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "volume_id": {
          "description": "The volume ID to remove.",
          "type": "string"
        }
      },
      "required": [
        "volume_id"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "RemoveVolumeParams"
    }
  },
  {
    "name": "search_templates",
    "description": "Search for Railway templates by name or code. Returns the top 5 matching templates with their codes.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "description": "Search query to match against template names and codes.",
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "SearchTemplatesParams"
    }
  },
  {
    "name": "service_metrics",
    "description": "Get CPU and memory (or other) metrics for a service. Returns recent data points and average values for the specified time window.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "hours_back": {
          "default": null,
          "description": "Number of hours back to query (default: 1).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "measurements": {
          "default": null,
          "description": "Metrics to fetch: CPU_USAGE, MEMORY_USAGE_GB, DISK_USAGE_GB, NETWORK_RX_GB, NETWORK_TX_GB. Defaults to CPU_USAGE and MEMORY_USAGE_GB.",
          "items": {
            "type": "string"
          },
          "nullable": true,
          "type": "array"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "sample_rate_seconds": {
          "default": null,
          "description": "Sample rate in seconds (default: 60).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "ServiceMetricsParams"
    }
  },
  {
    "name": "set_variables",
    "description": "Set one or more environment variables on a service. Pass variables as a JSON object mapping names to values. Triggers a redeploy unless skip_deploys is true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        },
        "skip_deploys": {
          "default": null,
          "description": "If true, skip triggering redeploys after setting variables.",
          "nullable": true,
          "type": "boolean"
        },
        "variables": {
          "additionalProperties": {
            "type": "string"
          },
          "description": "Map of variable names to values to set.",
          "type": "object"
        }
      },
      "required": [
        "variables"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "SetVariablesParams"
    }
  },
  {
    "name": "update_service",
    "description": "Update service instance settings such as build command, start command, replicas, health check, sleep mode, root directory, cron schedule, Dockerfile path, restart policy, pre-deploy command, region, Railway config file, and watch patterns.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "build_command": {
          "default": null,
          "description": "Build command override.",
          "nullable": true,
          "type": "string"
        },
        "cron_schedule": {
          "default": null,
          "description": "Cron schedule expression (e.g. \"0 */5 * * *\").",
          "nullable": true,
          "type": "string"
        },
        "dockerfile_path": {
          "default": null,
          "description": "Path to the Dockerfile (e.g. \"Dockerfile.prod\").",
          "nullable": true,
          "type": "string"
        },
        "environment_id": {
          "default": null,
          "description": "The environment ID or name. If omitted, uses the currently linked environment.",
          "nullable": true,
          "type": "string"
        },
        "health_check_path": {
          "default": null,
          "description": "Health check path (e.g. \"/health\").",
          "nullable": true,
          "type": "string"
        },
        "healthcheck_timeout": {
          "default": null,
          "description": "Health check timeout in milliseconds.",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "num_replicas": {
          "default": null,
          "description": "Number of replicas.",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "pre_deploy_command": {
          "default": null,
          "description": "Commands to run before deploying (e.g. database migrations).",
          "items": {
            "type": "string"
          },
          "nullable": true,
          "type": "array"
        },
        "project_id": {
          "default": null,
          "description": "The project ID. If omitted, uses the currently linked project.",
          "nullable": true,
          "type": "string"
        },
        "railway_config_file": {
          "default": null,
          "description": "Path to the Railway config file.",
          "nullable": true,
          "type": "string"
        },
        "region": {
          "default": null,
          "description": "Region to deploy in (e.g. \"us-west1\").",
          "nullable": true,
          "type": "string"
        },
        "restart_policy_max_retries": {
          "default": null,
          "description": "Maximum number of restart retries (used with ON_FAILURE restart policy).",
          "format": "int64",
          "nullable": true,
          "type": "integer"
        },
        "restart_policy_type": {
          "default": null,
          "description": "Restart policy type: \"ALWAYS\", \"ON_FAILURE\", or \"NEVER\".",
          "nullable": true,
          "type": "string"
        },
        "root_directory": {
          "default": null,
          "description": "Root directory for the build.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID or name. If omitted, uses the currently linked service.",
          "nullable": true,
          "type": "string"
        },
        "sleep_application": {
          "default": null,
          "description": "Whether to sleep the service when inactive.",
          "nullable": true,
          "type": "boolean"
        },
        "start_command": {
          "default": null,
          "description": "Start command override.",
          "nullable": true,
          "type": "string"
        },
        "watch_patterns": {
          "default": null,
          "description": "File watch patterns that trigger deploys.",
          "items": {
            "type": "string"
          },
          "nullable": true,
          "type": "array"
        }
      },
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "UpdateServiceParams"
    }
  },
  {
    "name": "update_volume",
    "description": "Update a volume's name or mount path. Provide environment_id and service_id when updating mount_path.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "environment_id": {
          "default": null,
          "description": "The environment ID (required when updating mount_path).",
          "nullable": true,
          "type": "string"
        },
        "mount_path": {
          "default": null,
          "description": "New mount path.",
          "nullable": true,
          "type": "string"
        },
        "name": {
          "default": null,
          "description": "New name for the volume.",
          "nullable": true,
          "type": "string"
        },
        "service_id": {
          "default": null,
          "description": "The service ID (used when updating mount_path).",
          "nullable": true,
          "type": "string"
        },
        "volume_id": {
          "description": "The volume ID to update.",
          "type": "string"
        }
      },
      "required": [
        "volume_id"
      ],
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "title": "UpdateVolumeParams"
    }
  },
  {
    "name": "whoami",
    "description": "Check Railway authentication status and return the current user",
    "inputSchema": {
      "type": "object",
      "properties": {}
    }
  }
];

function resolveRailwayCliPath(): string {
  if (!existsSync(RAILWAY_CLI_PATH)) {
    throw new Error(
      `Railway CLI entrypoint not found at ${RAILWAY_CLI_PATH}. Install it with: npm install -g @railway/cli`,
    );
  }

  return RAILWAY_CLI_PATH;
}

function railwayToolNames(): string[] {
  return RAILWAY_TOOLS.map((tool) => tool.name);
}

function registerRailwayStatus(
  status: "connected" | "error" | "disconnected",
  error?: string,
): void {
  registerMcpServer({
    id: "railway-mcp",
    label: "Railway MCP",
    status,
    error,
    tools: railwayToolNames(),
  });
}

interface KillableChildProcess {
  pid?: number;
  exitCode: number | null;
  kill(signal?: string | number): boolean;
}

function formatMcpContent(
  result: any,
  toolName: string,
): Array<{ type: "text"; text: string }> {
  const contentItems: Array<{ type: "text"; text: string }> = [];

  for (const item of (result.content ?? []) as any[]) {
    if (item.type === "text") {
      contentItems.push({
        type: "text" as const,
        text: item.text as string,
      });
    } else if (item.type === "image") {
      const mimeType = (item.mimeType as string) ?? "image/png";
      const data = item.data as string;
      contentItems.push({
        type: "text" as const,
        text: `[railway-mcp image]\ndata:${mimeType};base64,${data}`,
      });
    } else {
      contentItems.push({
        type: "text" as const,
        text: JSON.stringify(item),
      });
    }
  }

  if (contentItems.length === 0) {
    contentItems.push({
      type: "text" as const,
      text: `[railway-mcp] Tool "${toolName}" completed.`,
    });
  }

  return contentItems;
}

// ─── Bridge Initialization ────────────────────────────────────────────────────

async function closeTransportAndKillChild(
  transport: StdioClientTransport,
  label: string,
): Promise<void> {
  const child = (transport as unknown as { _process?: KillableChildProcess })._process;

  await transport.close().catch((err: any) => {
    console.warn(
      `[railway-mcp] Error during MCP transport close (${label}):`,
      err?.message ?? String(err),
    );
  });

  if (child && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
      console.warn(
        `[railway-mcp] Forced Railway MCP child process ${child.pid ?? "unknown"} to exit (${label}).`,
      );
    } catch (err: any) {
      console.warn(
        `[railway-mcp] Error killing Railway MCP child process (${label}):`,
        err?.message ?? String(err),
      );
    }
  }
}

async function startMcpBridge(_pi: ExtensionAPI): Promise<void> {
  if (mcpClient) return;

  const resolvedCliPath = resolveRailwayCliPath();

  // Resolve the token area and merge it over the full parent environment. We pass
  // env explicitly (rather than letting the SDK use its minimal default env) so
  // PATH/SystemRoot etc. survive on Windows AND the Railway token is present.
  const { env: tokenEnv, source: tokenSource } = loadRailwayTokenEnv();
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") childEnv[k] = v;
  }
  Object.assign(childEnv, tokenEnv);

  console.log(`[railway-mcp] Auth source: ${tokenSource}.`);

  // Spawn Node directly with the CLI JS entrypoint instead of the npm .cmd shim.
  // This bypasses cmd.exe/conhost.exe on Windows and prevents terminal flashes.
  const transport = new StdioClientTransport({
    command: "node",
    args: [resolvedCliPath, "mcp"],
    stderr: "pipe",
    env: childEnv,
  });

  const client = new Client({ name: "pi-railway-bridge", version: "1.0.0" });
  mcpTransport = transport;

  try {
    await client.connect(transport);
  } catch (err) {
    await closeTransportAndKillChild(transport, "startup failure");
    if (mcpTransport === transport) mcpTransport = null;
    throw err;
  }

  mcpClient = client;

  registerRailwayStatus("connected");
  console.log(
    `[railway-mcp] Connected Railway MCP bridge with ${RAILWAY_TOOLS.length} registered tools.`,
  );
}

async function ensureConnected(pi: ExtensionAPI): Promise<void> {
  if (mcpClient) return;

  if (!mcpConnectPromise) {
    mcpConnectPromise = startMcpBridge(pi)
      .catch((err: any) => {
        const message = err?.message ?? String(err);
        console.warn(
          "[railway-mcp] Failed to start MCP bridge:",
          message,
          "\nEnsure Railway CLI is installed and authenticated:",
          "\n  npm install -g @railway/cli",
          "\n  railway login",
        );
        registerRailwayStatus("error", message);
        mcpClient = null;
        mcpTransport = null;
        throw err;
      })
      .finally(() => {
        mcpConnectPromise = null;
      });
  }

  await mcpConnectPromise;
}

async function stopMcpBridge(): Promise<void> {
  const client = mcpClient;
  const transport = mcpTransport;

  mcpClient = null;
  mcpTransport = null;
  mcpConnectPromise = null;

  if (client) {
    await client.close().catch((err: any) => {
      console.warn(
        "[railway-mcp] Error during MCP client close:",
        err?.message ?? String(err),
      );
    });
  }

  if (transport) {
    await closeTransportAndKillChild(transport, "session shutdown");
  }

  unregisterMcpServer("railway-mcp");
}

function registerRailwayTools(pi: ExtensionAPI): void {
  if (toolsRegistered) return;
  toolsRegistered = true;

  for (const tool of RAILWAY_TOOLS) {
    const toolName = tool.name;

    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),

      execute: async (
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
        _onUpdate: any,
        _ctx: any,
      ) => {
        try {
          await ensureConnected(pi);

          if (!mcpClient) {
            throw new Error("MCP client is not connected.");
          }

          const result = await mcpClient.callTool({
            name: toolName,
            arguments: params as Record<string, unknown>,
          });

          return { content: formatMcpContent(result, toolName) };
        } catch (err: unknown) {
          return {
            content: [
              {
                type: "text" as const,
                text: `[railway-mcp] Tool "${toolName}" failed: ${(err as any)?.message ?? String(err)}`,
              },
            ],
          };
        }
      },
    });
  }

  registerRailwayStatus("disconnected");
  console.log(`[railway-mcp] Registered ${RAILWAY_TOOLS.length} Railway tools lazily.`);
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

export default function railwayMcpExtension(pi: ExtensionAPI) {
  // ─── Session Start: register tool proxies only; spawn lazily on first use ──

  pi.on("session_start", async (_event: any, _ctx: any) => {
    registerRailwayTools(pi);
  });

  // ─── Session Shutdown: close MCP connection and kill the spawned child ─────

  pi.on("session_shutdown", async (_event?: any) => {
    await stopMcpBridge();
  });
}
