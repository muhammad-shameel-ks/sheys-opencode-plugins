export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

export type HttpResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly headers: Headers;
      readonly json: unknown;
      readonly text: string;
    }
  | {
      readonly ok: false;
      readonly kind: "http" | "timeout" | "network" | "invalid_json" | "too_large";
      readonly status?: number;
      readonly headers?: Headers;
      readonly detail: string;
    };

export interface RequestJsonOptions {
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly secrets?: readonly (string | undefined)[];
  readonly fetchImpl?: typeof fetch;
}

/** Redacts secrets and collapses whitespace/control chars for safe UI display. */
export function sanitizeErrorText(text: string, secrets: readonly (string | undefined)[] = []): string {
  let clean = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      clean = clean.replaceAll(secret, "[redacted]");
    }
  }
  return clean.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.min(100, Math.max(0, value));
  return Math.round(clamped * 100) / 100;
}

export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = nonEmptyString(value);
  if (!text) return undefined;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export async function requestJson(url: string, options: RequestJsonOptions = {}): Promise<HttpResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const secrets = options.secrets ?? [];
  const fetchFn = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "manual",
      signal: controller.signal,
    });

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return {
        ok: false,
        kind: "too_large",
        status: response.status,
        headers: response.headers,
        detail: `Response exceeded ${maxBytes} bytes`,
      };
    }

    const text = new TextDecoder().decode(buffer);
    if (!response.ok) {
      return {
        ok: false,
        kind: "http",
        status: response.status,
        headers: response.headers,
        detail: sanitizeErrorText(text, secrets) || `HTTP ${response.status}`,
      };
    }

    let parsed: unknown;
    try {
      parsed = text.trim() ? JSON.parse(text) : null;
    } catch (error) {
      return {
        ok: false,
        kind: "invalid_json",
        status: response.status,
        headers: response.headers,
        detail: sanitizeErrorText(error instanceof Error ? error.message : String(error), secrets),
      };
    }

    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      json: parsed,
      text,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        ok: false,
        kind: "timeout",
        detail: `Request timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return {
      ok: false,
      kind: "network",
      detail: sanitizeErrorText(error instanceof Error ? error.message : String(error), secrets) || "Network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
