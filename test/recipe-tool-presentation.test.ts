import {test,expect} from 'bun:test';
import {validateRecipe} from '../src/recipe.js';
import {buildFrameworkAgentConfig} from '../src/framework-agent-config.js';
const config={path:'/tmp/presentation.json',cataloguePath:'board/tools.md'};
const recipe=(tp:unknown=config,workspace:unknown={mounts:[{name:'board',path:'/tmp/board',mode:'read-write',autoMaterialize:true}]})=>({name:'test',agent:{systemPrompt:'.',toolPresentation:tp},modules:{workspace}});
test('presentation config is validated and forwarded unchanged',()=>{
 const parsed=validateRecipe(recipe());
 expect(buildFrameworkAgentConfig(parsed,'ada','test',undefined).toolPresentation).toEqual(config);
});
test('reject invalid paths, unknown fields and missing catalogue mount',()=>{
 for(const tp of [{...config,path:'relative.json'},{...config,cataloguePath:'board/../tools.md'},{...config,cataloguePath:'missing/tools.md'},{...config,extra:true},null])
  expect(()=>validateRecipe(recipe(tp))).toThrow();
 expect(()=>validateRecipe(recipe(config,false))).toThrow();
});
test('component defaults validate source bindings and forward profiles',()=>{
 const defaults=[{source:'MCPL server: discord',path:'/tmp/discord.json'}];
 const parsed=validateRecipe(recipe({...config,defaults}));
 expect(buildFrameworkAgentConfig(parsed,'ada','test',undefined).toolPresentation?.defaults).toEqual(defaults);
 for(const bad of [null,[{source:'x',path:'relative'}],[...defaults,...defaults],[{source:'x',path:'/tmp/x',visible:false}]])
  expect(()=>validateRecipe(recipe({...config,defaults:bad}))).toThrow();
});
