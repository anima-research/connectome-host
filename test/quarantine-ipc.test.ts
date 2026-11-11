import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openSocket, type HostClient } from '../src/cli/host-socket.js';
import { quarantine } from '../src/cli/quarantine.js';
import { waiverConfirmation } from '../src/quarantine-operator.js';
import { connectWhenAccepting } from './ipc-connect.js';

async function until(check: () => boolean) {
  const end = Date.now()+8_000;
  while (!check()) { if(Date.now()>end) throw new Error('fake IPC deadline'); await Bun.sleep(10); }
}
async function harness(body: (h: {
  dir:string; start(hold?:boolean):Promise<void>; stop(crash?:boolean):Promise<void>; recoverInactiveFixture():void; client(control?:boolean):Promise<HostClient>;
  trace(events:Record<string,unknown>[]):void;
  cli(argv:string[]):Promise<{code:number;out:string[];err:string[]}>;
})=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'keyed-ipc-'));
  let child:ChildProcess|undefined, childStart:string|undefined;
  const startTime=(pid:number)=>readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];
  const clients:HostClient[]=[];
  const stop=async(crash=false)=>{
    if(child && child.exitCode===null && child.signalCode===null) {
      expect(startTime(child.pid!)).toBe(childStart);
      const exit=new Promise<void>(r=>child!.once('exit',()=>r()));child.kill(crash?'SIGKILL':'SIGTERM');await exit;
    }
  };
  // Explicit test-admin recovery ONLY after this fixture child positively exited.
  // Never part of start(): preserve stale artifacts, and never touch op receipts.
  const recoverInactiveFixture=()=>{
    expect(Boolean(child && (child.exitCode!==null || child.signalCode!==null))).toBe(true);
    renameSync(join(dir,'q'),join(dir,'retired-q-'+randomUUID()));
  };
  const start=async(hold=false)=>{
    child=spawn(process.execPath,[new URL('./mock-quarantine-child.ts',import.meta.url).pathname],
      {env:{...process.env,DATA_DIR:dir,HOLD_ACK:hold?'1':'0'},stdio:['ignore','ignore','ignore','ipc']});
    childStart=startTime(child.pid!);
    // Startup synchronization only; not a provider/route retry.
    const socket=await connectWhenAccepting(join(dir,'q','s'),{timeoutMs:8000});socket.destroy();
  };
  const client=async(control=true)=>{const c=await openSocket(join(dir,...(control?['q','s']:['ipc.sock'])));if('reason'in c)throw new Error(c.reason);clients.push(c);return c;};
  writeFileSync(join(dir,'install.json'),JSON.stringify({v:1,dataDir:dir,extraState:[]}));
  try {await start();await body({dir,start,stop,recoverInactiveFixture,client,trace:events=>child!.send(events),async cli(argv){
    const cli=spawn(process.execPath,[new URL('./mock-quarantine-cli.ts',import.meta.url).pathname,dir,'quarantine',...argv],{stdio:['ignore','pipe','pipe']});
    let out='',err='';cli.stdout!.on('data',s=>out+=s);cli.stderr!.on('data',s=>err+=s);
    const code=await new Promise<number>(resolve=>cli.once('exit',code=>resolve(code??1)));
    return {code,out:out.trim().split('\n').filter(Boolean),err:err.trim().split('\n').filter(Boolean)};
  }});}
  finally {for(const c of clients)c.close();await stop(true);rmSync(dir,{recursive:true,force:true});}
}
function command(view:Record<string,any>) {
  const r=view.records[0], operation=randomUUID();
  return {type:'quarantine-release',agent:'selected',key:r.key,generation:r.generation,selection:view.selection,operation,
    confirmation:waiverConfirmation('selected',r.key,r.generation,view.selection,operation)};
}
function dispatches(dir:string) {const p=join(dir,'native-dispatches');return existsSync(p)?readFileSync(p,'utf8').trim().split('\n').length:0;}

