// Disposable DEMO server for browser writes. Never opens data/live.sqlite.
import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/main.mjs';
import {prefabHash} from '../server/registry.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=resolve(root,'output/pass3-browser',randomUUID());
const local=resolve(fixture,'localdata');
mkdirSync(resolve(local,'registry'),{recursive:true});
const installed=resolve(root,'localdata/registry/items.json');
if(existsSync(installed)){
  // Registry and PNGs are private local inputs, never test fixtures in Git.
  writeFileSync(resolve(local,'registry/items.json'),readFileSync(installed));
  if(existsSync(resolve(root,'localdata/icons')))cpSync(resolve(root,'localdata/icons'),resolve(local,'icons'),{recursive:true});
}else{
  const definitions=[['Wood','Древесина','Material'],['Stone','Камень','Material'],['Iron','Железо','Material'],['Copper','Медь','Material'],['Coal','Уголь','Material'],['Resin','Смола','Material'],['FineWood','Качественная древесина','Material'],['Honey','Мёд','Consumable'],['Carrot','Морковь','Consumable'],['Raspberry','Малина','Consumable'],['CarrotSeeds','Семена моркови','Material'],['TrophyDeer','Трофей: олень','Trophy'],['Coins','Монеты','Material']];
  writeFileSync(resolve(local,'registry/items.json'),JSON.stringify({schemaVersion:1,gameVersion:'DEMO',generatedAt:new Date().toISOString(),source:{kind:'installed-assets'},items:definitions.map(([prefab,nameRu,itemTypeName])=>({id:'prefab:'+prefab,prefab,prefabHash:prefabHash(prefab),nameRu,nameEn:prefab,maxStack:50,iconKey:null,metadata:{itemTypeName}})),coverage:{definitionsFound:definitions.length,runtimeVerified:false}}));
}
const app=createApp({dataDir:resolve(fixture,'data'),localDataDir:local,port:37842,token:'browser-fixture-no-game-authority',intervals:true});
const original=app.demo.startDemo.bind(app.demo);
app.demo.startDemo=()=>{
 original();
 app.demo.ingest({worldId:'demo-midgard',worldName:'Мидгард · ДЕМО',sourceId:'qa-unknown',sessionId:'qa-session',sequence:0,mode:'client',coverage:'partial',gameVersion:'DEMO',containers:[{id:'demo:unknown-chest',name:'Синтетический сундук',type:'piece_chest',x:125,y:12,z:-50,observedAt:Date.now(),items:[{prefab:'Mod_QA_Unidentified',name:'Неопознанный DEMO-предмет',quantity:7,quality:2,variant:1}]}],destroyedIds:[]});
 return app.demo.state({worldId:'demo-midgard'});
};
await app.listen();
console.log('Disposable browser DEMO: http://127.0.0.1:37842 (all writes under output/pass3-browser)');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
