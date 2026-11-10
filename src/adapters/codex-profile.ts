/** Preserve model routing without importing personal tools, memories or instructions. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { digest } from '../shared/json.js';
import { privateDirectory, privateText, writePrivate } from '../connector/files.js';

export async function readCodexRouting(binary: string, profile?: string): Promise<Record<string, unknown>> {
  if(profile)throw new Error('Named Codex profile inspection is unavailable in this version. Use the existing default model configuration or configure a dedicated service installation.');
  return new Promise((resolve,reject)=>{
    const child = spawn(binary,['app-server'],{stdio:['pipe','pipe','ignore']});
    let buffer='',bytes=0,done=false;
    const finish=(error?:Error,value?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value!);};
    const timer=setTimeout(()=>finish(new Error('Cannot inspect the existing Codex model configuration.')),20000);
    child.once('error',()=>finish(new Error('Cannot start the installed Codex configuration service.')));
    child.once('exit',()=>{if(!done)finish(new Error('Codex configuration inspection ended before returning its routing.'));});
    child.stdin.on('error',()=>{});
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    send({id:1,method:'initialize',params:{clientInfo:{name:'envar-connect',version:'1.0'}}});
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>2*1024*1024){finish(new Error('Codex configuration exceeds the supported bound.'));return;}
      buffer+=chunk.toString('utf8');let at;
      while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at);buffer=buffer.slice(at+1);let event:any;try{event=JSON.parse(line);}catch{continue;}
        if(event.id===1){if(event.error){finish(new Error('Codex initialization was rejected.'));return;}send({id:2,method:'config/read',params:{includeLayers:false}});}
        if(event.id===2){
          const c=event.result?.config;
          if(!c||typeof c.model_provider!=='string'){finish(new Error('Cannot identify the selected Codex provider.'));return;}
          const keep:Record<string,unknown>={};
          for(const k of ['model','model_provider','model_reasoning_effort','service_tier','openai_base_url','forced_chatgpt_workspace_id','forced_login_method'])if(c[k]!=null)keep[k]=c[k];
          const provider=c.model_providers?.[c.model_provider];if(provider)keep.model_providers={[c.model_provider]:provider};
          finish(undefined,keep);
        }
      }
    });
  });
}
function toml(value:unknown):string {
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'||typeof value==='boolean')return String(value);
  if(Array.isArray(value))return '['+value.filter(x=>x!=null).map(toml).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!=null).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}';
  throw new Error('Unsupported Codex routing configuration value.');
}
export async function createCodexServiceProfile(binary:string, stateRoot:string, originalProfile?:string):Promise<{home:string; digest:string; environmentKeys:string[]}> {
  const routing=await readCodexRouting(binary,originalProfile);
  const provider=(routing.model_providers as Record<string,any>|undefined)?.[String(routing.model_provider)];
  const environmentKeys=[provider?.env_key,...Object.values(provider?.env_http_headers??{})]
    .filter((key):key is string=>typeof key==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(key));
  const settings={...routing,project_doc_max_bytes:0,instructions:'Complete the requested text task.',
    developer_instructions:'This is an isolated Envar text-service session. No tools or personal context are available.',
    approval_policy:'never',default_permissions:'envar_text',web_search:'disabled',skills:{include_instructions:false},
    features:Object.fromEntries(['apps','plugins','hooks','plugin_hooks','memories','multi_agent','browser_use','computer_use','image_generation','shell_tool'].map(k=>[k,false])),
    permissions:{envar_text:{filesystem:{':minimal':'read',':workspace_roots':{'.':'read'}},network:{enabled:false}}},
  };
  const text=Object.entries(settings).map(([k,v])=>k+'='+toml(v)).join('\n')+'\n',hash=digest(settings);
  const home=join(stateRoot,'runtimes','codex-'+hash.slice(0,16)),file=join(home,'config.toml');
  privateDirectory(home);
  if(existsSync(file)&&privateText(file)!==text)throw new Error('The isolated service configuration was changed. Review it before continuing.');
  if(!existsSync(file))writePrivate(file,text);
  // Model-provider auth commands/environment references remain local. ChatGPT
  // login credentials are never copied; a missing login is reported explicitly.
  return {home,digest:digest(text),environmentKeys};
}
