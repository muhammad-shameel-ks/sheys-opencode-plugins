# sheys-opencode-plugins

Minimal, zero-bloat plugins for OpenCode V2 (`opencode v2.x`).

## Plugins

### `@shey/opencode-limits` ([`plugins/limits`](plugins/limits))

A single-command (`/limits`) usage & quota viewer for OpenCode TUI with zero background polling, no sidebars/footers, no post-turn toasts, and zero LLM calls.

**Features:**
- Registers `/limits` in the `/` menu, command palette, and composer (`r` to refresh, `c` to copy, `Esc`/`q` to close).
- Works on both the OpenCode Home screen and inside active sessions.
- Auto-detects and queries only providers you have credentials for:
  - **Tier 1 (Subscriptions & Rolling Quotas):** OpenCode Go, OpenCode Zen, Claude (`anthropic` / Claude Code Keychain), OpenAI / Codex (`openai` / `codex` / `chatgpt`), GitHub Copilot, Google AGY, Gemini CLI.
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

## Development

```bash
npm run typecheck
npm run build
npm test
```
