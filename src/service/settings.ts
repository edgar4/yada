import type { Identity } from "../core/contracts.js";
export type RunContext = Readonly<{
  identity: Identity;
  conversationId: string;
  runId: string;
  profileId: string;
  startedProvider?: string;
}>;
export type ProfileSetting<T> = T | ((context: RunContext) => T | Promise<T>);
export function resolveSetting<T extends object>(
  setting: ProfileSetting<T>,
  context: RunContext,
): Promise<T>;
export function resolveSetting<T extends object>(
  setting: ProfileSetting<T> | undefined,
  context: RunContext,
): Promise<T | undefined>;
export async function resolveSetting<T extends object>(
  setting: ProfileSetting<T> | undefined,
  context: RunContext,
) {
  return typeof setting === "function" ? setting(context) : setting;
}
