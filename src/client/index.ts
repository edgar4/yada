import {
  parseApproval,
  parseEvent,
  parseJob,
  parseJobInput,
  parseSteering,
  ValidationError,
} from "./validate.js";
import type { Job, JobInput, RunEvent } from "../service/contracts.js";

export type { Job, JobInput, RunEvent };
export type Approval = Readonly<{
  id: string;
  preview: string;
  remember?: readonly string[];
  status:
    | "pending"
    | "approved"
    | "declined"
    | "executing"
    | "completed"
    | "expired"
    | "unknown"
    | "undelivered";
  expiresAt: number;
}>;
export type ClientOptions = Readonly<{
  baseUrl: string;
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  headers?: () => HeadersInit | Promise<HeadersInit>;
  reconnectDelayMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
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
const terminal = (event: RunEvent) =>
  event.type === "completed" ||
  event.type === "failed" ||
  event.type === "cancelled";
const retryable = (error: unknown) =>
  !(error instanceof ValidationError) &&
  (!(error instanceof ClientError) ||
    (error.status !== undefined && error.status >= 500));
const timedOut = () => new ClientError("Request timed out", 408);
const abortable = <T>(work: T | Promise<T>, signal?: AbortSignal) =>
  signal
    ? new Promise<T>((resolve, reject) => {
        const abort = () => {
          reject(signal.reason as Error);
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        void Promise.resolve(work)
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener("abort", abort);
          });
      })
    : Promise.resolve(work);
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
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      options.baseUrl.includes("?") ||
      options.baseUrl.includes("#")
    ) {
      throw new ClientError(
        "Base URL cannot contain credentials, a query or a fragment",
      );
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
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) ||
        options.timeoutMs < 0 ||
        options.timeoutMs > 300_000)
    )
      throw new ClientError("timeoutMs must be between 0 and 300000");
    this.options = options;
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  createInput(
    profileId: string,
    input: JobInput["input"],
    id: string = crypto.randomUUID(),
  ): JobInput {
    return parseJobInput({ id, profileId, input });
  }

  async createRun(
    conversationId: string,
    input: JobInput,
    signal?: AbortSignal,
  ): Promise<Job> {
    const body = JSON.stringify(parseJobInput(input));
    for (let attempt = 0; ; attempt++) {
      try {
        return parseJob(
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
    return parseJob(
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

  async steer(
    conversationId: string,
    runId: string,
    input: JobInput["input"],
    id: string = crypto.randomUUID(),
    signal?: AbortSignal,
  ): Promise<void> {
    const body = JSON.stringify(parseSteering({ id, input }));
    for (let attempt = 0; ; attempt++) {
      try {
        await this.json(
          `${this.path(conversationId, runId)}/messages`,
          "POST",
          body,
          signal,
        );
        return;
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

  async getApproval(
    conversationId: string,
    runId: string,
    approvalId: string,
    signal?: AbortSignal,
  ): Promise<Approval> {
    return parseApproval(
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
    remember?: "run" | "conversation",
  ): Promise<void> {
    await this.json(
      `${this.path(conversationId, runId)}/approvals/${encodeURIComponent(approvalId)}/decision`,
      "POST",
      JSON.stringify(remember ? { approved, remember } : { approved }),
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
    let attempt = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const link = new AbortController();
      const stop = () => {
        link.abort();
      };
      options.signal?.addEventListener("abort", stop, { once: true });
      let stalled: unknown;
      let probing: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        clearTimeout(probing);
        const ms = this.timeoutMs;
        if (!ms || link.signal.aborted) return;
        probing = setTimeout(() => {
          void this.getRun(conversationId, runId, link.signal).then(
            watch,
            (error: unknown) => {
              stalled = error;
              link.abort();
            },
          );
        }, ms);
      };
      try {
        const response = await this.request(
          `${this.path(conversationId, runId)}/events?after=${String(cursor)}`,
          "GET",
          undefined,
          link.signal,
          true,
        );
        watch();
        if (
          !response.headers
            .get("content-type")
            ?.includes("application/x-ndjson")
        )
          throw new ClientError("Expected an NDJSON event stream");
        for await (const line of lines(response, 65_536)) {
          let event: RunEvent;
          try {
            event = parseEvent(JSON.parse(line));
          } catch {
            throw new ClientError("Invalid run event");
          }
          watch();
          if (event.type !== "text_delta") {
            if (event.sequence <= cursor) continue;
            if (event.sequence !== cursor + 1)
              throw new ClientError("Event sequence gap");
            cursor = event.sequence;
            attempt = 0;
          }
          yield event;
          if (terminal(event)) return;
        }
      } catch (error) {
        const failure = stalled ?? error;
        if (options.signal?.aborted || !retryable(failure)) throw failure;
      } finally {
        clearTimeout(probing);
        options.signal?.removeEventListener("abort", stop);
        link.abort();
      }
      if (attempt >= (this.options.maxRetries ?? 3))
        throw new ClientError("Event stream disconnected; reconnect to resume");
      options.onReconnect?.(attempt + 1);
      await wait(this.delay(attempt), options.signal);
      attempt++;
    }
  }

  private get timeoutMs() {
    return this.options.timeoutMs ?? 15_000;
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
    stream = false,
  ) {
    signal?.throwIfAborted();
    const deadline = stream ? this.deadline(signal) : undefined;
    const active = deadline?.signal ?? signal;
    try {
      const headers = new Headers(
        await abortable(this.options.headers?.(), active),
      );
      headers.set(
        "accept",
        url.includes("/events?") ? "application/x-ndjson" : "application/json",
      );
      if (body !== undefined) headers.set("content-type", "application/json");
      const response = await this.transport(url, {
        method,
        redirect: "error",
        headers,
        credentials: this.options.credentials ?? "same-origin",
        ...(body === undefined ? {} : { body }),
        ...(active ? { signal: active } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ClientError(
          `Request failed (${String(response.status)})`,
          response.status,
        );
      }
      return response;
    } catch (error) {
      throw deadline?.expired() ? timedOut() : error;
    } finally {
      deadline?.clear();
    }
  }

  private deadline(signal?: AbortSignal) {
    const controller = new AbortController();
    let expired = false;
    const timer = this.timeoutMs
      ? setTimeout(() => {
          expired = true;
          controller.abort();
        }, this.timeoutMs)
      : undefined;
    return {
      signal: signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal,
      expired: () => expired,
      clear: () => {
        clearTimeout(timer);
      },
    };
  }

  private async json(
    url: string,
    method: string,
    body?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const deadline = this.deadline(signal);
    try {
      const response = await this.request(url, method, body, deadline.signal);
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
    } catch (error) {
      throw deadline.expired() ? timedOut() : error;
    } finally {
      deadline.clear();
    }
  }
}
