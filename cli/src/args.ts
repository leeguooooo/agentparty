// 轻量 argv 解析，不引 commander
export interface ArgSpec {
  booleans?: string[];
  repeatable?: string[];
  aliases?: Record<string, string>;
}

export interface Parsed {
  positionals: string[];
  flags: Record<string, string | boolean | Array<string | boolean>>;
  terminated: boolean;
  terminatedAt: number | null;
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): Parsed {
  const booleans = new Set(spec.booleans ?? []);
  const repeatable = new Set(spec.repeatable ?? []);
  const aliases = spec.aliases ?? {};
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  let terminated = false;
  let terminatedAt: number | null = null;

  const set = (key: string, value: string | boolean) => {
    if (repeatable.has(key)) {
      const arr = (flags[key] as Array<string | boolean> | undefined) ?? [];
      arr.push(value);
      flags[key] = arr;
    } else {
      flags[key] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      terminated = true;
      terminatedAt = positionals.length;
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      let key = a.slice(2);
      let val: string | undefined;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (val === undefined) {
        if (booleans.has(key)) {
          set(key, true);
          continue;
        }
        const next = argv[i + 1];
        if (next !== undefined && (next === "-" || !next.startsWith("-") || /^-\d/.test(next))) {
          val = next;
          i++;
        } else {
          set(key, true);
          continue;
        }
      }
      set(key, val);
    } else if (a.startsWith("-") && a.length > 1) {
      const key = aliases[a.slice(1)] ?? a.slice(1);
      if (booleans.has(key)) {
        set(key, true);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-") || /^-\d/.test(next))) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, terminated, terminatedAt };
}

export function str(v: string | boolean | Array<string | boolean> | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function num(v: string | boolean | Array<string | boolean> | undefined): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function valueFlagError(
  flags: Parsed["flags"],
  keys: string[],
  repeatableKeys: string[] = [],
): string | null {
  for (const key of keys) {
    const v = flags[key];
    if (v !== undefined && (typeof v !== "string" || v === "")) return `--${key} requires a value`;
  }
  for (const key of repeatableKeys) {
    const v = flags[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((item) => typeof item !== "string" || item === "")) {
      return `--${key} requires a value`;
    }
  }
  return null;
}

export function unknownFlagError(flags: Parsed["flags"], allowed: string[]): string | null {
  const known = new Set(allowed);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) return `unknown option --${key}`;
  }
  return null;
}

export function strArray(v: string | boolean | Array<string | boolean> | undefined): string[] | undefined {
  return Array.isArray(v) && v.every((item): item is string => typeof item === "string")
    ? v
    : undefined;
}

export function isHelpArg(argv: string[], opts: { allowHelpPositional?: boolean } = {}): boolean {
  if (argv.includes("--help") || argv.includes("-h")) return true;
  return opts.allowHelpPositional === true && argv.length === 1 && argv[0] === "help";
}
