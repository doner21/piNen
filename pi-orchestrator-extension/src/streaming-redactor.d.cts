export class StreamingSecretRedactor {
  push(value: string | Buffer): string;
  finish(): string;
}
export class WithheldOutputStream {
  push(value: string | Buffer): string;
  finish(): string;
}
export class WorkerProtocolSanitizer {
  sanitize<T>(event: T): T;
}
export function redactCompleteText(value: string): string;
export function sanitizeWorkerValue<T>(value: T): T;
export function sanitizeWorkerText(value: string): string;
