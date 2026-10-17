// Run only against tests/start-host-bed-qa.mjs. Every coordinate/payload is synthetic.
async page=>{
 const checks=[],errors=[];const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
 page.on('pageerror',error=>errors.push(String(error)));
 const base='http://127.0.0.1:37843';let sequence=0;
 const report=async(hostBed,initial=false)=>{
  const now=new Date().toISOString();
  const chest=(id,x,z,quantity)=>({id,type:'piece_chest',name:'Синтетический сундук',x,y:7,z,observedAt:now,items:[{prefab:'Wood',name:'Древесина',quantity}]});
  const payload={worldId:'host-bed-qa',worldName:'Синтетический мир 500 м',sourceId:'qa-host',sessionId:'qa-session',sequence:++sequence,mode:'host',coverage:'partial',gameVersion:'SYNTHETIC',containers:initial?[chest('inside',110,-200,10),chest('boundary',400,200,20),chest('outside',1000,-200,99)]:[],destroyedIds:[],...(hostBed?{hostBed}:{})};
  const response=await page.request.post(base+'/api/ingest',{headers:{'X-VRM-Token':'host-bed-browser-fixture-no-game-authority'},data:payload});
  check('synthetic ingest '+sequence,response.ok());
  if(page.url().startsWith(base))await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 };
 const api=async()=>await(await page.request.get(base+'/api/state')).json();
 await report(null,true);await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
 const banner=page.getByTestId('host-bed-area');
 await banner.waitFor();check('pending visibly preserves legacy scope',(await banner.getAttribute('data-status'))==='pending'&&(await banner.innerText()).includes('прежний охват')&&(await api()).stats.totalItems===129);
 await report({status:'set',x:100,y:7,z:-200});
 await page.waitForFunction(()=>document.querySelector('[data-testid="host-bed-area"]')?.getAttribute('data-status')==='active');
 check('active centre and radius visible',(await banner.innerText()).includes('500 м')&&(await page.getByTestId('host-bed-area-center').innerText()).includes('X 100 · Z -200'));
 const active=await api();check('HTTP excludes outside and includes 500m boundary',active.stats.totalItems===30&&active.containers.length===2&&active.containers.some(c=>c.id==='boundary')&&!active.containers.some(c=>c.id==='outside'));
 await page.getByTestId('mode-compact').click();await page.getByRole('textbox',{name:'Поиск ресурсов'}).fill('Wood');
 const row=page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"]');await row.waitFor();check('COMPACT shows scoped quantity',(await row.locator('.cell-quantity').innerText()).trim()==='30');
 await row.click();await page.getByTestId('resource-drawer').waitFor();check('drawer scoped total and locations',(await page.getByTestId('drawer-resource-total').innerText()).replace(/\D/g,'')==='30'&&await page.locator('.drawer-container').count()===2);await page.getByRole('button',{name:'Закрыть карточку'}).click();
 await page.getByRole('button',{name:'Режим второго монитора'}).click();check('area remains visible in focus',await banner.isVisible());
 await page.getByRole('button',{name:'Режим второго монитора'}).click();
 await report({status:'set',x:1000,y:7,z:-200});await page.waitForFunction(()=>document.querySelector('[data-testid="host-bed-area-center"]')?.textContent.includes('X 1000'));
 check('moving bed reveals retained outside record',(await api()).stats.totalItems===99);
 await report({status:'unset'});await page.getByTestId('host-bed-area-empty').waitFor();
 check('unset visibly pauses instead of inventing origin',(await banner.getAttribute('data-status'))==='unset'&&(await page.getByTestId('host-bed-area-empty').innerText()).includes('приостановлен')&&(await api()).resources.length===0);
 await page.getByRole('button',{name:/^Склады(?: |$)/}).click();check('storage explains paused accounting',await page.getByTestId('host-bed-area-empty').isVisible());
 await page.getByRole('button',{name:'Складские зоны',exact:true}).click();check('zones retain accounting indicator',await banner.isVisible());
 await report({status:'set',x:9000,y:7,z:9000});await page.getByRole('button',{name:'Обзор ресурсов',exact:true}).click();
 await page.getByTestId('host-bed-area-empty').waitFor();check('active empty area has no false connection prompt',!(await page.getByTestId('host-bed-area-empty').innerText()).includes('Подключите')&&(await api()).stats.totalItems===0);
 await report({status:'set',x:100,y:7,z:-200});await page.getByRole('button',{name:'Обзор ресурсов',exact:true}).click();
 await page.reload();await page.waitForFunction(()=>document.querySelector('[data-testid="host-bed-area"]')?.getAttribute('data-status')==='active');
 check('reload retains server anchor and totals',(await api()).stats.totalItems===30);
 for(const width of [800,1200]){await page.setViewportSize({width,height:1000});check('area banner fits width '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 check('no page JS errors',errors.length===0);
 return {result:'PASS',synthetic:true,checks};
}