test('real UNIX IPC and CLI independent processes: select, confirm, one native call, replay after restart',async()=>{
  await harness(async h=>{
    const inspect=await h.cli(['inspect','selected']);
    expect(inspect.code).toBe(0);
    const view=JSON.parse(inspect.out[0]!);
    expect(view.type).toBe('quarantine-response');
    expect(view.configuredModel).toBe('fake-model');
    expect(view.actualRetry).toContain('unknown');
    const cmd=command(view);
    const admin=await h.client(false);
    admin.subscribe([]);
    expect((await admin.request({type:'panel-request',op:'quarantine-release',params:cmd},2000))?.ok).toBe(false);
    await admin.request({type:'command',command:'/quarantine release all'},2000);
    expect(dispatches(h.dir)).toBe(0);
    admin.close();
    const argv=['release',cmd.agent,cmd.key,cmd.generation,cmd.selection,cmd.operation,'--confirm',cmd.confirmation];
    const result=await h.cli(argv);
    expect(result.code).toBe(0);expect(JSON.parse(result.out[0]!).status).toBe('released');
    expect(dispatches(h.dir)).toBe(1);
    expect((await h.cli(argv)).code).toBe(0);expect(dispatches(h.dir)).toBe(1);
    await h.stop();await h.start();
    expect((await h.cli(argv)).code).toBe(0);expect(dispatches(h.dir)).toBe(1);
    const read=await h.cli(['result',cmd.operation]);
    expect(JSON.parse(read.out[0]!)).toHaveProperty('observed.status','released');
    const c=await h.client(false);
    expect((await c.request({type:'describe'},2000))?.type).toBe('snapshot');
  });
},30_000);

test('landed native write, lost connection, crash with pending intent: key absence is not acknowledgement',async()=>{
  await harness(async h=>{
    await h.stop();await h.start(true);
    const c=await h.client();
    const view=await c.request({type:'quarantine-inspect',agent:'selected'},2000);
    const cmd=command(view!);
    const pending=c.request(cmd,4000);
    await until(()=>existsSync(join(h.dir,'landed')));
    c.close();await pending;
    const second=await h.client();
    expect((await second.request(cmd,2000))?.status).toBe('uncertain');
    expect(dispatches(h.dir)).toBe(1);
    await h.stop(true);
    // Policy changed: crash leftovers REFUSE. Explicit fixture-admin retirement
    // after positive child exit is required before testing durable op replay.
    const {listenQuarantineSocket}=await import('../src/quarantine-socket.js');
    const claim=readFileSync(join(h.dir,'q','owner.json'));
    await expect(listenQuarantineSocket(h.dir,{ready:{},log:()=>{},handle:async()=>({})})).rejects.toThrow('existing quarantine endpoint');
    expect(readFileSync(join(h.dir,'q','owner.json'))).toEqual(claim);
    h.recoverInactiveFixture();await h.start();
    const result=await h.cli(['result',cmd.operation]);
    expect(result.code).toBe(1);expect(JSON.parse(result.out[0]!).status).toBe('uncertain');
    const third=await h.client();
    expect((await third.request(cmd,2000))?.status).toBe('uncertain');
    expect(dispatches(h.dir)).toBe(1);
  });
},30_000);

test('CLI rejects all/prefix/boolean approval before contacting a host; unknown result is not success',async()=>{
  const out:string[]=[],err:string[]=[];
  for(const argv of [['inspect','selected','all'],['inspect','selected','a'.repeat(12)],['release','selected','a'.repeat(64),'g',randomUUID(),randomUUID(),'--confirm','true']]) {
    expect(await quarantine({root:'/no-such-install',argv,out:s=>out.push(s),err:s=>err.push(s)})).toBe(2);
  }
  await harness(async h=>{expect((await h.cli(['result',randomUUID()])).code).toBe(1);});
},15_000);


