const receipt=demo.submissions.find(s=>s.status==='APPROVED');
await go('/staff/enrolments/'+receipt.enrolment_id);
await scene(0,async()=>{
  await page.getByRole('heading',{name:'Receipt submissions',exact:true}).scrollIntoViewIfNeeded();
});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Correct approval (Super Admin)',exact:false}).first().click();
  await page.getByLabel('Correction reason (at least 5 characters)',{exact:true}).first().fill('Demo: incorrect approval needs to be reopened for review.');
  await page.getByRole('button',{name:'Preview impact',exact:true}).first().click();
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Confirm change',exact:true}).first().click();
  await saved();
  await page.getByRole('heading',{name:'Payment events and reversals',exact:true}).scrollIntoViewIfNeeded();
});
