import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseHandWrittenJson } from './hand-written-json.js';

export const ENV_REFERENCE = String.raw`\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}`;

/**
 * Walk a parsed-JSON value tree and substitute `${VAR_NAME}` patterns in
 * string values with `process.env.VAR_NAME`. Applied at recipe-load time,
 * before schema validation, so secrets can live in `.env` (gitignored)
 * while the recipe itself stays commit-safe.
 *
 * Patterns:
 *   - `${FOO}` — required.  Throws if FOO is unset (empty string OK).
 *   - `${FOO:-default}` — optional.  Uses FOO when set and non-empty,
 *     otherwise the literal default text.  Default may be empty
 *     (`${FOO:-}`) to mean "use FOO or just empty string, never throw".
 *   - VAR name: `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Default text: any chars except `}`.  No nested `${...}` parsing
 *     and no escape syntax — keep recipes JSON-friendly.
 *   - Multiple occurrences in a single string are all substituted.
 *   - Non-string values (numbers, booleans, nulls) pass through unchanged.
 *   - Arrays and objects are walked recursively.
 *
 * No escape syntax yet — a literal `${...}` in recipe JSON is not a
 * supported case.
 */
export function substituteEnvVars(value: unknown, source: string): unknown {
  if (typeof value === 'string') {
    return value.replace(
      new RegExp(ENV_REFERENCE, 'g'),
      (_match, name: string, defaultValue: string | undefined) => {
        const v = process.env[name];
        if (defaultValue !== undefined) {
          return v !== undefined && v !== '' ? v : defaultValue;
        }
        if (v === undefined) {
          throw new Error(
            `Recipe "${source}" references environment variable \${${name}} which is not set. ` +
            `Add it to your .env file, supply a default with \${${name}:-...}, ` +
            `or delete the section of the recipe that uses it ` +
            `(e.g. remove the mcpServers entry for a source you don't have).`,
          );
        }
        return v;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => substituteEnvVars(v, source));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnvVars(v, source);
    }
    return out;
  }
  return value;
}

export type RecipeSourceBase = { kind: 'file'; dir: string } | { kind: 'url'; base: string };

export interface RecipeDocument {
  raw: unknown;
  sourceBase: RecipeSourceBase;
}

export async function readRecipeDocument(source: string): Promise<RecipeDocument> {
  let raw: unknown;
  let sourceBase: RecipeSourceBase;

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to fetch recipe from ${source}: ${res.status} ${res.statusText}`);
    try {
      raw = await res.json();
    } catch (error) {
      if (error instanceof SyntaxError) throw new SyntaxError(`the recipe at ${source} isn't valid JSON`);
      throw error;
    }
    sourceBase = { kind: 'url', base: source };
  } else {
    const path = resolve(source);
    if (!existsSync(path)) throw new Error(`Recipe file not found: ${path}`);
    const text = readFileSync(path, 'utf-8');
    // A response's json() already skips a leading byte order mark, as
    // UTF-8 decoding does; a file read as text keeps it.
    try {
      raw = parseHandWrittenJson(text);
    } catch (error) {
      // The parser's message can quote the file's text, and a recipe can
      // hold a key inline, so it isn't passed on.
      if (error instanceof SyntaxError) throw new SyntaxError(`${path} isn't valid JSON`);
      throw error;
    }
    sourceBase = { kind: 'file', dir: dirname(path) };
  }

  return { raw, sourceBase };
}
