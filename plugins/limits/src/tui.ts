import type { BaseRenderable } from "@opentui/core";
import { createElement, createTextNode, effect, insert, insertNode, setProp, type JSX } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { batch, createSignal, onCleanup } from "solid-js";
import { formatLimitsText, formatPercent, formatResetCountdown, renderBar } from "./format.js";
import { LimitsRpc } from "./rpc.js";
import type { LimitRow, LimitsSnapshot, ProviderLimits } from "./types.js";

type TuiContext = Plugin.Context;

const RPC_TIMEOUT_MS = 15_000;

type TextNodeLike = string | JSX.Element | (() => string | JSX.Element);

function el(tag: string, props: Record<string, unknown>, ...children: TextNodeLike[]): JSX.Element {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "function" && key !== "onMouseUp" && key !== "onMouseDown") {
      effect(() => {
        setProp(node, key, (value as () => unknown)());
      });
    } else {
      setProp(node, key, value);
    }
  }
  const multi = children.length > 1;
  for (const child of children) {
    if (typeof child === "string") {
      insertNode(node, createTextNode(child));
    } else if (typeof child === "function") {
      insert(node, child, multi ? null : undefined);
    } else {
      insertNode(node, child as unknown as BaseRenderable);
    }
  }
  return node as unknown as JSX.Element;
}

function span(text: string | (() => string), style: Record<string, unknown> | (() => Record<string, unknown>)): JSX.Element {
  return el("span", { style }, text);
}

function usageColor(api: TuiContext, percentUsed: number | undefined): unknown {
  const feedback = api.theme.text.feedback;
  if (percentUsed === undefined) return api.theme.text.base;
  if (percentUsed >= 90) return feedback.error.base;
  if (percentUsed >= 70) return feedback.warning.base;
  return feedback.success.base;
}

function rpcErrorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function renderProviderBlock(api: TuiContext, provider: ProviderLimits, nowMs: () => number): JSX.Element {
  const accent = api.theme.hue?.accent?.[500] ?? api.theme.text.base;
  const muted = api.theme.text.muted;
  const base = api.theme.text.base;
  const errColor = api.theme.text.feedback.error.base;

  const titleParts: TextNodeLike[] = [
    span(provider.name, { fg: accent, bold: true }),
  ];
  if (provider.account) {
    titleParts.push(span(` (${provider.account})`, { fg: muted }));
  }
  if (provider.cached) {
    titleParts.push(span(" [cached]", { fg: muted }));
  }

  const labelWidth = Math.max(10, ...provider.rows.map((r) => r.label.length));

  const renderRow = (row: LimitRow): JSX.Element => {
    const parts: TextNodeLike[] = [
      span(`  ${row.label.padEnd(labelWidth)}  `, { fg: base }),
    ];

    if (row.percentUsed !== undefined) {
      const color = usageColor(api, row.percentUsed);
      parts.push(
        span(`${renderBar(row.percentUsed)} ${formatPercent(row.percentUsed).padStart(5)}`, { fg: color }),
      );
      if (row.valueText) {
        parts.push(span(`  ${row.valueText}`, { fg: muted }));
      }
    } else {
      parts.push(span(row.valueText ?? "-", { fg: base }));
    }

    if (row.resetsAt) {
      parts.push(
        span(
          () => {
            const countdown = formatResetCountdown(row.resetsAt, nowMs());
            return countdown ? `  ${countdown}` : "";
          },
          { fg: muted },
        ),
      );
    }

    return el("text", { wrapMode: "none", selectable: false }, ...parts);
  };

  return el(
    "box",
    { flexDirection: "column", marginBottom: 1 },
    el("text", { wrapMode: "none", selectable: false }, ...titleParts),
    ...(provider.status === "error"
      ? [el("text", { wrapMode: "word", selectable: false }, span(`  Error: ${provider.error ?? "Unavailable"}`, { fg: errColor }))]
      : provider.rows.length === 0
        ? [el("text", { wrapMode: "none", selectable: false }, span("  No active quota windows", { fg: muted }))]
        : provider.rows.map((row) => renderRow(row))),
  );
}

