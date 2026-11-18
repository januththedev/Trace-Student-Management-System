await go('/staff/programmes/'+demo.programmes[0].id);
const entry=page.getByRole('region',{name:/Student entry link for/}).first();
await scene(0,async()=>{await entry.scrollIntoViewIfNeeded();});
await scene(1,async()=>{await entry.getByRole('button',{name:'Copy link',exact:true}).click();});
await scene(2,async()=>{
  const target=await entry.getByRole('link',{name:'Open link',exact:true}).getAttribute('href');
  await go(target);
  await page.getByRole('heading',{level:1}).waitFor();
});
