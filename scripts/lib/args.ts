#!/usr/bin/env bun

export function parseCsv(value: unknown, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function unique<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function requireOptionValue(argv: string[], index: number, token: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return value;
}

export type CliParsedValue = boolean | string | string[];

export type CliParsedArgs = {
  _: string[];
  [key: string]: CliParsedValue | undefined;
};

export type CliOptionSpec = {
  boolean: Set<string>;
  value: Set<string>;
};

export type CliOptionParseOptions = {
  allowEquals?: boolean;
  allowNoPrefix?: boolean;
  repeat?: "collect" | "overwrite";
  strict?: boolean;
};

function setParsedArg(args: CliParsedArgs, key: string, value: CliParsedValue, repeat: "collect" | "overwrite"): void {
  if (repeat === "overwrite") {
    args[key] = value;
    return;
  }

  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(String(value));
    return;
  }
  args[key] = [String(existing), String(value)];
}

function requireValue(argv: string[], index: number, token: string): { value: string; nextIndex: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${token}`);
  }
  return { value, nextIndex: index + 1 };
}

export function parseCliOptions(
  argv: string[],
  startIndex: number,
  spec: CliOptionSpec | null,
  options: CliOptionParseOptions = {},
): CliParsedArgs {
  const args: CliParsedArgs = { _: [] };
  const strict = options.strict ?? spec !== null;
  const repeat = options.repeat ?? "overwrite";

  for (let index = startIndex; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    if (token === "--") {
      args._.push(...argv.slice(index + 1));
      break;
    }

    if (options.allowNoPrefix && token.startsWith("--no-")) {
      const key = token.slice(5);
      if (strict && spec && !spec.boolean.has(key)) {
        throw new Error(`Unknown option: ${token}`);
      }
      setParsedArg(args, key, false, repeat);
      continue;
    }

    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }

    if (options.allowEquals) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        if (!strict || !spec) {
          setParsedArg(args, key, value, repeat);
          continue;
        }
        if (spec.value.has(key)) {
          setParsedArg(args, key, value, repeat);
          continue;
        }
        if (spec.boolean.has(key) && value === "") {
          setParsedArg(args, key, true, repeat);
          continue;
        }
        throw new Error(`Unknown option: --${key}`);
      }
    }

    const key = token.slice(2);
    if (strict && spec) {
      if (spec.boolean.has(key)) {
        setParsedArg(args, key, true, repeat);
        continue;
      }
      if (spec.value.has(key)) {
        const result = requireValue(argv, index, token);
        setParsedArg(args, key, result.value, repeat);
        index = result.nextIndex;
        continue;
      }
      throw new Error(`Unknown option: ${token}`);
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      setParsedArg(args, key, true, repeat);
      continue;
    }

    setParsedArg(args, key, next, repeat);
    index += 1;
  }

  return args;
}
