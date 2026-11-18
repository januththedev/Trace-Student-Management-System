await go('/staff/enrolments/'+demo.students[0].enrolment_id);
await scene(0,async()=>{await page.getByRole('heading',{name:'Instalment timeline',exact:true}).scrollIntoViewIfNeeded();});
await scene(1,async()=>{await page.getByRole('heading',{name:'Charge adjustments',exact:true}).scrollIntoViewIfNeeded();});
await scene(2,async()=>{await page.getByRole('region',{name:'Enrolment balances',exact:true}).scrollIntoViewIfNeeded();});
