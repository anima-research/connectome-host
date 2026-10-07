import { test, expect } from 'bun:test';
import { validateRecipe, unknownRecipeKeys } from './recipe.js';
import { buildFrameworkAgentConfig } from './framework-agent-config.js';

test('native CLI admission requires supported provider and explicit model/effort', () => {
  expect(() => validateRecipe({ name: 'native', agent: { execution: 'native-cli', provider: 'mock', systemPrompt: '' } })).toThrow('native-cli');
  expect(() => validateRecipe({ name: 'native', agent: { execution: 'native-cli', provider: 'anthropic', systemPrompt: '' } })).toThrow('model');
});

import { AgentFramework, PassthroughStrategy, type Module } from '@animalabs/agent-framework';
import { Membrane } from '@animalabs/membrane';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeCLIHost, PassiveNativeCLIAdapter, CODEX_NATIVE_CONFIG, assertCodexClosedConfig, codexNativeArgs, readNativeCLIQualification, nativeClaudeEffort, sha256, type NativeCLIEvent } from './native-cli.js';

function fixtureSource(mode: string, cli = 'codex'): string {
  if (cli === 'claude') return claudeFixtureSource(mode);
  return `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('codex-cli 0.160.1'); process.exit(0); }
if(!process.argv.includes('features.apps=false'))process.exit(15);
const mode=${JSON.stringify(mode)};
const controls=${JSON.stringify(CODEX_NATIVE_CONFIG)};
const serverName=${JSON.stringify('inherited.with"quote')};
const pluginId=${JSON.stringify('fixture.name"quote@plugin')};
const instructionPath=process.env.CONNECTOME_TEST_NATIVE_INSTRUCTION_PATH;
const sourceModes=['qualified-source','source-unknown','source-missing','source-drift'];
const protocolModes=['observed-protocol','foreign-settings','settings-drift','foreign-usage','remote-active','account-drift'];
const say=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const finish=()=>{
 say({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'The genuine fixture final.'}}});
 if(mode==='duplicate-final') say({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{id:'answer2',type:'agentMessage',phase:'final_answer',text:'Contradiction'}}});
 say({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:mode==='partial'?'interrupted':'completed',error:null}}});
};
const call=(id)=>say({id,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'native-call-'+id,namespace:null,tool:'tool_0',arguments:{value:'exact-'+id}}});
let buffer='';
process.stdin.on('data',bytes=>{buffer+=bytes; let n; while((n=buffer.indexOf('\\n'))>=0){
 const raw=buffer.slice(0,n); buffer=buffer.slice(n+1); const m=JSON.parse(raw);
 if(m.method==='initialize'){
   if(m.params.capabilities.experimentalApi!==true) process.exit(2);
   if(mode==='malformed'){process.stdout.write('not-json\\n');continue;}
   if(mode==='dropout'){process.exit(0);}
   if(mode==='cancel') continue;
   say({id:m.id,result:{userAgent:'fixture'}});
   if(protocolModes.includes(mode))say({method:'remoteControl/status/changed',params:{status:mode==='remote-active'?'connected':'disabled',serverName:'fixture-host',installationId:'fixture-install',environmentId:null}});
 }else if(m.method==='account/read'){
   say({id:m.id,result:{account:{type:'chatgpt',email:null,planType:'pro'}}});
   if(protocolModes.includes(mode))say({method:'account/updated',params:{authMode:mode==='account-drift'?'apikey':'chatgpt',planType:'pro'}});
 }
 else if(m.method==='config/read'){const projected={...controls};delete projected['tools.update_plan.enabled'];delete projected['tools.experimental_request_user_input.enabled'];say({id:m.id,result:{config:{...projected,mcp_servers:{[serverName]:{enabled:true}},plugins:{[pluginId]:{enabled:true}},desktop:{notifications:true},custom_provider_secret:'never-retain-this-fixture-value'}}});}
 else if(m.method==='thread/start'){
   if(m.params.config['features.apps']!==false || m.params.baseInstructions!=='Bound system' || m.params.model!=='gpt-fixture' || m.params.modelProvider!=='openai' || m.params.environments.length || m.params.selectedCapabilityRoots.length || m.params.dynamicTools.length!==1) process.exit(3);
   if(JSON.stringify(m.params.config.mcp_servers)!==JSON.stringify({[serverName]:{enabled:false}}) || JSON.stringify(m.params.config.plugins)!==JSON.stringify({[pluginId]:{enabled:false}}) || m.params.config['tools.update_plan.enabled']!==false || m.params.config['tools.experimental_request_user_input.enabled']!==false)process.exit(12);
   if(mode==='source-drift')require('node:fs').writeFileSync(instructionPath,'Changed after qualification.');
   const instructionSources=sourceModes.includes(mode)?(mode==='source-missing'?[]:[mode==='source-unknown'?instructionPath+'.unknown':instructionPath]):[];
   say({id:m.id,result:{thread:{id:'thread'},model:'gpt-fixture',modelProvider:'openai',reasoningEffort:'medium',instructionSources}});
   if(protocolModes.includes(mode))say({method:'thread/settings/updated',params:{threadId:mode==='foreign-settings'?'foreign':'thread',threadSettings:{disabledPluginIds:[pluginId],cwd:process.cwd(),approvalPolicy:'never',approvalsReviewer:'auto_review',sandboxPolicy:{type:'readOnly',networkAccess:false},activePermissionProfile:null,model:mode==='settings-drift'?'foreign-model':'gpt-fixture',modelProvider:'openai',serviceTier:'default',effort:'medium',summary:null,collaborationMode:{mode:'default',settings:{model:'gpt-fixture',reasoning_effort:'medium',developer_instructions:null}},multiAgentMode:'explicitRequestOnly',personality:'pragmatic'}}});
 }else if(m.method==='mcpServerStatus/list'){if(m.params.threadId!=='thread')process.exit(13);say({id:m.id,result:{data:[{name:serverName,runtimeStatus:mode==='active-mcp'?'connected':'disabled'},...(mode==='connected-apps'?[{name:'codex_apps',runtimeStatus:'connected'}]:[])],nextCursor:null}});
 }else if(m.method==='turn/start'){
   if(JSON.stringify(m.params.disabledPluginIds)!==JSON.stringify([pluginId]))process.exit(14);
   if(m.params.environments.length || m.params.input.length!==1 || m.params.input[0].text!=='Original input' || m.params.effort!=='medium')process.exit(4);
   say({id:m.id,result:{turn:{id:'turn'}}});
   say({method:'turn/started',params:{threadId:'thread',turn:{id:'turn'}}});
   if(protocolModes.includes(mode))say({method:'thread/tokenUsage/updated',params:{threadId:'thread',turnId:mode==='foreign-usage'?'foreign':'turn',tokenUsage:{total:{totalTokens:10282,inputTokens:10256,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:26,reasoningOutputTokens:0},last:{totalTokens:10282,inputTokens:10256,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:26,reasoningOutputTokens:0},modelContextWindow:258400}}});
   if(mode==='request-id-collision'){call(0);continue;}
   say({id:100,method:'item/tool/call',params:{threadId:mode==='foreign'?'foreign':'thread',turnId:'turn',callId:'native-call',namespace:null,tool:mode==='unauthorized'?'tool_99':'tool_0',arguments:{value:'exact'}}});
   if(mode==='duplicate-call')say({id:101,method:'item/tool/call',params:{threadId:'thread',turnId:'turn',callId:'native-call',namespace:null,tool:'tool_0',arguments:{value:'exact'}}});
 }else if(mode==='request-id-collision' && m.result){
   if(m.result.contentItems[0].type!=='inputText'||!m.result.success)process.exit(5);
   const result=JSON.parse(m.result.contentItems[0].text);
   if(result.data.value!=='exact-'+m.id)process.exit(16);
   if(m.id<3)call(m.id+1);else finish();
 }else if(m.id===100 && m.result){ if(m.result.contentItems[0].type!=='inputText'||!m.result.success)process.exit(5);finish();}
}});
process.stdin.on('end',()=>{
 if(mode==='late-foreign-final') {
   process.stdout.write(JSON.stringify({method:'item/completed',params:{threadId:'foreign',turnId:'turn',item:{id:'late-answer',type:'agentMessage',phase:'final_answer',text:'Contradictory late final.'}}})+'\\n',()=>process.exit(0));
 } else process.exit(0);
});
`;
}


