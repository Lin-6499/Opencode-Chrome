import { Plugin } from '@opencode/plugin';
import { requestBridge } from '../bridge-client.mjs';
import { consumeLifecycle } from './lifecycle.mjs';

export default Plugin.define({
  id: 'local.chrome-control.lifecycle',
  setup(ctx) {
    const controller = new AbortController();
    const stream = ctx.event.subscribe({ signal: controller.signal });
    void consumeLifecycle(stream, (owner, endedAt) => requestBridge('cleanup_owner', { endedAt }, owner, { signal: controller.signal }), message => console.warn(message))
      .catch(() => { if (!controller.signal.aborted) console.warn('Chrome Control lifecycle event stream stopped.'); });
    return () => controller.abort();
  },
});
