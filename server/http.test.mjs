import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { request as httpRequest } from 'node:http';
import { createApp } from './main.mjs';

async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'vrm-http-'));const token='a'.repeat(64);const app=createApp({dataDir:dir,port:0,token,intervals:false});const port=await app.listen();const base=`http://127.0.0.1:${port}`;
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const request=(path,method='GET',value,headers={})=>fetch(base+path,{method,headers:{...(value!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(value!==undefined?{body:JSON.stringify(value)}:{})});
  return {app,base,port,token,request};
}
test('HTTP real database starts empty; explicit demo cannot contaminate it',async t=> {
  const {request}=await fixture(t);let response=await request('/api/state');assert.equal(response.status,200);assert.equal((await response.json()).world,null);response=await request('/api/demo/start','POST',{});assert.equal(response.status,200);assert.equal((await response.json()).demo,true);assert.equal((await(await request('/api/state')).json()).containers.length,0);assert.ok((await(await request('/api/state?demo=1')).json()).containers.length>0);
});
test('security: token, foreign Origin, DNS-rebinding Host, content type, JSON and body limit',async t=> {
  const {request,base}=await fixture(t);
  assert.equal((await request('/api/ingest','POST',{})).status,401);
  assert.equal((await request('/api/demo/start','POST',{}, {Origin:'https://attacker.example'})).status,403);
  const rebound=await new Promise((resolve,reject)=>{const req=httpRequest(base+'/api/state',{headers:{Host:'attacker.example:37841'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(rebound,403);
  assert.equal((await fetch(base+'/api/demo/start',{method:'POST',headers:{'Content-Type':'text/plain'},body:'{}'})).status,415);
  assert.equal((await fetch(base+'/api/demo/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/demo/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({oversize:'x'.repeat(3*1024*1024)})})).status,413);
});
test('authenticated ingest, API labels/minimums/zones and encoded stable IDs',async t=> {
  const {request,token}=await fixture(t);const payload={sourceId:'s',worldId:'w',worldName:'Мир',mode:'host',coverage:'partial',sessionId:'a',sequence:1,gameVersion:'1.0.20',containers:[{id:'1:9',identityKey:'pos-v1:123:00000000:00000000:00000000',type:'chest',name:'Сундук',x:0,y:0,z:0,items:[{prefab:'Wood',name:'Дерево',quantity:40}],observedAt:Date.now()}],destroyedIds:[]};
  assert.equal((await request('/api/ingest','POST',payload,{'X-VRM-Token':token})).status,200);
  assert.equal((await request('/api/ingest','POST',payload,{'X-VRM-Token':token})).status,200);
  assert.equal((await request('/api/ingest','POST',{...payload,worldName:'Changed'}, {'X-VRM-Token':token})).status,409);
  const state=await(await request('/api/state')).json();const id=state.containers[0].id;
  const label=await request(`/api/containers/${encodeURIComponent(id)}/label`,'POST',{worldId:'w',label:'Кузница'});assert.equal(label.status,200);assert.equal((await label.json()).containers[0].label,'Кузница');
  const minimum=await request('/api/minimums','PUT',{worldId:'w',prefab:'Wood',minimum:100});assert.equal((await minimum.json()).stats.shortages,1);
  const zone=await request('/api/zones','POST',{worldId:'w',name:'Пристань',x:0,z:0,radius:50,enabled:true});assert.equal((await zone.json()).zones.length,2);
});
test('WebSocket notifies state changes without broadcasting inventory or secret',async t=> {
  const {request,port,token}=await fixture(t);const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{origin:`http://127.0.0.1:${port}`});t.after(()=>ws.terminate());
  const events=[];ws.on('message',raw=>events.push(JSON.parse(raw.toString())));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const changed=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('No ws update')),3000);ws.on('message',raw=>{const value=JSON.parse(raw.toString());if(value.demo && value.revision>0){clearTimeout(timeout);resolve(value);}});});await request('/api/demo/start','POST',{});const event=await changed;assert.equal(event.type,'state-changed');assert.deepEqual(Object.keys(event).sort(),['demo','revision','type']);assert.ok(!JSON.stringify(events).includes(token));
});
