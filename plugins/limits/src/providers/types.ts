import type { Plugin } from "@opencode/plugin";
import type { ProviderLimitsCache } from "../cache.js";
import type { ProviderLimits } from "../types.js";

export type ExecImpl = (
  file: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<string>;

export interface ProviderContext {
  readonly ctx: Plugin.Context;
  readonly cache: ProviderLimitsCache;
  readonly fetchImpl?: typeof fetch;
  readonly execImpl?: ExecImpl;
}

export interface QuotaProvider {
  readonly id: string;
  readonly name: string;
  readonly fetch: (pctx: ProviderContext) => Promise<ProviderLimits | undefined>;
}
