#!/usr/bin/env node
'use strict';
/** Read-only source/checker replay; dependencies always belong to this workspace. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const WRAPPER_INHERITANCE = Object.fromEntries(['PI_ORCHESTRATOR_TEST_RUNS_OWNER', 'PI_ORCHESTRATOR_RUNS_ROOT', 'PI_ORCHESTRATOR_NEXT_RUNS_ROOT'].map(key => [key, process.env[key]]));
const EVIDENCE = fs.realpathSync('C:/Users/you/AppData/Local/Temp/orch-r7-isolation-inputs-mPt6AW');
const SOURCE = fs.realpathSync(process.env.ROUND7_SMALL_SOURCE_ROOT || ROOT);
assert.ok(SOURCE === ROOT || SOURCE === fs.realpathSync(path.join(EVIDENCE, 'original-pre-small')), 'source seam selects only candidate or declared read-only original-pre-small');
const within = (root, file) => { const r = path.relative(root, file); return !r || (!r.startsWith('..') && !path.isAbsolute(r)); };
function scratch(prefix) {
  const parent = fs.realpathSync(process.env.ROUND7_SMALL_SCRATCH_PARENT || os.tmpdir());
  assert.ok(parent && path.isAbsolute(parent) && parent === path.resolve(parent), 'canonical external Temp parent');
  assert.ok(within(fs.realpathSync(os.tmpdir()), parent), 'scratch must be under external Temp');
  assert.ok(!within(ROOT, parent) && !within(fs.realpathSync(EVIDENCE), parent), 'workspace and evidence are READONLY scratch exclusions');
  const directory = path.join(parent, prefix + require('node:crypto').randomBytes(8).toString('hex'));
  assert.ok(path.isAbsolute(directory) && !fs.existsSync(directory) && !within(ROOT, directory) && !within(fs.realpathSync(EVIDENCE), directory), 'newly owned external path before write');
  fs.mkdirSync(directory);
  assert.equal(fs.realpathSync(directory), directory, 'physical scratch, no link aliases');
  return directory;
}
function isolated(prefix) {
  const directory = scratch(prefix);
  for (const [key, name] of Object.entries({ PI_ORCHESTRATOR_RUNS_ROOT: 'legacy', PI_ORCHESTRATOR_NEXT_RUNS_ROOT: 'next', PI_CODING_AGENT_DIR: 'agent' })) {
    process.env[key] = path.join(directory, name);
    fs.mkdirSync(process.env[key]);
  }
  process.env.PI_ORCHESTRATOR_TEST_RUNS_OWNER = directory;
  return directory;
}
function declarations(relative, names) {
  const ts = require(path.join(ROOT, 'node_modules/typescript'));
  const file = path.join(SOURCE, relative), text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(n => n.name?.text === name);
    assert.ok(node, 'existing production declaration: ' + name);
    return node.getText(ast).replace(/^export\s+/, '');
  }).join('\n');
}
function api(relative, names, dependencies = {}) {
  const ts = require(path.join(ROOT, 'node_modules/typescript'));
  const js = ts.transpileModule(declarations(relative, names) + `\nglobalThis.api = {${names.join(',')}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const context = vm.createContext({ path, process, console, Buffer, TextDecoder, ...dependencies });
  vm.runInContext(js, context);
  return context.api;
}

/** The only root-free capabilities in the sanctioned package are prompt builders
 * and launch sizing (not spawn/persistence). Certify module identity AND the whole
 * reviewed implementation/dependency surface, not the spelling of a binding.
 * An implementation change invalidates this narrow certificate, failing closed.
 * "Stateless" here means no durable orchestrator run state; launch sizing uses
 * the script's disposable SDK configuration, but cannot create an orchestration.
 */
function statelessCapability(moduleFile, bindings) {
  const surfaces = {
    'src/index.ts': ['buildExecutorPrompt', 'buildPlanningPrompt', 'buildVerificationPrompt', 'buildVisibleMainVerificationPrompt'],
    'src/substrate.ts': ['resolveCompleteWorkerLaunchPrompt'],
    'src/executor-recovery/budget-estimator.ts': ['assertWorkerPromptFitsCapacity'],
  };
  const relative = path.relative(ROOT, moduleFile).split(path.sep).join('/');
  if (!bindings.length || !surfaces[relative] || !bindings.every(name => surfaces[relative].includes(name))) return false;
  // These complete modules cover prompt formatting, the continuation string,
  // timing projection, SDK assembly and estimation. Unknown exports, namespace,
  // rest bindings, different source identities and any changed implementation
  // cannot borrow the reviewed capability certificate.
  for (const dependency of [...Object.keys(surfaces), 'src/executor-recovery/contract-types.ts', 'src/command-times.ts']) {
    const candidate = path.join(ROOT, dependency), reviewed = path.join(ROOT, 'tests/fixtures/round8-source-certificate', dependency);
    if (!fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()
      || fs.realpathSync(candidate) !== candidate || !fs.readFileSync(candidate).equals(fs.readFileSync(reviewed))) return false;
  }
  return true;
}

