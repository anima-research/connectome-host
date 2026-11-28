const COUNT_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'COUNT_TOKENS_MODEL'] as const;

export type CountEnv = Partial<Record<(typeof COUNT_VARS)[number], string>>;

export async function withCountEnv<T>(env: CountEnv, run: () => Promise<T>): Promise<T> {
  const prior = COUNT_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of COUNT_VARS) {
    const value = env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
