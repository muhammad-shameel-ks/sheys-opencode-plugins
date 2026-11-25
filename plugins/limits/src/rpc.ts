import type { LimitsSnapshot } from "./types.js";

export const LIMITS_RPC_ID = "shey.opencode-limits";

interface StandardValidationIssue {
  readonly message: string;
}

interface StandardSchema<Input, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly StandardValidationIssue[] };
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

function makeSchema<T>(check: (value: unknown) => string | null): StandardSchema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-limits",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value as T };
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GetLimitsInput {
  readonly force?: boolean;
}

export const LimitsRpc = {
  id: LIMITS_RPC_ID,
  events: {},
  methods: {
    getLimits: {
      input: makeSchema<GetLimitsInput>((value) => {
        if (!isRecord(value)) return "input must be an object";
        if (value.force !== undefined && typeof value.force !== "boolean") {
          return "force must be a boolean";
        }
        return null;
      }),
      output: makeSchema<LimitsSnapshot>((value) => {
        if (!isRecord(value)) return "output must be an object";
        if (typeof value.fetchedAtMs !== "number" || !Array.isArray(value.providers)) {
          return "output must include fetchedAtMs and providers";
        }
        return null;
      }),
    },
  },
} as const;
