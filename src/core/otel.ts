import type { Span as OtelSpan } from "@opentelemetry/api";
import { optionalImport } from "../optional.js";
import type { Span, Tracer } from "./telemetry.js";
type OtelApi = typeof import("@opentelemetry/api");
export async function otelTracer(
  api?: OtelApi,
  name = "yada",
): Promise<Tracer> {
  const { trace, context, SpanStatusCode } =
    api ??
    (await optionalImport(
      () => import("@opentelemetry/api"),
      "@opentelemetry/api",
      "The OpenTelemetry tracer",
    ));
  const tracer = trace.getTracer(name);
  const raw = new WeakMap<Span, OtelSpan>();
  return {
    startSpan(spanName, attributes, parent) {
      const parentSpan = parent && raw.get(parent);
      const span = tracer.startSpan(
        spanName,
        { attributes: attributes ?? {} },
        parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined,
      );
      const wrapped: Span = {
        setAttribute: (key, value) => void span.setAttribute(key, value),
        setStatus: ({ code }) =>
          void span.setStatus({
            code: code === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          }),
        end: () => {
          span.end();
        },
      };
      raw.set(wrapped, span);
      return wrapped;
    },
  };
}
