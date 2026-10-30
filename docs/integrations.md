---
layout: doc
title: "Existing worker integration"
---

# Existing worker integration

`createTalonProvider` adapts a normalized Yada provider to Talon's existing worker provider contract. Pass it as the worker's `provider` dependency or return it from the host's provider registry factory. The host continues to run its graph, tools, PostgreSQL checkpoints and private Go API.

```ts
import {
  createProvider,
  providerConfigFromEnv,
  createTalonProvider,
} from "yada";

const provider = createTalonProvider(
  createProvider(providerConfigFromEnv(process.env)),
  { profile: "existing-profile", contextTokens: 128_000 },
);
```

Select a compatible provider with `YADA_LLM_PROVIDER`, `YADA_LLM_MODEL`, and `YADA_LLM_API_KEY` as described in [provider configuration](configuration.md). Use a verified context-window size and keep the host's capability check. The profile is a host-owned identifier used for checkpoint pinning and private metrics. Keep it stable when substituting the implementation for the same approved profile. Register a new profile when changing provider/model policy; existing conversations must retain their pinned implementation until drained or explicitly migrated.

The bridge maps assistant tool-call history, schemas and cancellation signals, returns structured tool calls and normalized private token usage when available, and discards generated prose. Invalid argument objects return through the host's invalid-call repair path. It never executes tools or creates runs, leases, approvals, events or receipts. The existing host remains responsible for tenant binding, reserved fields, policy, permission checks, write approval, operation IDs, receipt reconciliation and grounded presentation. Do not put the generic Yada HTTP service in front of existing runs as a second authority.

Providers requiring continuation metadata, including signed reasoning/tool-call histories, are refused because this host contract cannot persist that metadata. Redundant canonical function-call fields from the OpenAI SDK are accepted and stripped; unknown metadata or extra signature fields are refused. Use a compatible profile without continuation metadata for this integration. Supporting those profiles requires a versioned host message/checkpoint change that roundtrips metadata privately and preserves provider affinity; dropping signatures or caching them globally is unsafe. Yada's provider adapters also reject malformed SDK tool-call responses before the bridge; those failures follow the host's existing provider-error path.

For a local migration rehearsal, capture the existing deterministic worker/eval baseline, substitute the bridge at the provider factory, and run the same tests against the same graph and fake Go/MCP fixtures. Restore the original provider factory and repeat them to verify rollback. Include resumed conversations, stale fences, cancellation, approval/decline, duplicate decision, uncertain receipts and public output redaction. Deterministic oracle fixtures establish integration behavior, not live model task quality or production readiness.

Before any real rollout, drain active runs or preserve their pinned provider implementation, retain the original worker artifact/configuration, and test checkpoint restore and rollback with the real database. A full worker migration additionally needs an executor that accepts externally owned Go claims/fences, resumes existing checkpoints and decisions, and maps outcomes into the host's approved templates/cards without creating a second approval or lease system. This provider bridge does not migrate the worker, public API, web/mobile clients or stored checkpoints.
