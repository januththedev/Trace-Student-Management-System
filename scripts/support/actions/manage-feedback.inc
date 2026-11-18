await scene(0,async()=>{
  await page.getByRole('tab',{name:'Feedback inbox',exact:true}).click();
  await page.getByRole('heading',{name:'Easier payment review notes',exact:true}).click();
});
await scene(1,async()=>{
  await select('Status','In review');
  await page.getByRole('textbox',{name:'Response (optional)',exact:true}).fill('Thanks for the clear steps. We are reviewing a layout that keeps decision notes beside the evidence. We will update this request after testing it with the team.');
});
await scene(2,async()=>{
  const response=page.waitForResponse(r=>r.url().includes('/api/staff/support/feedback/')&&r.request().method()==='PATCH');
  await page.getByRole('button',{name:'Save response',exact:true}).click();
  if((await response).status()!==200)throw Error('Reply not saved');
  await page.getByText('Thanks for the clear steps.',{exact:false}).waitFor();
});
