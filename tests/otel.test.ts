import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { otelTracer } from "../src/core/otel.js";
import { eventSchema } from "../src/service/contracts.js";

const fakeApi = () => {
  const spans: {
    name: string;
    attributes: unknown;
    parent: unknown;
    set: Record<string, unknown>;
    status: { code: number } | undefined;
    ended: boolean;
  }[] = [];
  const api = {
    SpanStatusCode: { UNSET: 0, OK: 1, ERROR: 2 },
    context: { active: () => "ctx" },
    trace: {
      setSpan: (_ctx: unknown, span: unknown) => ({ parent: span }),
      getTracer: (name: string) => {
        expect(name).toBe("yada");
        return {
          startSpan: (
            spanName: string,
            options: { attributes: unknown },
            ctx?: { parent: unknown },
          ) => {
            const record = {
              name: spanName,
              attributes: options.attributes,
              parent: ctx?.parent,
              set: {} as Record<string, unknown>,
              status: undefined as { code: number } | undefined,
              ended: false,
            };
            spans.push(record);
            return {
              record,
              setAttribute: (key: string, value: unknown) => {
                record.set[key] = value;
              },
              setStatus: (status: { code: number }) => {
                record.status = status;
              },
              end: () => {
                record.ended = true;
              },
            };
          },
        };
      },
    },
  };
  return { api: api as never, spans };
};

describe("otelTracer", () => {
  it("creates spans with attributes, parents, status and end", async () => {
    const { api, spans } = fakeApi();
    const tracer = await otelTracer(api);
    const root = tracer.startSpan("yada.run");
    const child = tracer.startSpan("yada.tool", { "tool.name": "a" }, root);
    child.setAttribute("tool.outcome", "ok");
    child.setStatus({ code: "ok" });
    child.end();
    root.setStatus({ code: "error" });
    root.end();
    expect(spans.map((span) => span.name)).toEqual(["yada.run", "yada.tool"]);
    expect(spans[1]?.attributes).toEqual({ "tool.name": "a" });
    expect(spans[1]?.set).toEqual({ "tool.outcome": "ok" });
    expect(spans[0]?.parent).toBeUndefined();
    expect(spans[1]?.parent).toBeDefined();
    expect(spans[1]?.status).toEqual({ code: 1 });
    expect(spans[0]?.status).toEqual({ code: 2 });
    expect(spans.every((span) => span.ended)).toBe(true);
  });
  it("loads the installed package by default", async () => {
    const tracer = await otelTracer();
    const span = tracer.startSpan("yada.run");
    span.setStatus({ code: "ok" });
    span.end();
  });
});

describe("service event fixture", () => {
  it("parses with eventSchema in order", () => {
    const events = readFileSync("tests/fixtures/service-events.ndjson", "utf8")
      .trim()
      .split("\n")
      .map((line) => eventSchema.parse(JSON.parse(line)));
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.at(-1)?.type).toBe("completed");
  });
});
