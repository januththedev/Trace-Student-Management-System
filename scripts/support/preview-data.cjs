// Synthetic fixture discovery for recordings. Never connects to developer/production databases.
/* eslint-disable @typescript-eslint/no-require-imports -- standalone Node CommonJS fixture utility */
const fs = require('node:fs');
const path = require('node:path');
const postgres = require('postgres').default;
async function main() {
  const env = JSON.parse(fs.readFileSync('.agents-logs/ui-preview-env.json', 'utf8'));
  const url = new URL(env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/t2t_ui_preview_20261117') throw Error('Synthetic preview required');
  const sql = postgres(url.toString(), { max: 1 });
  try {
    // Align this existing disposable preview with the unreleased migration's millisecond precision.
    await sql`alter table support_feedback alter column created_at type timestamptz(3), alter column updated_at type timestamptz(3)`;
    await sql`alter table support_replies alter column created_at type timestamptz(3)`;
    const students = await sql`select s.id, s.full_name name, s.ref, e.id enrolment_id, e.status from students s join enrolments e on e.student_id=s.id order by s.ref`;
    const programmes = await sql`select p.id,p.name,p.code,i.id intake_id,i.code intake_code,i.label from programmes p join intakes i on i.programme_id=p.id where p.trashed_at is null and i.trashed_at is null order by p.name`;
    const submissions = await sql`select id,enrolment_id,status from payment_submissions order by submitted_at desc limit 25`;
    const assets = await sql`select id,enrolment_id,object_key,mime,validation,is_historical_placeholder from receipt_assets limit 5`;
    const receipts = {};
    const creditEnrolment = students[14].enrolment_id;
    await sql`insert into payment_events (enrolment_id,kind,amount_minor,source_reference,effective_date) select ${creditEnrolment},'HISTORICAL_IMPORT',100000,'support-training-credit','2026-11-17' where not exists (select 1 from payment_events where source_reference='support-training-credit')`;
    await sql`insert into programmes (code,name,status,trashed_at,trash_reason,purge_after,purge_status) values ('SUPPORT-RESTORE','Restorable training course (Demo)','ACTIVE',now(),'Demo: course moved to Trash for a restore tutorial',now()+interval '30 days','PENDING') on conflict do nothing`;
    const feeTraining = await sql.begin(async tx => {
      const [programme] = await tx`insert into programmes(code,name,is_public) values ('SUPPORT-FEE','Course fee training (Demo)',false) on conflict(lower(code)) do update set name=excluded.name returning id`;
      const [intake] = await tx`insert into intakes(programme_id,code,label,start_date,is_public) values (${programme.id},'SUPPORT-FEE-01','Training intake','2026-11-01',false) on conflict(programme_id,lower(code)) do update set label=excluded.label returning id`;
      let [version] = await tx`select id from fee_plan_versions where intake_id=${intake.id} and is_current=true`;
      if (!version) [version] = await tx`insert into fee_plan_versions(intake_id,version_no,notes) values (${intake.id},1,'Synthetic training schedule') returning id`;
      let [item] = await tx`select id from fee_plan_items where version_id=${version.id} order by sequence limit 1`;
      if (!item) [item] = await tx`insert into fee_plan_items(version_id,sequence,period_label,amount_minor,due_date) values (${version.id},1,'November 2026',100000,'2026-11-20') returning id`;
      let [enrolment] = await tx`select id from enrolments where student_id=${students[22].id} and intake_id=${intake.id}`;
      if (!enrolment) {
        [enrolment] = await tx`insert into enrolments(student_id,intake_id,fee_plan_version_id) values (${students[22].id},${intake.id},${version.id}) returning id`;
        await tx`insert into instalments(enrolment_id,fee_plan_item_id,sequence,period_label,original_charge_minor,due_date) values (${enrolment.id},${item.id},1,'November 2026',100000,'2026-11-20')`;
      }
      return {programmeId:programme.id,intakeId:intake.id,enrolmentId:enrolment.id};
    });
    const feeItems = await sql`select f.period_label,f.component,f.amount_minor,f.due_date from fee_plan_items f join fee_plan_versions v on v.id=f.version_id where v.intake_id=${feeTraining.intakeId} and v.is_current=true order by f.sequence`;
    for (const [n,kind] of ['approve','reject'].entries()) {
      const enrolment = students[20+n].enrolment_id;
      const [existing] = await sql`select id from payment_submissions where idempotency_key=${'support-demo-'+kind}`;
      if (existing) { receipts[kind]=existing.id; continue; }
      const [source] = await sql`select * from receipt_assets where validation='CLEAN' and is_historical_placeholder=false limit 1`;
      const key = 'receipts/'+enrolment+'/support-demo-'+kind+'.png';
      const storage = env.LOCAL_STORAGE_DIR;
      fs.mkdirSync(path.dirname(path.join(storage,key)),{recursive:true});
      fs.copyFileSync(path.join(storage,source.object_key),path.join(storage,key));
      const [asset] = await sql`insert into receipt_assets (enrolment_id,object_key,sha256,mime,size_bytes,width,height,validation,scan) values (${enrolment},${key},${source.sha256},${source.mime},${source.size_bytes},${source.width},${source.height},'CLEAN','NOT_CONFIGURED') returning id`;
      const [instalment] = await sql`select id from instalments where enrolment_id=${enrolment} order by sequence limit 1`;
      const [submission] = await sql`insert into payment_submissions (enrolment_id,target_instalment_id,asset_id,claimed_minor,transfer_date,idempotency_key,student_note) values (${enrolment},${instalment.id},${asset.id},100000,'2026-11-17',${'support-demo-'+kind},'Synthetic receipt used only for staff training') returning id`;
      receipts[kind]=submission.id;
    }
    fs.mkdirSync('output/playwright/support', { recursive: true });
    fs.writeFileSync('output/playwright/support/demo-data.json', JSON.stringify({ students, programmes, submissions, assets, receipts, creditEnrolment, feeItems, feeTraining }, null, 2));
    console.log({ students: students.length, programmes: programmes.length, submissions: submissions.length });
  } finally { await sql.end(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
