/**
 * Full-screen gate shown when this device's observer key is not granted on
 * this agent ('denied') or WebCrypto is unavailable ('unavailable' —
 * insecure context). Shows the device fingerprint to hand to the agent /
 * operator, and offers password sign-in as the fallback (navigating to
 * /auth/basic triggers the browser's basic-auth prompt; with cached
 * credentials the subsequent WS upgrade authenticates as a full client).
 */
import { createResource, Show } from 'solid-js';
import { deviceFingerprint } from './observer-identity';

export function ObserverGateScreen(props: { state: 'denied' | 'unavailable' }) {
  const [fingerprint] = createResource(deviceFingerprint);

  const copy = (): void => {
    const fp = fingerprint();
    if (fp) void navigator.clipboard?.writeText(fp);
  };

  return (
    <div class="fixed inset-0 z-50 bg-zinc-950/95 flex items-center justify-center p-6">
      <div class="max-w-xl w-full border border-zinc-800 rounded-lg bg-zinc-900 p-6 space-y-4 text-sm text-zinc-300">
        <Show
          when={props.state === 'denied'}
          fallback={
            <>
              <h2 class="text-base font-semibold text-zinc-100">Observer keys unavailable here</h2>
              <p>
                Device-key authentication needs a secure context (https or localhost) for WebCrypto.
                This page was loaded over plain http, so only password sign-in is available.
              </p>
            </>
          }
        >
          <h2 class="text-base font-semibold text-zinc-100">This device isn't authorized yet</h2>
          <p>
            This viewer shows an agent's interior — access is granted per device, by the agent or
            its operator. Share this device's key fingerprint with them:
          </p>
          <Show
            when={!fingerprint.loading && fingerprint() === null}
            fallback={
              <div class="flex items-center gap-2">
                <code class="font-mono text-xs bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 break-all flex-1">
                  {fingerprint.loading ? 'generating…' : fingerprint()}
                </code>
                <button
                  class="px-2 py-1.5 text-xs rounded border border-zinc-700 hover:bg-zinc-800"
                  onClick={copy}
                >
                  copy
                </button>
              </div>
            }
          >
            <p class="text-amber-300/90">
              This origin can't generate a device key (WebCrypto needs https or localhost) —
              use password sign-in below, or open the agent's https URL.
            </p>
          </Show>
          <p class="text-zinc-400">
            Grant (agent tool or operator edit of <code class="font-mono">data/observers.json</code>):{' '}
            <code class="font-mono text-xs">
              observers--grant key=&lt;fingerprint&gt; label=&lt;who-you-are&gt; scopes=[health,…]
            </code>
            . Takes effect within ~3s — then{' '}
            <button class="underline" onClick={() => location.reload()}>reload</button>.
          </p>
        </Show>
        <div class="pt-2 border-t border-zinc-800">
          <a class="underline text-zinc-400 hover:text-zinc-200" href="/auth/basic">
            Sign in with password instead
          </a>
        </div>
      </div>
    </div>
  );
}
