import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { Suspended, type Suspension } from "../../core/action.js";
import type { ProviderAdapter, ToolRun, Turn } from "../../core/contracts.js";

type Active = { run: ToolRun | undefined; suspended?: Suspension };
const declined = () => new McpError(-1, "Sampling declined");
const charsPerToken = 4;

export function clientRequests(
  client: Client,
  settings: {
    sampling?: boolean | undefined;
    elicitation?: boolean | undefined;
  },
  provider?: ProviderAdapter,
) {
  let active: Active | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  if (settings.sampling)
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async ({ params }, extra) => {
        const run = active?.run;
        if (!provider || !run) throw declined();
        const messages = params.messages.map((message): Turn => {
          const text = [message.content].flat().map((block) => {
            if (block.type !== "text") throw declined();
            return block.text;
          });
          return message.role === "user"
            ? { role: "user", content: text.join("\n") }
            : { role: "assistant", content: text.join("\n"), toolCalls: [] };
        });
        const result = await provider.complete({
          system: params.systemPrompt ?? "",
          messages,
          tools: [],
          signal: extra.signal,
        });
        run.addUsage(result.usage);
        if (result.finishReason !== "stop" && result.finishReason !== "length")
          throw declined();
        const limit = Math.min(run.maxOutput, params.maxTokens * charsPerToken);
        return {
          model: provider.name,
          role: "assistant",
          content: { type: "text", text: result.content.slice(0, limit) },
          stopReason:
            result.finishReason === "length" || result.content.length > limit
              ? "maxTokens"
              : "endTurn",
        };
      },
    );
  if (settings.elicitation)
    client.setRequestHandler(ElicitRequestSchema, async ({ params }) => {
      const slot = active;
      if (!slot?.run?.ask || params.mode === "url")
        return { action: "decline" };
      if (slot.suspended) return { action: "cancel" };
      const answer = await slot.run.ask({
        message: params.message,
        requestedSchema: params.requestedSchema,
      });
      if ("approvalId" in answer) {
        slot.suspended = answer;
        return { action: "cancel" };
      }
      return answer;
    });
  return async <T>(
    run: ToolRun | undefined,
    call: () => Promise<T>,
  ): Promise<T> => {
    if (!settings.sampling && !settings.elicitation) return call();
    const turn = queue.then(async () => {
      const slot: Active = { run };
      active = slot;
      let result: T | undefined;
      try {
        result = await call();
      } catch (error) {
        if (!slot.suspended) throw error;
      } finally {
        active = undefined;
      }
      if (slot.suspended) throw new Suspended(slot.suspended);
      return result as T;
    });
    queue = turn.catch(() => undefined);
    return turn;
  };
}
