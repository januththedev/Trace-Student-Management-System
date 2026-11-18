await go('/staff/review?submission='+demo.receipts.approve);
await scene(0,async()=>{await page.getByRole('button',{name:'Approve (A)',exact:true}).waitFor();});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Zoom in',exact:true}).click();
  await page.getByRole('button',{name:'Approve (A)',exact:true}).click();
  await page.getByLabel('Confirmed amount (LKR)',{exact:true}).waitFor();
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().endsWith('/approve')&&r.request().method()==='POST');
  await page.getByRole('button',{name:/^Confirm approve /}).click();
  if((await r).status()!==200)throw Error('Approval failed');
  await page.getByText(/Approved .* for/).first().waitFor();
});
