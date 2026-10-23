import {test,expect} from 'bun:test';
import {buildDebugContext} from '../src/web/panel-data.js';

// A stand-in framework whose presentation lookup checks it is asked, as itself, about the request its preview made.
const fake=(presentation:unknown,injections:boolean)=>{
 const request={messages:[],tools:[]};
 const framework={
  getAgent:()=>({name:'resident'}),
  previewActivation:async(_agent:string,opts:any)=>{expect(opts.injections).toBe(injections);return request;},
  getRequestToolPresentation(this:any,received:object){expect(this).toBe(framework);expect(received).toBe(request);return presentation;},
 };
 return {framework,request};
};
test('an agent without a presentation previews with toolPresentation null',async()=>{
 const {framework,request}=fake(null,false);
 const result=await buildDebugContext({framework} as any,'resident',{});
 expect(result.request).toBe(request);
 expect(result.toolPresentation).toBeNull();
 expect(result.transparent).toBe(true);
});
for(const injections of [false,true])
test(`the ${injections?'injections':'transparent'} preview carries the presentation captured with its own request`,async()=>{
 const presentation={revision:'frozen',advertised:[]};
 const {framework}=fake(presentation,injections);
 const result=await buildDebugContext({framework} as any,'resident',injections?{injections:true}:{});
 expect(result.toolPresentation).toBe(presentation);
 expect(result.transparent).toBe(!injections);
});
