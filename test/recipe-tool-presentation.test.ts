import {test,expect} from 'bun:test';
import {validateRecipe,unknownRecipeKeys} from '../src/recipe.js';
import {buildFrameworkAgentConfig} from '../src/framework-agent-config.js';
const config={path:'/tmp/presentation.json',cataloguePath:'board/tools.md'};
const board={mounts:[{name:'board',path:'/tmp/board',mode:'read-write',autoMaterialize:true}]};
const recipe=(tp:unknown=config,workspace:unknown=board)=>({name:'test',agent:{systemPrompt:'.',toolPresentation:tp},modules:{workspace}});
// Each refusal is matched by its own words, so a TypeError from code past a missing guard can't stand in for it.
const SHAPE=/agent\.toolPresentation requires absolute path and mount-prefixed cataloguePath/;
const MOUNT=/toolPresentation cataloguePath requires an existing workspace mount/;
const DEFAULTS=/toolPresentation defaults require unique component sources and absolute paths/;
test('presentation config is validated and forwarded unchanged',()=>{
 const parsed=validateRecipe(recipe());
 expect(buildFrameworkAgentConfig(parsed,'ada','test',undefined).toolPresentation).toEqual(config);
});
test('presentation is a known agent key, so a recipe with it warns of no ignored key',()=>{
 expect(unknownRecipeKeys(recipe())).toEqual([]);
});
test('the catalogue may sit in a mount the workspace makes itself',()=>{
 expect(()=>validateRecipe(recipe({...config,cataloguePath:'products/tools.md'},true))).not.toThrow();
 expect(()=>validateRecipe(recipe({...config,cataloguePath:'_config/tools.md'},{...board,configMount:true}))).not.toThrow();
});
test('reject invalid paths, unknown fields and missing catalogue mount',()=>{
 const cases:[unknown,RegExp][]=[
  [null,SHAPE],[{...config,path:'relative.json'},SHAPE],[{...config,extra:true},SHAPE],
  [{...config,cataloguePath:'tools.md'},SHAPE],[{...config,cataloguePath:'board/'},SHAPE],
  [{...config,cataloguePath:'board//tools.md'},SHAPE],[{...config,cataloguePath:'board/./tools.md'},SHAPE],
  [{...config,cataloguePath:'board/../tools.md'},SHAPE],[{...config,cataloguePath:'missing/tools.md'},MOUNT],
 ];
 for(const [tp,words] of cases) expect(()=>validateRecipe(recipe(tp))).toThrow(words);
 expect(()=>validateRecipe(recipe(config,false))).toThrow(MOUNT);
});
test('component defaults validate source bindings and forward profiles',()=>{
 const defaults=[{source:'MCPL server: discord',path:'/tmp/discord.json'}];
 const parsed=validateRecipe(recipe({...config,defaults}));
 expect(buildFrameworkAgentConfig(parsed,'ada','test',undefined).toolPresentation?.defaults).toEqual(defaults);
 for(const bad of [null,[{source:'x',path:'relative'}],[...defaults,...defaults],[{source:'x',path:'/tmp/x',visible:false}],[{source:'   ',path:'/tmp/x'}],[{path:'/tmp/x'}]])
  expect(()=>validateRecipe(recipe({...config,defaults:bad}))).toThrow(DEFAULTS);
});
