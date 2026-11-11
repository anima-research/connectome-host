import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as CM from '@animalabs/context-manager';
import { QuarantineOperator } from '../src/quarantine-operator.js';
import { fixture, selection } from './quarantine-fixture.js';
import { trackOperatorWork } from '../src/session-switch.js';

test('public AF-owned CM/strategy identity; one selected waiver is not a provider attempt or L1 commit', async () => {
  const fx = await fixture();
  try {
    expect(fx.framework.getAgent('selected')!.getContextManager()).toBe(fx.manager);
    expect(fx.manager.getStrategy()).toBe(fx.strategy);
    expect(CM.isKeyedCompressionQuarantineStrategy(fx.manager.getStrategy())).toBe(true);
    const before = fx.calls();
    const cmd = await selection(fx.operator);
    const native = fx.strategy.releaseCompressionRefusalQuarantine.bind(fx.strategy);
    let dispatched = 0;
    fx.strategy.releaseCompressionRefusalQuarantine = async args => {
      dispatched++;
      const intent = JSON.parse(readFileSync(join(fx.dir, 'keyed-quarantine-operations', `${cmd.operation}.intent.json`), 'utf8'));
      expect(intent.key).toBe(args.key);
      expect(intent.expectedGeneration).toBe(args.expectedGeneration);
      expect(intent.expectedBinding).toEqual(args.expectedBinding);
      return native(args);
    };
    const result = await fx.operator.handle(cmd);
    expect(result.status).toBe('released');
    expect(fx.calls()).toBe(before);
    expect(dispatched).toBe(1);
    expect(fx.strategy.getStats().l1).toBe(0);
    expect(result).not.toHaveProperty('coverage');
    expect(result).not.toHaveProperty('debtPaid');
    const path = join(fx.dir, 'keyed-quarantine-operations');
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(path, `${cmd.operation}.intent.json`)).mode & 0o777).toBe(0o600);
    const intent = JSON.parse(readFileSync(join(path, `${cmd.operation}.intent.json`), 'utf8'));
    expect(intent.expectedGeneration).toBe(cmd.generation);
    expect(intent.expectedBinding.loadId).toBeTruthy();
    expect((await fx.operator.handle(cmd)).status).toBe('recorded');
    expect((await fx.operator.handle({...cmd, operation: randomUUID()})).status).toBe('stale');
    expect(fx.calls()).toBe(before);
    // Subsequent ordinary native work is a separate fake refusal, NOT the waiver.
    await fx.manager.tick();
    expect(fx.calls()).toBeGreaterThan(before);
    expect(fx.strategy.getStats().l1).toBe(0); // another refusal, not L1 success
    fx.answer('end_turn');
    await fx.manager.tick();
    expect(fx.strategy.getStats().l1).toBeGreaterThan(0); // separate actual fake native commit
  } finally { await fx.close(); }
});

test('exact full-key, generation, agent and confirmation; boolean/actor/all/prefix never clear', async () => {
  const fx = await fixture();
  try {
    for (const change of [{ key: '' }, { key: 'all' }, { key: '*' }, { key: 'a'.repeat(12) }, { key: undefined },
      { agent: 'other' }, { generation: 'new-generation' }, { confirmation: true }, { confirmation: 'APPROVE' }]) {
      const cmd = await selection(fx.operator);
      expect((await fx.operator.handle({ ...cmd, ...change } as never)).status).toBe('invalidSelection');
      expect((await fx.operator.handle(cmd)).status).toBe('stale');
    }
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords', 1);
    for (const key of ['', 'all', '*', 'a'.repeat(12)]) {
      expect((await fx.operator.handle({ type: 'quarantine-inspect', agent: 'selected', key })).status).toBe('invalidSelection');
    }
    expect((await fx.operator.handle({ type: 'quarantine-inspect', agent: 'selected', limit: 0 })).status).toBe('invalidSelection');
  } finally { await fx.close(); }
});

test('explicit other/missing agent and unloaded/unsupported native strategy refuse', async () => {
  const fx = await fixture();
  try {
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'other'})).status).toBe('refused');
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'missing'})).status).toBe('refused');
    fx.strategy.detach();
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('branchUnavailable');
    fx.manager.close();
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('refused');
  } finally { await fx.close(); }
});