function claudeFixtureSource(mode: string): string {
  // Sanitized recorded WH status: no subscriptionType or credential-store assumption.
  const authStatus = mode === 'oauth-logged-out' ? { loggedIn: false, authMethod: 'none' } : {
    loggedIn: true,
    authMethod: mode === 'oauth-api-key' ? 'api_key' : mode.startsWith('oauth-') ? 'oauth_token' : 'claude.ai',
    apiProvider: ['oauth-other-provider', 'claudeai-other-provider'].includes(mode) ? 'thirdParty' : 'firstParty',
  };
  return `#!${process.execPath}
if(process.argv.includes('--version')) {console.log('2.1.291 (Claude Code)');process.exit(0);}
if(process.argv.includes('auth')) {const status=${JSON.stringify(authStatus)};console.log(JSON.stringify(status));process.exit(status.loggedIn?0:1);}
const mode=${JSON.stringify(mode)};
const arg=n=>process.argv[process.argv.indexOf(n)+1];
const session=arg('--session-id');
const endpoint=JSON.parse(arg('--mcp-config')).mcpServers.connectome.url;
const say=v=>process.stdout.write(JSON.stringify({...v,session_id:v.session_id??session})+'\\n');
const fs=require('node:fs'),path=require('node:path');
const nativeRoot=process.env.CONNECTOME_TEST_NATIVE_TRANSCRIPT_ROOT;
const assistant=(uuid,message)=>{
 fs.mkdirSync(nativeRoot,{recursive:true});
 const persisted=uuid==='final-frame'?{...message,
   stop_reason:mode==='missing-final-stop'?undefined:mode==='contradictory-final-stop'?'max_tokens':message.stop_reason,
   content:mode==='contradictory-final-content'?[{type:'text',text:'Different persisted final.'}]:message.content}:message;
 const record={type:'assistant',uuid,sessionId:session,isSidechain:false,message:persisted,effort:mode==='missing-effort'?undefined:mode==='effort-drift'?'high':'medium'};
 fs.appendFileSync(path.join(nativeRoot,session+'.jsonl'),JSON.stringify(record)+'\\n');
 say({type:'assistant',uuid,message:mode==='observed-native'?{...message,stop_reason:null}:message});
};
if(arg('--tools')!=='' || !process.argv.includes('--restricted') || !process.argv.includes('--strict-mcp-config') || process.argv.includes('--safe-mode') || arg('--setting-sources')!=='' || JSON.parse(arg('--settings')).disableAllHooks!==true || arg('--system-prompt')!=='Bound system' || arg('--effort')!=='medium')process.exit(9);
let buffer='';process.stdin.on('data',async bytes=>{
 buffer+=bytes;if(!buffer.includes('\\n'))return;
 const original=JSON.parse(buffer.trim());
 if(original.message.role!=='user'||original.message.content[0].text!=='Original input')process.exit(10);
 if(mode==='dropout')process.exit(0);
 if(mode==='malformed'){process.stdout.write('not-json\\n');return;}
 if(mode==='cancel')return;
 say({type:'system',subtype:'init',model:'gpt-fixture'});
 if(mode==='compact')say({type:'system',subtype:'compact_boundary',uuid:'compact-frame',compact_metadata:{trigger:'auto',pre_tokens:150000}});
 assistant('tool-frame',{id:'msg_tool',role:'assistant',model:'gpt-fixture',stop_reason:'tool_use',content:[{type:'tool_use',id:'native-call',name:'mcp__connectome__tool_0',input:{value:'exact'}}]});
 const post=async (id,method,params,token)=>fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',...(token?{'mcp-session-id':token}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
 const discovery=await post('server-discover-probe-1','server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'claude-code',version:'2.1.291'},'io.modelcontextprotocol/clientCapabilities':{roots:{listChanged:true},elicitation:{form:{},url:{}}}}},mode==='foreign-discovery'?'foreign':undefined);
 if(!discovery.ok)return;
 const unsupported=await discovery.json();
 if(unsupported.jsonrpc!=='2.0' || unsupported.id!=='server-discover-probe-1' || unsupported.error?.code!==-32601 || discovery.headers.get('mcp-session-id')!==null)process.exit(16);
 if(mode==='unbound-get'){await fetch(endpoint,{headers:{accept:'text/event-stream'}});return;}
 const init=await post(1,'initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 const token=init.headers.get('mcp-session-id');
 const initialized=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','mcp-session-id':token},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})});
 if(initialized.status!==202)process.exit(12);
 if(mode==='late-discovery'){await post('late-discovery','server/discover',{},token);return;}
 const stream=await fetch(endpoint,{method:'GET',headers:{accept:'text/event-stream','mcp-session-id':mode==='foreign-get'?'foreign':token}});
 if(stream.status!==405)process.exit(13);
 const listed=await post(2,'tools/list',{},mode==='foreign'?'foreign':token);
 if(!listed.ok)return;
 const tool=await post(3,'tools/call',{name:'tool_0',arguments:{value:mode==='reordered'?'wrong':'exact'}},token);
 if(!tool.ok)return;
 const result=await tool.json();if(result.result.isError)process.exit(11);
 if(['thinking','thinking-foreign','thinking-malformed'].includes(mode))say({type:'system',subtype:'thinking_tokens',estimated_tokens:mode==='thinking-malformed'?50.5:50,estimated_tokens_delta:50,session_id:mode==='thinking-foreign'?'foreign':session,uuid:'f9acf4c6-26dc-46cd-9421-4572b14f7173'});
 assistant('final-frame',{id:'msg_final',role:'assistant',model:'gpt-fixture',stop_reason:'end_turn',content:[{type:'text',text:'The genuine fixture final.'}]});
 if(['observed-native','malformed-rate','foreign-rate'].includes(mode))say({type:'rate_limit_event',session_id:mode==='foreign-rate'?'foreign':session,uuid:'190b54c7-455b-4179-9311-2bc4abc9af1e',rate_limit_info:{status:mode==='malformed-rate'?'invented':'allowed',resetsAt:1791332400,rateLimitType:'five_hour',overageStatus:'rejected',overageDisabledReason:'org_level_disabled',isUsingOverage:false,unifiedWindows:{five_hour:{utilization:0.01,resetsAt:1791332400},seven_day:{utilization:0.12,resetsAt:1791579600}}}});
 say({type:'result',subtype:mode==='partial'?'error_max_turns':'success',is_error:mode==='partial',result:'The genuine fixture final.'});
 setTimeout(()=>process.exit(0),20);
});
`;
}

