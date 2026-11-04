import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { abortable } from "../../core/abort.js";
import type { Identity, ReadTool } from "../../core/contracts.js";
import { readTool } from "../../core/tool.js";
import { mcpAccessDenied, renderBlock, requestFailure } from "./rpc.js";

const limit = 32_000;
export type McpPrompt = Pick<Prompt, "name" | "description" | "arguments">;
type Options = Readonly<{
  client: Client;
  timeout: number;
  authorize: (identity: Identity, name: string) => Promise<boolean>;
  fresh: () => Promise<void>;
}>;
const guarded = async <T>(
  options: Options,
  identity: Identity,
  name: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> => {
  if (!(await abortable(() => options.authorize(identity, name), signal)))
    throw mcpAccessDenied();
  await options.fresh();
  return run();
};
const fail = (error: unknown): never => {
  throw requestFailure(error);
};
export function resourceTools(server: string, options: Options): ReadTool[] {
  const { client, timeout } = options;
  const define = <S extends z.ZodType>(
    name: string,
    description: string,
    input: S,
    run: (args: z.output<S>, signal: AbortSignal) => Promise<string>,
  ) =>
    readTool({
      name: `${server}__${name}`,
      description,
      input,
      authorize: (identity) => options.authorize(identity, name),
      async execute(args, identity, signal) {
        return (
          await guarded(options, identity, name, signal, () =>
            run(args, signal),
          )
        ).slice(0, limit);
      },
    });
  return [
    define(
      "list_resources",
      "List resources exposed by the server. Pass nextCursor as cursor for more.",
      z.object({ cursor: z.string().optional() }),
      async ({ cursor }, signal) => {
        const page = await client
          .listResources(cursor ? { cursor } : {}, { signal, timeout })
          .catch(fail);
        const resources = page.resources.map(
          ({ uri, name, description, mimeType }) => ({
            uri,
            name,
            description,
            mimeType,
          }),
        );
        const render = (count: number) =>
          JSON.stringify({
            resources: resources.slice(0, count),
            nextCursor: page.nextCursor,
            ...(count < resources.length ? { truncated: true } : {}),
          });
        let count = resources.length;
        while (count > 0 && render(count).length > limit) count--;
        return render(count);
      },
    ),
    define(
      "read_resource",
      "Read the text of a resource by URI.",
      z.object({ uri: z.string().min(1) }),
      async ({ uri }, signal) => {
        const result = await client
          .readResource({ uri }, { signal, timeout })
          .catch(fail);
        return result.contents
          .map((item) =>
            "text" in item ? item.text : `[blob: ${item.mimeType ?? uri}]`,
          )
          .join("\n");
      },
    ),
  ];
}
export function promptApi(options: Options) {
  const { client, timeout } = options;
  return {
    async prompts(
      identity: Identity,
      signal: AbortSignal = AbortSignal.timeout(timeout),
    ): Promise<McpPrompt[]> {
      return guarded(options, identity, "list_prompts", signal, async () => {
        const prompts: McpPrompt[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          if (cursors.size >= 100)
            throw new Error("MCP discovery limit exceeded");
          const result = await client
            .listPrompts(cursor ? { cursor } : {}, { signal, timeout })
            .catch(fail);
          prompts.push(
            ...result.prompts.map(({ name, description, arguments: args }) => ({
              name,
              description,
              arguments: args,
            })),
          );
          cursor = result.nextCursor;
          if (cursor) {
            if (cursors.has(cursor)) throw new Error("Repeated MCP cursor");
            cursors.add(cursor);
          }
        } while (cursor);
        return prompts;
      });
    },
    async getPrompt(
      identity: Identity,
      name: string,
      args: Record<string, string> = {},
      signal: AbortSignal = AbortSignal.timeout(timeout),
    ): Promise<string> {
      const result = await guarded(
        options,
        identity,
        "get_prompt",
        signal,
        () =>
          client
            .getPrompt({ name, arguments: args }, { signal, timeout })
            .catch(fail),
      );
      const text = result.messages
        .map((message) => renderBlock(message.content))
        .join("\n\n");
      if (text.length > limit) throw new Error("MCP result too large");
      return text;
    },
  };
}
