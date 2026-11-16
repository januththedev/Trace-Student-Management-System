# Acceptance browser tests

Run `pnpm exec playwright install chromium`, then `pnpm exec playwright test`.
The config starts a new `pnpm dev --port 3100` server, creates/migrates/resets only
`t2t_e2e`, and seeds synthetic records with application crypto helpers. Each test
creates its own student and intake. No real accounts, receipts or notifications
are used. The test staff password and keys are synthetic and restricted to this
database/server. `TEST_DATABASE_URL` (or `DATABASE_URL`) supplies the PostgreSQL
host/administrator connection; the role must have permission to create databases.

Before starting, the config copies the current application sources and config
unchanged into `.artifacts/app` and shares the installed dependencies through a
directory junction. The dev server runs that disposable copy, so another agent's
dev server can keep running in the main checkout. An existing server is never
reused. Port 3100 must be free. The copied sources are test artifacts, not a fork.

Desktop Chromium and a 390px Pixel 7 profile run with reduced motion. Real HTTP
requests cover entry, private uploads, staff review/undo/rejection, remembered
devices, no-store headers, the actual service worker, expired database sessions,
keyboard navigation, delayed network responses and follow-up call outcomes.

For an explicitly chosen existing Chromium installation, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable; by default Playwright uses
its matching managed browser. Results, HTML reports, screenshots and failing-test
traces are written under `.artifacts/` (ignored). Expected application failures
must reference their append-only entry in `docs/agent-requests.md`; an unexpected
pass fails the suite so fixed regressions cannot remain hidden.

If Google Fonts stalls over IPv6 on the test host, set `T2T_E2E_IPV4_FONTS=1`.
The optional launcher forwards only the real Google font TLS connections over
IPv4; it does not change font content or intercept application/API traffic.
If the native font client still stalls, `T2T_E2E_CACHED_FONTS=1` downloads the real
CSS and font bytes with IPv4 curl into the ignored artifact cache and gives that
cache to Next's font test transport. Font content and application services remain
real. This option requires curl and the initial download still needs connectivity.

The helpers exercise the actual Radix course/intake lists and calendar rather
than assigning values to hidden native inputs. The upload check verifies both
the visible instalment and submitted instalment ID/business date. Keyboard
acceptance opens and selects the same list using Enter/Home/ArrowDown/Tab.
The copied fixture includes `.gitignore`; the application's explicit Tailwind
source path keeps CSS discovery inside `src` during isolated compilation.
