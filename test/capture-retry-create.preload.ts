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
    // DefaultErrorPolicy deliberately treats a stream deadline as a retryable
    // timeout; it does not pass membrane's deadline classification through.
    deadline: Object.assign(new MembraneError({ type: 'timeout', message: 'synthetic deadline', retryable: true }), { deadline: true }),
  };
  console.log('RETRY_CAPTURE=' + JSON.stringify({
    hasErrorPolicy: Object.hasOwn(config, 'errorPolicy'),
    isDefaultErrorPolicy: config.errorPolicy instanceof DefaultErrorPolicy,
    settings: config.errorPolicy && Reflect.get(config.errorPolicy, 'settings'),
    membraneRetry: Reflect.get(config.membrane, 'config').retry,
    membraneSettings: Reflect.get(config.membrane, 'retrySettings'),
    decisions: config.errorPolicy && Object.fromEntries(Object.entries(errors).map(([name, error]) => [
      name, Array.from({ length: 8 }, (_, attempt) => config.errorPolicy!.onInferenceError(error, 'synthetic-agent', attempt)),
    ])),
  }));
  process.exit(0);
};
