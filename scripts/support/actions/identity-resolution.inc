await scene(0,async()=>{await page.getByRole('button',{name:'Resolve',exact:true}).first().click();});
await scene(1,async()=>{
  await page.getByLabel('Corrected NIC',{exact:true}).fill('2003'+Date.now().toString().slice(-8));
  await page.getByLabel('Reason for the correction',{exact:true}).fill('Demo: identity verified against the original application before importing.');
});
await scene(2,async()=>{
  const r=page.waitForResponse(r=>r.url().endsWith('/resolve')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Import corrected record',exact:true}).click();
  if((await r).status()!==200)throw Error('Identity resolution failed');
  await page.getByRole('dialog').waitFor({state:'hidden'});
});
