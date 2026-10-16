import type { EventEmitter } from "node:events";

export type TelemetryChannel = "ordinary" | "control" | "terminal" | "counter";
export type CommandTelemetryOwnerConfiguration = Readonly<{
  ownerId: string;
  endpoint: string;
  permission: string;
  commandId: string;
  parentInvocationId?: string;
}>;

/** @internal Production decoder exported for finite transport regressions. */
export class FrameDecoder {
  constructor(
    onFrame: (frame: Record<string, unknown>) => void,
    onError: (error: Error) => void,
    maxFrameBytes?: () => number,
    reserveBufferedBytes?: (bytes: number) => boolean,
    releaseBufferedBytes?: (bytes: number) => void,
  );
  push(chunk: Uint8Array): void;
  finish(): void;
}

export class CommandTelemetryOwner {
  constructor(input: {
    commandRoot: string;
    evidenceDirectory: string;
    commandId: string;
    onEvent?: (event: Record<string, unknown>, context: Record<string, unknown>) => void;
    publicationHook?: (context: Record<string, unknown>) => void;
  });
  readonly ownerId: string;
  readonly endpoint: string;
  start(): Promise<void>;
  configuration(parentInvocationId?: string): CommandTelemetryOwnerConfiguration;
  reserveHostWork(invocationId: string, channel: TelemetryChannel, maxBytes: number): Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }> | undefined;
  committedReaderAdmissionAvailable(): boolean;
  reserveHostReaderWork(invocationId: string, channel: TelemetryChannel, maxBytes: number): Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }> | undefined;
  retainHostReaderDescriptor(
    descriptor: number,
    permission: Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }>,
    actualBytes: number,
    context?: { source?: string; reason?: string },
  ): void;
  completeHostWork(permission: Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }>, actualBytes: number): void;
  abandonHostWork(permission: Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }>): boolean;
  commitHostEvidence(invocationId: string, event: Record<string, unknown>): boolean;
  hostDeliveryBytes(event: Record<string, unknown>, channel?: TelemetryChannel): number;
  sendToInvocation(
    invocationId: string,
    event: Record<string, unknown>,
    channel: TelemetryChannel,
    permission: Readonly<{ permissionId: string; invocationId: string; channel: TelemetryChannel; maxBytes: number }>,
    priorActualBytes?: number,
  ): boolean;
  drainEvents(): Array<Record<string, unknown>>;
  finalizeInvocation(invocationId: string): boolean;
  invocationProducerState(invocationId: string): "open" | "closed";
  retireCommitted(invocationId: string): boolean;
  acquireCommitted(invocationId: string): { leaseId: string; generation: number; file: string; bytes: Buffer } | undefined;
  releaseReader(leaseId: string): boolean;
  accounting(): Record<string, number | string>;
  close(): Promise<void>;
}

export class CommandTelemetryClient extends EventEmitter {
  constructor(configuration: CommandTelemetryOwnerConfiguration, invocationId: string);
  connect(): Promise<void>;
  requestWork(channel: TelemetryChannel, maxBytes: number): Promise<Readonly<{ opId: string; channel: TelemetryChannel; maxBytes: number }>>;
  commitGranted(grant: Readonly<{ opId: string; channel: TelemetryChannel; maxBytes: number }>, event: Record<string, unknown>): Promise<Record<string, unknown>>;
  publish(event: Record<string, unknown>, channel?: TelemetryChannel): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export const COMMAND_TELEMETRY_LIMITS: Readonly<Record<string, number>>;
