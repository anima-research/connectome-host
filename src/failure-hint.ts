import { codexGateAuth } from './codex-subscription-adapter.js';
import { resolveProvider, type Recipe } from './recipe.js';

type Env = Record<string, string | undefined>;

interface BuiltCredential {
  readonly provider: string;
}

interface Route {
  endpoint?: { setting: string; value: string | undefined };
  credential: string;
}

function routeOf(recipe: Recipe, env: Env, credentials: BuiltCredential | null | undefined): Route | undefined {
  switch (resolveProvider(recipe)) {
    case 'anthropic':
      return {
        endpoint: { setting: 'ANTHROPIC_BASE_URL', value: env.ANTHROPIC_BASE_URL },
        credential: credentials ? 'the subscription credential (/auth status shows its state)' : 'ANTHROPIC_API_KEY',
      };
    case 'openai-responses':
      return { endpoint: { setting: 'OPENAI_BASE_URL', value: env.OPENAI_BASE_URL }, credential: 'OPENAI_API_KEY' };
    case 'bedrock':
      return {
        endpoint: { setting: 'BEDROCK_BASE_URL', value: env.BEDROCK_BASE_URL },
        credential: env.AWS_SESSION_TOKEN
          ? 'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN'
          : 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY',
      };
    case 'openai-codex':
      return {
        endpoint: { setting: 'CODEX_BASE_URL', value: env.CODEX_BASE_URL },
        credential: codexGateAuth(env) ? 'CODEX_GATE_TOKEN' : 'the ChatGPT login (/auth status shows its state)',
      };
    case 'openai-compatible':
      return { endpoint: { setting: "the recipe's agent.baseUrl", value: recipe.agent.baseUrl }, credential: 'OPENAI_COMPATIBLE_API_KEY' };
    case 'openrouter':
      return { credential: 'OPENROUTER_API_KEY' };
    case 'mock':
      return undefined;
  }
}

function endpointState(value: string | undefined): string {
  if (!value) return 'not set, so the default';
  const host = URL.canParse(value) ? new URL(value).host : '';
  return host === '' ? 'set, but not to a URL such as https://host:port' : `set to ${host}`;
}

export function failureHint(
  recipe: Recipe,
  env: Env,
  credentials: BuiltCredential | null | undefined,
): (errorType: string | undefined) => string | undefined {
  const route = routeOf(recipe, env, credentials);
  return (errorType) => {
    if (!route) return undefined;
    if (errorType === 'network' || errorType === 'timeout') {
      const { endpoint } = route;
      return endpoint
        ? `Check the network, any proxy, and ${endpoint.setting} (${endpointState(endpoint.value)}).`
        : 'Check the network and any proxy.';
    }
    if (errorType === 'auth') return `Check ${route.credential}.`;
    return undefined;
  };
}
