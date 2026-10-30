import { describe, expect, it, vi } from "vitest";
import {
  BrowserClient,
  ClientError,
  type RunEvent,
} from "../src/client/index.js";

const event = (
  sequence: number,
  type: RunEvent["type"] = "progress",
): RunEvent => ({ version: 1, sequence, type, at: 1 });
const input = { id: "run", profileId: "support", input: "Hello" };
const job = {
  id: "run",
  profileId: "support",
  input: "Hello",
  createdAt: 1,
  updatedAt: 1,
  status: "queued",
  cancelRequested: false,
  history: [],
  events: [event(1, "queued")],
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const stream = (...values: unknown[]) =>
  new Response(values.map((value) => JSON.stringify(value)).join("\n"), {
    headers: { "content-type": "application/x-ndjson" },
  });
const setup = (transport: typeof fetch, maxRetries = 0) =>
  new BrowserClient({
    baseUrl: "https://host.test/api/",
    fetch: transport,
    maxRetries,
    reconnectDelayMs: 0,
  });
const collect = async (events: AsyncGenerator<RunEvent>) => {
  const result = [];
  for await (const value of events) result.push(value);
  return result;
};

describe("browser client", () => {
  it("validates configuration and stable request input", () => {
    expect(() => new BrowserClient({ baseUrl: "file:///a" })).toThrow("HTTP");
    for (const maxRetries of [-1, 11, 0.5])
      expect(
        () => new BrowserClient({ baseUrl: "https://host.test", maxRetries }),
      ).toThrow("maxRetries");
    for (const reconnectDelayMs of [-1, 30_001, Infinity])
      expect(
        () =>
          new BrowserClient({ baseUrl: "https://host.test", reconnectDelayMs }),
      ).toThrow("reconnectDelayMs");
    const client = new BrowserClient({ baseUrl: "https://host.test" });
    expect(client.createInput("support", "Hello").id).toMatch(/^[\da-f-]{36}$/);
    expect(client.createInput("support", "Hello", "stable").id).toBe("stable");
    expect(() => client.createInput("support", "")).toThrow();
  });

  it("retries creates with the same id and fresh host authorization", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json(job));
    let token = 0;
    const client = new BrowserClient({
      baseUrl: "https://host.test",
      fetch: transport,
      maxRetries: 1,
      reconnectDelayMs: 0,
      credentials: "include",
      headers: () => ({ authorization: `Bearer ${String(++token)}` }),
    });
    const input = client.createInput("support", "Hello", "run");
    await expect(client.createRun("chat /", input)).resolves.toMatchObject(job);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://host.test/v1/conversations/chat%20%2F/runs",
    );
    expect(transport.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify(input),
      JSON.stringify(input),
    ]);
    expect(
      new Headers(transport.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer 2");
    expect(transport.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("encodes paths and retrieves runs, approvals, decisions and cancellation", async () => {
    const approval = {
      id: "a/b",
      preview: "Action",
      status: "pending",
      expiresAt: 3,
    };
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(job))
      .mockResolvedValueOnce(json(approval))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({}));
    const client = setup(transport);
    await expect(client.getRun("chat", "r/b")).resolves.toMatchObject(job);
    await expect(client.getApproval("chat", "run", "a/b")).resolves.toEqual(
      approval,
    );
    await client.decide("chat", "run", "a/b", false);
    await client.cancel("chat", "run");
    expect(transport.mock.calls.map((call) => call[0])).toEqual([
      "https://host.test/api/v1/conversations/chat/runs/r%2Fb",
      "https://host.test/api/v1/conversations/chat/runs/run/approvals/a%2Fb",
      "https://host.test/api/v1/conversations/chat/runs/run/approvals/a%2Fb/decision",
      "https://host.test/api/v1/conversations/chat/runs/run/cancel",
    ]);
    expect(transport.mock.calls[2]?.[1]?.body).toBe('{"approved":false}');
  });

  it("reconnects from its last cursor and deduplicates replay", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(stream(event(1, "queued")))
      .mockResolvedValueOnce(stream(event(1), event(2, "completed"), event(3)));
    const reconnect = vi.fn();
    await expect(
      collect(
        setup(transport, 2).events("chat", "run", { onReconnect: reconnect }),
      ),
    ).resolves.toEqual([event(1, "queued"), event(2, "completed")]);
    expect(transport.mock.calls[2]?.[0]).toContain("after=1");
    expect(reconnect.mock.calls).toEqual([[1], [2]]);
  });

  it("resumes an explicit cursor and closes at all terminal statuses", async () => {
    for (const type of ["completed", "failed", "cancelled"] as const) {
      await expect(
        collect(
          setup(
            vi
              .fn<typeof fetch>()
              .mockResolvedValue(stream(event(4), event(5, type))),
          ).events("chat", "run", { after: 3 }),
        ),
      ).resolves.toEqual([event(4), event(5, type)]);
    }
    for (const after of [-1, 0.5, Infinity])
      await expect(
        collect(setup(fetch).events("chat", "run", { after })),
      ).rejects.toThrow("cursor");
  });

  it("does not retry auth failures, invalid payloads or event gaps", async () => {
    for (const status of [401, 403, 409]) {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({}, status));
      await expect(
        collect(setup(transport, 3).events("chat", "run")),
      ).rejects.toMatchObject({ status });
      expect(transport).toHaveBeenCalledTimes(1);
    }
    for (const response of [
      stream({ version: 2 }),
      stream(event(2)),
      new Response("invalid", {
        headers: { "content-type": "application/x-ndjson" },
      }),
      new Response("{}"),
    ]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(
        collect(setup(transport, 3).events("chat", "run")),
      ).rejects.toBeInstanceOf(ClientError);
      expect(transport).toHaveBeenCalledTimes(1);
    }
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(json({}));
    await expect(
      setup(malformed, 3).createRun("chat", input),
    ).rejects.toThrow();
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it("limits retries and propagates creation errors", async () => {
    await expect(
      collect(
        setup(vi.fn<typeof fetch>().mockResolvedValue(stream()), 1).events(
          "chat",
          "run",
        ),
      ),
    ).rejects.toThrow("disconnected");
    await expect(
      setup(
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
        1,
      ).createRun("chat", input),
    ).rejects.toThrow("offline");
    await expect(
      setup(
        vi.fn<typeof fetch>().mockResolvedValue(json({}, 401)),
        1,
      ).createRun("chat", input),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("bounds streamed lines and JSON, releases readers and handles empty responses", async () => {
    const responses = [
      new Response("x".repeat(65_537), {
        headers: { "content-type": "application/x-ndjson" },
      }),
      new Response(null, {
        headers: { "content-type": "application/x-ndjson" },
      }),
    ];
    for (const response of responses)
      await expect(
        collect(
          setup(vi.fn<typeof fetch>().mockResolvedValue(response)).events(
            "chat",
            "run",
          ),
        ),
      ).rejects.toThrow();
    for (const response of [
      new Response("x".repeat(2_097_153)),
      new Response(('"' + "x".repeat(1_100_000) + '"\n').repeat(2)),
    ])
      await expect(
        setup(vi.fn<typeof fetch>().mockResolvedValue(response)).getRun(
          "chat",
          "run",
        ),
      ).rejects.toThrow("size limit");
    await expect(
      setup(
        vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid")),
      ).cancel("chat", "run"),
    ).rejects.toThrow("Invalid JSON");
    await expect(
      setup(vi.fn<typeof fetch>().mockResolvedValue(new Response(""))).cancel(
        "chat",
        "run",
      ),
    ).resolves.toBeUndefined();
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(
      `\n${JSON.stringify({ ...event(1, "completed"), text: "é" })}\n`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      },
      cancel,
    });
    await expect(
      collect(
        setup(
          vi.fn<typeof fetch>().mockResolvedValue(
            new Response(body, {
              headers: { "content-type": "application/x-ndjson" },
            }),
          ),
        ).events("chat", "run"),
      ),
    ).resolves.toMatchObject([{ text: "é" }]);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts creation, stream reconnection and outstanding fetches", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn<typeof fetch>();
    await expect(
      setup(transport).createRun("chat", input, controller.signal),
    ).rejects.toThrow();
    await expect(
      collect(
        setup(transport).events("chat", "run", { signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    const reconnect = new AbortController();
    const client = new BrowserClient({
      baseUrl: "https://host.test",
      fetch: vi.fn<typeof fetch>().mockResolvedValue(stream()),
      reconnectDelayMs: 1000,
    });
    const promise = collect(
      client.events("chat", "run", {
        signal: reconnect.signal,
        onReconnect: () => {
          setTimeout(() => {
            reconnect.abort();
          }, 1);
        },
      }),
    );
    await expect(promise).rejects.toThrow("Aborted");
  });
});
