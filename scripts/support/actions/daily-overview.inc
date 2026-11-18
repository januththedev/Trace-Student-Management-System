await scene(0,async()=>{
  await page.getByRole('heading',{level:1}).waitFor();
  await page.getByText('Pending receipts',{exact:false}).first().scrollIntoViewIfNeeded();
});
await scene(1,async()=>{
  await page.getByRole('link',{name:'Receipt review',exact:true}).click();
  await page.getByRole('main').waitFor();
});
await scene(2,async()=>{
  await page.getByRole('link',{name:'Students',exact:true}).click();
  await page.getByLabel('Search students',{exact:true}).waitFor();
  await page.getByRole('link',{name:'Help & support',exact:true}).hover();
});
