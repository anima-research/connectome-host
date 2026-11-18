import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenQuarantineSocket } from '../src/quarantine-socket.js';
import { openSocket } from '../src/cli/host-socket.js';
import { quarantine } from '../src/cli/quarantine.js';

const options = { ready: { pid: process.pid, recipe: 'fake' }, log: () => {},
  handle: async () => ({ status: 'ok' }) };
async function until(check:()=>boolean) {
  const end=Date.now()+5000;
  while(!check()){if(Date.now()>end)throw Error('deadline');await Bun.sleep(10);}
}
async function fixture(body:(dir:string)=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),'q-socket-'));
  try {await body(dir);} finally {rmSync(dir,{recursive:true,force:true});}
}
async function listen(server:Server,path:string) {
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>resolve());});
}

test('private finite listener cleanup is idempotent and permits a fresh listener',async()=>{
  await fixture(async dir=>{
    const control=await listenQuarantineSocket(dir,options);
    expect(lstatSync(join(dir,'q')).mode&0o777).toBe(0o700);
    expect(lstatSync(join(dir,'q','owner.json')).mode&0o777).toBe(0o600);
    const c=await openSocket(join(dir,'q','s'));if('reason'in c)throw Error(c.reason);
    expect((await c.request({type:'quarantine-result',operation:'fake'},2000))?.status).toBe('ok');
    control.close();control.close();await c.closed;
    await until(()=>!existsSync(join(dir,'q','owner.json')));
    expect(existsSync(join(dir,'q','s'))).toBe(false);
    const again=await listenQuarantineSocket(dir,options);again.close();
    await until(()=>!existsSync(join(dir,'q','owner.json')));
  });
});

test('second listener cannot unlink a live owned control socket',async()=>{
  await fixture(async dir=>{
    const first=await listenQuarantineSocket(dir,options), ino=lstatSync(join(dir,'q','s')).ino;
    try {
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine endpoint');
      expect(lstatSync(join(dir,'q','s')).ino).toBe(ino);
      const c=await openSocket(join(dir,'q','s'));if('reason'in c)throw Error(c.reason);
      expect((await c.request({type:'quarantine-inspect',agent:'fake'},2000))?.status).toBe('ok');c.close();
    } finally { first.close();await until(()=>!existsSync(join(dir,'q','owner.json'))); }
  });
});

test('SIGKILL-owned stale endpoint refuses even with complete ownership evidence',async()=>{
  await fixture(async dir=>{
    const child=spawn(process.execPath,['--eval',`import {listenQuarantineSocket} from ${JSON.stringify(new URL('../src/quarantine-socket.ts',import.meta.url).pathname)}; await listenQuarantineSocket(${JSON.stringify(dir)},{ready:{},handle:async()=>({}),log:()=>{}});`],{stdio:'ignore'});
    const startTime=()=>readFileSync(`/proc/${child.pid}/stat`,'utf8').split(') ')[1].split(' ')[19];
    const started=startTime();
    try {
      await until(()=>existsSync(join(dir,'q','s')));
      const exit=new Promise<void>(r=>child.once('exit',()=>r()));expect(startTime()).toBe(started);child.kill('SIGKILL');await exit;
      expect(existsSync(join(dir,'q','s'))).toBe(true);
      const inode=lstatSync(join(dir,'q','s')).ino, marker=readFileSync(join(dir,'q','owner.json'));
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine endpoint');
      expect(lstatSync(join(dir,'q','s')).ino).toBe(inode);
      expect(readFileSync(join(dir,'q','owner.json'))).toEqual(marker);
    } finally {if(child.exitCode===null&&child.signalCode===null){expect(startTime()).toBe(started);const exit=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exit;}}
  });
});

test('unknown regular file endpoint is never unlinked',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'q'),{mode:0o700});writeFileSync(join(dir,'q','s'),'unknown');
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine endpoint');
    expect(readFileSync(join(dir,'q','s'),'utf8')).toBe('unknown');
  });
});

