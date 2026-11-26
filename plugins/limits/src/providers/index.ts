import type { LimitsPluginOptions, LimitsSnapshot, ProviderLimits } from "../types.js";
import { fetchAntigravityAgent } from "./antigravity-cli.js";
import { fetchAnthropic } from "./anthropic.js";
import { API_KEY_PROVIDERS } from "./api-key-vendors.js";
import { fetchCopilot } from "./copilot.js";
import { fetchGoogleAgy, fetchGoogleGeminiCli } from "./google.js";
import { fetchOpenAI } from "./openai.js";
import { fetchOpenCodeGo } from "./opencode-go.js";
import { fetchOpenCodeZen } from "./opencode-zen.js";
import type { ProviderContext, QuotaProvider } from "./types.js";

export const ALL_PROVIDERS: readonly QuotaProvider[] = [
  { id: "opencode-go", name: "OpenCode Go", fetch: fetchOpenCodeGo },
  { id: "anthropic", name: "Claude", fetch: fetchAnthropic },
  { id: "openai", name: "OpenAI / Codex", fetch: fetchOpenAI },
  { id: "copilot", name: "GitHub Copilot", fetch: fetchCopilot },
  { id: "google-agy", name: "Google AGY", fetch: fetchGoogleAgy },
  { id: "antigravity-agent", name: "Antigravity (agy)", fetch: fetchAntigravityAgent },
  { id: "google-gemini-cli", name: "Gemini CLI", fetch: fetchGoogleGeminiCli },
  { id: "opencode-zen", name: "OpenCode Zen", fetch: fetchOpenCodeZen },
  ...API_KEY_PROVIDERS,
];

function selectProviders(options?: LimitsPluginOptions): readonly QuotaProvider[] {
  const include = options?.include ? new Set(options.include) : undefined;
  const exclude = options?.exclude ? new Set(options.exclude) : undefined;

  // The Antigravity Agent provider is disabled by default, so its quota row is hidden unless it is enabled.
  const agyEnabled = process.env.OPENCODE_AGY_ENABLE === "1";

  return ALL_PROVIDERS.filter((provider) => {
    if (provider.id === "antigravity-agent" && !agyEnabled) return false;
    if (include && !include.has(provider.id)) return false;
    if (exclude && exclude.has(provider.id)) return false;
    return true;
  });
}

async function runProvider(
  provider: QuotaProvider,
  pctx: ProviderContext,
  force: boolean,
  nowMs: number,
): Promise<ProviderLimits | undefined> {
  const cached = pctx.cache.get(provider.id, provider.name, nowMs, force);
  if (cached) return cached;

  try {
    const result = await provider.fetch(pctx);
    if (!result) return undefined;
    if (result.status === "ok") {
      pctx.cache.recordSuccess(provider.id, result, Date.now());
    }
    return result;
  } catch (error) {
    return {
      id: provider.id,
      name: provider.name,
      status: "error",
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectLimitsSnapshot(
  pctx: ProviderContext,
  options: { readonly force?: boolean; readonly pluginOptions?: LimitsPluginOptions } = {},
): Promise<LimitsSnapshot> {
  const nowMs = Date.now();
  const force = options.force ?? false;
  const activeProviders = selectProviders(options.pluginOptions);

  const settled = await Promise.all(
    activeProviders.map((provider) => runProvider(provider, pctx, force, nowMs)),
  );

  return {
    fetchedAtMs: Date.now(),
    providers: settled.filter((item): item is ProviderLimits => item !== undefined),
  };
}
