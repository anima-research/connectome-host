// Subprocess-only probe of the real host call site. Stop before framework
// startup: no provider calls, sockets, or module start hooks can run.
import { AgentFramework, DefaultErrorPolicy } from '@animalabs/agent-framework';
import { MembraneError } from '@animalabs/membrane';

Math.random = () => 0; // Pin overloaded equal jitter at its lower bound.
AgentFramework.create = async (config) => {
  const errors = {
    retryable: new MembraneError({ type: 'server', message: 'synthetic 503', retryable: true, httpStatus: 503 }),
    rate_limited: new MembraneError({ type: 'rate_limit', message: 'synthetic 429', retryable: true, httpStatus: 429 }),
    overloaded: new MembraneError({ type: 'server', message: 'synthetic 529', retryable: true, httpStatus: 529 }),
    final: new MembraneError({ type: 'invalid_request', message: 'synthetic final', retryable: false }),
    // The registered marker is what the framework's progress bounds set.
    deadline: Object.assign(new MembraneError({ type: 'timeout', message: 'synthetic deadline', retryable: true }), { [Symbol.for('membrane.deadlineExpiry')]: true }),
  };
  // Mirror today's framework fallback when create() receives no errorPolicy.
  // This no-startup probe cannot observe the installed fallback's identity;
  // doing so would require framework startup or coupling to private state.
  // An upstream fallback replacement can therefore escape these default cases.
  // The separate omission controls assert only that the host supplies no policy.
  // Probe policy decisions only: provider holds run separately before it.
  const policy = config.errorPolicy ?? new DefaultErrorPolicy();
  const statedWaits = [500, ...[60_000, 90_000, 120_000, 300_000, 600_000, 900_000, 1_200_000]
    .flatMap(ceiling => [ceiling - 1, ceiling, ceiling + 1])];
  console.log('RETRY_CAPTURE=' + JSON.stringify({
    hasErrorPolicy: Object.hasOwn(config, 'errorPolicy'),
    isDefaultErrorPolicy: config.errorPolicy instanceof DefaultErrorPolicy,
    settings: config.errorPolicy && Reflect.get(config.errorPolicy, 'settings'),
    membraneRetry: Reflect.get(config.membrane, 'config').retry,
    membraneSettings: Reflect.get(config.membrane, 'retrySettings'),
    statedWaitDecisions: Object.fromEntries((['retryable', 'rate_limited', 'overloaded'] as const).map(name => [
      name, Object.fromEntries(statedWaits.map(retryAfterMs => [retryAfterMs, policy.onInferenceError(new MembraneError({
        type: errors[name].type, message: errors[name].message, retryable: true,
        httpStatus: errors[name].httpStatus, retryAfterMs,
      }), 'synthetic-agent', 0)])),
    ])),
    decisions: config.errorPolicy && Object.fromEntries(Object.entries(errors).map(([name, error]) => [
      name, Array.from({ length: 14 }, (_, attempt) => config.errorPolicy!.onInferenceError(error, 'synthetic-agent', attempt)),
    ])),
  }));
  process.exit(0);
};
