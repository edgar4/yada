import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { abortable } from "../../core/abort.js";
import type { Identity, ReadTool } from "../../core/contracts.js";
import { readTool } from "../../core/tool.js";
import { renderBlock } from "./rpc.js";

const limit = 32_000;
export type McpPrompt = Pick<Prompt, "name" | "description" | "arguments">;
type Options = Readonly<{
  client: Client;
  timeout: number;
  authorize: (identity: Identity, name: string) => Promise<boolean>;
  fresh: () => Promise<void>;
}>;
const failed = () => new Error("MCP request failed");
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
        if (!(await abortable(() => options.authorize(identity, name), signal)))
          throw new Error("MCP access denied");
        await options.fresh();
        return (await run(args, signal)).slice(0, limit);
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
          .catch(() => {
            throw failed();
          });
        return JSON.stringify({
          resources: page.resources.map(
            ({ uri, name, description, mimeType }) => ({
              uri,
              name,
              description,
              mimeType,
            }),
          ),
          nextCursor: page.nextCursor,
        });
      },
    ),
    define(
      "read_resource",
      "Read the text of a resource by URI.",
      z.object({ uri: z.string().min(1) }),
      async ({ uri }, signal) => {
        const result = await client
          .readResource({ uri }, { signal, timeout })
          .catch(() => {
            throw failed();
          });
        return result.contents
          .map((item) =>
            "text" in item ? item.text : `[blob: ${item.mimeType ?? uri}]`,
          )
          .join("\n");
      },
    ),
  ];
}
export function promptApi(options: Omit<Options, "authorize">) {
  const { client, timeout, fresh } = options;
  return {
    async prompts(signal?: AbortSignal): Promise<McpPrompt[]> {
      await fresh();
      const prompts: McpPrompt[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await client
          .listPrompts(cursor ? { cursor } : {}, {
            ...(signal ? { signal } : {}),
            timeout,
          })
          .catch(() => {
            throw failed();
          });
        prompts.push(
          ...result.prompts.map(({ name, description, arguments: args }) => ({
            name,
            description,
            arguments: args,
          })),
        );
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return prompts;
    },
    async getPrompt(
      name: string,
      args: Record<string, string> = {},
      signal?: AbortSignal,
    ): Promise<string> {
      await fresh();
      const result = await client
        .getPrompt(
          { name, arguments: args },
          { ...(signal ? { signal } : {}), timeout },
        )
        .catch(() => {
          throw failed();
        });
      const text = result.messages
        .map((message) => renderBlock(message.content))
        .join("\n\n");
      if (text.length > limit) throw new Error("MCP result too large");
      return text;
    },
  };
}
