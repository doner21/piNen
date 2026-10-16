import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

// Check all ancestors, not just the leaf: a junction is not an owned copy.
function canonicalExisting(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED');
  const resolved = path.resolve(value);
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('LINKED_PATH_REFUSED');
    if (path.dirname(current) === current) break;
  }
  if (path.relative(fs.realpathSync.native(resolved), resolved) !== '') throw new Error('NONCANONICAL_PATH_REFUSED');
  return resolved;
}

export function validateConfig(configPath) {
  const cfgPath = canonicalExisting(configPath);
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (cfg.provider !== 'openai-codex' || cfg.model !== 'gpt-6-astra') throw new Error('EXACT_ASTRA_HOST_REQUIRED');
  for (const key of ['nodeExe', 'cwd', 'frozenRoot', 'extension', 'sdkEntry', 'piCli', 'runDir', 'systemFile', 'commandFile', 'supervisorFile']) {
    cfg[key] = canonicalExisting(cfg[key]);
  }
  if (!/node\.exe$/i.test(cfg.nodeExe) || path.relative(cfg.nodeExe, process.execPath) !== '') throw new Error('USE_CONFIGURED_ABSOLUTE_NODE_EXE');
  if (!Array.isArray(cfg.evidenceRoots)) throw new Error('DECLARE_READONLY_EVIDENCE_ROOTS');
  cfg.evidenceRoots = cfg.evidenceRoots.map(canonicalExisting);
  const separated = [cfg.cwd, cfg.frozenRoot, cfg.runDir, ...cfg.evidenceRoots];
  for (let i = 0; i < separated.length; i++) {
    for (const other of separated.slice(i + 1)) {
      if (inside(separated[i], other) || inside(other, separated[i])) throw new Error('ROOTS_MUST_BE_SEPARATE');
    }
  }
  for (const key of ['extension', 'sdkEntry', 'piCli']) {
    if (!inside(cfg.frozenRoot, cfg[key]) || !fs.statSync(cfg[key]).isFile()) throw new Error('FROZEN_HOST_INPUT_REQUIRED');
  }
  for (const file of [cfgPath, cfg.systemFile, cfg.commandFile, cfg.supervisorFile]) {
    if (!inside(cfg.runDir, file) || !fs.statSync(file).isFile()) throw new Error('PREPARED_RUN_INPUT_REQUIRED');
  }
  for (const name of ['sessions', 'runtime', 'runtime/agent', 'runtime/runs', 'runtime/next-runs', 'runtime/user-workflows', 'runtime/project-workflows', 'runtime/tmp', 'runtime/cache']) {
    canonicalExisting(path.join(cfg.runDir, name));
  }
  const command = fs.readFileSync(cfg.commandFile, 'utf8').trim();
  const separator = command.indexOf(' -- ');
  if (!command.startsWith('/orchestrate run ') || separator < 0) throw new Error('LITERAL_FRESH_RUN_WITH_TASK_SEPARATOR_REQUIRED');
  const controls = command.slice(0, separator);
  if (/--\S*fallback|--resume\b|--discovery-only\b/.test(controls)) throw new Error('LITERAL_FRESH_RUN_WITHOUT_FALLBACK_REQUIRED');
  // Accept the example's explicit spelling only; aliases/inline overrides must
  // not undo the exact role/count controls. Task prose is not launch controls.
  if (/--[\w-]+=|--[\w-]*[A-Z]|--(?:concurrency|executor-count|planner-concurrency|verifier-concurrency|off|visible-main|action)\b/.test(controls)) throw new Error('USE_EXPLICIT_EXAMPLE_CONTROLS');
  const required = {
    supervision: 'visible-main', 'adaptive-supervision': 'off',
    'planner-provider': 'openai-codex', 'planner-model': 'gpt-6-astra',
    'executor-provider': 'openai-codex', 'executor-model': 'gpt-6.1-sol',
    'verifier-provider': 'openai-codex', 'verifier-model': 'gpt-6.1-sol',
    'planner-count': '1', 'executor-concurrency': '1', 'verifier-count': '1', 'max-retries': '0',
  };
  // The coordinator supplies a literal command, not arbitrary launch argv.
  for (const [flag, value] of Object.entries(required)) {
    const matches = [...controls.matchAll(new RegExp(`--${flag}\\s+("[^"]*"|'[^']*'|\\S+)`, 'g'))];
    if (matches.length !== 1 || matches[0][1].replace(/^["']|["']$/g, '') !== value) throw new Error(`EXACT_COMMAND_CONTROL_REQUIRED: ${flag}`);
  }
  const paradigms = [...controls.matchAll(/--paradigm\s+("[^"]*"|'[^']*'|\S+)/g)];
  if (paradigms.length !== 1 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(paradigms[0][1].replace(/^["']|["']$/g, ''))) throw new Error('ONE_PARADIGM_REQUIRED');
  const automatic = [...controls.matchAll(/--automatic-plan-approval\s+(\S+)/g)];
  if (automatic.length > 1 || (automatic.length && !['on', 'off'].includes(automatic[0][1]))) throw new Error('AUTOMATIC_PLAN_APPROVAL_ON_OR_OFF_REQUIRED');
  if ((cfg.automaticPlanApproval === true) !== (automatic[0]?.[1] === 'on')) throw new Error('DECLARE_AUTOMATIC_PLAN_APPROVAL_SETTING');
  cfg.automaticPlanApproval = cfg.automaticPlanApproval === true;
  if (!/--no-force-kill\b/.test(controls)) throw new Error('NO_FORCE_KILL_GUARD_REQUIRED');
  return { cfgPath, cfg };
}

export function childEnvironment(cfg) {
  const runtime = path.join(cfg.runDir, 'runtime');
  const env = { ...process.env,
    PI_CODING_AGENT_DIR: path.join(runtime, 'agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(cfg.runDir, 'sessions'),
    PI_ORCHESTRATOR_RUNS_ROOT: path.join(runtime, 'runs'),
    PI_ORCHESTRATOR_NEXT_RUNS_ROOT: path.join(runtime, 'next-runs'),
    PI_ORCHESTRATOR_USER_WORKFLOWS_ROOT: path.join(runtime, 'user-workflows'),
    PI_ORCHESTRATOR_PROJECT_WORKFLOWS_ROOT: path.join(cfg.cwd, '.pi', 'orchestrator-workflows'),
    PI_CLI_PATH: cfg.piCli, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    TEMP: path.join(runtime, 'tmp'), TMP: path.join(runtime, 'tmp'), TMPDIR: path.join(runtime, 'tmp'),
    XDG_CACHE_HOME: path.join(runtime, 'cache'), JITI_FS_CACHE: '0',
  };
  delete env.PI_SESSION_FILE;
  delete env.PI_SESSION_ID;
  delete env.PI_CLI;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

function launch(configPath) {
  const { cfgPath, cfg } = validateConfig(configPath);
  const host = canonicalExisting(path.join(path.dirname(fileURLToPath(import.meta.url)), 'orchestrate-host.mjs'));
  if (!inside(cfg.runDir, host)) throw new Error('COPY_BOTH_SCRIPTS_INTO_OWNED_RUN_BEFORE_LAUNCH');
  const put = (name, value) => fs.writeFileSync(path.join(cfg.runDir, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const stdout = fs.openSync(path.join(cfg.runDir, 'host.stdout.log'), 'wx');
  const stderr = fs.openSync(path.join(cfg.runDir, 'host.stderr.log'), 'wx');
  const argv = [host, cfgPath];
  const child = spawn(cfg.nodeExe, argv, { cwd: cfg.cwd, env: childEnvironment(cfg), detached: true, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  child.once('spawn', () => {
    const record = { launchedAt: new Date().toISOString(), pid: child.pid, nodeExe: cfg.nodeExe, cwd: cfg.cwd, argv, configPath: cfgPath, automaticPlanApproval: cfg.automaticPlanApproval };
    put('dispatch.json', record);
    console.log(JSON.stringify(record));
    child.unref();
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  });
  child.once('error', error => {
    put('launch-failed.json', { at: new Date().toISOString(), error: error.message });
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    console.error(error.message);
  });
}

// Refresh the exported projection without starting a second extension host.
// Loading a new host can pause nonterminal supervised runs at startup.
export async function readCurrentProjection(configPath, runId) {
  const { cfg } = validateConfig(configPath);
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId) || runId.length > 128 || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(runId)) throw new Error('VALID_RUN_ID_REQUIRED');
  const runDir = canonicalExisting(path.join(cfg.runDir, 'runtime', 'runs', runId));
  Object.assign(process.env, childEnvironment(cfg));
  const require = createRequire(cfg.sdkEntry);
  const createJiti = require('jiti');
  const jiti = createJiti(cfg.extension, { interopDefault: true, moduleCache: false, fsCache: false });
  const { refreshLiveStatus } = await jiti.import(path.join(path.dirname(cfg.extension), 'live-status.ts'));
  return refreshLiveStatus(runDir);
}

// These are bundled script modes, not additional /orchestrate commands.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--status') console.log(JSON.stringify(await readCurrentProjection(process.argv[3], process.argv[4])));
  else launch(process.argv[2]);
}
