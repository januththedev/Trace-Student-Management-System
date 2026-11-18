await page.getByRole('region',{name:'Selected enrolment',exact:true}).waitFor();
await scene(0,async()=>{await page.getByRole('button',{name:'Promised to pay',exact:true}).click();});
await scene(1,async()=>{
  await page.getByLabel('Notes',{exact:true}).fill('Demo: student agreed to pay LKR 500 on 20 November.');
  await page.getByLabel('Promised amount (LKR)',{exact:true}).fill('500');
  await page.getByLabel('Manual contact override reason (only when needed)',{exact:true}).fill('Demo: student called the office to agree this payment date.');
  await date('Promised local date',20);
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Save outcome',exact:true}).click();
  await page.getByText('Outcome saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Done and refresh',exact:true}).click();
});
