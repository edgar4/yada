import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadSkills,
  readTool,
  writeTool,
  type ProviderRequest,
  type ProviderResult,
  type Tool,
  type ToolCall,
} from "../src/index.js";
import type { ActionExecutor } from "../src/core/action.js";

export type Scenario = {
  name: string;
  input: string;
  build: () => Promise<{
    tools: Tool[];
    system?: string;
    executeWrite?: ActionExecutor;
  }>;
  fake: (request: ProviderRequest, call: number) => ProviderResult;
  expect: {
    status: "completed" | "awaiting_approval";
    text?: string;
    calls?: { name: string; args?: Record<string, unknown> }[];
  };
};

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
  request.messages.filter((turn) => turn.role === "tool").at(-1)?.content ?? "";

const orders = readTool({
  name: "get_order",
  description: "Look up an order by its numeric id",
  input: z.strictObject({ id: z.string().regex(/^\d+$/) }),
  authorize,
  execute: ({ id }) => Promise.resolve(`Order ${id}: shipped`),
});

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
];