test('unknown socket without matching private inode receipt is never unlinked',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'q'),{mode:0o700});const server=createServer(c=>c.destroy());await listen(server,join(dir,'q','s'));
    try {
      const ino=lstatSync(join(dir,'q','s')).ino;
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine endpoint');
      expect(lstatSync(join(dir,'q','s')).ino).toBe(ino);
      writeFileSync(join(dir,'q','owner.json'),JSON.stringify({v:1,dev:0,ino:0}),{mode:0o600});
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine endpoint');
      expect(lstatSync(join(dir,'q','s')).ino).toBe(ino);
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
});

test('symlink directory and symlink receipt are not followed/repaired',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'other'),{mode:0o700});symlinkSync(join(dir,'other'),join(dir,'q'));
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow();
    expect(lstatSync(join(dir,'q')).isSymbolicLink()).toBe(true);
    unlinkSync(join(dir,'q'));mkdirSync(join(dir,'q'),{mode:0o700});
    const server=createServer(c=>c.destroy());await listen(server,join(dir,'q','s'));
    writeFileSync(join(dir,'other','marker'),'untouched');symlinkSync(join(dir,'other','marker'),join(dir,'q','owner.json'));
    try {
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow();
      expect(readFileSync(join(dir,'other','marker'),'utf8')).toBe('untouched');
      expect(lstatSync(join(dir,'q','owner.json')).isSymbolicLink()).toBe(true);
    } finally {await new Promise<void>(r=>server.close(()=>r()));}
  });
});

test('insecure channel/data directory and overlong UNIX path refuse without repair',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'q'),{mode:0o755});
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('mode 0700');
    expect(lstatSync(join(dir,'q')).mode&0o777).toBe(0o755);
    chmodSync(join(dir,'q'),0o700);chmodSync(dir,0o777);
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('ownership/write');chmodSync(dir,0o700);
    const long=join(dir,'x'.repeat(100));mkdirSync(long);
    await expect(listenQuarantineSocket(long,options)).rejects.toThrow('path too long');
    expect(existsSync(join(long,'q'))).toBe(false);
  });
});

test('cleanup stays anchored across directory rename and leaves replacement endpoint untouched',async()=>{
  await fixture(async dir=>{
    const control=await listenQuarantineSocket(dir,options);
    renameSync(join(dir,'q'),join(dir,'old'));mkdirSync(join(dir,'q'),{mode:0o700});
    writeFileSync(join(dir,'q','s'),'unknown');writeFileSync(join(dir,'q','owner.json'),'unknown');
    control.close();await until(()=>!existsSync(join(dir,'old','owner.json')));
    expect(readFileSync(join(dir,'q','s'),'utf8')).toBe('unknown');
    expect(readFileSync(join(dir,'q','owner.json'),'utf8')).toBe('unknown');
  });
});

test('closing a listener does not unlink an unknown socket or marker substituted in place',async()=>{
  await fixture(async dir=>{
    const control=await listenQuarantineSocket(dir,options);
    renameSync(join(dir,'q','s'),join(dir,'q','original'));
    renameSync(join(dir,'q','owner.json'),join(dir,'q','original-owner'));
    writeFileSync(join(dir,'q','s'),'unknown');writeFileSync(join(dir,'q','owner.json'),'unknown');
    control.close();await Bun.sleep(50);
    expect(readFileSync(join(dir,'q','s'),'utf8')).toBe('unknown');
    expect(readFileSync(join(dir,'q','owner.json'),'utf8')).toBe('unknown');
  });
});

