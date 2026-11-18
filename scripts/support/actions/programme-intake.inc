const code='TRAIN'+Date.now().toString().slice(-6);
await scene(0,async()=>{
  await page.getByRole('button',{name:'New programme',exact:true}).click();
  await page.getByLabel('Programme code',{exact:true}).fill(code);
  await page.getByLabel('Programme name',{exact:true}).fill('Training course (Demo)');
  await page.getByLabel('Description',{exact:true}).fill('Synthetic course for demonstrating setup.');
  await page.getByRole('button',{name:'Create programme',exact:true}).click();
  await saved();
});
await scene(1,async()=>{
  await page.getByRole('link').filter({has:page.getByRole('heading',{name:'Training course (Demo)',exact:true})}).first().click();
  await page.getByRole('button',{name:'New intake',exact:true}).click();
  await page.getByLabel('Intake code',{exact:true}).fill(code+'A');
  await page.getByLabel('Batch label',{exact:true}).fill('November training batch');
  await date('Start date',17);
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Create intake',exact:true}).click();
  await saved();
  await page.getByRole('heading',{name:'November training batch',exact:true}).waitFor();
});
