import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResult,
} from "../core/contracts.js";
export function createFakeProvider(
  script: (
    request: ProviderRequest,
    call: number,
  ) => ProviderResult | Promise<ProviderResult>,
  deltas?: readonly string[],
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name: "fake",
    capabilities: { toolCalling: true, vision: true },
    requests,
    async complete(request) {
      requests.push(request);
      return script(request, requests.length);
    },
    ...(deltas && {
      async *stream(request) {
        requests.push(request);
        const result = await script(request, requests.length);
        for (const delta of deltas) yield { type: "text" as const, delta };
        return result;
      },
    }),
  };
}