test('unknown control endpoint disables only optional channel, not regular headless startup/commands/stop',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'q'),{mode:0o700});writeFileSync(join(dir,'q','s'),'unknown');
    const child=spawn(process.execPath,[new URL('./mock-headless-command-child.ts',import.meta.url).pathname],
      {env:{...process.env,DATA_DIR:dir},stdio:'ignore'});
    try {
      await until(()=>existsSync(join(dir,'headless.log'))&&readFileSync(join(dir,'headless.log'),'utf8').includes('quarantine control unavailable'));
      const c=await openSocket(join(dir,'ipc.sock'));if('reason'in c)throw Error(c.reason);
      expect((await c.request({type:'describe'},2000))?.type).toBe('snapshot');
      writeFileSync(join(dir,'install.json'),JSON.stringify({v:1,dataDir:dir,extraState:[]}));
      let closed=false;void c.closed.then(()=>closed=true);
      expect(await quarantine({root:dir,argv:['inspect','fixture'],out:()=>{},err:()=>{}})).toBe(1);
      expect(closed).toBe(false); // no fallback to the regular stream socket
      expect((await c.request({type:'command',command:'/no-such-optional-channel'},2000))?.type).toBe('command-output');
      // Old raw fleet verbs have no accepted quarantine dispatch on ipc.sock.
      c.send({type:'quarantine-release',corrId:'not-a-fleet-command'});
      expect((await c.request({type:'describe'},2000))?.type).toBe('snapshot');
      const exit=new Promise<number|null>(r=>child.once('exit',r));c.send({type:'shutdown',graceful:true});
      expect(await exit).toBe(0);c.close();
      expect(readFileSync(join(dir,'q','s'),'utf8')).toBe('unknown');
    } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
  });
},15_000);

test('empty, torn, legacy, hardlinked and symlink claims without sockets refuse untouched',async()=>{
  await fixture(async dir=>{
    mkdirSync(join(dir,'q'),{mode:0o700});
    const claim=join(dir,'q','owner.json');
    for (const value of ['', '{', JSON.stringify({v:1,dev:1,ino:1})]) {
      writeFileSync(claim,value,{mode:0o600});const before=lstatSync(claim);
      await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine ownership claim');
      expect(lstatSync(claim).ino).toBe(before.ino);expect(readFileSync(claim,'utf8')).toBe(value);
    }
    const {linkSync}=await import('node:fs');linkSync(claim,join(dir,'held'));
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine ownership claim');
    expect(lstatSync(claim).nlink).toBe(2);unlinkSync(claim);
    symlinkSync(join(dir,'held'),claim);
    await expect(listenQuarantineSocket(dir,options)).rejects.toThrow('existing quarantine ownership claim');
    expect(lstatSync(claim).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(dir,'held'),'utf8')).toBe(JSON.stringify({v:1,dev:1,ino:1}));
    expect(existsSync(join(dir,'q','s'))).toBe(false);
  });
});

test('two separate simultaneous starters reserve one winner; after SIGKILL both new starters refuse stale bytes',async()=>{
  await fixture(async dir=>{
    const children: {child:ReturnType<typeof spawn>;start:string;exited:Promise<unknown>}[]=[];
    // Only these positively identified fixture children may be signalled.
    const startTime=(pid:number)=>readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[19];
    function start(role:string) {
      const child=spawn(process.execPath,[new URL('./mock-quarantine-reservation-child.ts',import.meta.url).pathname,dir,role],{stdio:'ignore'});
      if(!child.pid)throw Error('fixture spawn failed');
      const record={child,start:startTime(child.pid),exited:new Promise(r=>child.once('exit',r))};children.push(record);return record;
    }
    async function kill(record:typeof children[number]) {
      if(record.child.exitCode===null&&record.child.signalCode===null) {
        expect(startTime(record.child.pid!)).toBe(record.start);record.child.kill('SIGKILL');
      }
      await record.exited;
    }
    try {
      const a=start('a'),b=start('b');await until(()=>existsSync(join(dir,'a-started'))&&existsSync(join(dir,'b-started')));
      writeFileSync(join(dir,'go'),'yes');
      await until(()=>['a','b'].every(r=>existsSync(join(dir,r+'-ready'))||existsSync(join(dir,r+'-error'))));
      const winners=['a','b'].filter(r=>existsSync(join(dir,r+'-ready')));expect(winners).toHaveLength(1);
      const winner=winners[0], loser=winner==='a'?'b':'a';
      expect(readFileSync(join(dir,loser+'-error'),'utf8')).toContain('existing quarantine');
      const c=await openSocket(join(dir,'q','s'));if('reason'in c)throw Error(c.reason);
      expect((await c.request({type:'quarantine-result'},2000))?.status).toBe(winner);c.close();
      await kill(winner==='a'?a:b);
      const socket=lstatSync(join(dir,'q','s')),claim=lstatSync(join(dir,'q','owner.json')),bytes=readFileSync(join(dir,'q','owner.json'));
      unlinkSync(join(dir,'go'));start('c');start('d');
      await until(()=>existsSync(join(dir,'c-started'))&&existsSync(join(dir,'d-started')));writeFileSync(join(dir,'go'),'yes');
      await until(()=>existsSync(join(dir,'c-error'))&&existsSync(join(dir,'d-error')));
      for(const role of ['c','d']) {expect(existsSync(join(dir,role+'-ready'))).toBe(false);expect(readFileSync(join(dir,role+'-error'),'utf8')).toContain('existing quarantine endpoint');}
      expect(lstatSync(join(dir,'q','s')).ino).toBe(socket.ino);
      expect(lstatSync(join(dir,'q','owner.json')).ino).toBe(claim.ino);
      expect(readFileSync(join(dir,'q','owner.json'))).toEqual(bytes);
    } finally {for(const child of children)await kill(child);}
  });
},15_000);

