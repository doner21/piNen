import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  MissionWorker,
  MissionWorkerEvent,
  MissionWorkerFactory,
  MissionWorkerIdentity,
  MissionWorkerInspection,
  OpenMissionWorkerRequest,
  ProcessInspector,
  ProcessObservation,
} from "./types";

export interface ScriptedMutation {
  path: string;
  content: string;
}

export interface ScriptedMissionTurn {
  mutations?: ScriptedMutation[];
  events?: MissionWorkerEvent[];
  throwMessage?: string;
  throwState?: "running" | "exited";
}

export interface ScriptedMissionWorkerFactoryOptions {
  sessionRoot: string;
  turns: ScriptedMissionTurn[];
  firstPid?: number;
}

interface ScriptedSession {
  sessionId: string;
  sessionFile: string;
  cursor: string | null;
  nextTurn: number;
  state: MissionWorkerInspection["state"];
  pid: number;
  processStartedAt: string;
  prompts: string[];
  identity?: MissionWorkerIdentity;
}

/** Deterministic persistent-session worker used by mission crash/recovery tests. */
export class ScriptedMissionWorkerFactory implements MissionWorkerFactory, ProcessInspector {
  readonly adapterName = "scripted-mission-worker-v1";
  readonly #sessionRoot: string;
  readonly #turns: ScriptedMissionTurn[];
  readonly #sessions = new Map<string, ScriptedSession>();
  #nextPid: number;
  #sessionCounter = 0;

  constructor(options: ScriptedMissionWorkerFactoryOptions) {
    this.#sessionRoot = path.resolve(options.sessionRoot);
    this.#turns = options.turns.map((turn) => JSON.parse(JSON.stringify(turn)) as ScriptedMissionTurn);
    this.#nextPid = options.firstPid ?? 90_000;
    mkdirSync(this.#sessionRoot, { recursive: true });
  }

  get prompts(): string[] {
    return [...this.#sessions.values()].flatMap((session) => session.prompts);
  }

  get sessions(): MissionWorkerIdentity[] {
    return [...this.#sessions.values()].flatMap((session) => session.identity ? [{ ...session.identity }] : []);
  }

  async open(request: OpenMissionWorkerRequest): Promise<MissionWorker> {
    let session: ScriptedSession | undefined;
    if (request.resume) session = this.#sessions.get(path.resolve(request.resume.sessionFile));
    if (!session) {
      this.#sessionCounter += 1;
      const sessionId = `scripted-session-${this.#sessionCounter}`;
      const sessionFile = path.join(this.#sessionRoot, `${sessionId}.jsonl`);
      writeFileSync(sessionFile, "", { flag: "wx" });
      session = {
        sessionId,
        sessionFile,
        cursor: null,
        nextTurn: 0,
        state: "idle",
        pid: 0,
        processStartedAt: new Date(Date.UTC(2026, 8, 2, 0, 0, this.#sessionCounter)).toISOString(),
        prompts: [],
      };
      this.#sessions.set(path.resolve(sessionFile), session);
    }
    session.pid = this.#nextPid++;
    session.state = "idle";
    session.processStartedAt = new Date(Date.UTC(2026, 8, 2, 0, 1, session.pid % 60)).toISOString();
    const identity: MissionWorkerIdentity = {
      adapter: this.adapterName,
      workerId: `${request.runId}:primary:${request.generation}`,
      pid: session.pid,
      processStartedAt: session.processStartedAt,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      cursor: session.cursor,
      generation: request.generation,
      route: request.resume?.route ?? request.route,
    };
    session.identity = identity;
    return new ScriptedMissionWorker(request.cwd, session, this.#turns, identity);
  }

  async terminate(identity: MissionWorkerIdentity): Promise<boolean> {
    const session = this.#sessions.get(path.resolve(identity.sessionFile));
    if (!session) return false;
    session.state = "exited";
    return true;
  }

  inspect(pid: number): ProcessObservation;
  inspect(identity: MissionWorkerIdentity): Promise<MissionWorkerInspection>;
  inspect(value: number | MissionWorkerIdentity): ProcessObservation | Promise<MissionWorkerInspection> {
    if (typeof value !== "number") {
      const session = this.#sessions.get(path.resolve(value.sessionFile));
      if (!session || !session.identity) return Promise.resolve({ state: "unknown", identity: value, error: "scripted session not found" });
      return Promise.resolve({ state: session.state, identity: { ...session.identity }, ...(session.state === "exited" ? { exitCode: 0 } : {}) });
    }
    const session = [...this.#sessions.values()].find((candidate) => candidate.pid === value);
    return session
      ? { pid: value, alive: session.state !== "exited", startedAt: session.processStartedAt }
      : { pid: value, alive: false };
  }
}

class ScriptedMissionWorker implements MissionWorker {
  readonly identity: MissionWorkerIdentity;
  readonly #cwd: string;
  readonly #session: ScriptedSession;
  readonly #turns: ScriptedMissionTurn[];

  constructor(cwd: string, session: ScriptedSession, turns: ScriptedMissionTurn[], identity: MissionWorkerIdentity) {
    this.#cwd = cwd;
    this.#session = session;
    this.#turns = turns;
    this.identity = identity;
  }

  async *prompt(message: string, signal?: AbortSignal): AsyncIterable<MissionWorkerEvent> {
    if (this.#session.state === "exited") throw new Error("scripted worker already exited");
    if (signal?.aborted) throw new Error("scripted worker aborted before prompt");
    this.#session.state = "running";
    this.#session.prompts.push(message);
    const turn = this.#turns[this.#session.nextTurn++] ?? { events: [{ type: "settled", cursor: this.#session.cursor, tokens: 0 }] };
    for (const mutation of turn.mutations ?? []) {
      const target = path.resolve(this.#cwd, mutation.path);
      const relative = path.relative(this.#cwd, target);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`scripted mutation escapes workspace: ${mutation.path}`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, mutation.content, "utf8");
    }
    if (turn.throwMessage) {
      this.#session.state = turn.throwState ?? "exited";
      throw new Error(turn.throwMessage);
    }
    const events = turn.events?.length ? turn.events : [{ type: "settled", cursor: this.#session.cursor, tokens: 0 } satisfies MissionWorkerEvent];
    for (const event of events) {
      if (signal?.aborted) {
        this.#session.state = "exited";
        throw new Error("scripted worker aborted");
      }
      if (event.type === "cursor") this.#updateCursor(event.cursor);
      if (event.type === "settled") {
        if (event.cursor) this.#updateCursor(event.cursor);
        this.#session.state = "idle";
      }
      if (event.type === "failed") this.#session.state = event.retryable ? "idle" : "exited";
      yield JSON.parse(JSON.stringify(event)) as MissionWorkerEvent;
    }
  }

  async inspect(): Promise<MissionWorkerInspection> {
    return { state: this.#session.state, identity: { ...this.#session.identity! }, ...(this.#session.state === "exited" ? { exitCode: 0 } : {}) };
  }

  async abort(): Promise<void> {
    this.#session.state = "exited";
  }

  async close(): Promise<void> {
    this.#session.state = "exited";
  }

  #updateCursor(cursor: string): void {
    this.#session.cursor = cursor;
    if (this.#session.identity) this.#session.identity = { ...this.#session.identity, cursor };
  }
}
