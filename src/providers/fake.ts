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
): ProviderAdapter & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    name: "fake",
    capabilities: { toolCalling: true },
    requests,
    async complete(request) {
      requests.push(request);
      return script(request, requests.length);
    },
  };
}
