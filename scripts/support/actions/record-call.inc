await page.getByRole('region',{name:'Selected enrolment',exact:true}).waitFor();
await scene(0,async()=>{await page.getByRole('region',{name:'Selected enrolment',exact:true}).scrollIntoViewIfNeeded();});
await scene(1,async()=>{await page.getByRole('button',{name:'No answer',exact:true}).click();});
await scene(2,async()=>{
  await page.getByRole('form',{name:'No answer outcome',exact:true}).getByLabel('Notes',{exact:true}).fill('Demo: no answer; follow the business-day retry policy.');
  await page.getByRole('button',{name:'Save outcome',exact:true}).click();
  await page.getByText('Outcome saved.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Done and refresh',exact:true}).click();
});
