# Security Model

piNen is a **sanitized** Pi coding-agent harness designed to be safely published
and distributed. This document describes the security model and the measures
taken to prevent secret leakage, protect user data, and ensure safe operation.

## Design Principles

1. **Zero secrets in repository** — All configuration files containing API keys,
   tokens, or credentials are templates (`.example.json`). Real configs are
   gitignored and never committed.

2. **Private-first publishing** — The `safe-github-publish` shape creates
   repositories as **private** by default, requiring explicit human approval
   to make public.

3. **No runtime state committed** — Session data, orchestration runs, NenFlow
   run artifacts, handoffs, diagnostics, and cache files are all gitignored.

4. **No binaries committed** — The Engram binary and other executables are
   downloaded by the installer, not stored in the repository.

5. **No personal data** — The repository is sanitized of publisher-specific
   paths, emails, project memory, and machine-specific configuration.

## What Is Gitignored

| Category | Examples |
|----------|----------|
| **Auth/Secrets** | `auth.json`, `mcp.json`, `gmail-config.json`, `.env` files |
| **Sessions** | `agent/sessions/`, `agent/handoffs/` |
| **Runs** | `agent/nenflow-v3/runs/`, `agent/orchestration/runs/` |
| **State** | `scheduler.json`, `trust.json`, `verbosity-state.json` |
| **Diagnostics** | `agent/diagnostics/`, trace files, crash logs |
| **Memory** | `graphify-brain/` project graphs and wiki pages |
| **Binaries** | `*.exe`, `*.dll`, `*.so`, `*.dylib` |
| **Dependencies** | `node_modules/` |
| **Media** | `*.jpg`, `*.png`, `*.pdf`, `*.mp4` (except intentional skill resources) |

## Secret Scanning

piNen includes `.gitleaks.toml` for pre-commit secret detection. The
`safe-github-publish` shape runs `gitleaks detect` before any push.

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
2. Review the sanitization contract in the `safe-github-publish` shape
3. Report via GitHub Issues (include minimal reproduction steps)

Do NOT include API keys, tokens, or secrets in bug reports.

## Security Checklist for Publishing

When publishing a repository using piNen, the `safe-github-publish` shape ensures:

- [ ] Allowlist-only staging (no broad recursive copy)
- [ ] Source `.git/` history is never copied
- [ ] All auth/config files are templates, not real configs
- [ ] No personal paths, emails, or machine-specific paths
- [ ] No runtime state, sessions, runs, diagnostics, or caches
- [ ] No binaries, media, or archives (except intentional skill resources)
- [ ] `gitleaks detect` passes with zero findings
- [ ] Path denylist scan passes
- [ ] Repository is created private-first
- [ ] Independent remote verification PASSes before any public visibility change