// P1: actual CLI with the reviewer's retained-controller fixture. Must fail on
// 0706 (inspection exits 0 but closes the owner), not merely on a missing API.
test('operator inspect/result/pending CLI release preserve owner, subscription, speech and correlated isolation',async()=>{
  await harness(async h=>{
    await h.stop();await h.start(true);
    const controller=await h.client(false), foreground:Record<string,unknown>[]=[];
    let closed=false;void controller.closed.then(()=>closed=true);
    controller.onEvent(e=>foreground.push(e));controller.subscribe(['inference:*']);
    expect((await controller.request({type:'describe'},2000))?.type).toBe('snapshot');
    h.trace([{type:'inference:started',agentName:'selected'},
      {type:'inference:tokens',agentName:'selected',blockType:'text',content:'before-'}]);
    await until(()=>foreground.some(e=>e.content==='before-'));
    const inspected=await h.cli(['inspect','selected']);
    expect(inspected.code).toBe(0);expect(closed).toBe(false);
    const cmd=command(JSON.parse(inspected.out[0]!));
    const unknown=await h.cli(['result',cmd.operation]);
    expect(JSON.parse(unknown.out[0]!).status).toBe('unknown-operation');expect(closed).toBe(false);
    const release=h.cli(['release',cmd.agent,cmd.key,cmd.generation,cmd.selection,cmd.operation,'--confirm',cmd.confirmation]);
    await until(()=>existsSync(join(h.dir,'landed')));
    expect(closed).toBe(false);
    expect((await controller.request({type:'describe'},2000))?.type).toBe('snapshot');
    expect((await controller.request({type:'command',command:'/no-such-routing-test'},2000))?.type).toBe('command-output');
    const pending=await h.cli(['result',cmd.operation]);
    expect(JSON.parse(pending.out[0]!).status).toBe('uncertain');
    expect(closed).toBe(false);
    h.trace([{type:'inference:tokens',agentName:'selected',blockType:'text',content:'after'},
      {type:'inference:completed',agentName:'selected'},
      {type:'test:not-subscribed',agentName:'selected'}]);
    await until(()=>foreground.some(e=>e.type==='inference:speech'));
    expect(foreground.find(e=>e.type==='inference:speech')?.content).toBe('before-after');
    expect(foreground.some(e=>e.type==='test:not-subscribed'||e.type==='quarantine-response')).toBe(false);
    writeFileSync(join(h.dir,'ack'),'yes');
    const released=await release;
    expect(released.code).toBe(0);
    // No stream lines mixed into the finite operator output.
    expect(released.out).toHaveLength(1);expect(JSON.parse(released.out[0]!).status).toBe('released');
    expect(closed).toBe(false);expect(dispatches(h.dir)).toBe(1);
  });
},30_000);

test('regular successor/reconnect still takes over but cannot steal pending operator response',async()=>{
  await harness(async h=>{
    await h.stop();await h.start(true);
    const first=await h.client(false);let firstClosed=false;void first.closed.then(()=>firstClosed=true);
    const operator=await h.client(), operatorEvents:Record<string,unknown>[]=[];
    operator.onEvent(e=>operatorEvents.push(e));
    const view=await operator.request({type:'quarantine-inspect',agent:'selected'},2000);
    const cmd=command(view!);const pending=operator.request(cmd,6000);
    await until(()=>existsSync(join(h.dir,'landed')));
    const second=await h.client(false),secondEvents:Record<string,unknown>[]=[];
    second.onEvent(e=>secondEvents.push(e));second.subscribe(['inference:*']);
    await until(()=>firstClosed);
    expect((await second.request({type:'describe'},2000))?.type).toBe('snapshot');
    let secondClosed=false;void second.closed.then(()=>secondClosed=true);
    const third=await h.client(false),thirdEvents:Record<string,unknown>[]=[];
    third.onEvent(e=>thirdEvents.push(e));third.subscribe(['inference:*']);
    await until(()=>secondClosed);
    expect((await third.request({type:'command',command:'/no-such-routing-test'},2000))?.type).toBe('command-output');
    h.trace([{type:'inference:started',agentName:'selected'},
      {type:'inference:tokens',agentName:'selected',blockType:'text',content:'only-third'},
      {type:'inference:completed',agentName:'selected'}]);
    await until(()=>thirdEvents.some(e=>e.type==='inference:speech'));
    writeFileSync(join(h.dir,'ack'),'yes');
    expect((await pending)?.status).toBe('released');
    expect(operatorEvents.every(e=>e.type==='quarantine-response'&&typeof e.corrId==='string')).toBe(true);
    expect(operatorEvents).toHaveLength(2);
    expect(secondEvents.some(e=>e.type==='quarantine-response'||e.content==='only-third')).toBe(false);
    expect(thirdEvents.some(e=>e.type==='quarantine-response')).toBe(false);
    expect(dispatches(h.dir)).toBe(1);
  });
},30_000);