/** Bounded full-source loader inventory. Only literals, constant aliases and
 * path.join/resolve are resolved; uncertainty is a rejection, never roots.
 * This is not a general JavaScript evaluator or a filename exemption.
 */
function importInventory(file, source, parent) {
  const ts = require(path.join(ROOT, 'node_modules/typescript'));
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(ast.parseDiagnostics.length, 0, 'classified import source parses');
  const constants = new Map(), loaders = new Set(['require']), factories = new Set();
  function walk(node, visitor) { visitor(node); ts.forEachChild(node, child => walk(child, visitor)); }
  walk(ast, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && node.parent.flags & ts.NodeFlags.Const) {
      if (constants.has(node.name.text)) {
        if (constants.get(node.name.text)?.getText(ast) !== node.initializer.getText(ast)) constants.set(node.name.text, undefined); // differing scopes fail closed
      } else constants.set(node.name.text, node.initializer);
    }
  });
  walk(ast, node => {
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) constants.set(node.left.text, undefined);
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && ts.isIdentifier(node.operand)) constants.set(node.operand.text, undefined);
  });
  function value(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) {
      if (node.text === '__dirname') return path.dirname(file);
      if (node.text === '__filename') return file;
      if (seen.has(node.text)) return undefined;
      return value(constants.get(node.text), new Set([...seen, node.text]));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = value(node.left, seen), right = value(node.right, seen);
      return typeof left === 'string' && typeof right === 'string' ? left + right : undefined;
    }
    if (ts.isCallExpression(node) && /^(?:path\.(?:join|resolve))$/.test(node.expression.getText(ast))) {
      const pathImport = constants.get('path');
      if (!pathImport || !ts.isCallExpression(pathImport) || pathImport.expression.getText(ast) !== 'require' || pathImport.arguments[0]?.text !== 'node:path') return undefined;
      const args = node.arguments.map(arg => value(arg, seen));
      if (args.every(arg => typeof arg === 'string')) return path[node.expression.name.text](...args);
    }
    return undefined;
  }
  // Alias discovery is bounded by the number of declarations, including aliases
  // of require and the jiti factory/loader. Every use is subsequently inspected.
  for (let pass = 0; pass <= constants.size; pass++) for (const [name, init] of constants) {
    if (init && ts.isIdentifier(init) && loaders.has(init.text)) loaders.add(name);
    if (init && ts.isIdentifier(init) && factories.has(init.text)) factories.add(name);
    if (init && ts.isCallExpression(init)) {
      const callee = init.expression.getText(ast), id = value(init.arguments[0]);
      if (loaders.has(callee) && typeof id === 'string' && /[\\/]jiti[\\/]lib[\\/]jiti\.cjs$/.test(id)) factories.add(name);
      if (factories.has(callee)) loaders.add(name);
      if (ts.isCallExpression(init.expression) && loaders.has(init.expression.expression.getText(ast))) {
        const factoryId = value(init.expression.arguments[0]);
        if (typeof factoryId === 'string' && /[\\/]jiti[\\/]lib[\\/]jiti\.cjs$/.test(factoryId)) loaders.add(name);
      }
    }
  }
  const imports = [];
  walk(ast, node => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) assert.fail('owned roots established: unclassified ES import');
    if (ts.isIdentifier(node) && (loaders.has(node.text) || factories.has(node.text))) {
      const parent = node.parent;
      assert.ok(ts.isVariableDeclaration(parent) && (parent.name === node && node.text !== 'require'
        || parent.initializer === node && ts.isIdentifier(parent.name) && (loaders.has(parent.name.text) || factories.has(parent.name.text)))
        || ts.isCallExpression(parent) && parent.expression === node,
      'owned roots established: unclassified loader escape');
    }
    if (ts.isPropertyAccessExpression(node) && node.getText(ast) === 'process.env') {
      assert.ok(ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent) || ts.isSpreadAssignment(node.parent), 'owned roots established: unclassified environment alias/mutation');
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'process') assert.fail('owned roots established: unclassified computed process surface');
    if (ts.isIdentifier(node) && ['globalThis', 'global', 'module'].includes(node.text)) assert.fail('owned roots established: unclassified ambient loader surface');
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Function') assert.fail('owned roots established: unclassified generated loader');
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression.getText(ast);
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword || /(?:\bcreateRequire\b|\._load\b|\._compile\b)/.test(callee) || /^(?:eval|Function|module\.require|require\.(?:resolve|bind))$/.test(callee)) assert.fail('owned roots established: unclassified dynamic loader');
    if (!loaders.has(callee)) return;
    const id = value(node.arguments[0]);
    assert.ok(typeof id === 'string' && id, 'owned roots established: unresolved/computed import: ' + file + ': ' + node.getText(ast));
    if (id.startsWith('node:')) {
      assert.ok(['node:assert/strict', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:module', 'node:child_process', 'node:stream', 'node:events', 'node:perf_hooks', 'node:net'].includes(id), 'owned roots established: unclassified builtin capability: ' + id);
      if (id === 'node:module') {
        const declaration = node.parent;
        assert.ok(ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name), 'owned roots established: unclassified module loader binding');
        const name = declaration.name.text;
        walk(ast, reference => {
          if (!ts.isIdentifier(reference) || reference.text !== name || reference === declaration.name) return;
          assert.ok(ts.isPropertyAccessExpression(reference.parent) && reference.parent.expression === reference && reference.parent.name.text === '_initPaths', 'owned roots established: unclassified module loader capability');
        });
      }
      imports.push({ node, id, kind: 'builtin' }); return;
    }
    const moduleFile = path.isAbsolute(id) ? path.normalize(id) : path.resolve(path.dirname(file), id);
    assert.ok(within(ROOT, moduleFile) || within(EVIDENCE, moduleFile) || within(parent, moduleFile), 'owned roots established: import is outside owned/read-only inputs');
    assert.ok(fs.existsSync(moduleFile) && fs.lstatSync(moduleFile).isFile() && !fs.lstatSync(moduleFile).isSymbolicLink()
      && fs.realpathSync(moduleFile) === moduleFile, 'owned roots established: unresolved/nonregular module import');
    if (/[\\/]jiti[\\/]lib[\\/]jiti\.cjs$/.test(moduleFile)) {
      assert.ok(within(path.join(ROOT, 'node_modules'), moduleFile), 'workspace-owned loader dependency');
      const parentNode = node.parent;
      const declaration = ts.isVariableDeclaration(parentNode) ? parentNode : ts.isCallExpression(parentNode) && parentNode.expression === node ? parentNode.parent : undefined;
      assert.ok(declaration && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
        && (factories.has(declaration.name.text) || loaders.has(declaration.name.text)), 'owned roots established: unclassified/mutable loader factory');
      imports.push({ node, id, moduleFile, kind: 'factory' }); return;
    }
    const declaration = node.parent;
    const bindings = ts.isVariableDeclaration(declaration) && ts.isObjectBindingPattern(declaration.name)
      ? declaration.name.elements.map(element => element.dotDotDotToken ? '<rest>' : (element.propertyName || element.name).getText(ast)) : [];
    imports.push({ node, id, moduleFile, bindings, kind: statelessCapability(moduleFile, bindings) ? 'stateless' : 'stateful' });
  });
  const eager = imports.filter(entry => entry.kind === 'stateful' && !definitionSurface(entry.moduleFile, ts));
  const firstEager = eager.length ? Math.min(...eager.map(entry => entry.node.getStart(ast))) : Infinity;
  // Stopping initialization must not hide a subsequent root replacement. This
  // deliberately conservative ordering check rejects later/dynamic env writes,
  // including those in deferred bodies, rather than claiming full flow analysis.
  walk(ast, node => {
    if (node.getStart(ast) <= firstEager) return;
    const mutation = ts.isDeleteExpression(node) ? node.expression : ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left : undefined;
    if (!mutation) return;
    const target = mutation.getText(ast);
    if (/^process\.env(?:\[|$)/.test(target) || /^process\.env\.PI_ORCHESTRATOR_(?:NEXT_)?RUNS_ROOT$/.test(target)) assert.fail('owned roots established: late or unclassified root mutation');
  });
  return { ts, ast, imports };
}

