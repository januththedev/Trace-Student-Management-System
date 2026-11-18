const decision=page.getByRole('button',{name:'Decide application',exact:true}).first();
await scene(0,async()=>{await decision.scrollIntoViewIfNeeded();});
await scene(1,async()=>{
  await decision.click();
  await select('Decision','UNDER REVIEW');
  await page.getByLabel('Decision reason',{exact:true}).fill('Demo: waiting for the remaining application documents.');
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().includes('/api/staff/admissions/')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Confirm decision',exact:true}).click();
  if((await r).status()!==200)throw Error('Admission decision failed');
  await page.getByText('Decision saved.',{exact:true}).waitFor();
});