test('manager reinitialization and strategy replacement stale prior snapshots; normal append does not', async () => {
  const fx = await fixture();
  try {
    let cmd = await selection(fx.operator);
    await fx.manager.setStrategy(fx.strategy);
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    cmd = await selection(fx.operator);
    await fx.manager.setStrategy(new CM.PassthroughStrategy());
    expect((await fx.operator.handle(cmd)).status).toBe('refused');
    await fx.manager.setStrategy(fx.strategy);
    cmd = await selection(fx.operator);
    fx.manager.addMessage('User', [{type:'text',text:'ordinary append'}]);
    expect((await fx.operator.handle(cmd)).status).toBe('released');
  } finally { await fx.close(); }
});

test('busy switch/stop and explicit epoch invalidation refuse without dispatch', async () => {
  const fx = await fixture();
  try {
    for (const field of ['switching', 'stopping'] as const) {
      const cmd = await selection(fx.operator);
      fx.app[field] = true;
      expect((await fx.operator.handle(cmd)).status).toBe('refused');
      fx.app[field] = false;
    }
    const cmd = await selection(fx.operator);
    fx.operator.invalidate();
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',1);
  } finally { await fx.close(); }
});

test('nonce expiry and bounded snapshots; no expiry extends an old intent', async () => {
  const fx = await fixture();
  const now = performance.now.bind(performance);
  try {
    const cmd = await selection(fx.operator);
    performance.now = () => now() + 60_001;
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    performance.now = now;
    for (let i=0;i<64;i++) expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('ok');
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('busy');
  } finally { performance.now = now; await fx.close(); }
});

test('same operation across independent helpers and restart cannot dispatch twice', async () => {
  const fx = await fixture();
  let second: QuarantineOperator | undefined;
  try {
    let calls=0;
    const native = fx.strategy.releaseCompressionRefusalQuarantine.bind(fx.strategy);
    fx.strategy.releaseCompressionRefusalQuarantine = async (intent) => { calls++; return native(intent); };
    const cmd = await selection(fx.operator);
    second = new QuarantineOperator(fx.app, fx.dir);
    const other = await selection(second, cmd.operation);
    const results = await Promise.all([fx.operator.handle(cmd), second.handle(other)]);
    expect(results.map(r=>r.status).sort()).toEqual(['released','uncertain']);
    expect(calls).toBe(1);
    second.close(); second = new QuarantineOperator(fx.app, fx.dir);
    expect((await second.handle(cmd)).status).toBe('recorded');
    expect((await second.handle({type:'quarantine-result',operation:cmd.operation})).status).toBe('recorded');
    expect(calls).toBe(1);
  } finally { second?.close(); await fx.close(); }
});

test('lost ACK / native landed-then-throw remains uncertain even when key absent', async () => {
  const fx = await fixture();
  try {
    const native = fx.strategy.releaseCompressionRefusalQuarantine.bind(fx.strategy);
    let calls = 0;
    fx.strategy.releaseCompressionRefusalQuarantine = async (intent) => { calls++; await native(intent); throw new Error('ACK lost'); };
    const cmd = await selection(fx.operator);
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',0);
    const result = await fx.operator.handle(cmd);
    expect(result).toHaveProperty('observed.status','uncertain');
    expect(calls).toBe(1);
  } finally { await fx.close(); }
});

test('pending/torn/no-follow intent refuses; outcome write failure cannot be turned into success', async () => {
  const fx = await fixture();
  try {
    const dir = join(fx.dir,'keyed-quarantine-operations');
    mkdirSync(dir,{mode:0o700});
    let cmd = await selection(fx.operator);
    writeFileSync(join(dir,`${cmd.operation}.intent.json`),'',{mode:0o600});
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    cmd = await selection(fx.operator);
    symlinkSync('/dev/null',join(dir,`${cmd.operation}.intent.json`));
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',1);
    cmd = await selection(fx.operator);
    mkdirSync(join(dir,`${cmd.operation}.result.json`));
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',0);
  } finally { await fx.close(); }
});

test('insecure receipt directory refuses before native mutation', async () => {
  const fx = await fixture();
  try {
    const dir = join(fx.dir,'keyed-quarantine-operations');
    mkdirSync(dir,{mode:0o700}); chmodSync(dir,0o755);
    const cmd = await selection(fx.operator);
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',1);
  } finally { await fx.close(); }
});

test('manager branch away-and-back and agent incarnation changes stale selections', async () => {
  const fx = await fixture();
  try {
    let cmd = await selection(fx.operator);
    await fx.manager.fork('fake-other-branch');
    await fx.manager.switchBranch('main');
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    cmd = await selection(fx.operator);
    const get = fx.framework.getAgentRecord.bind(fx.framework);
    fx.framework.getAgentRecord = name => { const record=get(name);return record?{...record,incarnation:record.incarnation+1}:null; };
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    fx.framework.getAgentRecord = get;
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',1);
  } finally { await fx.close(); }
});

