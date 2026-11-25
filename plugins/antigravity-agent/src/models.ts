import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface AgyModel {
  readonly id: string;
  readonly name: string;
}

export function findAgy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.OPENCODE_AGY_PATH) return env.OPENCODE_AGY_PATH;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "agy"))) return join(dir, "agy");
  }
  const fallback = join(homedir(), ".local", "bin", "agy");
  return existsSync(fallback) ? fallback : undefined;
}

/** Parses `agy models`: `slug<TAB>Display name` per line, with a progress line first. */
export function parseModels(output: string): AgyModel[] {
  const seen = new Set<string>();
  const models: AgyModel[] = [];
  for (const line of output.split("\n")) {
    const [id, ...rest] = line.split("\t");
    const name = rest.join("\t").trim();
    if (!id || !name || /\s/.test(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name });
  }
  return models;
}

export function listModels(agyPath: string): Promise<AgyModel[]> {
  return new Promise((resolve, reject) => {
    execFile(agyPath, ["models"], { cwd: tmpdir(), timeout: 30_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) return reject(error);
      resolve(parseModels(stdout));
    });
  });
}