export const LimitsTuiPlugin = Plugin.define({
  id: "shey.opencode-limits.tui",
  setup(api) {
    const [dialogOpen, setDialogOpen] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [snapshot, setSnapshot] = createSignal<LimitsSnapshot | undefined>(undefined);
    const [errorText, setErrorText] = createSignal<string | undefined>(undefined);
    const [nowMs, setNowMs] = createSignal(Date.now());
    let activeController: AbortController | undefined;

    async function loadLimits(force = false): Promise<void> {
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;

      batch(() => {
        setLoading(true);
        setErrorText(undefined);
      });

      try {
        const location = api.location ?? api.data.location.default();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]);
        const result = await api.client.rpc(LimitsRpc).getLimits(
          { force },
          { ...(location ? { location } : {}), signal },
        );
        if (controller.signal.aborted) return;
        batch(() => {
          setSnapshot(result);
          setNowMs(Date.now());
          setLoading(false);
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        batch(() => {
          setErrorText(rpcErrorText(error));
          setLoading(false);
        });
      } finally {
        if (activeController === controller && loading()) {
          setLoading(false);
        }
      }
    }

    function copySnapshot(): void {
      const current = snapshot();
      if (!current) return;
      const text = formatLimitsText(current, Date.now());
      const copied = api.renderer.copyToClipboardOSC52(text);
      api.ui.toast.show({
        variant: copied ? "success" : "warning",
        title: "Limits",
        message: copied ? "Copied limits to clipboard" : "Terminal clipboard copy unavailable",
        duration: 3_000,
      });
    }

    function openLimitsDialog(force = false): void {
      const wasOpen = dialogOpen();
      void loadLimits(force);
      if (!wasOpen) {
        setDialogOpen(true);
        api.ui.dialog.set({ size: "large", centered: true });
        api.ui.dialog.show(
          () => {
            const ticker = setInterval(() => setNowMs(Date.now()), 30_000);
            onCleanup(() => clearInterval(ticker));

            const muted = api.theme.text.muted;
            const base = api.theme.text.base;
            const errColor = api.theme.text.feedback.error.base;

            return el(
              "box",
              { flexDirection: "column", paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 },
              el(
                "box",
                { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 },
                el(
                  "text",
                  { wrapMode: "none", selectable: false },
                  span("Limits", { fg: base, bold: true }),
                  span(() => (loading() ? "  loading..." : ""), { fg: muted }),
                ),
                el(
                  "text",
                  { wrapMode: "none", selectable: false },
                  span("r refresh · c copy · esc close", { fg: muted }),
                ),
              ),
              el(
                "scrollbox",
                { flexDirection: "column", maxHeight: 24 },
                () => {
                  const err = errorText();
                  if (err) {
                    return el("text", { wrapMode: "word", selectable: false }, span(`Failed to load limits: ${err}`, { fg: errColor }));
                  }
                  const snap = snapshot();
                  if (!snap) {
                    return el(
                      "text",
                      { wrapMode: "none", selectable: false },
                      span(loading() ? "Checking active providers..." : "No limits loaded yet.", { fg: muted }),
                    );
                  }
                  if (snap.providers.length === 0) {
                    return el(
                      "text",
                      { wrapMode: "word", selectable: false },
                      span("No configured providers detected. Log in with `opencode auth login` or set an API key.", { fg: muted }),
                    );
                  }
                  return el(
                    "box",
                    { flexDirection: "column" },
                    ...snap.providers.map((provider) => renderProviderBlock(api, provider, nowMs)),
                  );
                },
              ),
            );
          },
          () => {
            setDialogOpen(false);
            activeController?.abort();
          },
        );
      }
    }

    function parseLimitsArgs(argsText?: string): boolean {
      const norm = (argsText ?? "").trim().toLowerCase();
      return norm === "refresh" || norm === "-r" || norm === "--refresh";
    }

    // 1. Register /limits in command palette + "/" autocomplete
    api.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "limits.show",
          title: "Show usage limits",
          description: "Check active subscription and API quota limits",
          group: "Limits",
          palette: true,
          slash: {
            name: "limits",
            arguments: true,
          },
          run: (input) => {
            openLimitsDialog(parseLimitsArgs(input));
          },
        },
      ],
    }));

    // 2. Intercept literal "/limits" + Enter in the composer so it never invokes an LLM
    api.keymap.layer(() => ({
      priority: 1,
      commands: [
        {
          bind: "return",
          run: () => {
            const editor = api.renderer.currentFocusedEditor;
            const trimmed = editor?.plainText.trim() ?? "";
            if (!editor || !trimmed.startsWith("/")) return false;
            const [cmd, ...rest] = trimmed.split(/\s+/);
            if (cmd !== "/limits") return false;
            editor.clear();
            openLimitsDialog(parseLimitsArgs(rest.join(" ")));
          },
        },
      ],
    }));

    // 3. Modal shortcuts while the Limits dialog is open
    api.keymap.layer(() => ({
      mode: "global",
      enabled: () => dialogOpen(),
      priority: 50,
      commands: [
        {
          bind: "r",
          run: () => {
            void loadLimits(true);
          },
        },
        {
          bind: "c",
          run: () => {
            copySnapshot();
          },
        },
        {
          bind: "q",
          run: () => {
            api.ui.dialog.clear();
          },
        },
      ],
    }));
  },
});

export default LimitsTuiPlugin;
