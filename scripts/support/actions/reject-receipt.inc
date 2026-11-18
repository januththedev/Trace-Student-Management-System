await go('/staff/review?submission='+demo.receipts.reject);
await scene(0,async()=>{await page.getByRole('button',{name:'Reject (R)',exact:true}).waitFor();});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Reject (R)',exact:true}).click();
  await page.getByRole('button',{name:'Receipt is unreadable',exact:true}).click();
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().endsWith('/reject')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Confirm reject',exact:true}).click();
  if((await r).status()!==200)throw Error('Rejection failed');
  await page.getByText(/Rejected receipt from/).first().waitFor();
});
