import { z } from "zod";
import {
  eventSchema,
  isTerminal,
  jobInputSchema,
  jobSchema,
  type Job,
  type JobInput,
  type RunEvent,
} from "../service/contracts.js";

export type { Job, JobInput, RunEvent };
export const approvalSchema = z.strictObject({
  id: z.string(),
  preview: z.string(),
  status: z.enum([
    "pending",
    "approved",
    "declined",
    "executing",
    "completed",
    "expired",
  ]),
  expiresAt: z.number(),
});
export type Approval = z.infer<typeof approvalSchema>;
export type ClientOptions = Readonly<{
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  reconnectDelayMs?: number;
  maxRetries?: number;
}>;
export type StreamOptions = Readonly<{
  after?: number;
  signal?: AbortSignal;
  onReconnect?: (attempt: number) => void;
}>;
export class ClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ClientError";
  }
}
const terminal = (event: RunEvent) => isTerminal(event.type);
const retryable = (error: unknown) =>
  !(error instanceof z.ZodError) &&
  (!(error instanceof ClientError) ||
    (error.status !== undefined && error.status >= 500));
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });

async function* lines(
  response: Response,
  limit: number,
  totalLimit = Infinity,
) {
  if (!response.body) throw new ClientError("Response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  let totalBytes = 0;
  const decode = (value?: Uint8Array, stream = false) => {
    try {
      return decoder.decode(value, { stream });
    } catch {
      throw new ClientError("Invalid UTF-8 response");
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > totalLimit)
        throw new ClientError("Response exceeds size limit");
      for (const byte of value) {
        bytes = byte === 10 ? 0 : bytes + 1;
        if (bytes > limit) throw new ClientError("Response exceeds size limit");
      }
      pending += decode(value, true);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield line;
      }
    }
    pending += decode();
    if (pending.trim()) yield pending.trim();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class BrowserClient {
  private readonly options: ClientOptions;
  private readonly transport: typeof fetch;
  constructor(options: ClientOptions) {
    const url = new URL(options.baseUrl);
    if (!["https:", "http:"].includes(url.protocol)) {
      throw new ClientError("Base URL must use HTTP or HTTPS");
    }
    if (
      options.maxRetries !== undefined &&
      (!Number.isInteger(options.maxRetries) ||
        options.maxRetries < 0 ||
        options.maxRetries > 10)
    )
      throw new ClientError("maxRetries must be between 0 and 10");
    if (
      options.reconnectDelayMs !== undefined &&
      (!Number.isFinite(options.reconnectDelayMs) ||
        options.reconnectDelayMs < 0 ||
        options.reconnectDelayMs > 30_000)
    )
      throw new ClientError("reconnectDelayMs must be between 0 and 30000");
    this.options = options;
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  createInput(
    profileId: string,
    input: string,
    id: string = crypto.randomUUID(),
  ): JobInput {
    return jobInputSchema.parse({ id, profileId, input });
  }

  async createRun(
    conversationId: string,
    input: JobInput,
    signal?: AbortSignal,
  ): Promise<Job> {
    const body = JSON.stringify(jobInputSchema.parse(input));
    for (let attempt = 0; ; attempt++) {
      try {
        return jobSchema.parse(
          await this.json(this.path(conversationId), "POST", body, signal),
        );
      } catch (error) {
        if (
          signal?.aborted ||
          !retryable(error) ||
          attempt >= (this.options.maxRetries ?? 3)
        )
          throw error;
        await wait(this.delay(attempt), signal);
      }
    }
  }

  async getRun(
    conversationId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Job> {
    return jobSchema.parse(
      await this.json(
        this.path(conversationId, runId),
        "GET",
        undefined,
        signal,
      ),
    );
  }

  async cancel(
    conversationId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      `${this.path(conversationId, runId)}/cancel`,
      "POST",
      undefined,
      signal,
    );
  }

  async getApproval(
    conversationId: string,
    runId: string,
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<Approval> {
    return approvalSchema.parse(
      await this.json(
        `${this.path(conversationId, runId)}/approvals/${encodeURIComponent(approvalId)}`,
        "GET",
        undefined,
        signal,
      ),
    );
  }

  async decide(
    conversationId: string,
    runId: string,
    approvalId: string,
    approved: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      `${this.path(conversationId, runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      "POST",
      JSON.stringify({ approved }),
      signal,
    );
  }

  async *events(
    conversationId: string,
    runId: string,
    options: StreamOptions = {},
  ): AsyncGenerator<RunEvent> {
    let cursor = options.after ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ClientError("Invalid event cursor");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.request(
          `${this.path(conversationId, runId)}/events?after=${String(cursor)}`,
          "GET",
          undefined,
          options.signal,
        );
        if (
          !response.headers
            .get("content-type")
            ?.includes("application/x-ndjson")
        )
          throw new ClientError("Expected an NDJSON event stream");
        for await (const line of lines(response, 65_536)) {
          let event: RunEvent;
          try {
            event = eventSchema.parse(JSON.parse(line));
          } catch {
            throw new ClientError("Invalid run event");
          }
          if (event.sequence <= cursor) continue;
          if (event.sequence !== cursor + 1)
            throw new ClientError("Event sequence gap");
          cursor = event.sequence;
          yield event;
          if (terminal(event)) return;
        }
      } catch (error) {
        if (options.signal?.aborted || !retryable(error)) throw error;
      }
      if (attempt >= (this.options.maxRetries ?? 3))
        throw new ClientError("Event stream disconnected; reconnect to resume");
      options.onReconnect?.(attempt + 1);
      await wait(this.delay(attempt), options.signal);
    }
  }

  private delay(attempt: number) {
    return Math.min(
      (this.options.reconnectDelayMs ?? 500) * 2 ** attempt,
      30_000,
    );
  }

  private path(conversationId: string, runId?: string) {
    const base = this.options.baseUrl.replace(/\/$/, "");
    return `${base}/v1/conversations/${encodeURIComponent(conversationId)}/runs${runId === undefined ? "" : `/${encodeURIComponent(runId)}`}`;
  }

  private async request(
    url: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const headers = new Headers(await this.options.headers?.());
    headers.set(
      "accept",
      url.includes("/events?") ? "application/x-ndjson" : "application/json",
    );
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await this.transport(url, {
      method,
      headers,
      credentials: this.options.credentials ?? "same-origin",
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ClientError(
        `Request failed (${String(response.status)})`,
        response.status,
      );
    }
    return response;
  }

  private async json(
    url: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.request(url, method, body, signal);
    if (response.status === 204) return undefined;
    let text = "";
    for await (const line of lines(response, 2_097_152, 2_097_152)) {
      text += line;
    }
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ClientError("Invalid JSON response");
    }
  }
}
