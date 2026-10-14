import type { RunEvent, RunResult } from "@segno/core";

/** The parts of a stream-json message the Adapter reads. */
interface Message {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
  /** Set on a synthetic assistant message the CLI prints for an API error. */
  error?: string;
  rate_limit_info?: RateLimitInfo;
}
interface Window {
  utilization?: number;
  /** Unix seconds. */
  resetsAt?: number;
}
interface RateLimitInfo extends Window {
  status?: "allowed" | "allowed_warning" | "rejected";
  /** Set while the CLI carries on past the limit on extra usage. */
  isUsingOverage?: boolean;
  rateLimitType?: string;
  unifiedWindows?: Record<string, Window>;
}
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input?: Record<string, unknown> }
  | { type: string };

/** The input field that best says what a tool call did. */
const toolSubjects = [
  "file_path",
  "command",
  "pattern",
  "path",
  "url",
  "query",
];

interface StreamOptions {
  /** The session the Run was started with, reported in `started`. */
  sessionId: string;
  /** Whether the Run asked for structured output. */
  structured: boolean;
  emit(event: RunEvent): void;
}

/**
 * Reads `claude -p --output-format stream-json` output line by line, emitting
 * RunEvents, and classifies the Run once the process has ended [ADR-0017].
 */
export function readStream({ sessionId, structured, emit }: StreamOptions) {
  let pending = "";
  let result: Message | undefined;
  /** Set once the stream signals a usage or rate limit. */
  let limited: { resetAt?: string } | undefined;

  function limit(resetAt: string | undefined) {
    if (limited && (limited.resetAt || !resetAt)) return;
    limited = resetAt ? { resetAt } : {};
    emit({ type: "rateLimited", ...limited });
  }

  function read(line: string) {
    let message: Message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "system" && message.subtype === "init")
      emit({ type: "started", sessionId: message.session_id ?? sessionId });
    // Every message is a sign of progress for the idle timer.
    emit({ type: "activity", summary: message.type ?? "message" });
    if (message.type === "rate_limit_event" && message.rate_limit_info) {
      const info = message.rate_limit_info;
      const usage = usageOf(info);
      if (usage) emit({ type: "usage", ...usage });
      if (info.status === "rejected" && !info.isUsingOverage)
        limit(iso(info.resetsAt));
    } else if (message.type === "assistant") {
      if (message.error === "rate_limit") limit(undefined);
      for (const block of message.message?.content ?? []) {
        const text = readable(block);
        if (text) emit({ type: "output", text });
      }
    } else if (message.type === "result") result = message;
  }

  return {
    write(text: string) {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) read(line);
    },
    end({
      code,
      signal,
      stderr,
    }: {
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
    }): RunResult {
      if (pending.trim()) read(pending);
      const exit = code === null ? {} : { exitCode: code };
      const succeeded = result && !result.is_error && code === 0 && !signal;
      // A limit signal decides, unless the Run finished its work [ADR-0021].
      if (limited && !succeeded)
        return {
          kind: "rate-limited",
          ...limited,
          detail: result?.result || stderr || "Claude Code is rate-limited.",
        };
      if (signal)
        return { kind: "crashed", detail: `claude was killed by ${signal}.` };
      if (!result)
        return {
          kind: "crashed",
          detail: "The stream ended without a result.",
          ...exit,
        };
      if (result.is_error || code !== 0)
        return {
          kind: "failed",
          detail: result.result || stderr || "claude exited with an error.",
          ...exit,
        };
      return {
        kind: "completed",
        sessionId,
        finalText: result.result ?? "",
        ...(structured && result.structured_output !== undefined
          ? { structured: result.structured_output }
          : {}),
      };
    },
  };
}

/** A human-readable line for the live Run stream, or nothing. */
function readable(block: ContentBlock) {
  if (block.type === "text" && "text" in block && block.text)
    return `${block.text}\n`;
  if (block.type === "tool_use" && "name" in block) {
    const subject = toolSubjects
      .map((key) => block.input?.[key])
      .find((value) => typeof value === "string");
    return `→ ${block.name}${subject ? ` ${subject}` : ""}\n`;
  }
  return undefined;
}

/**
 * The window the CLI names as binding (else the fullest), as a percentage
 * of its limit. Usage is only ever what the CLI reports [ADR-0021].
 */
function usageOf(info: RateLimitInfo) {
  const windows = Object.values(info.unifiedWindows ?? {}).filter(
    (window) => typeof window.utilization === "number",
  );
  const window =
    (info.rateLimitType && info.unifiedWindows?.[info.rateLimitType]) ||
    windows.sort((a, b) => (b.utilization ?? 0) - (a.utilization ?? 0))[0];
  if (typeof window?.utilization !== "number") return undefined;
  const resetAt = iso(window.resetsAt);
  return {
    used: Math.round(window.utilization * 100),
    limit: 100,
    ...(resetAt ? { resetAt } : {}),
  };
}

function iso(seconds: number | undefined) {
  return typeof seconds === "number"
    ? new Date(seconds * 1000).toISOString()
    : undefined;
}