async function runFixture(mode: string, cli = 'codex') {
  const dir = realpathSync(mkdtempSync(join(realpathSync(process.env.CONNECTOME_TEST_EVIDENCE_DIR ?? tmpdir()), 'native-cli-test-')));
  const aliasMode = mode.startsWith('alias-');
  const fixture = join(dir, 'codex-fixture');
  const source = fixtureSource(aliasMode ? 'success' : mode, cli);
  const invocationLog = join(dir, 'invocations.log');
  const phaseLog = `require('node:fs').appendFileSync(${JSON.stringify(invocationLog)}, (process.argv.includes('--version')?'version':process.argv.includes('auth')?'auth':'main')+'\\n');`;
  writeFileSync(fixture, aliasMode ? source : source.replace('\n', `\n${phaseLog}\n`)); chmodSync(fixture, 0o700);
  const binary = aliasMode ? join(dir, 'ai-killswitch-wrapper.sh') : fixture;
  const invocationPath = aliasMode ? join(dir, cli) : binary;
  if (aliasMode) {
    const other = join(dir, 'other-wrapper.sh');
    writeFileSync(other, '#!/bin/sh\nexit 65\n'); chmodSync(other, 0o700);
    // Observed wrapper contract: only the configured claude/codex basename selects a provider.
    writeFileSync(binary, `#!/bin/sh
case "\${0##*/}" in claude|codex) ;; *) exit 64 ;; esac
phase=main
case "\${1-}" in --version) phase=version ;; auth) phase=auth ;; esac
printf '%s\\n' "$phase" >> '${invocationLog}'
if [ '${mode}' = "alias-retarget-$phase" ]; then /bin/ln -sf '${other}' '${invocationPath}'; fi
exec '${fixture}' "$@"
`);
    chmodSync(binary, 0o700);
    symlinkSync(mode === 'alias-wrong-target' ? other : binary, invocationPath);
    symlinkSync(binary, join(dir, cli === 'claude' ? 'codex' : 'claude'));
  }
  const envName = cli === 'claude' ? 'CLAUDE_BINARY' : 'CODEX_BINARY';
  const old = process.env[envName]; process.env[envName] = invocationPath;
  const oldInstruction = process.env.CONNECTOME_TEST_NATIVE_INSTRUCTION_PATH;
  const instructionPath = join(dir, 'native-instructions.txt');
  const qualifiedSource = cli === 'codex' && ['qualified-source', 'source-unknown', 'source-missing', 'source-drift'].includes(mode);
  if (qualifiedSource) writeFileSync(instructionPath, 'Existing native user instructions.');
  process.env.CONNECTOME_TEST_NATIVE_INSTRUCTION_PATH = instructionPath;
  const oldTranscript = process.env.CONNECTOME_TEST_NATIVE_TRANSCRIPT_ROOT;
  process.env.CONNECTOME_TEST_NATIVE_TRANSCRIPT_ROOT = join(dir, 'native-history');
  let calls = 0;
  const module: Module = { name: 'fixture', async start() {}, async stop() {},
    getTools: () => [{ name: 'echo', description: 'Fixture echo', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }],
    async handleToolCall(call) { calls++; return { success: true, data: call.input }; },
    async onProcess() { return {}; } };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'), membrane: new Membrane(new PassiveNativeCLIAdapter()),
    agents: [{ name: 'bound', model: 'gpt-fixture', systemPrompt: 'Bound system', strategy: new PassthroughStrategy(), allowedTools: ['fixture--echo'] }],
    modules: [module], inferencePolicy: { shouldInfer: () => false }, maintenanceIntervalMs: 0 });
  framework.start();
  const recipe = validateRecipe({ name: 'native', agent: { name: 'bound', execution: 'native-cli', provider: cli === 'claude' ? 'anthropic' : 'openai-codex',
    model: 'gpt-fixture', systemPrompt: 'Bound system', ...(cli === 'claude' ? { thinking: { enabled: true, effort: 'medium' } } : { responses: { reasoningEffort: 'medium' } }), allowedTools: ['fixture--echo'] } });
  const proofs = Object.fromEntries(['installedConfig', 'toolClosure', 'protocol', 'lifecycle'].map(key => {
    const path = join(dir, `native-cli-${key}.json`); const bytes = JSON.stringify(key === 'installedConfig' ? { nativeBinary: { path: binary, sha256: mode === 'binary-drift' ? '0'.repeat(64) : sha256(readFileSync(binary)) }, ...(qualifiedSource ? { nativeInstructionSources: [{ path: instructionPath, sha256: sha256(readFileSync(instructionPath)) }] } : {}), ...(cli === 'claude' ? { nativeTranscript: { projectDir: join(dir, 'native-history'), cwd: process.cwd(), cliBinaryPath: binary, cliBinarySha256: sha256(readFileSync(binary)), cliVersion: '2.1.291' } } : {}) } : { fixture: key }); writeFileSync(path, bytes);
    return [key, { path, sha256: sha256(bytes) }];
  }));
  const loginMode = cli === 'claude'
    ? (mode === 'claudeai-mode-drift' || (mode.startsWith('oauth-') && mode !== 'oauth-mode-drift') ? 'oauth_token' : 'claude.ai')
    : 'chatgpt';
  const report = { binding: { fixture: true }, role: 'fixture', instance: 'bound', runtime: { fixture: true },
    recipeSha256: sha256(JSON.stringify(recipe, null, 2)), cli, cliVersion: cli === 'claude' ? '2.1.291' : '0.160.1', interface: cli === 'claude' ? 'claude-print-stream-json' : 'codex-app-server-stdio',
    loginMode, model: 'gpt-fixture', effort: 'medium', qualified: true, proofs };
  const reportPath = join(dir, 'native-cli-qualification.json'); const reportBytes = JSON.stringify(report); writeFileSync(reportPath, reportBytes);
  const oldPath = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH;
  const oldHash = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256;
  process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH = reportPath;
  process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256 = sha256(reportBytes);
  const host = new NativeCLIHost(framework, recipe, 'bound', dir);
  const events: NativeCLIEvent[] = [];
  let resolveStarted!: () => void;
  const started = new Promise<void>(r => { resolveStarted = r; });
  host.onEvent(event => { events.push(event); if (event.type === 'native-cli:started') resolveStarted(); });
  const receipt = host.publishInput('Original input');
  expect(receipt.messageSha256).toBe(sha256(JSON.stringify(framework.getAgent('bound')!.getContextManager().getMessage(receipt.messageId))));
  expect(() => host.publishInput('Duplicate overlapping input')).toThrow('busy');
  if (mode === 'cancel') { await started; await host.stop(); }
  else await host.waitForIdle();
  const messages = framework.getAgent('bound')!.getContextManager().getAllMessages();
  await host.stop(); await framework.stop();
  if (old === undefined) delete process.env[envName]; else process.env[envName] = old;
  if (oldTranscript === undefined) delete process.env.CONNECTOME_TEST_NATIVE_TRANSCRIPT_ROOT; else process.env.CONNECTOME_TEST_NATIVE_TRANSCRIPT_ROOT = oldTranscript;
  if (oldPath === undefined) delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH; else process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH = oldPath;
  if (oldInstruction === undefined) delete process.env.CONNECTOME_TEST_NATIVE_INSTRUCTION_PATH; else process.env.CONNECTOME_TEST_NATIVE_INSTRUCTION_PATH = oldInstruction;
  if (oldHash === undefined) delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256; else process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256 = oldHash;
  const raw = readFileSync(join(dir, readdirSync(dir).find(p => p.startsWith('native-cli.') && p.endsWith('.jsonl') && !p.endsWith('.native-session.jsonl'))!), 'utf8');
  expect(raw).not.toContain('never-retain-this-fixture-value');
  return { events, messages, calls, raw, invocations: readdirSync(dir).includes('invocations.log') ? readFileSync(invocationLog, 'utf8').trim().split('\n') : [] };
}

