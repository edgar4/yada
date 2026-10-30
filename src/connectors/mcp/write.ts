import { createHash } from "node:crypto";
import { z } from "zod";
import type { Tool as RemoteTool } from "@modelcontextprotocol/sdk/types.js";
import type { WriteTool } from "../../core/action.js";
import type { Identity, ToolSpec } from "../../core/contracts.js";
import type { McpConfig, McpWriteMapping } from "./config.js";
import { canonical } from "./discovery.js";
import { structuredResult, type McpInvoke, type McpValidate } from "./rpc.js";
import { abortable } from "../../core/abort.js";

const preparation = z.strictObject({
  preview: z.string().min(1).max(32_000),
  version: z.string().min(1).max(1024),
});
const receipt = z.strictObject({
  status: z.literal("completed"),
  receipt: z.string().min(1).max(32_000),
});
const outcome = z.discriminatedUnion("status", [
  receipt,
  z.strictObject({ status: z.literal("unknown") }),
]);
const operationId = z.string().min(1).max(256);
export function mcpWriteTool(options: {
  config: McpConfig;
  mapping: McpWriteMapping;
  remote: RemoteTool;
  prepare: RemoteTool;
  receipt: RemoteTool;
  spec: ToolSpec;
  owner: Identity;
  authorize: (identity: Identity, tool: string) => Promise<boolean>;
  invoke: McpInvoke;
  validate: McpValidate;
}): WriteTool {
  const { config, mapping, remote, invoke } = options;
  const server =
    "url" in config
      ? { url: new URL(config.url).href }
      : { command: config.command, args: config.args ?? [] };
  const policy = {
    contractVersion: 1,
    server,
    mapping,
    tools: [remote, options.prepare, options.receipt].map((tool) => ({
      name: tool.name,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    })),
  };
  const version = `${mapping.version}:${createHash("sha256").update(canonical(policy)).digest("hex")}`;
  const metadata = (context: Record<string, string> = {}) => ({
    "io.yada/action": {
      contractVersion: 1,
      tool: remote.name,
      actorId: options.owner.actorId,
      tenantId: options.owner.tenantId,
      ...context,
    },
  });
  const authorize = (identity: Identity) =>
    options.authorize(identity, remote.name);
  const access = async (identity: Identity, signal: AbortSignal) => {
    if (!(await abortable(() => authorize(identity), signal)))
      throw new Error("MCP access denied");
  };
  return {
    effect: "write",
    version,
    spec: options.spec,
    authorize,
    async prepare(args, identity, signal) {
      await access(identity, signal);
      const input = options.validate(remote.name, args);
      return preparation.parse(
        structuredResult(
          await invoke(
            options.prepare.name,
            { arguments: input },
            identity,
            signal,
            metadata(),
          ),
        ),
      );
    },
    async execute(args, context) {
      await access(context.identity, context.signal);
      const meta = metadata({
        operationId: operationId.parse(context.operationId),
        version: preparation.shape.version.parse(context.version),
      });
      return receipt.parse(
        structuredResult(
          await invoke(
            remote.name,
            args,
            context.identity,
            context.signal,
            meta,
          ),
        ),
      ).receipt;
    },
    async reconcile(id, identity, signal) {
      await access(identity, signal);
      const result = outcome.parse(
        structuredResult(
          await invoke(
            options.receipt.name,
            {},
            identity,
            signal,
            metadata({ operationId: operationId.parse(id) }),
          ),
        ),
      );
      return result.status === "completed" ? result.receipt : undefined;
    },
  };
}
