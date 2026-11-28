// Subprocess-only probe of the real host.
import { AgentFramework, type ProcessState } from '@animalabs/agent-framework';
import { SubscriptionGcModule } from '../src/modules/subscription-gc-module.js';

const create = AgentFramework.create.bind(AgentFramework);
const server = process.env.GC_PROBE_SERVER ?? 'zulip';
const noState = {} as ProcessState;

AgentFramework.create = async (config) => {
  const framework = await create(config);
  const gc = config.modules?.find((module) => module instanceof SubscriptionGcModule);
  const start = framework.start.bind(framework);
  framework.start = () => {
    start();
    if (!(gc instanceof SubscriptionGcModule)) {
      console.log('GC_PROBED=no module');
      return;
    }
    console.log(`GC_SETTINGS=${JSON.stringify(gc.getAgentSettingsExtension().get('agent'))}`);
    void gc.onProcess({
      type: 'mcpl:channel-incoming',
      serverId: server,
      channelId: `${server}:probe`,
      messageId: 'probe-1',
      author: { id: 'u1', name: 'someone' },
      content: [{ type: 'text', text: 'overheard ambient chatter' }],
      timestamp: new Date().toISOString(),
      metadata: {},
    }, noState).then(() => console.log('GC_PROBED=yes'));
  };
  return framework;
};
