await scene(0,async()=>{
  await page.getByLabel('Search students',{exact:true}).fill(demo.students[0].ref);
  await page.getByRole('button',{name:'Find students',exact:true}).click();
  await page.getByRole('link',{name:demo.students[0].name,exact:true}).waitFor();
});
await scene(1,async()=>{
  await page.getByRole('link',{name:demo.students[0].name,exact:true}).click();
  await page.getByRole('link',{name:'View financial history',exact:true}).first().click();
  await page.getByRole('region',{name:'Enrolment balances',exact:true}).waitFor();
});
await scene(2,async()=>{
  await page.getByRole('region',{name:'Enrolment balances',exact:true}).scrollIntoViewIfNeeded();
});
