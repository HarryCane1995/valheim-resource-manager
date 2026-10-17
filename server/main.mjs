import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { InventoryStore, ApiError } from './store.mjs';
import { ItemRegistry } from './registry.mjs';
import { object, string, number, worldBody, validateIngest, validateZone } from './validation.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MAX_BODY=3*1024*1024;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2','.webp':'image/webp'};

export function createApp({dataDir=resolve(ROOT,'data'),localDataDir=dataDir===resolve(ROOT,'data')?resolve(ROOT,'localdata'):resolve(dataDir,'localdata'),distDir=resolve(ROOT,'dist'),port=37841,now=()=>Date.now(),token:providedToken,intervals=true}={}) {
  mkdirSync(dataDir,{recursive:true});
  const tokenPath=resolve(dataDir,'ingest-token.txt');
  let token=providedToken;
  if(!token) {
    if(existsSync(tokenPath)) token=readFileSync(tokenPath,'utf8').trim();
    if(!token || !/^[a-f0-9]{64}$/.test(token)) { token=randomBytes(32).toString('hex');writeFileSync(tokenPath,token,{mode:0o600}); }
  }
  const registry=new ItemRegistry(localDataDir);
  const real=new InventoryStore(resolve(dataDir,'live.sqlite'),{now,registry});
  const demo=new InventoryStore(resolve(dataDir,'demo.sqlite'),{now,demo:true,registry});
  const clients=new Set();
  let activePort=port;
  const server=createServer(async(req,res)=> {
    setHeaders(res);
    try {
      secureRequest(req);
      const url=new URL(req.url,'http://127.0.0.1');
      const demoFlag=url.searchParams.get('demo');
      if(demoFlag!==null && !['0','1'].includes(demoFlag)) throw new ApiError(400,'demo: ожидается 0 или 1.');
      const store=demoFlag==='1'?demo:real;
      const selection={worldId:url.searchParams.get('worldId')||undefined,zoneId:url.searchParams.get('zoneId')||'all'};
      if(req.method==='GET' && url.pathname==='/api/health') return json(res,200,{ok:true,service:'VALHEIM RESOURCE MANAGER',version:'0.3.0',localOnly:true});
      if(req.method==='GET' && url.pathname==='/api/state') return json(res,200,store.state(selection));
      if(req.method==='GET' && url.pathname==='/api/registry') {registry.reload();return json(res,200,registry.state());}
      if(req.method==='POST' && url.pathname==='/api/registry') {authorizeSource(req);const summary=registry.publish(await body(req));notify(real);notify(demo);return json(res,200,{ok:true,summary});}
      if(req.method==='PUT' && url.pathname==='/api/registry/overrides') {const item=registry.override(await body(req));notify(real);notify(demo);return json(res,200,{ok:true,item,summary:registry.summary()});}
      if(req.method==='POST' && url.pathname==='/api/clusters') {const cluster=registry.createCluster(await body(req));notify(real);notify(demo);return json(res,201,{ok:true,cluster,clusters:registry.clusters});}
      const clusterMatch=/^\/api\/clusters\/([^/]+)$/.exec(url.pathname);
      if(req.method==='PUT' && clusterMatch) {const cluster=registry.renameCluster(decodeURIComponent(clusterMatch[1]),await body(req));notify(real);notify(demo);return json(res,200,{ok:true,cluster,clusters:registry.clusters});}
      const iconMatch=/^\/api\/icons\/([a-f0-9]{64})\.png$/.exec(url.pathname);
      if(iconMatch && req.method==='POST') {authorizeSource(req);if(!/^image\/png(?:\s*;|$)/i.test(req.headers['content-type'] || ''))throw new ApiError(415,'Требуется Content-Type: image/png.','CONTENT_TYPE');const icon=registry.publishIcon(iconMatch[1],await bytes(req,512*1024));return json(res,200,{ok:true,...icon});}
      if(iconMatch && ['GET','HEAD'].includes(req.method)) {const file=registry.iconFile(iconMatch[1]);if(!file)throw new ApiError(404,'Пиктограмма не найдена.','ICON_NOT_FOUND');const stat=statSync(file);res.statusCode=200;res.setHeader('Content-Type','image/png');res.setHeader('Content-Length',stat.size);res.setHeader('Cache-Control','private, max-age=31536000, immutable');if(req.method==='HEAD')res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);return;}
      if(req.method==='POST' && ['/api/ingest','/api/snapshot'].includes(url.pathname)) {
        authorizeSource(req);
        const payload=validateIngest(await body(req));
        if(url.pathname==='/api/snapshot' && payload.mode!=='snapshot') throw new ApiError(400,'Snapshot endpoint requires snapshot mode.');
        const revision=real.ingest(payload);notify(real);
        const reindexRequested=payload.containers.some(container=>container.items.some(item=>!registry.resolve(item.prefab)));
        return json(res,200,{ok:true,revision,receivedAt:new Date(now()).toISOString(),reindexRequested});
      }
      if(req.method==='POST' && url.pathname==='/api/demo/start') { await body(req);const state=demo.startDemo();notify(demo);return json(res,200,state); }
      if(req.method==='POST' && url.pathname==='/api/demo/step') {
        const value=object(await body(req));
        if(!['add40','move','disconnect','reconnect'].includes(value.action)) throw new ApiError(400,'Неизвестное действие демонстрации.');
        const state=demo.demoStep(value.action);notify(demo);return json(res,200,state);
      }
      const labelMatch=/^\/api\/containers\/([^/]+)\/label$/.exec(url.pathname);
      if(req.method==='POST' && labelMatch) {
        const value=await body(req);const worldId=worldBody(value);string(value.label,'label',120,{empty:true});
        const id=decodeURIComponent(labelMatch[1]);const state=store.label(worldId,id,value.label);notify(store);return json(res,200,state);
      }
      if(req.method==='PUT' && url.pathname==='/api/minimums') {
        const value=await body(req);const worldId=worldBody(value);string(value.prefab,'prefab',200);number(value.minimum,'minimum',{min:0,max:1_000_000_000,integer:true});
        const state=store.minimum(worldId,value.prefab,value.minimum);notify(store);return json(res,200,state);
      }
      const zoneMatch=/^\/api\/zones\/([^/]+)$/.exec(url.pathname);
      if((req.method==='POST' && url.pathname==='/api/zones') || (req.method==='PUT' && zoneMatch)) {
        const value=validateZone(await body(req));const id=zoneMatch?decodeURIComponent(zoneMatch[1]):undefined;
        const state=store.zone(value.worldId,value,id);notify(store);return json(res,200,state);
      }
      if(url.pathname.startsWith('/api/')) throw new ApiError(404,'API-метод не найден.','NOT_FOUND');
      if(req.method!=='GET' && req.method!=='HEAD') throw new ApiError(405,'Метод не поддерживается.','METHOD_NOT_ALLOWED');
      let pathname;
      try { pathname=decodeURIComponent(url.pathname); } catch { throw new ApiError(400,'Некорректный путь.'); }
      const candidate=resolve(distDir,'.'+pathname);
      if(candidate!==resolve(distDir) && !candidate.startsWith(resolve(distDir)+sep)) throw new ApiError(403,'Путь недоступен.','FORBIDDEN');
      let file=candidate;
      if(!existsSync(file) || !statSync(file).isFile()) {
        if(extname(pathname)) throw new ApiError(404,'Файл не найден.','NOT_FOUND');
        file=resolve(distDir,'index.html');
      }
      if(!existsSync(file)) throw new ApiError(503,'Панель ещё не собрана. Выполните npm run build.','BUILD_REQUIRED');
      const stat=statSync(file);res.statusCode=200;res.setHeader('Content-Type',mime[extname(file)]||'application/octet-stream');res.setHeader('Content-Length',stat.size);res.setHeader('Cache-Control',extname(file)==='.html'?'no-store':'public, max-age=3600');
      if(req.method==='HEAD') res.end();else createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    } catch(error) {
      if(!res.headersSent) json(res,error.status||500,{error:error.status?error.message:'Внутренняя ошибка сервера.',code:error.code||'INTERNAL_ERROR'});
      else res.destroy();
      if(!error.status) console.error(error);
    }
  });
  function authorizeSource(req) {const supplied=req.headers['x-vrm-token'];if(typeof supplied!=='string' || Buffer.byteLength(supplied)!==Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(supplied),Buffer.from(token)))throw new ApiError(401,'Неверный токен источника.','UNAUTHORIZED');}
  function secureRequest(req) {
    const host=req.headers.host;
    const allowedHosts=new Set([`127.0.0.1:${activePort}`,`localhost:${activePort}`]);
    if(!allowedHosts.has(host)) throw new ApiError(403,'Недопустимый адрес локального сервера.','HOST_REJECTED');
    const origin=req.headers.origin;
    if(origin && !new Set([`http://127.0.0.1:${activePort}`,`http://localhost:${activePort}`]).has(origin)) throw new ApiError(403,'Запрос с постороннего сайта отклонён.','ORIGIN_REJECTED');
  }
  const wss=new WebSocketServer({noServer:true,maxPayload:4096});
  server.on('upgrade',(req,socket,head)=> {
    try {
      secureRequest(req);
      if(new URL(req.url,'http://127.0.0.1').pathname!=='/ws') throw new ApiError(404,'Not found');
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    } catch { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');socket.destroy(); }
  });
  wss.on('connection',ws=> {clients.add(ws);ws.send(JSON.stringify({type:'state-changed',revision:real.revision,demo:false}));ws.send(JSON.stringify({type:'state-changed',revision:demo.revision,demo:true}));ws.on('close',()=>clients.delete(ws));ws.on('error',()=>clients.delete(ws));});
  function notify(store) { const message=JSON.stringify({type:'state-changed',revision:store.revision,demo:store.demo});for(const ws of clients) if(ws.readyState===WebSocket.OPEN) ws.send(message); }
  const timer=intervals?setInterval(()=> {registry.reload();demo.tickDemo();notify(real);notify(demo);},3000):null;
  timer?.unref();
  return {
    server,real,demo,registry,tokenPath,
    listen:()=>new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);activePort=server.address().port;resolveListen(activePort);});}),
    close:async()=> {if(timer)clearInterval(timer);for(const ws of clients)ws.terminate();wss.close();if(server.listening)await new Promise(done=>server.close(done));real.close();demo.close();}
  };
}
function setHeaders(res) {
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
}
function json(res,status,value) {res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));}
async function body(req) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw new ApiError(415,'Требуется Content-Type: application/json.','CONTENT_TYPE');
  const raw=await bytes(req,MAX_BODY);
  try{return JSON.parse(raw.toString('utf8'));}catch{throw new ApiError(400,'Некорректный JSON.','INVALID_JSON');}
}
async function bytes(req,max) {
  const length=Number(req.headers['content-length']);if(Number.isFinite(length) && length>max) throw new ApiError(413,'Пакет превышает разрешённый размер.','BODY_TOO_LARGE');
  let size=0;const chunks=[];
  for await (const chunk of req) {size+=chunk.length;if(size>max)throw new ApiError(413,'Пакет превышает разрешённый размер.','BODY_TOO_LARGE');chunks.push(chunk);}
  return Buffer.concat(chunks);
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp();
  app.listen().then(()=>console.log('VALHEIM RESOURCE MANAGER: http://127.0.0.1:37841')).catch(error=>{console.error(error.message);process.exitCode=1;app.close();});
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>app.close().then(()=>process.exit(0)));
}
