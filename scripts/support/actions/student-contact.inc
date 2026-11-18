await go('/staff/students/'+demo.students[2].id);
await scene(0,async()=>{
  await page.getByLabel('Full name',{exact:true}).scrollIntoViewIfNeeded();
});
await scene(1,async()=>{
  await page.getByLabel('Email',{exact:true}).fill('demo.contact@example.test');
  await page.getByLabel('Reason for change',{exact:true}).fill('Demo: student confirmed the updated contact address.');
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await saved();
});
