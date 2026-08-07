# Security Model

piNen is a **sanitized** Pi coding-agent harness designed to be safely published
and distributed. This document describes the security model and the measures
taken to prevent secret leakage, protect user data, and ensure safe operation.

## Design Principles

1. **Zero secrets in repository** — All configuration files containing API keys,
   tokens, or credentials are templates (`.example.json`). Real configs are
   gitignored and never committed.

2. **Explicit publishing** — Git publication is an explicit user action. This
   repository carries the sanitization checklist and does not publish credentials
   or mutate remotes implicitly.

3. **No runtime state committed** — Session data, orchestration runs,
   handoffs, diagnostics, and cache files are all gitignored.

4. **No runtime executables committed** — The Engram executable and other native
   runtime binaries are downloaded or built during installation, not stored in the repository.
   Licensed font assets used by visual-design skills are static resources, not executable code.

5. **No personal/project data** — The repository is sanitized of publisher-specific
   paths, emails, project agents/shapes, project memory, and machine-specific configuration.

6. **Capability/data separation** — Engram and Graphify source, setup, tools, and
   documentation are included; observations, databases, saved graphs, project wikis,
   prompts, sessions, and health traces are excluded.

## What Is Gitignored

| Category | Examples |
|----------|----------|
| **Auth/Secrets** | `auth.json`, `mcp.json`, `gmail-config.json`, `.env` files |
| **Sessions** | `agent/sessions/`, `agent/handoffs/` |
| **Runs** | `agent/orchestration/runs/`, `agent/orchestrate-runs/`, `pi-orchestrator-extension/runs-state/` |
| **State** | `scheduler.json`, `trust.json`, `verbosity-state.json` |
| **Diagnostics** | `agent/diagnostics/`, trace files, crash logs |
| **Memory** | Engram databases/observations; `graphify-brain/` project graphs and wiki pages |
| **Binaries** | `*.exe`, `*.dll`, `*.so`, `*.dylib` |
| **Dependencies** | `node_modules/` |
| **Media** | `*.jpg`, `*.png`, `*.pdf`, `*.mp4` (except intentional skill resources) |

## Secret Scanning

piNen includes `.gitleaks.toml` for pre-commit secret detection. The
publishing workflow runs `gitleaks detect` before any push.

### Running gitleaks locally

```bash
# Install gitleaks
# https://github.com/gitleaks/gitleaks#installing

# Scan staged files
gitleaks detect --source . --redact --verbose

# Scan without git history
gitleaks detect --source . --no-git --redact --verbose
```

Template files (`.example.json`) and documentation are allowlisted in
`.gitleaks.toml` since they contain only placeholder values like
`<YOUR_API_KEY>`.

## Installer Safety

The one-click Windows installer (`install.ps1`):

- **No admin by default** — installs to user home directory only
- **No `Invoke-Expression`** — downloads to a temp file and executes the file
- **No secret collection** — template configs contain only placeholders
- **Idempotent** — safe to rerun; requires `-Force` to overwrite existing install
- **Timestamped backups** — `-Force` creates a backup before overwriting
- **Auditable** — readable PowerShell script, no obfuscation

## Core Patch Safety

The Pi core patch (`agent/core-patch/`):

- **Opt-in** — requires explicit `-ApplyCorePatch` flag
- **Idempotent** — safe to apply multiple times
- **Creates backups** — timestamped backups in `agent/core-patch/backups/`
- **Never triggers live reload** — requires a full Pi restart
- **Backups are gitignored** — not committed to the repository

## Environment Variable Handling

| Variable | Where Set | Safety |
|----------|-----------|--------|
| `ENGRAM_BIN` | User env var (opt-in) or per-session | Points to binary path only |
| `TAVILY_API_KEY` | `mcp.json` env block or shell env | Contains API key — never committed |
| `PINEN_PERSIST_ENV` | Shell env | Controls whether setup.sh modifies profiles |

## Profile/Script Mutation Policy

- **Windows:** `setup.ps1` only persists `ENGRAM_BIN` with `-PersistEnv` flag
- **Unix:** `setup.sh` only appends to `.bashrc`/`.zshrc` with `--persist-env`
  flag or `PINEN_PERSIST_ENV=1`
- **No unconditional auto-mutation** of shell profiles, PATH, or system config
- Users are always informed before any profile modification

## Reporting Security Issues

If you discover a security issue in piNen, please:

1. Check if the issue is in your local configuration (not the published harness)
2. Review the sanitization checklist in this document
3. Report via GitHub Issues (include minimal reproduction steps)

Do NOT include API keys, tokens, or secrets in bug reports.

## Security Checklist for Publishing

When publishing a repository using piNen, verify that:

- [ ] Allowlist-only staging (no broad recursive copy)
- [ ] Source `.git/` history is never copied
- [ ] All auth/config files are templates, not real configs
- [ ] No personal paths, emails, machine-specific paths, or project-specific agents/shapes
- [ ] No runtime state, sessions, runs, diagnostics, or caches
- [ ] No binaries, media, or archives (except intentional skill resources)
- [ ] `gitleaks detect` passes with zero findings
- [ ] Path denylist scan passes
- [ ] Publishing is explicitly authorized
- [ ] Independent remote verification passes before any visibility change