for (const cli of ['claude', 'codex']) {
  test(`native ${cli} preserves configured alias through version, auth and main dispatch`, async () => {
    const result = await runFixture('alias-success', cli);
    const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe('completed');
    expect(terminal.finalText).toBe('The genuine fixture final.');
    expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.exitCode).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.invocations).toEqual(cli === 'claude' ? ['version', 'auth', 'main'] : ['version', 'main']);
  });
  for (const mode of ['alias-wrong-target', 'alias-retarget-version', ...(cli === 'claude' ? ['alias-retarget-auth'] : [])]) {
    test(`native ${cli} rejects ${mode} before the next dispatch or Framework effect`, async () => {
      const result = await runFixture(mode, cli);
      const terminal = result.events.at(-1)!;
      if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
      expect(terminal.outcome).toBe('failed'); expect(terminal.finalText).toBeNull();
      expect(result.calls).toBe(0);
      expect(result.events.some(e => e.type === 'native-cli:started')).toBe(false);
      expect(result.events.some(e => e.type === 'native-cli:failure' && e.reason.includes('qualified binary identity'))).toBe(true);
      expect(result.invocations).toEqual(mode === 'alias-wrong-target' ? [] : mode === 'alias-retarget-auth' ? ['version', 'auth'] : ['version']);
    });
  }
}

for (const mode of ['success', 'qualified-source', 'observed-protocol']) test(`native Codex ${mode} supported protocol links real Framework pairs and stores genuine final text`, async () => {
  const result = await runFixture(mode);
  const terminal = result.events.at(-1)!;
  expect(terminal.type).toBe('native-cli:terminal');
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('completed'); expect(terminal.nativeStatus).toBe('completed');
  expect(terminal.nativeModel).toBe('gpt-fixture'); expect(terminal.nativeEffort).toBe('medium');
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.exitCode).toBe(0);
  expect(result.calls).toBe(1);
  const link = result.events.find(e => e.type === 'native-cli:tool-link')!;
  if (link.type !== 'native-cli:tool-link') throw new Error('Missing tool link');
  expect(link.nativeCallId).toBe('native-call'); expect(link.provenance).toBe('framework.puppetToolCall');
  const toolIndex = result.messages.findIndex(m => m.content.some(b => b.type === 'tool_use' && b.id === link.frameworkToolUseId));
  expect(toolIndex).toBeGreaterThan(0);
  expect(result.messages[toolIndex].participant).toBe('bound');
  expect(result.messages[toolIndex + 1].content.some(b => b.type === 'tool_result' && b.toolUseId === link.frameworkToolUseId)).toBe(true);
  expect(result.messages.at(-1)!.participant).toBe('bound');
  if (terminal.finalText === null) throw new Error('Missing genuine text');
  expect(result.messages.at(-1)!.content).toEqual([{ type: 'text', text: terminal.finalText }]);
  expect(result.events.some(e => e.type.startsWith('inference:'))).toBe(false);
  if (mode === 'observed-protocol') {
    for (const method of ['remoteControl/status/changed', 'account/updated', 'thread/settings/updated', 'thread/tokenUsage/updated']) expect(result.raw).toContain(method);
    expect(result.raw).toContain('258400');
  }
});

