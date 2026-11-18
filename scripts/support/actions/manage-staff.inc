await scene(0,async()=>{
  await page.getByRole('button',{name:'Invite team member',exact:true}).click();
  await page.getByLabel('Full name',{exact:true}).fill('Training Administrator');
  await page.getByLabel('Email address',{exact:true}).fill('training.admin@example.test');
});
await scene(1,async()=>{
  await page.addStyleTag({content:'input[readonly]{visibility:hidden!important}'});
  await select('Role','Admin');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button',{name:'Create invitation',exact:true}).click();
  await page.getByText('Invitation created.',{exact:false}).waitFor();
});
await scene(2,async()=>{
  // Invitation URLs are private. Never expose a token in a published training clip.
  await page.getByRole('button',{name:/Edit permissions for/}).first().click();
  await page.getByLabel('Reason for change',{exact:true}).fill('Demo: reviewing the existing access assignment.');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
});
