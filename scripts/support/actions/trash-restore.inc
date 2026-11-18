const item=page.getByRole('article').filter({has:page.getByRole('heading',{name:'Restorable training course (Demo)',exact:true})});
await scene(0,async()=>{await item.scrollIntoViewIfNeeded();});
await scene(1,async()=>{
  await item.getByRole('button',{name:'Restore',exact:true}).click();
  await page.getByLabel('Reason',{exact:true}).fill('Demo: restore the retained training programme.');
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().endsWith('/api/staff/trash')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Confirm',exact:true}).click();
  if((await r).status()!==200)throw Error('Restore failed');
  await page.getByText('The change has been recorded.',{exact:true}).waitFor();
});
