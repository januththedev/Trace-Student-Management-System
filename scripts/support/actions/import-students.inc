const p=demo.programmes[0], suffix=Date.now().toString().slice(-8);
const csv='student_ref,full_name,nic,phone,email,programme_code,intake_code,instalment_sequence,period_label,amount,due_date\n'+
  ',CSV training (Demo),2002'+suffix+',0700000002,training.csv@example.test,'+p.code+','+p.intake_code+',1,Training instalment,1000,2026-11-20\n'+
  'IDENTITY-'+suffix+',Identity training (Demo),,0700000003,training.identity@example.test,'+p.code+','+p.intake_code+',1,Training instalment,1000,2026-11-20';
await scene(0,async()=>{
  const download=page.waitForEvent('download');
  await page.getByRole('link',{name:'Download CSV template',exact:true}).click();
  await download;
  await page.getByLabel('CSV contents',{exact:true}).fill(csv);
});
await scene(1,async()=>{
  await page.getByRole('button',{name:'Run dry-run',exact:true}).click();
  await page.getByRole('heading',{name:'Dry-run results',exact:true}).waitFor();
});
await scene(2,async()=>{
  await page.getByRole('button',{name:'Commit reviewed import',exact:true}).click();
  await page.getByRole('heading',{name:'Import committed',exact:true}).waitFor();
});