test('native Codex server requests can reuse client request IDs and retain four Framework pairs', async () => {
  const result = await runFixture('request-id-collision');
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('completed');
  expect(terminal.nativeStatus).toBe('completed');
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.exitCode).toBe(0);
  expect(terminal.finalText).toBe('The genuine fixture final.');
  expect(result.calls).toBe(4);
  const raw = result.raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const configRequest = raw.find(row => row.direction === 'stdin' && JSON.parse(row.raw).method === 'config/read');
  expect(JSON.parse(configRequest.raw).id).toBe(3);
  expect(raw.filter(row => row.direction === 'configuration')).toHaveLength(1);
  const links = result.events.filter(e => e.type === 'native-cli:tool-link');
  expect(links).toHaveLength(4);
  const frameworkIds: string[] = [];
  for (const [id, link] of links.entries()) {
    if (link.type !== 'native-cli:tool-link') throw new Error('Missing tool link');
    expect(link.nativeCallId).toBe('native-call-' + id);
    expect(link.provenance).toBe('framework.puppetToolCall');
    frameworkIds.push(link.frameworkToolUseId);
    const index = result.messages.findIndex(message => message.content.some(block => block.type === 'tool_use' && block.id === link.frameworkToolUseId));
    expect(index).toBeGreaterThan(0);
    expect(result.messages[index].participant).toBe('bound');
    expect(result.messages[index].content.some(block => block.type === 'tool_use' && block.id === link.frameworkToolUseId && JSON.stringify(block.input) === JSON.stringify({ value: 'exact-' + id }))).toBe(true);
    expect(result.messages[index + 1].content.some(block => block.type === 'tool_result' && block.toolUseId === link.frameworkToolUseId)).toBe(true);
    const request = raw.find(row => row.direction === 'stdout' && JSON.parse(row.raw).method === 'item/tool/call' && JSON.parse(row.raw).id === id);
    expect(JSON.parse(request.raw).params.callId).toBe('native-call-' + id);
  }
  expect(new Set(frameworkIds).size).toBe(4);
  if (terminal.finalText === null) throw new Error('Missing genuine text');
  expect(result.messages.at(-1)!.content).toEqual([{ type: 'text', text: terminal.finalText }]);
  expect(result.events.some(e => e.type.startsWith('inference:'))).toBe(false);
});

for (const mode of ['foreign-settings', 'settings-drift', 'foreign-usage', 'remote-active', 'account-drift']) test(`native Codex refuses observed ${mode}`, async () => {
  const result = await runFixture(mode);
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('failed'); expect(terminal.finalText).toBe(null);
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(result.calls).toBe(0);
  const reason = { 'foreign-settings': 'settings', 'settings-drift': 'settings', 'foreign-usage': 'usage', 'remote-active': 'remote control', 'account-drift': 'account' }[mode];
  expect(result.events.some(e => e.type === 'native-cli:failure' && e.reason.includes(reason!))).toBe(true);
});

for (const mode of ['source-unknown', 'source-missing', 'source-drift']) test(`native Codex refuses ${mode} before provider turn`, async () => {
  const result = await runFixture(mode);
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('failed'); expect(terminal.finalText).toBe(null);
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(result.calls).toBe(0);
  expect(result.raw).not.toContain('"method":"turn/start"');
  expect(result.events.some(e => e.type === 'native-cli:failure' && e.reason.includes(mode === 'source-drift' ? 'hash drift' : 'instruction sources'))).toBe(true);
});

for (const mode of ['malformed', 'dropout', 'unauthorized', 'foreign', 'duplicate-call', 'duplicate-final', 'partial', 'cancel']) {
  test(`native CLI refuses ${mode} with owned shutdown and retained failure`, async () => {
    const result = await runFixture(mode);
    const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
    expect(terminal.finalText).toBe(null); expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true);
    expect(result.events.some(e => e.type === 'native-cli:failure')).toBe(true);
    expect(result.messages.some(m => m.content.some(b => b.type === 'text' && b.text === 'The genuine fixture final.'))).toBe(false);
    if (['unauthorized', 'foreign', 'malformed', 'dropout', 'cancel'].includes(mode)) expect(result.calls).toBe(0);
    if (mode === 'malformed') expect(result.raw).toContain('not-json');
    const failure = result.events.find(e => e.type === 'native-cli:failure')!;
    if (failure.type !== 'native-cli:failure') throw new Error('Missing failure');
    const reasons: Record<string, string> = { malformed: 'JSON Parse', dropout: 'without a terminal', unauthorized: 'unauthorized', foreign: 'foreign', 'duplicate-call': 'duplicate', 'duplicate-final': 'Duplicate native final', partial: 'partial', cancel: 'cancelled' };
    expect(failure.reason).toContain(reasons[mode]);
    if (['duplicate-call', 'duplicate-final', 'partial'].includes(mode)) expect(result.calls).toBe(1);
  });
}

test('effective closure refuses inherited contributors, missing controls and changed controls', () => {
  expect(() => assertCodexClosedConfig(CODEX_NATIVE_CONFIG)).not.toThrow();
  expect(() => assertCodexClosedConfig({ ...CODEX_NATIVE_CONFIG, mcp_servers: { inherited: {} } })).toThrow('mcp_servers');
  expect(() => assertCodexClosedConfig({ ...CODEX_NATIVE_CONFIG, plugins: { inherited: true } })).toThrow('plugins');
  expect(() => assertCodexClosedConfig({ ...CODEX_NATIVE_CONFIG, 'features.shell_tool': true })).toThrow('shell_tool');
  expect(() => assertCodexClosedConfig({ web_search: 'disabled' })).toThrow('qualified');
  expect(codexNativeArgs()).toContain('features.token_budget={ enabled = false, use_history_notes_extension = false }');
  expect(codexNativeArgs()).toContain('features.apps=false');
  expect(() => assertCodexClosedConfig({ ...CODEX_NATIVE_CONFIG, 'features.apps': true })).toThrow('features.apps');
  const missingApps = { ...CODEX_NATIVE_CONFIG } as Record<string, unknown>; delete missingApps['features.apps'];
  expect(() => assertCodexClosedConfig(missingApps, true)).toThrow('features.apps');
});

test('passive adapter refuses HTTP completion and streaming', async () => {
  const adapter = new PassiveNativeCLIAdapter();
  await expect(adapter.complete()).rejects.toThrow('prohibits');
  await expect(adapter.stream()).rejects.toThrow('prohibits');
});


