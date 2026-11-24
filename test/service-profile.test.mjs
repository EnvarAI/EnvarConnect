import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectServiceProfile,verifyServiceProfile,materializeServiceProfile,CLAUDE_SERVICE_PLUGIN} from '../dist/adapters/service-profile.js';
import {CliRuntimeAdapter,cliCommand} from '../dist/adapters/cli-runtime.js';
import {runtimeReport} from '../dist/connector/runtime-report.js';
function profile(t,runtime='codex'){
 const root=mkdtempSync(join(tmpdir(),'envar-profile-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,runtime==='codex'?'config.toml':'settings.json'),runtime==='codex'?'model="owner-model"\n':'{}',{mode:0o600});
 mkdirSync(join(root,'skills','calculate'),{recursive:true});writeFileSync(join(root,'skills','calculate','SKILL.md'),'---\nname: calculate\ndescription: arithmetic\n---\nUse the selected calculator.\n');
 mkdirSync(join(root,'tools'));writeFileSync(join(root,'tools','calculator.mjs'),'console.log(42)');
 return root;
}
test('approved skills and tool files are bound and copied into the native workspace',t=>{
 for(const runtime of ['codex','claude-code']){
  const root=profile(t,runtime),selected=inspectServiceProfile(runtime,root),workspace=join(root,'job');mkdirSync(workspace);
  assert.equal(selected.skillCount,1);materializeServiceProfile(runtime,selected,workspace);
  assert.match(readFileSync(join(workspace,runtime==='codex'?'.agents':'.claude','skills','calculate','SKILL.md'),'utf8'),/calculator/);
  if(runtime==='claude-code'){
   const plugin=join(workspace,'.claude');
   assert.deepEqual(readdirSync(plugin).sort(),['.claude-plugin','skills']);
   assert.equal(JSON.parse(readFileSync(join(plugin,'.claude-plugin','plugin.json'),'utf8')).name,CLAUDE_SERVICE_PLUGIN);
  }
  assert.equal(readFileSync(join(workspace,'tools','calculator.mjs'),'utf8'),'console.log(42)');
  writeFileSync(join(root,'auth.json'),'rotating native login remains local');
  assert.equal(verifyServiceProfile(runtime,selected).digest,selected.digest);
  writeFileSync(join(root,'tools','calculator.mjs'),'console.log(43)');
  assert.throws(()=>verifyServiceProfile(runtime,selected),/changed/);
 }
});
test('profile paths cannot escape through a skill symlink',t=>{
 const root=profile(t);symlinkSync('/etc/passwd',join(root,'skills','outside'));
 assert.throws(()=>inspectServiceProfile('codex',root),/symbolic links/);
});
test('Codex first-run system skill installation does not invalidate seller configuration',t=>{
 const root=profile(t),selected=inspectServiceProfile('codex',root);
 mkdirSync(join(root,'skills','.system','native-skill'),{recursive:true});
 writeFileSync(join(root,'skills','.system','native-skill','SKILL.md'),'Native runtime asset');
 assert.equal(verifyServiceProfile('codex',selected).digest,selected.digest);
 assert.equal(inspectServiceProfile('codex',root).skillCount,1);
 const workspace=join(root,'job');mkdirSync(workspace);
 materializeServiceProfile('codex',selected,workspace);
 assert.throws(()=>readFileSync(join(workspace,'.agents','skills','.system','native-skill','SKILL.md')),/ENOENT/);
});
test('Claude profiles use explicit native settings and MCP without bypass flags',t=>{
 const root=profile(t,'claude-code');writeFileSync(join(root,'mcp.json'),'{}');
 const config={serviceProfile:inspectServiceProfile('claude-code',root)};
 const args=cliCommand('claude-code',config,join(root,'job'));
 assert.equal(args[args.indexOf('--settings')+1],join(config.serviceProfile.root,'settings.json'));
 assert.equal(args[args.indexOf('--mcp-config')+1],join(config.serviceProfile.root,'mcp.json'));
 assert.equal(args[args.indexOf('--setting-sources')+1],'');
 assert.equal(args[args.indexOf('--plugin-dir')+1],join(root,'job','.claude'));
 assert.ok(!args.includes('--disable-slash-commands'));assert.ok(!args.some(x=>x.startsWith('--dangerously-')));
});
test('Claude refuses a preexisting project configuration beside selected skills',t=>{
 const root=profile(t,'claude-code'),selected=inspectServiceProfile('claude-code',root),workspace=join(root,'job');
 mkdirSync(join(workspace,'.claude'),{recursive:true});
 writeFileSync(join(workspace,'.claude','settings.json'),JSON.stringify({hooks:{}}));
 assert.throws(()=>materializeServiceProfile('claude-code',selected,workspace),/already contains configuration/);
 assert.deepEqual(readdirSync(join(workspace,'.claude')),['settings.json']);
});
test('a Claude profile without selected skills does not load a plugin',t=>{
 const root=profile(t,'claude-code');rmSync(join(root,'skills'),{recursive:true});
 const selected=inspectServiceProfile('claude-code',root),workspace=join(root,'job');mkdirSync(workspace);
 materializeServiceProfile('claude-code',selected,workspace);
 assert.equal(selected.skillCount,0);assert.equal(existsSync(join(workspace,'.claude')),false);
 assert.ok(!cliCommand('claude-code',{serviceProfile:selected},workspace).includes('--plugin-dir'));
});
test('only a bounded profile fingerprint enters platform diagnostics',t=>{
 const root=profile(t),p=inspectServiceProfile('codex',root);
 const report=runtimeReport({adapter:'codex',runtimeVersion:'0.145.0',capabilities:{recover:true,input:false,cancel:false},executionProfile:{mode:'service-profile',digest:p.digest,skillCount:p.skillCount}});
 assert.equal(report.execution_profile.skill_count,1);assert.ok(!JSON.stringify(report).includes(root));
});
test('changing profiles does not replace a completed original CLI result',t=>{
 const root=profile(t),workspace=join(root,'jobs');mkdirSync(workspace);
 const first=new CliRuntimeAdapter(root,'codex',{binary:'/bin/false',workspace,configurationApproved:true,timeoutSeconds:20});
 const id='11111111-1111-4111-8111-111111111111',dir=join(root,'executions',id);mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(join(dir,'result.json'),JSON.stringify({version:1,key:id,adapter:'codex',binding:first.binding,state:'completed',text:'original result'}),{mode:0o600});
 const next=new CliRuntimeAdapter(root,'codex',{binary:'/bin/false',workspace,configurationApproved:true,timeoutSeconds:20,serviceProfile:inspectServiceProfile('codex',root)});
 return next.observe({adapter:'codex',version:1,value:{execution_key:id,binding:first.binding}}).then(value=>assert.equal(value.text,'original result'));
});
