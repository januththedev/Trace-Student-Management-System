await go('/staff/enrolments/'+demo.students[5].enrolment_id);
await scene(0,async()=>{
  await page.getByRole('link',{name:'Manage awards',exact:true}).click();
  await page.getByRole('heading',{name:'New award',exact:true}).waitFor();
});
await scene(1,async()=>{
  await select('Award type','DISCOUNT');
  await page.getByLabel('Value (LKR or percentage)',{exact:true}).fill('100');
  await page.getByLabel('Award reason',{exact:true}).fill('Demo: approved course discount for the selected instalments.');
  await page.getByRole('button',{name:'Confirm change',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Award impact',exact:true}).scrollIntoViewIfNeeded();
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Confirm change',exact:true}).click();
  await saved();
  await page.getByRole('link',{name:'Financial history',exact:true}).click();
  await page.getByRole('region',{name:'Enrolment balances',exact:true}).waitFor();
});
