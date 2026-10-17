// Fresh tests/start-host-bed-qa.mjs server required. All writes are synthetic.
async page=>{
 const base='http://127.0.0.1:37843',checks=[],errors=[];
 const check=(name,ok)=>{if(!ok)throw Error(name);checks.push(name);};
 page.on('pageerror',error=>errors.push(String(error)));
 let sequence=0;
 const ingest=async(items)=>{
  const response=await page.request.post(base+'/api/ingest',{headers:{'X-VRM-Token':'host-bed-browser-fixture-no-game-authority'},data:{worldId:'stock-qa',worldName:'Синтетическая проверка запасов',sourceId:'stock-test',sessionId:'stock-test',sequence:++sequence,mode:'host',coverage:'partial',gameVersion:'SYNTHETIC',hostBed:{status:'set',x:0,y:7,z:0},containers:[{id:'stock-chest',type:'piece_chest',name:'Тестовый сундук',x:0,y:7,z:0,observedAt:new Date().toISOString(),items:items.map(([prefab,quantity])=>({prefab,name:prefab,quantity}))}],destroyedIds:[]}});
  check('synthetic ingest '+sequence,response.ok());
 };
 await ingest([['Wood',150],['Stone',220],['Iron',400],['Copper',50]]);
 const set=await page.request.put(base+'/api/minimums/default',{data:{worldId:'stock-qa',minimum:200,resetOverrides:true}});
 check('default 200 applied',set.ok());
 await page.goto(base);await page.evaluate(()=>localStorage.clear());await page.reload();
 await page.getByTestId('stock-legend').filter({hasText:'200'}).waitFor();check('legend explains default and three levels',(await page.getByTestId('stock-legend').innerText()).includes('200'));
 await page.getByRole('button',{name:'Развернуть всё',exact:true}).click();
 const levels={Wood:'deficit',Stone:'near',Iron:'surplus'};
 for(const [prefab,level] of Object.entries(levels))check('NORMAL cluster '+level,await page.locator(`[data-testid="normal-cluster-item"][data-prefab="${prefab}"] [data-testid="stock-gauge"]`).getAttribute('data-stock-level')===level);
 await page.getByRole('button',{name:'Вид карточками',exact:true}).click();
 for(const [prefab,level] of Object.entries(levels))check('cards '+level,await page.locator(`[data-testid="resource-card"][data-prefab="${prefab}"] [data-testid="stock-gauge"]`).getAttribute('data-stock-level')===level);
 const red=page.locator('[data-testid="resource-card"][data-prefab="Wood"] [data-testid="stock-gauge"]');
 check('red meter exposes missing quantity',(await red.getAttribute('aria-valuetext')).includes('не хватает 50'));
 await page.getByRole('button',{name:'Вид таблицей',exact:true}).click();
 check('normal table has stock gauge',await page.locator('[data-testid="normal-resource-row"][data-prefab="Stone"] [data-stock-level="near"]').count()===1);
 await page.locator('[data-testid="normal-resource-row"][data-prefab="Wood"]').click();await page.getByTestId('resource-drawer').waitFor();
 check('drawer inherits common minimum',await page.getByRole('spinbutton',{name:'Минимальный запас',exact:true}).inputValue()==='200'&&await page.getByTestId('resource-drawer').locator('[data-stock-level="deficit"]').count()===1);
 await page.getByRole('button',{name:'Закрыть карточку'}).click();
 await page.getByTestId('mode-compact').click();await page.getByLabel('Группировка').selectOption('none');await page.getByLabel('Количество колонок',{exact:true}).selectOption('2');
 for(const [prefab,level] of Object.entries(levels)){
  const row=page.locator(`[data-testid="compact-resource-row"][data-prefab="${prefab}"]`);
  check('COMPACT '+level,await row.locator('[data-testid="stock-gauge"]').getAttribute('data-stock-level')===level);
 }
 check('two panes preserve unique resources',await page.getByTestId('compact-pane').count()===2&&await page.getByTestId('compact-resource-row').count()===4);
 check('deficit badge is red',await page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"] .compact-shortage').evaluate(el=>getComputedStyle(el).color)==='rgb(242, 138, 130)');
 for(const height of [30,32]){await page.getByLabel('Высота строки').selectOption(String(height));const measured=await page.getByTestId('compact-resource-row').first().evaluate(el=>el.getBoundingClientRect().height);check('gauge fits '+height+'px row',Math.abs(measured-height)<1);}
 await ingest([['Wood',150],['Stone',220],['Iron',400]]);await page.getByRole('button',{name:'Обновить данные',exact:true}).click();
 const empty=page.locator('[data-testid="compact-resource-row"][data-prefab="Copper"]');await empty.waitFor();
 check('depleted resource remains red at zero',await empty.locator('[data-stock-level="deficit"]').count()===1&&(await empty.locator('.cell-quantity').innerText()).trim()==='0');
 await page.reload();await empty.waitFor();check('common threshold and zero survive reload',await empty.locator('[data-testid="stock-gauge"]').getAttribute('aria-valuetext').then(text=>text.includes('минимум: 200')));
 await page.getByTestId('quick-filter-shortage').click();check('shortage filter only shows deficits',await page.getByTestId('compact-resource-row').count()===2);
 await page.getByTestId('quick-filter-all').click();
 for(const width of [800,1200]){await page.setViewportSize({width,height:1000});check('no page overflow '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 check('no browser JS errors',errors.length===0);
 return {result:'PASS',synthetic:true,checks};
}
