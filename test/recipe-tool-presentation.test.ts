import {test,expect} from 'bun:test';
import {validateRecipe,unknownRecipeKeys} from '../src/recipe.js';
import {buildFrameworkAgentConfig} from '../src/framework-agent-config.js';
const config={path:'/tmp/presentation.json',cataloguePath:'board/tools.md'};
const board={mounts:[{name:'board',path:'/tmp/board',mode:'read-write',autoMaterialize:true}]};
const recipe=(tp:unknown=config,workspace:unknown=board)=>({name:'test',agent:{systemPrompt:'.',toolPresentation:tp},modules:{workspace}});
const OBJECT=/^Recipe agent\.toolPresentation must be an object \{ path, cataloguePath, defaults\? \}, got null/;
const ABSOLUTE=/^Recipe agent\.toolPresentation\.path must be an absolute path, got "relative\.json"\.$/;
const UNKNOWN=/^Recipe agent\.toolPresentation has unknown key "extra"/;
const CATALOGUE=/^Recipe agent\.toolPresentation\.cataloguePath must be a path in a workspace mount, such as "mount\/catalogue\.json", with no "\." or "\.\." part, got "/;
const MOUNT=/Recipe agent\.toolPresentation\.cataloguePath requires an existing workspace mount\./;
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
  [null,OBJECT],[{...config,path:'relative.json'},ABSOLUTE],[{...config,extra:true},UNKNOWN],
  [{...config,cataloguePath:'tools.md'},CATALOGUE],[{...config,cataloguePath:'board/'},CATALOGUE],
  [{...config,cataloguePath:'board//tools.md'},CATALOGUE],[{...config,cataloguePath:'board/./tools.md'},CATALOGUE],
  [{...config,cataloguePath:'board/../tools.md'},CATALOGUE],[{...config,cataloguePath:'missing/tools.md'},MOUNT],
 ];
 for(const [tp,words] of cases) expect(()=>validateRecipe(recipe(tp))).toThrow(words);
 expect(()=>validateRecipe(recipe(config,false))).toThrow(MOUNT);
});
test('component defaults validate source bindings and forward profiles',()=>{
 const defaults=[{source:'MCPL server: discord',path:'/tmp/discord.json'}];
 const parsed=validateRecipe(recipe({...config,defaults}));
 expect(buildFrameworkAgentConfig(parsed,'ada','test',undefined).toolPresentation?.defaults).toEqual(defaults);
 const refused:[unknown,RegExp][]=[
  [null,/^Recipe agent\.toolPresentation\.defaults must be a list of \{ source, path \} objects, got null/],
  [[{source:'x',path:'relative'}],/^Recipe agent\.toolPresentation\.defaults\[0\]\.path must be an absolute path, got "relative"\.$/],
  [[...defaults,...defaults],/^Recipe agent\.toolPresentation\.defaults require unique component sources\.$/],
  [[{source:'x',path:'/tmp/x',visible:false}],/^Recipe agent\.toolPresentation\.defaults\[0\] has unknown key "visible"/],
  [[{source:'   ',path:'/tmp/x'}],/^Recipe agent\.toolPresentation\.defaults\[0\]\.source must be a non-empty string, got "   "\.$/],
  [[{path:'/tmp/x'}],/^Recipe agent\.toolPresentation\.defaults\[0\]\.source must be a non-empty string, got nothing\.$/],
 ];
 for(const [bad,words] of refused) expect(()=>validateRecipe(recipe({...config,defaults:bad}))).toThrow(words);
});