for (const mode of ['success', 'observed-native', 'thinking']) test(`native Claude ${mode} MCP links genuine assistant declaration, real stored pair and final result`, async () => {
  const result = await runFixture(mode, 'claude');
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('completed'); expect(terminal.nativeStatus).toBe('success');
  expect(terminal.nativeModel).toBe('gpt-fixture'); expect(terminal.nativeEffort).toBe('medium');
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.exitCode).toBe(0);
  expect(result.calls).toBe(1);
  const link = result.events.find(e => e.type === 'native-cli:tool-link')!;
  if (link.type !== 'native-cli:tool-link') throw new Error('Missing tool link');
  expect(link.nativeCallId).toBe('native-call'); expect(link.nativeRequestId).toBe('3');
  expect(result.messages.some(m => m.content.some(b => b.type === 'tool_use' && b.id === link.frameworkToolUseId))).toBe(true);
  expect(result.messages.at(-1)!.content).toEqual([{ type: 'text', text: 'The genuine fixture final.' }]);
  if (mode === 'observed-native') expect(result.raw).toContain('rate_limit_event');
  if (mode === 'thinking') expect(result.raw).toContain('thinking_tokens');
});
for (const mode of ['malformed', 'dropout', 'foreign', 'foreign-get', 'unbound-get', 'foreign-discovery', 'late-discovery', 'malformed-rate', 'foreign-rate', 'thinking-foreign', 'thinking-malformed', 'reordered', 'partial', 'cancel']) {
  test(`native Claude refuses ${mode} and reaps its owned process`, async () => {
    const result = await runFixture(mode, 'claude'); const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe(mode === 'cancel' ? 'cancelled' : 'failed');
    expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.finalText).toBe(null);
    if (['partial', 'malformed-rate', 'foreign-rate', 'thinking-foreign', 'thinking-malformed'].includes(mode)) expect(result.calls).toBe(1); else expect(result.calls).toBe(0);
    const failure = result.events.find(e => e.type === 'native-cli:failure')!;
    if (failure.type !== 'native-cli:failure') throw new Error('Missing failure');
    const reasons: Record<string, string> = { malformed: 'json parse', dropout: 'without a terminal', foreign: 'foreign', 'foreign-get': 'foreign', 'unbound-get': 'unsupported', 'foreign-discovery': 'foreign', 'late-discovery': 'unadmitted', 'malformed-rate': 'rate-limit status', 'foreign-rate': 'foreign', 'thinking-foreign': 'foreign', 'thinking-malformed': 'thinking token', reordered: 'reordered', partial: 'partial', cancel: 'cancelled' };
    expect(failure.reason.toLowerCase()).toContain(reasons[mode]);
  });
}


for (const cli of ['claude', 'codex']) test(`trusted current ${cli} qualification supports truthful login modes and refuses conflicting binding, tampered proof and namespace drift`, () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(process.env.CONNECTOME_TEST_EVIDENCE_DIR ?? tmpdir()), 'native-cli-qualification-test-')));
  const recipe = validateRecipe({ name: 'qualified', agent: { execution: 'native-cli', provider: cli === 'claude' ? 'anthropic' : 'openai-codex',
    name: 'bound', model: 'gpt-fixture', systemPrompt: 'Bound system', ...(cli === 'claude' ? { thinking: { enabled: true, effort: 'medium' } } : { responses: { reasoningEffort: 'medium' } }) } });
  const proofs = Object.fromEntries(['installedConfig', 'toolClosure', 'protocol', 'lifecycle'].map(key => {
    const path = join(dir, `native-cli-${key}.json`); const bytes = JSON.stringify({ fixture: key }); writeFileSync(path, bytes);
    return [key, { path, sha256: sha256(bytes) }];
  }));
  const base = { binding: { fixture: true }, role: 'fixture', instance: 'bound', runtime: { fixture: true },
    recipeSha256: sha256(JSON.stringify(recipe, null, 2)), cli, cliVersion: cli === 'claude' ? '2.1.291' : '0.160.1', interface: cli === 'claude' ? 'claude-print-stream-json' : 'codex-app-server-stdio',
    loginMode: cli === 'claude' ? 'claude.ai' : 'chatgpt', model: 'gpt-fixture', effort: 'medium', qualified: true, proofs };
  const path = join(dir, 'native-cli-qualification.json');
  const oldPath = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH;
  const oldHash = process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256;
  const publish = (report: unknown) => { const bytes = JSON.stringify(report); writeFileSync(path, bytes);
    process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH = path; process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256 = sha256(bytes); };
  try {
    delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH; delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256;
    expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow();
    publish(base); expect(readNativeCLIQualification(recipe, 'bound').files).toHaveLength(5);
    if (cli === 'claude') {
      publish({ ...base, loginMode: 'oauth_token' });
      expect(readNativeCLIQualification(recipe, 'bound').report.loginMode).toBe('oauth_token');
    }
    for (const loginMode of cli === 'claude' ? ['apiKey', 'none', 'chatgpt'] : ['apiKey', 'none', 'claude.ai', 'oauth_token']) {
      publish({ ...base, loginMode }); expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow('binding');
    }
    for (const patch of [{ qualified: false }, { instance: 'foreign' }, { model: 'foreign' }, { effort: 'high' },
      { cliVersion: '0.160.2' }, { loginMode: 'apiKey' }, { recipeSha256: '0'.repeat(64) }]) {
      publish({ ...base, ...patch }); expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow('binding');
    }
    publish(base); process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256 = '0'.repeat(64);
    expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow('hash');
    publish(base); writeFileSync(proofs.toolClosure.path, 'tampered');
    expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow('hash');
    writeFileSync(proofs.toolClosure.path, JSON.stringify({ fixture: 'toolClosure' }));
    publish({ ...base, proofs: { ...proofs, toolClosure: proofs.protocol } });
    expect(() => readNativeCLIQualification(recipe, 'bound')).toThrow('staged evidence');
  } finally {
    if (oldPath === undefined) delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH; else process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH = oldPath;
    if (oldHash === undefined) delete process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256; else process.env.CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256 = oldHash;
  }
});

test('native CLI selection bypasses HTTP auth initialization while HTTP omission preserves refusal', async () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(process.env.CONNECTOME_TEST_EVIDENCE_DIR ?? tmpdir()), 'native-cli-auth-test-')));
  const path = join(dir, 'recipe.json');
  const recipe = { name: 'auth', agent: { name: 'bound', execution: 'native-cli', provider: 'anthropic', model: 'claude-fixture',
    systemPrompt: 'Bound system', thinking: { enabled: true, effort: 'medium' } }, modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false } };
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: join(dir, 'data') };
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH', 'CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256']) delete env[key];
  const run = async () => { const process = Bun.spawn([globalThis.process.execPath, new URL('./index.ts', import.meta.url).pathname, path, '--headless'],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]); return { code, stderr }; };
  writeFileSync(path, JSON.stringify(recipe)); const native = await run();
  expect(native.code).toBe(1); expect(native.stderr).not.toContain('Missing ANTHROPIC_API_KEY');
  expect(native.stderr).toContain('Native CLI qualification is missing');
  delete (recipe.agent as { execution?: string }).execution;
  writeFileSync(path, JSON.stringify(recipe)); const http = await run();
  expect(http.code).toBe(1); expect(http.stderr).toContain('Missing ANTHROPIC_API_KEY');
});

import { connect, type Socket } from 'node:net';
import { existsSync } from 'node:fs';

