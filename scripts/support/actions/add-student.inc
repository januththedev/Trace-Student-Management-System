const name='Training Student '+Date.now().toString().slice(-6)+' (Demo)';
await scene(0,async()=>{
  await page.getByRole('button',{name:'New application',exact:true}).click();
  await page.getByLabel('Applicant name',{exact:true}).fill(name);
  await page.getByLabel('NIC',{exact:true}).fill('2001'+Date.now().toString().slice(-8));
  await page.getByLabel('Phone',{exact:true}).fill('0700000001');
  await page.getByRole('button',{name:'Create application',exact:true}).click();
  await saved();
});
await scene(1,async()=>{
  const card=page.getByRole('heading',{name,exact:true}).locator('..').locator('..');
  await card.getByRole('button',{name:'Decide application',exact:true}).click();
  await select('Decision','ACCEPTED');
  await page.getByLabel('Decision reason',{exact:true}).fill('Demo: intake and fee plan reviewed; application accepted.');
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Confirm decision',exact:true}).click();
  const card=page.getByRole('heading',{name,exact:true}).locator('..').locator('..');
  await card.getByRole('link',{name:'View enrolment',exact:true}).click();
  await page.getByRole('region',{name:'Enrolment balances',exact:true}).waitFor();
});