test('same loaded manager changed under a framework epoch refuses; sibling native records survive', async () => {
  const fx = await fixture();
  try {
    await fx.manager.tick(); // a separate native source/shape refuses
    const view = fx.strategy.inspectCompressionRefusalQuarantine();
    expect(view).toHaveProperty('totalRecords',2);
    let cmd = await selection(fx.operator);
    const old=fx.app.framework;
    // Fake a replacement framework using ONLY its public lookup functions.
    fx.app.framework = {getAgent:old.getAgent.bind(old),getAgentRecord:old.getAgentRecord.bind(old),
      getAllAgents:old.getAllAgents.bind(old),getHostModeStatus:old.getHostModeStatus.bind(old),getQueueDepth:old.getQueueDepth.bind(old)} as never;
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    fx.app.framework=old;
    cmd = await selection(fx.operator);
    const result = await fx.operator.handle(cmd);
    expect(result).toHaveProperty('remainingRecords',1);
    const after = fx.strategy.inspectCompressionRefusalQuarantine();
    expect(after).toHaveProperty('totalRecords',1);
    if (view.status==='ok' && after.status==='ok') {
      expect(after.records[0]!.key).toBe(view.records.find(r=>r.key!==cmd.key)!.key);
    }
  } finally { await fx.close(); }
});

test('CM remains authority when the confirmed hold disappears before dispatch; no legacy clear fallback', async () => {
  const fx = await fixture();
  try {
    const cmd = await selection(fx.operator);
    const view = fx.strategy.inspectCompressionRefusalQuarantine();
    if(view.status!=='ok') throw new Error('no view');
    await fx.strategy.releaseCompressionRefusalQuarantine({key:cmd.key,expectedGeneration:cmd.generation,expectedBinding:view.binding});
    const result=await fx.operator.handle(cmd);
    expect(result.status).toBe('not-held');
    expect((await fx.operator.handle(cmd))).toHaveProperty('observed.status','not-held');
  } finally { await fx.close(); }
});

test('active turn, queue, scripts and existing operator work are lifecycle-busy without native dispatch', async () => {
  const fx=await fixture();
  try {
    const status=fx.framework.getHostModeStatus.bind(fx.framework);
    for(const change of [{drained:false},{activeTurnAgents:['other']},{parkedAdmissions:1},{gatedRequests:1},{backgroundScripts:1}]) {
      const cmd=await selection(fx.operator);
      fx.framework.getHostModeStatus=()=>({...status(),...change});
      expect((await fx.operator.handle(cmd)).status).toBe('refused');
      fx.framework.getHostModeStatus=status;
    }
    const cmd=await selection(fx.operator);
    const queue=fx.framework.getQueueDepth.bind(fx.framework);
    fx.framework.getQueueDepth=()=>1;
    expect((await fx.operator.handle(cmd)).status).toBe('refused');
    fx.framework.getQueueDepth=queue;
    let done!:()=>void;
    const pending=trackOperatorWork(fx.app,'other operator',new Promise<void>(r=>{done=r;}));
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('refused');
    done();await pending;
    expect(fx.strategy.inspectCompressionRefusalQuarantine()).toHaveProperty('totalRecords',1);
  } finally {await fx.close();}
});

test('native binding must match public agent namespace; shared strategy manager scope is refused', async () => {
  const fx=await fixture();
  try {
    const get=fx.framework.getAgentRecord.bind(fx.framework);
    fx.framework.getAgentRecord=name=>{const r=get(name);return r?{...r,namespace:'wrong-scope'}:null;};
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('refused');
    fx.framework.getAgentRecord=get;
    // Public setStrategy accidentally reuses another live manager's strategy.
    await fx.framework.getAgent('other')!.getContextManager().setStrategy(fx.strategy);
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'selected'})).status).toBe('refused');
    expect((await fx.operator.handle({type:'quarantine-inspect',agent:'other'})).status).toBe('refused');
  } finally {await fx.close();}
});