test('actual headless CLI input ACK binds stored input; socket dropout cancels and reaps without replay', async () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(process.env.CONNECTOME_TEST_EVIDENCE_DIR ?? tmpdir()), 'native-cli-headless-test-')));
  const binary = join(dir, 'codex-fixture'); writeFileSync(binary, fixtureSource('cancel')); chmodSync(binary, 0o700);
  const rawRecipe = { name: 'headless-native', agent: { name: 'bound', execution: 'native-cli', provider: 'openai-codex',
    model: 'gpt-fixture', systemPrompt: 'Bound system', responses: { reasoningEffort: 'medium' }, allowedTools: [] },
    modules: { subagents: false, lessons: false, retrieval: false, wake: false, workspace: false } };
  const recipePath = join(dir, 'recipe.json'); writeFileSync(recipePath, JSON.stringify(rawRecipe, null, 2));
  const proofs = Object.fromEntries(['installedConfig', 'toolClosure', 'protocol', 'lifecycle'].map(key => {
    const path = join(dir, `native-cli-${key}.json`); const bytes = JSON.stringify(key === 'installedConfig' ? { nativeBinary: { path: binary, sha256: sha256(readFileSync(binary)) } } : { fixture: key }); writeFileSync(path, bytes);
    return [key, { path, sha256: sha256(bytes) }];
  }));
  const report = { binding: { fixture: true }, role: 'fixture', instance: 'bound', runtime: { fixture: true },
    recipeSha256: sha256(JSON.stringify(rawRecipe, null, 2)), cli: 'codex', cliVersion: '0.160.1', interface: 'codex-app-server-stdio',
    loginMode: 'chatgpt', model: 'gpt-fixture', effort: 'medium', qualified: true, proofs };
  const reportPath = join(dir, 'native-cli-qualification.json'); const reportBytes = JSON.stringify(report); writeFileSync(reportPath, reportBytes);
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dir, CODEX_BINARY: binary,
    CONNECTOME_NATIVE_CLI_QUALIFICATION_PATH: reportPath, CONNECTOME_NATIVE_CLI_QUALIFICATION_SHA256: sha256(reportBytes) };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']) delete env[key];
  const child = Bun.spawn([process.execPath, new URL('./index.ts', import.meta.url).pathname, recipePath, '--headless'],
    { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
  const socketPath = join(dir, 'ipc.sock');
  const until = async (check: () => boolean) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(r => setTimeout(r, 10));
    if (!check()) throw new Error(`Missing expected headless fixture evidence in ${dir}`); };
  let socket: Socket | null = null;
  try {
    await until(() => existsSync(socketPath));
    socket = connect(socketPath);
    const events: Array<Record<string, any>> = []; let buffer = '';
    socket.on('data', bytes => { buffer += bytes.toString(); let i; while ((i = buffer.indexOf('\n')) !== -1) {
      events.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); } });
    await new Promise<void>((yes, no) => { socket!.once('connect', yes); socket!.once('error', no); });
    socket.write(`${JSON.stringify({ type: 'subscribe', events: ['native-cli:*', 'puppet:tool-call', 'inference:*'] })}\n`);
    socket.write(`${JSON.stringify({ type: 'text', content: 'Original input' })}\n`);
    await until(() => events.some(e => e.type === 'native-cli:started'));
    const ack = events.find(e => e.type === 'native-cli:input')!;
    const started = events.find(e => e.type === 'native-cli:started')!;
    expect(ack.messageId).toBe(started.messageId); expect(ack.messageSha256).toBe(started.messageSha256);
    expect(events.indexOf(ack)).toBeLessThan(events.indexOf(started));
    expect(events.some(e => e.type.startsWith('inference:'))).toBe(false);
    socket.destroy(); socket = null;
    const evidence = join(dir, started.evidencePath);
    await until(() => readFileSync(evidence, 'utf8').includes('native-cli:terminal'));
    const rows = readFileSync(evidence, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const terminal = rows.find(r => r.event?.type === 'native-cli:terminal').event;
    expect(terminal.outcome).toBe('cancelled'); expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true);
    expect(() => process.kill(started.pid, 0)).toThrow();
    socket = connect(socketPath);
    await new Promise<void>((yes, no) => { socket!.once('connect', yes); socket!.once('error', no); });
    socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    expect(await child.exited).toBe(0);
    expect(existsSync(socketPath)).toBe(false); expect(existsSync(join(dir, 'headless.pid'))).toBe(false);
    expect(readdirSync(dir).filter(f => f.startsWith('native-cli.') && f.endsWith('.jsonl'))).toHaveLength(1);
  } finally {
    socket?.destroy();
    if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
  }
});


