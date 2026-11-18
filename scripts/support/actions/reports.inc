await scene(0,async()=>{
  await page.getByRole('button',{name:'Apply dates',exact:true}).click();
  await page.getByRole('combobox',{name:'Export report',exact:true}).waitFor();
});
await scene(1,async()=>{
  await page.getByRole('checkbox',{name:'Full NIC (audited)',exact:true}).uncheck();
  await page.getByRole('combobox',{name:'Export report',exact:true}).click();
  await page.getByRole('option').first().click();
});
await scene(2,async()=>{
  const pdf=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download PDF',exact:true}).click();
  if(!(await pdf).suggestedFilename().endsWith('.pdf'))throw Error('PDF missing');
  const csv=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download CSV',exact:true}).click();
  if(!(await csv).suggestedFilename().endsWith('.csv'))throw Error('CSV missing');
});
