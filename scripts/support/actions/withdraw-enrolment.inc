await go('/staff/enrolments/'+demo.students[12].enrolment_id);
await scene(0,async()=>{
  await page.getByRole('region',{name:'Enrolment balances',exact:true}).waitFor();
});
await scene(1,async()=>{
  await page.getByRole('link',{name:'Withdraw enrolment',exact:true}).click();
  await page.getByLabel('Withdrawal reason',{exact:true}).fill('Demo: student requested withdrawal from this course.');
  await page.getByRole('button',{name:'Confirm change',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Withdrawal impact',exact:true}).scrollIntoViewIfNeeded();
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Confirm change',exact:true}).click();
  await saved();
});