test('native transcript effort refuses foreign, grouped, duplicate, missing and conflicting observations', () => {
  const message = { id: 'msg', role: 'assistant', model: 'claude-fixture', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Full final' }] };
  const row = { type: 'assistant', uuid: 'frame', sessionId: 'session', isSidechain: false, message, effort: 'medium' };
  const frames = [{ uuid: 'frame', messageId: 'msg', model: 'claude-fixture', content: message.content }];
  const bytes = (entries: unknown[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  expect(nativeClaudeEffort(bytes([row]), 'session', frames, 'Full final')).toBe('medium');
  expect(() => nativeClaudeEffort(bytes([{ ...row, sessionId: 'foreign' }]), 'session', frames, 'Full final')).toThrow('match');
  expect(() => nativeClaudeEffort(bytes([{ ...row, effort: undefined }]), 'session', frames, 'Full final')).toThrow();
  expect(() => nativeClaudeEffort(bytes([row, row]), 'session', frames, 'Full final')).toThrow('duplicate');
  expect(() => nativeClaudeEffort(bytes([{ ...row, message: { ...message, content: [...message.content, { type: 'thinking', thinking: 'internal' }] } }]), 'session', frames, 'Full final')).toThrow('match');
  const second = { ...row, uuid: 'second', effort: 'high' };
  expect(() => nativeClaudeEffort(bytes([row, second]), 'session', [...frames, { ...frames[0], uuid: 'second' }], 'Full final')).toThrow('conflict');
});
for (const mode of ['missing-effort', 'effort-drift', 'missing-final-stop', 'contradictory-final-stop', 'contradictory-final-content']) {
  test(`native Claude refuses ${mode} after owned exit and retains exact native history bytes`, async () => {
    const result = await runFixture(mode, 'claude'); const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe('failed'); expect(terminal.nativeStatus).toBe('success');
    expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true); expect(terminal.finalText).toBe(null);
    expect(terminal.nativeEffort).toBe(mode === 'effort-drift' ? 'high' : null);
    expect(result.raw).toContain('native-session');
  });
}

for (const mode of ['binary-drift', 'active-mcp', 'connected-apps']) {
  test(`native qualified binding refuses ${mode} before provider turn`, async () => {
    const result = await runFixture(mode);
    expect(result.calls).toBe(0);
    const terminal = result.events.at(-1)!;
    expect(terminal.type).toBe('native-cli:terminal');
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe('failed'); expect(terminal.finalText).toBe(null);
    expect(result.events.some(e => e.type === 'native-cli:failure' && e.reason.includes(mode === 'binary-drift' ? 'hash drift' : 'not disabled'))).toBe(true);
  });
}
test('native Claude retains owned compact boundary and completes with genuine native effort', async () => {
  const result = await runFixture('compact', 'claude');
  const terminal = result.events.at(-1)!;
  expect(terminal.type).toBe('native-cli:terminal');
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('completed'); expect(terminal.nativeEffort).toBe('medium');
  expect(result.raw).toContain('compact_boundary');
});


test('native Host configuration denies tools outside the recipe allowlist without stored calls', async () => {
  const dir = realpathSync(mkdtempSync(join(realpathSync(process.env.CONNECTOME_TEST_EVIDENCE_DIR ?? tmpdir()), 'native-tool-permissions-')));
  const raw = { name: 'native', agent: { execution: 'native-cli', provider: 'openai-codex',
    model: 'gpt-fixture', systemPrompt: 'Bound system', responses: { reasoningEffort: 'medium' },
    allowedTools: ['permissions--allowed'] } };
  expect(unknownRecipeKeys(raw)).toEqual([]);
  const recipe = validateRecipe(raw);
  const calls: string[] = [];
  const module: Module = { name: 'permissions', async start() {}, async stop() {},
    getTools: () => ['allowed', 'denied'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    async handleToolCall(call) { calls.push(call.name); return { success: true, data: 'Permitted result' }; },
    async onProcess() { return {}; } };
  const framework = await AgentFramework.create({ storePath: join(dir, 'store'),
    membrane: new Membrane(new PassiveNativeCLIAdapter()),
    agents: [buildFrameworkAgentConfig(recipe, 'bound', 'gpt-fixture', new PassthroughStrategy())],
    modules: [module], inferencePolicy: { shouldInfer: () => false }, maintenanceIntervalMs: 0 });
  framework.start();
  try {
    const agent = framework.getAgent('bound')!;
    expect(framework.getAllTools().map(t => t.name).sort()).toEqual(['agent_settings', 'permissions--allowed', 'permissions--denied']);
    expect(agent.canUseTool('agent_settings')).toBe(false);
    expect(framework.getAllTools().filter(t => agent.canUseTool(t.name)).map(t => t.name)).toEqual(['permissions--allowed']);
    const before = agent.getContextManager().getAllMessages().length;
    await expect(framework.puppetToolCall('bound', 'permissions--denied', {})).rejects.toThrow('not on');
    expect(calls).toEqual([]);
    expect(agent.getContextManager().getAllMessages()).toHaveLength(before);
    const permitted = await framework.puppetToolCall('bound', 'permissions--allowed', {});
    expect(permitted.result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(agent.getContextManager().getAllMessages().some(m => m.content.some(b => b.type === 'tool_use' && b.id === permitted.toolUseId))).toBe(true);
  } finally { await framework.stop(); }
});


test('native clean exit with a late foreign final never stores successful assistant text', async () => {
  const result = await runFixture('late-foreign-final');
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.exitCode).toBe(0);
  expect(terminal.reaped).toBe(true);
  expect(terminal.pidAbsent).toBe(true);
  expect(terminal.outcome).toBe('failed');
  expect(terminal.finalText).toBeNull();
  expect(result.raw).toContain('late-answer');
  expect(result.messages.some(message => message.content.some(block => block.type === 'text' && block.text === 'The genuine fixture final.'))).toBe(false);
});


test('native Claude accepts the documented subscription OAuth environment and firstParty status', async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-subscription-oauth';
    const result = await runFixture('oauth-token', 'claude');
    const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe('completed'); expect(terminal.finalText).toBe('The genuine fixture final.');
    expect(result.calls).toBe(1); expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true);
    const rows = result.raw.trim().split('\n').map(line => JSON.parse(line));
    expect(rows.find(row => row.direction === 'auth-mode')).toEqual({ ts: expect.any(Number), direction: 'auth-mode', loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });
    expect(rows.find(row => row.direction === 'qualification-binding').report.loginMode).toBe('oauth_token');
    expect(result.invocations).toEqual(['version', 'auth', 'main']);
    expect(rows.some(row => JSON.stringify(row).includes('fixture-subscription-oauth'))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

test('native Codex keeps its ChatGPT route when Claude subscription OAuth is present', async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fixture-subscription-oauth';
    const result = await runFixture('success');
    const terminal = result.events.at(-1)!;
    if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
    expect(terminal.outcome).toBe('completed'); expect(result.calls).toBe(1);
    expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

for (const mode of ['oauth-other-provider', 'oauth-logged-out', 'claudeai-other-provider', 'oauth-api-key', 'oauth-mode-drift', 'claudeai-mode-drift']) test(`native Claude refuses ${mode} before main dispatch and native tools`, async () => {
  const result = await runFixture(mode, 'claude');
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('failed'); expect(terminal.finalText).toBe(null);
  expect(result.calls).toBe(0); expect(terminal.pid).toBeNull();
  expect(result.events.some(event => event.type === 'native-cli:started')).toBe(false);
  expect(result.events.some(event => event.type === 'native-cli:failure' && event.reason.includes('subscription login'))).toBe(true);
  expect(result.invocations).toEqual(['version', 'auth']);
});


test('native Claude accepts firstParty OAuth status supplied by its existing CLI wrapper', async () => {
  const result = await runFixture('oauth-token', 'claude');
  const terminal = result.events.at(-1)!;
  if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
  expect(terminal.outcome).toBe('completed'); expect(result.calls).toBe(1);
  expect(terminal.finalText).toBe('The genuine fixture final.');
  expect(terminal.reaped).toBe(true); expect(terminal.pidAbsent).toBe(true);
});

for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
  test(`native Claude preserves refusal of alternate route ${key}`, async () => {
    const previous = process.env[key];
    try {
      process.env[key] = 'fixture-alternate-route';
      const result = await runFixture('oauth-token', 'claude');
      const terminal = result.events.at(-1)!;
      if (terminal.type !== 'native-cli:terminal') throw new Error('Missing terminal');
      expect(terminal.outcome).toBe('failed'); expect(terminal.pid).toBeNull(); expect(result.calls).toBe(0);
      expect(result.events.some(event => event.type === 'native-cli:started')).toBe(false);
      expect(result.events.some(event => event.type === 'native-cli:failure' && event.reason.includes(key))).toBe(true);
      expect(result.raw).not.toContain('fixture-alternate-route');
      expect(result.invocations).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  });
}
