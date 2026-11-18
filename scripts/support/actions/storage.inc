await scene(0,async()=>{await page.getByRole('region',{name:'Storage capacity',exact:true}).scrollIntoViewIfNeeded();});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Refresh storage usage',exact:true}).click();
  await page.getByRole('progressbar',{name:'App storage budget used',exact:true}).waitFor();
});
await scene(2,async()=>{await page.getByText('Space saved by archival',{exact:true}).scrollIntoViewIfNeeded();});
