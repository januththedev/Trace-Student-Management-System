await scene(0,async()=>{
  await page.getByRole('button',{name:'Send feedback',exact:true}).click();
  await select('Which area?','Receipts');
});
await scene(1,async()=>{
  const d=page.getByRole('dialog');
  await d.getByLabel('Short title',{exact:true}).fill('Keep review notes beside the evidence');
  await d.getByLabel('Tell us more',{exact:true}).fill('While checking a receipt I need to see the evidence and decision notes together. Please keep both visible so the review is easier to complete. This is a demonstration suggestion.');
});
await scene(2,async()=>{
  const response=page.waitForResponse(r=>r.url().endsWith('/api/staff/support/feedback')&&r.request().method()==='POST');
  await page.getByRole('dialog').getByRole('button',{name:'Send feedback',exact:true}).click();
  if((await response).status()!==201)throw Error('Feedback not saved');
  await page.getByRole('heading',{name:'Your feedback',exact:true}).waitFor();
  await page.getByRole('heading',{name:'Keep review notes beside the evidence',exact:true}).first().waitFor();
});
