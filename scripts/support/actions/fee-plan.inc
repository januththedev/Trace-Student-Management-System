await go('/staff/programmes/'+demo.feeTraining.programmeId);
let version;
await scene(0,async()=>{
  await page.getByRole('button',{name:/Version .*Current/}).first().click();
  await page.getByRole('button',{name:'New fee plan version',exact:true}).first().click();
});
await scene(1,async()=>{
  for(let i=0;i<demo.feeItems.length;i++){
    const item=demo.feeItems[i];
    if(i)await page.getByRole('button',{name:'Add fee item',exact:true}).click();
    await page.getByLabel('Period label',{exact:true}).nth(i).fill(item.period_label);
    await page.getByLabel('Component',{exact:true}).nth(i).fill(item.component);
    await page.getByLabel('Amount (LKR)',{exact:true}).nth(i).fill(String(item.amount_minor/100+100));
    const d=new Date(item.due_date), month=d.toLocaleString('en-US',{month:'long',timeZone:'UTC'});
    await date('Due date',d.getUTCDate(),i,month,String(d.getUTCFullYear()));
  }
  await page.getByRole('textbox',{name:'Version notes',exact:true}).fill('Demo: reviewed fee adjustment with the same instalment structure.');
  const response=page.waitForResponse(r=>r.url().endsWith('/fee-plans')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create fee plan version',exact:true}).click();
  const result=await response;
  if(result.status()!==200 && result.status()!==201)throw Error('Fee version not created');
  const created=await result.json();
  await saved();
  version=page.getByRole('button',{name:new RegExp('^Version '+created.versionNo+' Current ')});
  await version.waitFor();
  await version.click();
  await page.getByRole('button',{name:'Apply fee amounts to existing enrolments',exact:true}).first().click();
  await page.getByRole('button',{name:'Choose existing enrolments',exact:true}).first().click();
});
await scene(2,async()=>{
  // Radix exposes the visible checkbox by its stable fee-prefixed id.
  await page.locator('button[role="checkbox"][id^="fee-"]:not([disabled])').first().check();
  await page.getByRole('button',{name:'Preview selected fee changes',exact:true}).click();
  await page.getByRole('region',{name:'Fee change impact preview',exact:true}).waitFor();
  await page.getByLabel('Reason for applying fee changes',{exact:true}).fill('Demo: approved updated course fees for the reviewed enrolment.');
  await page.getByRole('button',{name:'Confirm fee changes for selected enrolments',exact:true}).click();
  await page.getByText(/Fee changes applied to 1 selected enrolments/).waitFor();
});
