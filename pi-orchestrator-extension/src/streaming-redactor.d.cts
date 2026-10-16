export class StreamingSecretRedactor {
  push(value: string | Buffer): string;
  finish(): string;
}
export function redactCompleteText(value: string): string;
