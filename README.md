# sheys-opencode-plugins

Minimal, zero-bloat plugins for OpenCode V2 (`opencode v2.x`).

## Plugins

### `@shey/opencode-limits` ([`plugins/limits`](plugins/limits))

A single-command (`/limits`) usage & quota viewer for OpenCode TUI with zero background polling, no sidebars/footers, no post-turn toasts, and zero LLM calls.

**Features:**
- Registers `/limits` in the `/` menu, command palette, and composer (`r` to refresh, `c` to copy, `Esc`/`q` to close).
- Works on both the OpenCode Home screen and inside active sessions.
- Auto-detects and queries only providers you have credentials for:
  - **Tier 1 (Subscriptions & Rolling Quotas):** OpenCode Go, OpenCode Zen, Claude (`anthropic` / Claude Code Keychain), OpenAI / Codex (`openai` / `codex` / `chatgpt`), GitHub Copilot, Google AGY, Antigravity (agy) CLI quota via `agy -p /usage` (only when `OPENCODE_AGY_ENABLE=1`; set `OPENCODE_AGY_PATH` to override the binary), Gemini CLI.
  - **Tier 2 (API-Key Quotas & Balances):** Kimi Code, Z.ai / Zhipu GLM, MiniMax, Ollama Cloud, OpenRouter, DeepSeek.
- 60s in-memory cache + `429` exponential backoff cooldown.

**Optional filter in `~/.config/opencode/opencode.json`:**
```json
{
  "plugins": [
    [
      "/Users/testuser/workspace/sandbox/sheys-opencode-plugins/plugins/limits",
      {
        "exclude": ["opencode-zen"]
      }
    ]
  ]
}
```

### `@shey/opencode-antigravity-agent` ([`plugins/antigravity-agent`](plugins/antigravity-agent))

> **Disabled by default.** Google's Antigravity Additional Terms (§6) and FAQ say using third-party software, including OpenCode, with an Antigravity login, or wrapping `agy` in third-party coding agents, is not supported on consumer plans and can lead to suspension. The plugin does nothing unless `OPENCODE_AGY_ENABLE=1` is set; doing so on a consumer Google account is at your own risk. It will be enabled once Google publishes official guidance that allows this use.

Antigravity Agent: the Google Antigravity CLI (`agy`) as an OpenCode model provider, built the way OpenCode's native Claude Agent provider is. `agy` only supplies the model; OpenCode keeps its own tools, permissions, history, compaction, and subagents.

- Models come from `agy models` and appear as `antigravity-agent/<slug>` (Gemini, plus the Claude/GPT models your plan exposes).
- Sign in with `agy` once, then `/connect` → **Google** → **Antigravity Agent (agy CLI)**. The method only checks that `agy` is logged in; OpenCode never reads agy's credentials.
- agy's built-in file, shell, and URL tools are denied. OpenCode's tools reach agy as an MCP server; each call is held, run by OpenCode (permission prompts included), and the result is handed back to the same agy process.
- Quota shows up in `/limits` (5h and weekly, via `agy -p /usage`) only when `OPENCODE_AGY_ENABLE=1` is set.
- `OPENCODE_AGY_PATH` selects another `agy` binary. Requires Antigravity CLI to be installed and signed in on the same machine.
- Known gap: agy's `search_web` can't be blocked by a permission rule, so it stays available to the model.

```json
{
  "plugins": ["/Users/testuser/workspace/sandbox/sheys-opencode-plugins/plugins/antigravity-agent"]
}
```

## Development

```bash
npm run typecheck
npm run build
npm test
```
