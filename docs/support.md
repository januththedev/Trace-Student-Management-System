# Staff help and feedback

Open **Help & support** from the staff header. The help library is organised by task, with search, English video narration, captions and written steps. Super Admin tasks appear only for that role. Individual mutations still check their actual delegated capability on the server.

Videos are recordings of the real application with synthetic demonstration records. Narration is generated locally using the installed Microsoft David English voice. MP4s use H.264 at 720p / 12 fps, mono AAC and fast-start metadata. They load only when played; posters and captions load when a guide is opened. No real student data, production sessions or private invitation tokens belong in recordings.

**Send feedback** accepts a problem, suggestion or question and the relevant area. Authors see their own tickets under **My feedback**. Super Admins see **Feedback inbox**, can change status and append replies. Earlier replies remain visible. Updates create a private in-portal notification for the author. Feedback is not automatically sent to an external developer, email address or third-party service.

Both creation and responses use payload-bound idempotency, transactional fresh authorization and audit records. Replies require the expected ticket version. Audit/replay records exclude the free-text message. Lists use stable timestamp/UUID pagination; millisecond database precision preserves JavaScript cursor boundaries. UI errors retain form content and retry keys.

## Database rollout

Migration **0004_support_feedback.sql** creates `support_feedback` and `support_replies`, their indexes and constraints. Apply the checked-in migration chain to the intended database **before** serving this release. Existing financial and student tables are unchanged by this migration. Local recording/testing uses isolated synthetic databases; it does not migrate production.

## Maintaining walkthroughs

The authoritative task catalogue is `src/app/staff/support/tutorials.ts`; matching media metadata is `tutorial-media.json`. Public assets live in `public/support/videos/`. Run `node scripts/check-support-media.mjs` to reject missing recordings, stale sizes, invalid caption timings or oversized clips.

Recording utilities are under `scripts/support/`. They require Windows System.Speech, `tsx`, Playwright CLI and Python `imageio_ffmpeg`. The recorder drives an already authenticated `t2t-support` Playwright CLI session on `http://localhost:3100`. It refuses a different origin. Fixture preparation requires the exact local `t2t_ui_preview_20261117` database; it must never be pointed at production. Raw recordings, generated speech and execution evidence remain in the ignored `output/playwright/support` directory.

1. Prepare the synthetic preview; run `node scripts/support/preview-data.cjs` to discover/create the recording fixtures.
2. Run `pnpm exec tsx scripts/support/record.ts <task-id>` to perform and record the task. Mutating demonstrations change only that preview. Prepare fresh fixtures before repeating one-time actions such as withdrawal or restore.
3. Run `python scripts/support/encode.py <task-id>` to combine the recording and English narration, generate captions and poster, and update the metadata.
4. Watch the exported clip, verify the action and final outcome, then run the media check. Re-record whenever the controls or workflow change.

The recorder uses installed local tools and makes no production writes. All published videos must show completed, verified demonstrations; a failed recording must not be entered into the media manifest.
