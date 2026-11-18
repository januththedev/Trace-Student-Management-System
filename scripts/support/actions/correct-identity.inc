await go('/staff/students/'+demo.students[10].id);
await scene(0,async()=>{await page.getByLabel('Correct NIC',{exact:true}).scrollIntoViewIfNeeded();});
await scene(1,async()=>{
  await page.getByLabel('Correct NIC',{exact:true}).fill('2004'+Date.now().toString().slice(-8));
  await page.getByLabel('Reason for change',{exact:true}).fill('Demo: verified identifier correction against the original registration.');
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await saved();
  await page.getByRole('heading',{level:1}).scrollIntoViewIfNeeded();
});
