import { fileURLToPath } from "node:url";
import { z } from "zod";
import { contentText } from "../src/core/content.js";
import {
  loadSkills,
  readTool,
  writeTool,
  type ProviderRequest,
  type ProviderResult,
  type ToolCall,
} from "../src/index.js";
import type { Scenario } from "../src/evals/scenario.js";

const authorize = () => Promise.resolve(true);
const reply = (content: string): ProviderResult => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});
const call = (id: string, name: string, args: unknown): ProviderResult => ({
  content: "",
  toolCalls: [{ id, name, args } satisfies ToolCall],
  finishReason: "tool_calls",
});
const lastTool = (request: ProviderRequest) =>
  contentText(
    request.messages.filter((turn) => turn.role === "tool").at(-1)?.content ??
      "",
  );

const orders = readTool({
  name: "get_order",
  description: "Look up an order by its numeric id",
  input: z.strictObject({ id: z.string().regex(/^\d+$/) }),
  authorize,
  execute: ({ id }) => Promise.resolve(`Order ${id}: shipped`),
});

const redSquare =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

export const scenarios: Scenario[] = [
  {
    name: "tool error self-correction",
    input: "What is the status of order 42? Use the get_order tool.",
    build: () => Promise.resolve({ tools: [orders] }),
    fake: (request, n) =>
      n === 1
        ? call("1", "get_order", { id: "order-42" })
        : n === 2
          ? call("2", "get_order", { id: "42" })
          : reply(`Order 42 is ${lastTool(request).split(": ")[1] ?? "?"}`),
    expect: {
      status: "completed",
      text: "shipped",
      calls: [{ name: "get_order" }, { name: "get_order", args: { id: "42" } }],
    },
  },
  {
    name: "multi-tool",
    input:
      "Report the weather in Paris and the time in Tokyo. Use the tools weather and time.",
    build: () =>
      Promise.resolve({
        tools: [
          readTool({
            name: "weather",
            description: "Weather for a city",
            input: z.strictObject({ city: z.string() }),
            authorize,
            execute: () => Promise.resolve("sunny"),
          }),
          readTool({
            name: "time",
            description: "Local time for a city",
            input: z.strictObject({ city: z.string() }),
            authorize,
            execute: () => Promise.resolve("09:00"),
          }),
        ],
      }),
    fake: (_request, n) =>
      n === 1
        ? {
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              { id: "1", name: "weather", args: { city: "Paris" } },
              { id: "2", name: "time", args: { city: "Tokyo" } },
            ],
          }
        : reply("Paris is sunny and it is 09:00 in Tokyo"),
    expect: {
      status: "completed",
      text: "sunny",
      calls: [
        { name: "weather", args: { city: "Paris" } },
        { name: "time", args: { city: "Tokyo" } },
      ],
    },
  },
  {
    name: "approval suspension",
    input: "Rename the project to Atlas using the rename_project tool.",
    build: () =>
      Promise.resolve({
        tools: [
          writeTool({
            name: "rename_project",
            description: "Rename the project (requires approval)",
            version: "1",
            input: z.strictObject({ name: z.string() }),
            authorize,
            prepare: ({ name }) =>
              Promise.resolve({ preview: `Rename to ${name}`, version: "1" }),
            execute: () => Promise.resolve("renamed"),
          }),
        ],
        executeWrite: () =>
          Promise.resolve({
            status: "awaiting_approval",
            approvalId: "eval-approval",
          }),
      }),
    fake: () => call("1", "rename_project", { name: "Atlas" }),
    expect: {
      status: "awaiting_approval",
      calls: [{ name: "rename_project", args: { name: "Atlas" } }],
    },
  },
  {
    name: "skill read",
    input: "How long do customers have to request a refund? Use the skills.",
    build: async () => {
      const skills = await loadSkills({
        directories: [fileURLToPath(new URL("skills", import.meta.url))],
        authorize,
      });
      return { tools: [...skills.tools], system: skills.system };
    },
    fake: (request, n) =>
      n === 1
        ? call("1", "yada_read_skill", { name: "support" })
        : reply(
            lastTool(request).includes("REFUND-30")
              ? "30 days, code REFUND-30"
              : "unknown",
          ),
    expect: {
      status: "completed",
      text: "REFUND-30",
      calls: [{ name: "yada_read_skill", args: { name: "support" } }],
    },
  },
  {
    name: "long output",
    input:
      "Call the dump tool and tell me the secret code at the start of its output.",
    build: () =>
      Promise.resolve({
        tools: [
          readTool({
            name: "dump",
            description: "Dump a large report",
            input: z.strictObject({}),
            authorize,
            execute: () =>
              Promise.resolve(`Secret code: 7731\n${"x".repeat(200_000)}`),
          }),
        ],
      }),
    fake: (request, n) =>
      n === 1
        ? call("1", "dump", {})
        : reply(
            lastTool(request).includes("[truncated")
              ? "The secret code is 7731 (output truncated)"
              : "output was not truncated",
          ),
    expect: {
      status: "completed",
      text: "7731",
      calls: [{ name: "dump" }],
    },
  },
  {
    name: "reasoning replay",
    input:
      "Call get_code for 'alpha', then call redeem with exactly the code it returns.",
    build: () =>
      Promise.resolve({
        tools: [
          readTool({
            name: "get_code",
            description: "Get a one-time code for a name",
            input: z.strictObject({ name: z.string() }),
            authorize,
            execute: () => Promise.resolve("code 8841"),
          }),
          readTool({
            name: "redeem",
            description: "Redeem a code",
            input: z.strictObject({ code: z.string() }),
            authorize,
            execute: ({ code }) => Promise.resolve(`redeemed ${code}`),
          }),
        ],
      }),
    fake: (request, n) =>
      n === 1
        ? {
            ...call("1", "get_code", { name: "alpha" }),
            providerMetadata: { provider: "fake", data: { thinking: "t1" } },
          }
        : n === 2
          ? request.messages.some(
              (turn) =>
                turn.role === "assistant" &&
                turn.providerMetadata?.data["thinking"] === "t1",
            )
            ? call("2", "redeem", { code: "8841" })
            : reply("reasoning was not replayed")
          : reply("Redeemed 8841"),
    expect: {
      status: "completed",
      text: "8841",
      calls: [{ name: "get_code" }, { name: "redeem", args: { code: "8841" } }],
    },
  },
  {
    name: "parallel reads",
    input:
      "Look up the stock of items a1, b2 and c3 with the stock tool. Call it for all three at once.",
    build: () =>
      Promise.resolve({
        tools: [
          readTool({
            name: "stock",
            description: "Stock level for an item id",
            input: z.strictObject({ id: z.string() }),
            authorize,
            execute: ({ id }) => Promise.resolve(`${id}: 5`),
          }),
        ],
      }),
    fake: (_request, n) =>
      n === 1
        ? {
            content: "",
            finishReason: "tool_calls",
            toolCalls: ["a1", "b2", "c3"].map((id) => ({
              id,
              name: "stock",
              args: { id },
            })),
          }
        : reply("a1, b2 and c3 each have 5 in stock"),
    expect: {
      status: "completed",
      text: "5",
      calls: ["a1", "b2", "c3"].map((id) => ({ name: "stock", args: { id } })),
    },
  },
  {
    name: "multimodal",
    input: [
      { type: "text", text: "What single color is this image? One word." },
      { type: "image", mimeType: "image/png", data: redSquare },
    ],
    build: () => Promise.resolve({ tools: [] }),
    fake: (request) =>
      reply(
        request.messages.some(
          (turn) =>
            turn.role === "user" &&
            Array.isArray(turn.content) &&
            turn.content.some((part) => part.type === "image"),
        )
          ? "Red"
          : "unknown",
      ),
    expect: { status: "completed", text: "red" },
  },
];