test('old late close cannot unlink a new live generation after explicit administrative retirement',async()=>{
  await fixture(async dir=>{
    const old=await listenQuarantineSocket(dir,options);
    // Test-only administrative substitution; ordinary startup never retires these.
    renameSync(join(dir,'q','s'),join(dir,'q','retired-s'));
    renameSync(join(dir,'q','owner.json'),join(dir,'q','retired-owner'));
    const next=await listenQuarantineSocket(dir,options), inode=lstatSync(join(dir,'q','s')).ino;
    old.close();await Bun.sleep(50);old.close();
    try {
      expect(lstatSync(join(dir,'q','s')).ino).toBe(inode);
      const c=await openSocket(join(dir,'q','s'));if('reason'in c)throw Error(c.reason);
      expect((await c.request({type:'quarantine-result'},2000))?.status).toBe('ok');c.close();
    } finally {next.close();await until(()=>!existsSync(join(dir,'q','owner.json')));}
  });
});

test('death immediately after exclusive reservation leaves an empty claim and no automatic recovery',async()=>{
  await fixture(async dir=>{
    const child=spawn(process.execPath,[new URL('./mock-quarantine-reservation-child.ts',import.meta.url).pathname,dir,'pause-claim'],{stdio:'ignore'});
    const startTime=()=>readFileSync(`/proc/${child.pid}/stat`,'utf8').split(') ')[1].split(' ')[19];
    const started=startTime(),exit=new Promise(r=>child.once('exit',r));
    try {
      writeFileSync(join(dir,'go'),'yes');await until(()=>existsSync(join(dir,'reserved')));
      expect(existsSync(join(dir,'q','s'))).toBe(false);
      expect(readFileSync(join(dir,'q','owner.json'),'utf8')).toBe('');
      expect(startTime()).toBe(started);child.kill('SIGKILL');await exit;
      const inode=lstatSync(join(dir,'q','owner.json')).ino;
      const results=await Promise.allSettled([listenQuarantineSocket(dir,options),listenQuarantineSocket(dir,options)]);
      expect(results.every(r=>r.status==='rejected')).toBe(true);
      expect(lstatSync(join(dir,'q','owner.json')).ino).toBe(inode);
      expect(readFileSync(join(dir,'q','owner.json'),'utf8')).toBe('');
      expect(existsSync(join(dir,'q','s'))).toBe(false);
    } finally {
      if(child.exitCode===null&&child.signalCode===null){expect(startTime()).toBe(started);child.kill('SIGKILL');}await exit;
    }
  });
});