/** Recognize definition-only CJS by its complete top-level effects and exports.
 * Imported constructors/functions are NOT stateless: their stubs require actual
 * roots before invocation. Class static effects/getters/computed exports reject.
 */
function definitionSurface(file, ts) {
  if (!fs.existsSync(file) || path.extname(file) !== '.cjs') return undefined;
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const definitions = new Set(), values = new Set(), exports = {};
  function inert(node) {
    if (!node) return true;
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true;
    if (ts.isIdentifier(node)) return values.has(node.text);
    if (ts.isPropertyAccessExpression(node)) return inert(node.expression);
    if (ts.isBinaryExpression(node)) return inert(node.left) && inert(node.right);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(inert);
    if (ts.isObjectLiteralExpression(node)) return node.properties.every(p => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && inert(p.initializer));
    if (ts.isCallExpression(node)) {
      if (node.expression.getText(tree) === 'require') return node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text.startsWith('node:');
      return node.expression.getText(tree) === 'Object.freeze' && node.arguments.length === 1 && inert(node.arguments[0]);
    }
    return false;
  }
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement)) { definitions.add(statement.name?.text); continue; }
    if (ts.isClassDeclaration(statement)) {
      if (statement.heritageClauses?.some(h => h.types.some(t => !ts.isIdentifier(t.expression) || !values.has(t.expression.text)))) return undefined;
      if (statement.members.some(m => ts.isClassStaticBlockDeclaration(m) || m.modifiers?.some(mod => mod.kind === ts.SyntaxKind.StaticKeyword) || m.name && ts.isComputedPropertyName(m.name))) return undefined;
      definitions.add(statement.name?.text); continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!inert(declaration.initializer)) return undefined;
        if (ts.isIdentifier(declaration.name)) values.add(declaration.name.text);
        else if (ts.isObjectBindingPattern(declaration.name)) for (const element of declaration.name.elements) values.add(element.name.getText(tree));
        else return undefined;
      }
      continue;
    }
    if (ts.isExpressionStatement(statement)) {
      if (ts.isStringLiteral(statement.expression)) continue;
      const expression = statement.expression;
      if (!ts.isBinaryExpression(expression) || expression.left.getText(tree) !== 'module.exports'
        || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isObjectLiteralExpression(expression.right)) return undefined;
      for (const property of expression.right.properties) {
        const name = property.name?.getText(tree);
        const target = ts.isShorthandPropertyAssignment(property) ? name : ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer) ? property.initializer.text : undefined;
        if (!name || !target || !definitions.has(target) && !values.has(target)) return undefined;
        exports[name] = definitions.has(target) ? 'capability' : 'value';
      }
      continue;
    }
    return undefined;
  }
  return Object.keys(exports).length ? exports : undefined;
}

