// Run with playwright-cli run-code --filename tests/browser-pass2.cjs
// Screenshots contain local user data. output/ is ignored; never publish it.
async page => {
  page.setDefaultTimeout(10000);
  const results=[];
  const check=(name,pass,detail='')=>{results.push({name,pass,detail});if(!pass)throw Error(name+': '+detail);};
  const errors=[];page.on('pageerror',error=>errors.push(String(error)));
  await page.setViewportSize({width:1440,height:960});
  await page.goto('http://127.0.0.1:37841/');
  await page.waitForFunction(()=>document.querySelectorAll('[data-testid="compact-resource-row"]').length>0);
  await page.getByTestId('mode-normal').click();
  if(await page.getByRole('button',{name:'Режим второго монитора'}).getAttribute('aria-pressed')==='true')await page.getByRole('button',{name:'Режим второго монитора'}).click();
  check('NORMAL switch',await page.getByTestId('app-shell').getAttribute('data-display-mode')==='normal');
  await page.screenshot({path:'output/PASS2-NORMAL.png',fullPage:false});
  await page.getByTestId('mode-compact').click();
  await page.getByLabel('Высота строки').selectOption('32');
  check('COMPACT switch',await page.getByTestId('app-shell').getAttribute('data-display-mode')==='compact');
  const row=page.getByTestId('compact-resource-row').first();
  check('8 table columns',await row.locator('td').count()===8);
  const height=await row.evaluate(el=>el.getBoundingClientRect().height);
  check('32px actual row height',height>=30&&height<=34,String(height));
  check('sticky header',await page.locator('.compact-table thead').evaluate(el=>getComputedStyle(el).position)==='sticky');
  const icons=page.getByTestId('compact-catalog').locator('img');
  await icons.first().waitFor();
  await page.waitForFunction(()=>{const el=document.querySelector('[data-testid="compact-catalog"] img');return el?.complete&&el.naturalWidth>0;});
  check('authentic PNG load',await icons.count()>0,String(await icons.count()));
  const search=page.getByRole('textbox',{name:'Поиск ресурсов'});
  for(const term of ['Древесина','Wood','prefab:Wood','-151837501']){
    await search.fill(term);
    await page.waitForTimeout(100);
    check('search '+term,await page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"]').count()===1);
  }
  await page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"]').click();
  check('right container drawer',await page.getByTestId('resource-drawer').isVisible());
  check('drawer quantity',Number((await page.getByTestId('drawer-resource-total').innerText()).replace(/\D/g,''))>0);
  await page.getByRole('button',{name:'Закрыть карточку'}).click();
  await search.fill('');
  await page.getByRole('button',{name:'Сортировать: Предмет',exact:true}).click();
  await page.getByTestId('compact-scroll').evaluate(el=>{el.scrollTop=360;el.dispatchEvent(new Event('scroll',{bubbles:true}));});
  const before=await page.getByTestId('compact-scroll').evaluate(el=>el.scrollTop);
  await page.waitForTimeout(6500);
  check('live refresh keeps scroll',await page.getByTestId('compact-scroll').evaluate(el=>el.scrollTop)===before);
  await page.getByTestId('mode-normal').click();await page.getByTestId('mode-compact').click();
  check('mode switch keeps scroll',await page.getByTestId('compact-scroll').evaluate(el=>el.scrollTop)===before);
  await page.reload();await page.getByTestId('compact-catalog').waitFor({state:'visible'});
  check('mode persists after reload',await page.getByTestId('app-shell').getAttribute('data-display-mode')==='compact');
  await page.getByRole('button',{name:'Режим второго монитора'}).click();
  for(const width of [800,1000,1200]){
    await page.setViewportSize({width,height:900});
    check('viewport '+width,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.setViewportSize({width:1200,height:960});
  await page.getByTestId('compact-scroll').evaluate(el=>{el.scrollTop=0;});
  await page.screenshot({path:'output/PASS2-COMPACT.png',fullPage:false});
  await page.getByLabel('Высота строки').selectOption('30');
  check('density control',Math.round(await row.evaluate(el=>el.getBoundingClientRect().height))===30);
  await page.getByLabel('Высота строки').selectOption('32');
  await page.getByLabel('Группировка').selectOption('categories');
  check('category grouping',await page.locator('.compact-category-row').count()>0);
  await page.getByRole('button',{name:'Свернуть всё',exact:true}).click();
  check('collapse categories',await page.getByTestId('compact-resource-row').count()===0);
  await page.getByRole('button',{name:'Развернуть всё',exact:true}).click();
  await page.getByLabel('Группировка').selectOption('none');
  const realBefore=await page.evaluate(async()=>{const state=await(await fetch('/api/state')).json();return state.resources.reduce((sum,r)=>sum+r.quantity,0);});
  await page.getByRole('button',{name:'Демо-режим',exact:true}).click();
  await page.locator('.demo-banner').waitFor({state:'visible'});
  check('explicit DEMO status',(await page.locator('.demo-banner').innerText()).includes('Синтетические'));
  await search.fill('Wood');
  await page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"]').click();
  const readQuantity=async()=>Number((await page.getByTestId('drawer-resource-total').innerText()).replace(/\D/g,''));
  const demoBefore=await readQuantity();
  await page.getByRole('button',{name:'Закрыть карточку'}).click();
  await page.getByTestId('resource-drawer').waitFor({state:'hidden',timeout:10000});
  await page.getByRole('button',{name:'40 дерева',exact:true}).click({timeout:10000});
  await page.locator('[data-testid="compact-resource-row"][data-prefab="Wood"]').click();
  check('DEMO live +40 updates drawer',await readQuantity()===demoBefore+40);
  check('live update preserves search',await search.inputValue()==='Wood');
  await page.getByRole('button',{name:'Закрыть карточку'}).click();
  await page.getByRole('button',{name:'Выйти из демо',exact:true}).click();
  const realAfter=await page.evaluate(async()=>{const state=await(await fetch('/api/state')).json();return state.resources.reduce((sum,r)=>sum+r.quantity,0);});
  check('DEMO isolated from real inventory',realAfter===realBefore);
  await search.fill('');
  check('no browser exceptions',errors.length===0,errors.join(';'));
  return {results,passed:results.filter(r=>r.pass).length,total:results.length};
}
