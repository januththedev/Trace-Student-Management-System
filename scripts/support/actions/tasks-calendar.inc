await page.getByRole('region',{name:'Selected enrolment',exact:true}).waitFor();
await scene(0,async()=>{await page.getByRole('heading',{name:'Open tasks',exact:true}).scrollIntoViewIfNeeded();});
await scene(1,async()=>{
  const close=page.getByRole('button',{name:'Close task',exact:true}).first();
  if(await close.count()){
    await close.click();
    await page.getByLabel('Closure reason',{exact:true}).fill('Demo: the assigned follow-up has been completed.');
    await page.getByRole('button',{name:'Confirm close',exact:true}).click();
  } else {await page.getByRole('heading',{name:'Contact history',exact:true}).scrollIntoViewIfNeeded();}
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Business holidays',exact:true}).click();
  await page.getByRole('button',{name:'Refresh holidays',exact:true}).click();
  await page.getByLabel('Holiday name',{exact:true}).scrollIntoViewIfNeeded();
});