/** Execute initialization only with inert import stubs. Inspect all imports
 * first; a first neutral binding cannot hide another loader/capability. Never
 * load product modules or a local fixture, and never manufacture inherited roots.
 */
async function probeDirect(file, parent, options = {}) {
  parent = fs.realpathSync(parent);
  assert.ok(path.isAbsolute(parent) && !within(ROOT, parent) && !within(EVIDENCE, parent) && within(fs.realpathSync(os.tmpdir()), parent), 'owned external probe parent');
  const source = fs.readFileSync(file, 'utf8');
  const { ts, ast, imports } = importInventory(file, source, parent);
  const product = imports.filter(entry => entry.kind === 'stateful' || entry.kind === 'stateless');
  assert.ok(product.length, 'probe has classified imported capabilities');
  const neutralProducts = product.every(entry => entry.kind === 'stateless');
  const ioSurface = imports.some(entry => ['node:fs', 'node:child_process', 'node:net'].includes(entry.id));
  // An I/O namespace is not made stateless by a pure product binding. The one
  // existing capacity entrypoint uses filesystem I/O only for its disposable
  // SDK sizing fixture (and SessionManager.inMemory), not durable run state.
  // Certify its COMPLETE reviewed source, irrespective of the filename; any
  // changed/later capability invalidates that certificate. Other I/O-bearing
  // scripts must demonstrate actual roots, never receive an optimistic exemption.
  const reviewedIoUse = ioSurface && source === fs.readFileSync(path.join(EVIDENCE, 'pre-repair/tests/test-2026-09-17-binding-capacity.cjs'), 'utf8');
  const stateless = neutralProducts && (!ioSurface || reviewedIoUse);
  const inherited = options.inherited || {};
  if (options.inherited) {
    assert.deepEqual(inherited, WRAPPER_INHERITANCE, 'inheritance must be the actual unchanged run-isolated environment, not synthesized roots');
    const owner = inherited.PI_ORCHESTRATOR_TEST_RUNS_OWNER;
    assert.ok(owner && path.isAbsolute(owner) && fs.realpathSync(owner) === owner && within(parent, owner), 'actual isolated wrapper owner');
    for (const key of ['PI_ORCHESTRATOR_RUNS_ROOT', 'PI_ORCHESTRATOR_NEXT_RUNS_ROOT']) assert.ok(inherited[key] && within(owner, inherited[key]), 'wrapper roots belong to its real owner');
  }
  const processMock = { env: { ...process.env, PI_ORCHESTRATOR_RUNS_ROOT: undefined, PI_ORCHESTRATOR_NEXT_RUNS_ROOT: undefined, PI_ORCHESTRATOR_TEST_RUNS_OWNER: undefined, PI_CODING_AGENT_DIR: undefined, ...inherited }, argv: [process.execPath, file], pid: process.pid, platform: process.platform, execPath: process.execPath, cwd: () => ROOT, on() {}, once() {}, stderr: { write() {} } };
  const observations = [];
  const boundary = new Error('isolated initialization boundary');
  let initializationError;
  function roots() {
    const roots = [processMock.env.PI_ORCHESTRATOR_RUNS_ROOT, processMock.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT];
    for (const root of roots) {
      assert.ok(root && path.isAbsolute(root) && path.resolve(root) === root && within(parent, root), 'owned roots established before stateful imports/access: ' + path.basename(file));
      let ancestor = root;
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      assert.ok(within(parent, fs.realpathSync(ancestor)), 'physical owned roots, no link alias');
    }
    assert.notEqual(roots[0], roots[1], 'separate legacy and next roots');
    return roots;
  }
  function stop(neutral = false) {
    observations.push({ roots: neutral && stateless ? [undefined, undefined] : roots(), stateless: neutral && stateless });
    throw boundary;
  }
  const guardedFs = new Proxy({}, { get(_target, key) {
    if (key === 'then') return undefined; // the filesystem module is not a thenable
    if (['mkdirSync', 'writeFileSync', 'appendFileSync', 'rmSync', 'mkdtempSync'].includes(key)) return (file, ...args) => {
      const target = path.resolve(file);
      assert.ok(within(parent, target), 'probe writes only owned scratch');
      // Reject a symlink/junction ancestor before any actual write.
      let ancestor = fs.existsSync(target) ? target : path.dirname(target);
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      assert.ok(within(parent, fs.realpathSync(ancestor)), 'physical owned write path');
      return fs[key](file, ...args);
    };
    if (key === 'symlinkSync') return (target, link, ...args) => {
      // Existing sanctioned initialization builds a deliberate owned link
      // fixture, never a dependency link or a workspace/evidence alias.
      assert.ok(within(parent, path.resolve(target)) && within(parent, path.resolve(link)), 'owned link fixture endpoints');
      assert.ok(within(parent, fs.realpathSync(path.dirname(link))) && within(parent, fs.realpathSync(path.dirname(target))), 'physical owned link fixture');
      return fs.symlinkSync(target, link, ...args);
    };
    if (['readFileSync', 'existsSync', 'lstatSync', 'statSync', 'realpathSync'].includes(key)) return (file, ...args) => {
      const target = path.resolve(file);
      assert.ok(within(parent, target) || within(ROOT, target) || within(EVIDENCE, target), 'probe cannot inspect live roots');
      let ancestor = target;
      while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
      const physical = fs.realpathSync(ancestor);
      assert.ok(within(parent, physical) || within(ROOT, physical) || within(EVIDENCE, physical), 'probe cannot follow aliases into live roots');
      return fs[key](file, ...args);
    };
    if (key === 'constants') return fs.constants;
    return () => { throw Error('unclassified filesystem capability: ' + String(key)); };
  } });
  const localRequire = id => {
    if (id === 'node:fs') return guardedFs;
    if (id === 'node:os') return { tmpdir: () => parent };
    if (id === 'node:module') return { _initPaths() {} };
    if (id === 'node:child_process') return new Proxy({}, { get(_target, key) { return key === 'then' ? undefined : () => { throw Error('probe must not launch a suite'); }; } });
    if (id === 'node:net') return new Proxy({}, { get(_target, key) { return key === 'then' ? undefined : () => { throw Error('probe must not open network I/O'); }; } });
    if (id.startsWith('node:')) return require(id);
    const moduleFile = path.isAbsolute(id) ? path.normalize(id) : path.resolve(path.dirname(file), id);
    const entries = imports.filter(entry => entry.moduleFile === moduleFile);
    assert.ok(entries.length, 'owned roots established: runtime import was classified');
    if (entries.every(entry => entry.kind === 'factory')) return () => localRequire;
    if (entries.every(entry => entry.kind === 'stateless')) {
      if (stateless) stop(true);
      if (neutralProducts) stop(); // uncertified I/O-bearing surface needs real roots
      return Object.fromEntries(entries.flatMap(entry => entry.bindings.map(name => [name, () => stop()])));
    }
    const surface = definitionSurface(moduleFile, ts);
    if (surface) return Object.fromEntries(Object.entries(surface).map(([name, kind]) => [name, kind === 'capability' ? function () { stop(); } : Object.freeze({})]));
    stop();
  };
  // Track every evaluated call/new result, including assigned promises and
  // nested detached async initialization. Attach handlers immediately; a later
  // VM expression or a parent's catch must not leave a rejected child detached.
  const pending = [];
  let boundaryLogged = false;
  function recordError(...errors) {
    for (const error of errors) {
      if (error === boundary || error === boundary.stack) { boundaryLogged = true; continue; }
      // The existing no-output entrypoint reports its retained owned fixture in
      // finally after logging a failure. Only this ancillary protocol record,
      // following the exact injected sentinel, is not an initialization error.
      // All other strings/errors still fail, even after a boundary was reached.
      if (boundaryLogged && typeof error === 'string' && error.startsWith('ITEM3_FAILURE_ROOT=')) {
        const retained = error.slice('ITEM3_FAILURE_ROOT='.length);
        if (path.isAbsolute(retained) && within(parent, retained) && fs.existsSync(retained) && fs.realpathSync(retained) === retained) continue;
      }
      initializationError ||= error instanceof Error ? error : new Error(String(error));
    }
  }
  function track(result) {
    if (result && typeof result.then === 'function') pending.push(Promise.resolve(result).then(() => {}, recordError));
    return result;
  }
  const transformed = ts.transform(ast, [context => {
    const visit = node => {
      const visited = ts.visitEachChild(node, visit, context);
      return ts.isCallExpression(visited) || ts.isNewExpression(visited)
        ? ts.factory.createCallExpression(ts.factory.createIdentifier('__track'), undefined, [visited]) : visited;
    };
    return tree => ts.visitNode(tree, visit);
  }]);
  const instrumented = ts.createPrinter().printFile(transformed.transformed[0]);
  transformed.dispose();
  const context = vm.createContext({ require: localRequire, __track: track, __dirname: path.dirname(file), __filename: file, process: processMock, console: { log() {}, error: recordError }, Buffer, URL, TextDecoder, setImmediate() { throw Error('probe must stop before scheduling'); } });
  try { track(vm.runInContext(instrumented, context, { filename: file })); } catch (error) { recordError(error); }
  // Calls settling an earlier promise can register more children. Await the
  // growing list, not a one-time snapshot, without a timer or forced exit.
  for (let index = 0; index < pending.length; index++) await pending[index];
  if (initializationError) throw initializationError;
  assert.ok(observations.length, 'probe reaches actual import/capability boundary: ' + file);
  return observations[0];
}
async function checkPackageIsolation(packageRoot, parent) {
  const scripts = Object.entries(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).scripts).filter(([, command]) => /tests\/(?:test|benchmark)-[^\s]+\.cjs/.test(command));
  assert.ok(scripts.length);
  const direct = new Set();
  for (const [name, command] of scripts) {
    for (const segment of command.split(/\s*&&\s*/)) {
      if (segment.startsWith('node tests/run-isolated.cjs ')) {
        assert.match(segment, /^node tests\/run-isolated\.cjs(?: tests\/[\w/.-]+\.cjs)+$/, name + ': wrapper must not silently discard flags');
      } else {
        const match = /^node (tests\/[\w/.-]+\.cjs)(?: --[\w-]+)?$/.exec(segment);
        assert.ok(match, name + ': unknown test entrypoint cannot bypass isolation');
        direct.add(match[1]);
      }
    }
  }
  for (const file of direct) await probeDirect(path.join(packageRoot, file), parent);
  return direct.size;
}
/** Select the actual copied checker; only dependency/source plumbing is adapted in memory. */
function baselineChecker() {
  const file = fs.realpathSync(process.env.ROUND7_ISOLATION_CHECKER_BASELINE);
  assert.equal(file, fs.realpathSync(path.join(EVIDENCE, 'pre-repair/tests/test-2026-10-06-round7-test-isolation.cjs')), 'only the declared pre-repair checker');
  assert.ok(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink(), 'regular read-only checker copy');
  let source = fs.readFileSync(file, 'utf8');
  source = source.replace(/const ROOT = [^\n]+;/, 'const ROOT = ' + JSON.stringify(ROOT) + ';')
    .replace(/const EVIDENCE = [^\n]+;/, 'const EVIDENCE = ' + JSON.stringify(EVIDENCE) + ';')
    .replace("path.join(EVIDENCE, 'pre-small')", "path.join(EVIDENCE, 'original-pre-small')");
  const copied = { exports: {} };
  vm.runInNewContext(source, { require, module: copied, __dirname: path.dirname(file), process, console, Buffer, TextDecoder, URL }, { filename: file });
  return copied.exports;
}
const checker = process.env.ROUND7_ISOLATION_CHECKER_BASELINE ? baselineChecker() : { probeDirect, checkPackageIsolation };
module.exports = { ROOT, SOURCE, scratch, isolated, declarations, api, ...checker };
async function main() {
  const directory = isolated('round7-isolation-');
  try {
    // Faithfully promote the independent package fixture; never execute its unsafe module.
    const fixture = path.join(EVIDENCE, 'probe/unsafe-package');
    for (const relative of ['package.json', 'tests/test-unsafe.cjs']) assert.ok(fs.lstatSync(path.join(fixture, relative)).isFile() && !fs.lstatSync(path.join(fixture, relative)).isSymbolicLink(), 'regular read-only probe inputs');
    const unsafePackage = path.join(directory, 'unsafe-package');
    fs.cpSync(fixture, unsafePackage, { recursive: true, dereference: false });
    await assert.rejects(async () => checker.checkPackageIsolation(unsafePackage, directory), /owned roots established/,
      'Direct package scripts with no root setup and an aliased stateful product import must be rejected');
    console.log('PASS promoted independent aliased package rejection');
    const count = await checker.checkPackageIsolation(ROOT, directory);
    assert.ok(count > 0, 'all sanctioned direct scripts covered without executing their suites');
    const state = JSON.stringify(path.join(ROOT, 'src/run-state.ts'));
    const pure = JSON.stringify(path.join(ROOT, 'src/index.ts'));
    const setup = `const fs=require('node:fs'),os=require('node:os'),path=require('node:path'); const owned=fs.mkdtempSync(path.join(os.tmpdir(),'direct-')); process.env.PI_ORCHESTRATOR_RUNS_ROOT=path.join(owned,'legacy'); process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT=path.join(owned,'next');`;
    async function reject(name, source, expression = /owned roots established/) {
      const file = path.join(directory, name + '.cjs'); fs.writeFileSync(file, source);
      await assert.rejects(async () => checker.probeDirect(file, directory), expression, name);
      console.log('PASS reject ' + name);
    }
    async function accept(name, source, options) {
      const file = path.join(directory, name + '.cjs'); fs.writeFileSync(file, source);
      const report = await checker.probeDirect(file, directory, options);
      console.log('PASS accept ' + name); return report;
    }
    await reject('unsafe', `require(${state});`);
    await reject('late', `require(${state}); ${setup}`);
    await reject('one-root', `process.env.PI_ORCHESTRATOR_RUNS_ROOT=${JSON.stringify(path.join(directory, 'only'))};require(${state});`);
    await reject('shared-roots', setup + `process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT=process.env.PI_ORCHESTRATOR_RUNS_ROOT; require(${state});`, /separate legacy/);
    await reject('pure-later-alias', `const {buildPlanningPrompt}=require(${pure});const statePath='../'+'src/run-state.ts';const state=require(statePath);`);
    // Also resolve the actual state module, proving rejection is root ownership
    // rather than a missing fixture/module. It is inspected, never executed.
    await reject('pure-later-resolved-alias', `const {buildPlanningPrompt}=require(${pure});const statePath=${JSON.stringify(path.join(ROOT, 'src'))}+${JSON.stringify(path.sep + 'run-state.ts')};const state=require(statePath);`, /owned roots established before stateful imports/);
    await reject('unresolved', `const {buildPlanningPrompt}=require(${pure});require(process.env.UNRESOLVED_IMPORT);`);
    await reject('computed', `const {buildPlanningPrompt}=require(${pure});require(['../src/run-state.ts'][0]);`);
    await reject('dynamic-import', `const {buildPlanningPrompt}=require(${pure}); import('../src/run-state.ts');`);
    await reject('aliased-loader', `const {buildPlanningPrompt}=require(${pure});const load=require;load('../src/run-state.ts');`);
    await reject('mutable-loader-alias', `const {buildPlanningPrompt}=require(${pure});let load=require;load(${state});`);
    const jitiFactory = JSON.stringify(path.join(ROOT, 'node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.cjs'));
    await reject('mutable-loader-factory', `const {buildPlanningPrompt}=require(${pure});let factory=require(${jitiFactory});const load=factory(__filename);load(${state});`);
    await reject('aliased-loader-factory', `const {buildPlanningPrompt}=require(${pure});const factory=require(${jitiFactory});const alias=factory;const load=alias(__filename);load(${state});`, /owned roots established before stateful imports/);
    await reject('escaped-loader', `const {buildPlanningPrompt}=require(${pure});const load=require.bind(null);load('../src/run-state.ts');`);
    await reject('pure-plus-namespace', `const {buildPlanningPrompt}=require(${pure});const namespace=require(${pure});`);
    await reject('pure-plus-rest', `const {buildPlanningPrompt,...rest}=require(${pure});`);
    await reject('wrong-module-same-binding', `const {buildPlanningPrompt}=require(${state});`);
    await reject('late-after-pure', `const {buildPlanningPrompt}=require(${pure});require(${state});${setup}`);
    await reject('root-replacement-after-import', setup + `require(${state});process.env.PI_ORCHESTRATOR_NEXT_RUNS_ROOT='unsafe';require(${state});`);
    await reject('root-deleted-after-import', setup + `require(${state});delete process.env.PI_ORCHESTRATOR_RUNS_ROOT;require(${state});`);
    await reject('ambient-later-loader', `const {buildPlanningPrompt}=require(${pure});globalThis.require('../src/run-state.ts');`);
    await reject('unresolved-with-owned-roots', setup + `require('../src/missing-state.ts');`);
    await reject('environment-alias', setup + `const env=process.env;require(${state});env.PI_ORCHESTRATOR_RUNS_ROOT='unsafe';`);
    await reject('later-created-loader', `const {buildPlanningPrompt}=require(${pure});const {createRequire}=require('node:module');const load=createRequire(__filename);load(${state});`);
    await reject('later-vm-loader', `const {buildPlanningPrompt}=require(${pure});const vm=require('node:vm');vm.runInThisContext('require(\"../src/run-state.ts\")');`);
    await reject('later-process-capability', `const {buildPlanningPrompt}=require(${pure});const live=require('node:process');`);
    await reject('later-unclassified-io', `const {buildPlanningPrompt}=require(${pure});const io=require('node:fs/promises');`);
    await reject('pure-plus-io-namespace', `const {buildPlanningPrompt}=require(${pure});const io=require('node:fs');`, /owned roots established before stateful imports/);
    await reject('pure-plus-io-binding', `const {buildPlanningPrompt}=require(${pure});const {writeFileSync}=require('node:fs');`, /owned roots established before stateful imports/);
    await accept('direct-roots', setup + `require(${state});`);
    await accept('pure-before-direct-setup', `const {buildPlanningPrompt}=require(${pure});${setup}require(${state});`);
    const wrapperFile = path.join(directory, 'actual-wrapper.cjs');
    fs.writeFileSync(wrapperFile, `require(${state});`);
    const wrapperReport = await checker.probeDirect(wrapperFile, WRAPPER_INHERITANCE.PI_ORCHESTRATOR_TEST_RUNS_OWNER, { inherited: WRAPPER_INHERITANCE });
    assert.deepEqual(wrapperReport.roots, [WRAPPER_INHERITANCE.PI_ORCHESTRATOR_RUNS_ROOT, WRAPPER_INHERITANCE.PI_ORCHESTRATOR_NEXT_RUNS_ROOT]);
    console.log('PASS actual unchanged wrapper inheritance');
    {
      await assert.rejects(async () => checker.probeDirect(wrapperFile, directory, { inherited: {
        PI_ORCHESTRATOR_TEST_RUNS_OWNER: directory,
        PI_ORCHESTRATOR_RUNS_ROOT: path.join(directory, 'fabricated-legacy'),
        PI_ORCHESTRATOR_NEXT_RUNS_ROOT: path.join(directory, 'fabricated-next'),
      } }), /actual unchanged run-isolated environment, not synthesized roots/, 'fabricated inheritance cannot establish direct isolation');
      console.log('PASS reject synthetic-inheritance');
      await reject('async-real-error', setup + `(async()=>{try{require(${state});}catch(error){throw new Error('genuine initialization error');}})();`, /genuine initialization error/);
      await reject('async-logged-real-error', setup + `(async()=>{try{require(${state});}catch(error){throw new Error('genuine logged error');}})().catch(error=>console.error(error.stack));`, /genuine logged error/);
      await accept('async-boundary-rethrow', setup + `(async()=>{require(${state});})().catch(error=>{throw error;});`);
      await accept('async-boundary-not-last-expression', setup + `(async()=>{require(${state});})();const tail=1;`);
      await accept('async-assigned-boundary', setup + `const ready=(async()=>{require(${state});})();const tail=1;`);
      await accept('async-detached-child-boundary', setup + `(async()=>{(async()=>{require(${state});})();})();`);
      await reject('async-detached-child-error', setup + `(async()=>{(async()=>{try{require(${state});}catch(error){throw new Error('genuine detached child error');}})();})();`, /genuine detached child error/);
    }
    const neutral = await accept('certified-stateless-alias', `const {buildPlanningPrompt:prompt}=require(${pure});`);
    assert.equal(neutral.stateless, true);
    assert.deepEqual(neutral.roots, [undefined, undefined], 'stateless evidence is NOT synthetic inherited roots');
    const definition = path.join(directory, 'definitions.cjs');
    fs.writeFileSync(definition, "class Stateful { constructor() { throw Error('must not execute'); } } module.exports={Stateful};");
    await reject('definition-capability-unsafe', `const {Stateful}=require(${JSON.stringify(definition)});new Stateful();`);
    await accept('definition-capability-owned', `const {Stateful}=require(${JSON.stringify(definition)});${setup}new Stateful();`);
    fs.writeFileSync(definition, "class Stateful { static data=require('../src/run-state.ts'); } module.exports={Stateful};");
    await reject('definition-static-effect', `const {Stateful}=require(${JSON.stringify(definition)});`);
    console.log('PASS round7 test isolation: complete imports/capabilities, real roots and settled initialization errors');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
// Surface async assertion failures as ordinary uncaught test errors, not
// detached promise rejections or explicit process exits.
if (require.main === module) main().catch(error => { queueMicrotask(() => { throw error; }); });