test('same-key synthetic native event replacement after inspection is CM-owned stale, not a newer-generation waiver', async () => {
  const fx=await fixture();
  try {
    const cmd=await selection(fx.operator);
    const view=fx.strategy.inspectCompressionRefusalQuarantine();
    if(view.status!=='ok') throw new Error('no view');
    // Synthetic native-writer conflict in the PRIVATE fixture only. No production host writer.
    // Use public Chronicle APIs, not strategy private fields or a replacement host seam.
    const state=`${view.binding.namespace}/autobio:compression-refusal-quarantine-events`;
    const store=fx.manager.getStore();
    const events=store.getStateJson(state) as Array<Record<string,unknown>>;
    const exhausted=events.find(e=>e.kind==='exhausted' && e.key===cmd.key)!;
    expect(exhausted).toBeTruthy();
    store.setStateJson(state,[...events,{...exhausted,eventId:'synthetic-replacement-generation'}]);
    expect((await fx.operator.handle(cmd)).status).toBe('stale');
    const after=fx.strategy.inspectCompressionRefusalQuarantine();
    if(after.status!=='ok') throw new Error('no view');
    expect(after.records[0]!.generation).toBe('synthetic-replacement-generation');
    expect(after.totalRecords).toBe(1);
  } finally {await fx.close();}
});

test('malformed saved released result is uncertain and cannot acknowledge absence', async () => {
  const fx=await fixture();
  try {
    const cmd=await selection(fx.operator);
    expect((await fx.operator.handle(cmd)).status).toBe('released');
    writeFileSync(join(fx.dir,'keyed-quarantine-operations',`${cmd.operation}.result.json`),
      JSON.stringify({format:'keyed-quarantine-v1',status:'released',operation:cmd.operation}));
    expect((await fx.operator.handle(cmd)).status).toBe('uncertain');
  } finally {await fx.close();}
});

test('caller mutation while native CAS waits cannot redirect the saved operation receipt', async () => {
  const fx=await fixture();
  try {
    const cmd=await selection(fx.operator);
    const operation=cmd.operation;
    const native=fx.strategy.releaseCompressionRefusalQuarantine.bind(fx.strategy);
    let allow!:()=>void;
    const wait=new Promise<void>(r=>{allow=r;});
    fx.strategy.releaseCompressionRefusalQuarantine=async args=>{await wait;return native(args);};
    const work=fx.operator.handle(cmd);
    cmd.operation=randomUUID();cmd.key='b'.repeat(64);cmd.generation='changed';
    allow();
    expect(await work).toHaveProperty('operation',operation);
    expect(await fx.operator.handle({type:'quarantine-result',operation})).toHaveProperty('observed.status','released');
    expect(await fx.operator.handle({type:'quarantine-result',operation:cmd.operation})).toHaveProperty('status','unknown-operation');
  } finally {await fx.close();}
});

test('configured logical labels are snapshotted receipts, never actual fake-provider observations', async () => {
  const fx=await fixture();
  try {
    fx.app.recipe.agent.provider='anthropic'; // only a public label; actual fixture complete() is still fake
    const cmd=await selection(fx.operator);
    fx.app.recipe.agent.provider='bedrock';
    const result=await fx.operator.handle(cmd);
    expect(result).toHaveProperty('configuredAtInspection.logicalProvider','anthropic');
    expect(result).toHaveProperty('configuredAtInspection.model','fake-model');
    expect(result).toHaveProperty('configuredAtInspection.credentialAlias',null);
    expect(result.actualRetry).toBe('unknown');
    expect(await fx.operator.handle({type:'quarantine-result',operation:cmd.operation})).toHaveProperty('observed.actualRetry','unknown');
  } finally {await fx.close();}
});

test('same-live native waiver episode callback zero produces absence-only host alert, not paid coverage', async () => {
  const fx=await fixture();
  try {
    const {quarantineAlarm}=await import('../src/web/quarantine-alert.js');
    const alerts:Array<ReturnType<typeof quarantineAlarm>>=[];
    fx.strategy.setQuarantineAlarmHandler(status=>alerts.push(quarantineAlarm(status)));
    await fx.manager.tick(); // opens the episode, then a separate native fake refusal adds a sibling
    expect(alerts.length).toBeGreaterThan(0);
    for(let i=0;i<2;i++) expect((await fx.operator.handle(await selection(fx.operator))).status).toBe('released');
    expect(fx.strategy.getStats().l1).toBe(0);
    expect(alerts.some(a=>a.data.count===0)).toBe(false); // release never drives the callback
    await fx.manager.tick(); // existing ordinary alarm path, not a host waiver tick
    const clear=alerts.find(a=>a.data.count===0)!;
    expect(clear).toBeTruthy();
    expect(clear.message).toContain('no records held');
    expect(clear.message).toContain('coverage and debt payment not established');
    expect(clear.message).not.toContain('all debt paid');
    expect(clear.data).toEqual({count:0});
    expect(fx.strategy.getStats().l1).toBe(0);
  } finally {await fx.close();}
});
