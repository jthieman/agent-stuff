import { Buffer } from "node:buffer";
import { format } from "node:util";

import { JsSandboxRuntimeError } from "./normalize-error.ts";

export class OutputCapture {
  stdout = "";
  stderr = "";
  stdoutBytes = 0;
  stderrBytes = 0;
  truncated = false;

  constructor(private readonly outputLimitBytes: number) {}

  stdoutLine(values: unknown[]): void {
    this.write("stdout", `${format(...values)}\n`);
  }

  stderrLine(values: unknown[]): void {
    this.write("stderr", `${format(...values)}\n`);
  }

  write(stream: "stdout" | "stderr", text: string): void {
    const bytes = Buffer.byteLength(text);
    const current = this.stdoutBytes + this.stderrBytes;
    const limit = this.outputLimitBytes;

    if (current + bytes > limit) {
      const remaining = Math.max(0, limit - current);
      const encoded = Buffer.from(text);
      const partialBytes = encoded.subarray(0, utf8PrefixLength(encoded, remaining));
      const partial = partialBytes.toString("utf8");
      if (stream === "stdout") {
        this.stdout += partial;
        this.stdoutBytes += partialBytes.byteLength;
      } else {
        this.stderr += partial;
        this.stderrBytes += partialBytes.byteLength;
      }

      this.truncated = true;
      throw new JsSandboxRuntimeError("OUTPUT_LIMIT", `${stream} output limit exceeded`);
    }

    if (stream === "stdout") {
      this.stdout += text;
      this.stdoutBytes += bytes;
    } else {
      this.stderr += text;
      this.stderrBytes += bytes;
    }
  }
}

function utf8PrefixLength(bytes: Uint8Array, maxBytes: number): number {
  let end = Math.min(maxBytes, bytes.byteLength);
  while (end > 0 && end < bytes.byteLength && isUtf8ContinuationByte(bytes[end])) {
    end -= 1;
  }
  return end;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
