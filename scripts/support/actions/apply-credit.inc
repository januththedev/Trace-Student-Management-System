await go('/staff/enrolments/'+demo.creditEnrolment);
await scene(0,async()=>{await page.getByRole('region',{name:'Enrolment balances',exact:true}).waitFor();});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Apply credit',exact:true}).click();
  const d=page.getByRole('dialog');
  await d.getByLabel('Amount (LKR)',{exact:true}).fill('100');
  await d.getByLabel('Reason',{exact:true}).fill('Demo: apply existing enrolment credit to the selected instalment.');
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().endsWith('/credit')&&r.request().method()==='POST');
  await page.getByRole('dialog').getByRole('button',{name:'Apply credit',exact:true}).click();
  if((await r).status()!==200)throw Error('Credit allocation failed');
  await page.getByRole('heading',{name:'Allocation history',exact:true}).scrollIntoViewIfNeeded();
});
