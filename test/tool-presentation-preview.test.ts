import {test,expect} from 'bun:test';
import {buildDebugContext} from '../src/web/panel-data.js';

test('debug preview works on a published framework without presentation API',async()=>{
 const request={messages:[],tools:[]};
 const framework={getAgent:()=>({name:'resident'}),previewActivation:async()=>request};
 const result=await buildDebugContext({framework} as any,'resident',{});
 expect(result.request).toBe(request);
 expect(result.toolPresentation).toBeNull();
 expect(result.transparent).toBe(true);
});
test('debug preview retrieves metadata from the exact compiled request with framework binding',async()=>{
 const request={messages:[],tools:[]};
 const presentation={revision:'frozen',advertised:[]};
 const framework={
  getAgent:()=>({name:'resident'}),
  previewActivation:async(_agent:string,opts:any)=>{expect(opts.injections).toBe(true);return request;},
  getRequestToolPresentation(this:any,received:object){expect(this).toBe(framework);expect(received).toBe(request);return presentation;},
 };
 const result=await buildDebugContext({framework} as any,'resident',{injections:true});
 expect(result.toolPresentation).toBe(presentation);
 expect(result.transparent).toBe(false);
});
