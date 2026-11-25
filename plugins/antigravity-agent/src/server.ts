import { Integration, Model, Plugin, Provider } from "@opencode/plugin";
import { findAgy, listModels, type AgyModel } from "./models.js";

const PROVIDER_ID = "antigravity-agent";
/** Antigravity signs in with a Google account, so it lives in the Google group of the `/connect` picker. */
const INTEGRATION_ID = "google";
const METHOD_ID = "antigravity-agent";
const CACHE_KEY = "models";

function contextWindow(id: string): number {
  return id.startsWith("claude") || id.startsWith("gpt") ? 200_000 : 1_000_000;
}

function isAgyModel(value: unknown): value is AgyModel {
  return typeof value === "object" && value !== null && typeof (value as AgyModel).id === "string" && typeof (value as AgyModel).name === "string";
}

export const AntigravityAgentPlugin = Plugin.define({
  id: "shey.antigravity-agent",
  async setup(ctx) {
    // Disabled by default: Google's Antigravity terms and FAQ say wrapping `agy` in third-party agents is not
    // supported on consumer plans. Re-enable by default only once Google publishes official guidance allowing it.
    if (process.env.OPENCODE_AGY_ENABLE !== "1") return;
    const agyPath = findAgy();
    if (!agyPath) return;

    const providerID = Provider.ID.make(PROVIDER_ID);
    const source = { models: [] as AgyModel[] };
    const cached = await ctx.storage.get(CACHE_KEY);
    if (Array.isArray(cached)) source.models = cached.filter(isAgyModel);

    // Cold start: nothing cached yet, so wait for agy once instead of showing no models.
    if (source.models.length === 0) {
      source.models = await listModels(agyPath).catch(() => []);
      if (source.models.length > 0) await ctx.storage.set(CACHE_KEY, source.models as unknown as never);
    }

    const packageUrl = new URL("./provider.js", import.meta.url).href;

    await ctx.provider.transform((editor) => {
      if (source.models.length === 0) return;
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Antigravity Agent",
          activation: "enabled",
          package: packageUrl,
          integrationID: Integration.ID.make(INTEGRATION_ID),
        },
        models: source.models.map((agy) => ({
          ...Model.Info.default(providerID, Model.ID.make(agy.id)),
          name: agy.name,
          capabilities: { ...Model.Info.default(providerID, Model.ID.make(agy.id)).capabilities, tools: true },
          limit: { context: contextWindow(agy.id), output: 64_000 },
        })),
      });
    });

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: {
          id: Integration.MethodID.make(METHOD_ID),
          type: "command",
          label: "Antigravity Agent (agy CLI)",
          // OpenCode saves a command's stdout as the key. `agy models` fails unless agy is signed in, so this checks
          // the login and stores only a short marker; agy keeps its own credentials and OpenCode never reads them.
          command: ["sh", "-c", `"${agyPath}" models >/dev/null 2>&1 && echo agy-cli`],
        },
      });
    });

    // The model list comes from agy itself and is cached so OpenCode can show it without spawning agy at startup.
    void listModels(agyPath)
      .then(async (models) => {
        if (models.length === 0) return;
        const changed = JSON.stringify(models) !== JSON.stringify(source.models);
        source.models = models;
        await ctx.storage.set(CACHE_KEY, models as unknown as never);
        if (changed) await ctx.provider.reload();
      })
      .catch(() => undefined);
  },
});

export default AntigravityAgentPlugin;