test('closed operator requester is not redirected; independent result observes saved outcome',async()=>{
  await harness(async h=>{
    await h.stop();await h.start(true);
    const controller=await h.client(false),events:Record<string,unknown>[]=[];
    controller.onEvent(e=>events.push(e));controller.subscribe(['*']);
    const operator=await h.client();
    const cmd=command((await operator.request({type:'quarantine-inspect',agent:'selected'},2000))!);
    const pending=operator.request(cmd,4000);
    await until(()=>existsSync(join(h.dir,'landed')));operator.close();expect(await pending).toBeNull();
    writeFileSync(join(h.dir,'ack'),'yes');
    await until(()=>existsSync(join(h.dir,'keyed-quarantine-operations',cmd.operation+'.result.json')));
    const result=await h.cli(['result',cmd.operation]);expect(JSON.parse(result.out[0]!).observed.status).toBe('released');
    expect(events.some(e=>e.type==='quarantine-response')).toBe(false);
    expect((await controller.request({type:'describe'},2000))?.type).toBe('snapshot');
    const retry=await h.cli(['release',cmd.agent,cmd.key,cmd.generation,cmd.selection,cmd.operation,'--confirm',cmd.confirmation]);
    expect(retry.code).toBe(0);expect(dispatches(h.dir)).toBe(1);
  });
},30_000);

test('host stop with landed pending operator work leaves uncertain intent and no cross-channel reply',async()=>{
  await harness(async h=>{
    await h.stop();await h.start(true);
    const controller=await h.client(false),events:Record<string,unknown>[]=[];
    controller.onEvent(e=>events.push(e));controller.subscribe(['*']);
    const operator=await h.client();const cmd=command((await operator.request({type:'quarantine-inspect',agent:'selected'},2000))!);
    const pending=operator.request(cmd,4000);
    await until(()=>existsSync(join(h.dir,'landed')));
    controller.send({type:'shutdown',graceful:true});
    expect(await pending).toBeNull();await controller.closed;
    expect(events.some(e=>e.type==='quarantine-response')).toBe(false);
    await h.stop();await h.start();
    const result=await h.cli(['result',cmd.operation]);expect(JSON.parse(result.out[0]!).status).toBe('uncertain');
    expect(dispatches(h.dir)).toBe(1);
  });
},30_000);

test('control socket refuses stream/command/shutdown/subscribe, malformed and uncorrelated envelopes',async()=>{
  await harness(async h=>{
    const controller=await h.client(false);controller.subscribe(['*']);
    const operator=await h.client(),events:Record<string,unknown>[]=[];operator.onEvent(e=>events.push(e));
    for (const type of ['describe','subscribe','text','command','shutdown','panel-request','eval']) {
      expect((await operator.request({type,events:[],content:'never wake',command:'/quit'},2000))?.status).toBe('refused');
    }
    expect((await controller.request({type:'describe'},2000))?.type).toBe('snapshot');
    expect(events.every(e=>e.type==='quarantine-response')).toBe(true);expect(dispatches(h.dir)).toBe(0);
    // No correlation => no dispatch, no unrequested output.
    operator.send({type:'quarantine-release'});await operator.closed;
    const second=await h.client();second.send({type:'quarantine-inspect',agent:'selected',corrId:'x',padding:'x'.repeat(70_000)});await second.closed;
    expect(dispatches(h.dir)).toBe(0);
  });
},20_000);
