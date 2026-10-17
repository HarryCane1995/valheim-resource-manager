// Read-only real snapshot QA; only browser display preferences change.
async page=>{
 await page.setViewportSize({width:1440,height:1050});
 await page.goto('http://127.0.0.1:37841/');
 await page.getByTestId('quick-filter-all').click();
 await page.getByTestId('cluster-filter').selectOption('all');
 await page.getByRole('textbox',{name:'Поиск ресурсов'}).fill('');
 await page.getByTestId('mode-normal').click();
 if(await page.getByRole('button',{name:'Режим второго монитора'}).getAttribute('aria-pressed')==='true')await page.getByRole('button',{name:'Режим второго монитора'}).click();
 await page.getByRole('button',{name:'Вид кластерами'}).click();
 await page.getByRole('button',{name:'Свернуть всё',exact:true}).click();
 await page.screenshot({path:'output/PASS3-NORMAL.png',fullPage:false});
 await page.getByTestId('mode-compact').click();
 await page.getByLabel('Группировка').selectOption('clusters');
 await page.getByRole('button',{name:'Свернуть всё',exact:true}).click();
 const metal=page.locator('tr[data-testid="compact-cluster-group"][data-cluster-id="metallurgy"]');
 await metal.getByRole('button').click();
 const rows=page.locator('tbody[data-cluster-id="metallurgy"] tr[data-testid="compact-category-group"] button');
 for(let i=0;i<await rows.count();i++)if(await rows.nth(i).getAttribute('aria-expanded')==='false')await rows.nth(i).click();
 if(await page.getByRole('button',{name:'Режим второго монитора'}).getAttribute('aria-pressed')!=='true')await page.getByRole('button',{name:'Режим второго монитора'}).click();
 await page.setViewportSize({width:1200,height:1050});
 await page.getByTestId('compact-scroll').evaluate(el=>{el.scrollTop=0;});
 const iron=page.locator('[data-testid="compact-resource-row"][data-prefab="Iron"]');
 await iron.waitFor({state:'visible'});
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-testid="compact-resource-row"] img')].filter(el=>el.getBoundingClientRect().top<innerHeight).every(el=>el.complete&&el.naturalWidth>0));
 const state=await page.evaluate(async()=>await(await fetch('/api/state')).json());
 const sum=state.clusterStats.reduce((sum,c)=>sum+c.totalItems,0);
 if(sum!==state.stats.totalItems||state.registry.inventoryUnknownItems!==0)throw Error('Native snapshot conservation/identity regression');
 await page.screenshot({path:'output/PASS3-COMPACT.png',fullPage:false});
 await iron.click();
 await page.getByTestId('drawer-container-list').waitFor({state:'visible'});
 await page.screenshot({path:'output/PASS3-CONTAINERS.png',fullPage:false});
 await page.getByRole('button',{name:'Закрыть карточку'}).click();
 return {result:'PASS',types:state.resources.length,quantity:sum,containers:state.containers.length,icons:state.resources.filter(r=>r.iconUrl).length,metallurgy:state.clusterStats.find(c=>c.clusterId==='metallurgy')};
}
