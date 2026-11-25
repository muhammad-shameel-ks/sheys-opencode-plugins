import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clampPercent, nonEmptyString, toIsoTimestamp } from "../http.js";
import type { LimitRow, ProviderLimits } from "../types.js";
import type { ExecImpl, ProviderContext } from "./types.js";

const AGY_TIMEOUT_MS = 30_000;

function shortFamily(family: string): string {
  const lower = family.toLowerCase();
  if (lower === "gemini" || lower === "gemini models") return "Gemini";
  if (lower.includes("claude") && lower.includes("gpt")) return "Claude/GPT";
  return family;
}

function windowLabel(description: string): string | undefined {
  const lower = description.toLowerCase();
  if (lower.includes("weekly")) return "Weekly";
  if (lower.includes("five hour") || lower.includes("five-hour") || lower.includes("5 hour") || lower.includes("5h")) {
    return "5h";
  }
  return undefined;
}

export function parseAgyUsageOutput(text: string): { readonly rows: LimitRow[] } | { readonly error: string } {
  const rows = new Map<string, LimitRow>();
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 3) continue;
    const family = nonEmptyString(cols[0]);
    const win = windowLabel(cols[1] ?? "");
    const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(cols[2] ?? "");
    if (!family || !win || !match) continue;

    const label = `${shortFamily(family)} ${win}`;
    const percentUsed = clampPercent(100 - Number(match[1]));
    const resetsAt = toIsoTimestamp(cols[3]);
    const existing = rows.get(label);
    if (!existing || (existing.percentUsed ?? 0) < percentUsed) {
      rows.set(label, { label, percentUsed, resetsAt });
    }
  }

  const list = [...rows.values()];
  if (list.length > 0) return { rows: list };
  return { error: text.trim() ? "Unrecognized agy /usage output" : "Empty agy /usage output" };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAgyBinary(): string {
  const fromEnv = nonEmptyString(process.env.OPENCODE_AGY_PATH);
  if (fromEnv) return fromEnv;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (dirs.some((dir) => isExecutable(path.join(dir, "agy")))) return "agy";
  const fallback = path.join(os.homedir(), ".local", "bin", "agy");
  return isExecutable(fallback) ? fallback : "agy";
}

const defaultExec: ExecImpl = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
    child.stdin?.end();
  });

export async function fetchAntigravityAgent(pctx: ProviderContext): Promise<ProviderLimits | undefined> {
  const id = "antigravity-agent";
  const name = "Antigravity (agy)";
  const exec = pctx.execImpl ?? defaultExec;

  let stdout: string;
  try {
    stdout = await exec(resolveAgyBinary(), ["-p", "/usage"], { cwd: os.tmpdir(), timeoutMs: AGY_TIMEOUT_MS });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { killed?: boolean };
    if (err?.code === "ENOENT") return undefined;
    const message = err?.killed ? "agy /usage timed out" : `agy /usage failed${err?.code ? ` (${err.code})` : ""}`;
    return { id, name, status: "error", rows: [], error: message };
  }

  const parsed = parseAgyUsageOutput(stdout);
  if ("error" in parsed) return { id, name, status: "error", rows: [], error: parsed.error };
  return { id, name, status: "ok", rows: parsed.rows };
}
