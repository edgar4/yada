import type { ActionExecutor } from "../core/action.js";
import type {
  Content,
  ProviderRequest,
  ProviderResult,
  Tool,
} from "../core/contracts.js";

export type Scenario = {
  name: string;
  input: Content;
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
