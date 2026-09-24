# The organization library

This recipe covers **Templates → From {Organization}**: the catalog Electron
relays, **Add** with `trust: "org"`, the stamps, withdrawn releases, the
report snapshot, **Bot → Skills → From {Organization}** and the provenance
line. The product behaviour is described in
[../org-library.md](../org-library.md). Nothing here talks to a real Admin.
A catalog is relayed into a disposable fixture through
`POST /api/testing/org-library`, which exists only when the fixture was
started with `OMB_TEST_ORG_LIBRARY_KEY`.

## Library units

```sh
pnpm exec vitest run server/org-library.test.ts
```

This test uses a real store, routine manager and skill store in a throwaway
home. The release files are the committed fixtures as Admin would serve
them: parsed as files, stamped with a publisher, in canonical bytes. It
checks the following:

- **Catalog (§7.3.1).** Unknown fields are ignored and a bad entry is
  dropped. A bad envelope, another organization's catalog, a digest that
  does not name the bytes, and a plain-http Admin each keep the last
  catalog. A `formatVersion: 3` entry shows as "update" and its file is
  never read.
- **Files (§7.3.2).** A file whose bytes do not match its name is refused on
  read: shown as not downloaded, Add answers `503 blob_unavailable`, and the
  failure is reported. A file stamped by another publisher is refused as
  `invalid_package`.
- **Relay (§7.3.3).** `applyRelay` returns before `state.json` is written or
  anything is reported. The reconcile and the report follow.
- **Add (§7.3.4).** Skills are on, with an `org:` source. Routines are
  paused. Bots carry `installId`, `publisher`, `ref`, `sha256` and
  `agentKey`. Every bot, group chat and routine part has `r` and `w`, and
  `w(name)` is "Scout 2" when "Scout" was taken. The stamps never reach
  `listRoutines()` or the skill listing. The index and the report follow.
- **Idempotency (§7.3.5).** Add twice gives one team. When `state.json` is
  deleted, the next relay adopts the records and Add stays a no-op. A
  skills-only package's second Add is a no-op too. Signing out hides the
  shelf and keeps the copies. Reconnecting recognizes the installs.
- **Withdrawn (§7.3.6).** A withdrawn release has its skills off, its
  routines paused, `status: "withdrawn"`, and the report says
  `withdrawn_by_publisher`. A skill switched back on afterwards stays on. An
  entry that disappears changes nothing.
- **Removal (§7.3.7).** Deleting the install's last bot marks it `removed`
  and reports `removed_locally`. Add then works again.
- **Skills-only package.** It is registered with no records, and its skills
  are offered per bot. Adding one puts it on, stamped. A duplicate is `409`.
  Withdrawing the package switches that skill off.
- **No organization (§7.3.7).** Nothing is listed, no `org-library/` folder
  is created, no bot's skill state is read, and nothing is reported.

## HTTP through a fixture server

```sh
pnpm exec vitest run server/org-library.e2e.test.ts --silent=false
```

This launches and cleans its own fake-engine fixture with
`launchVerificationServer`, passing a random `OMB_TEST_ORG_LIBRARY_KEY`. It
checks the following:

- With no relay, `GET /api/org-library` is `{organization: null, packages: []}`.
- The relay route answers `404` with the wrong key.
- After the relay, both packages are listed as ready, and
  `GET /api/org-library/packages/:packageId` returns the checked document.
- `POST /api/org-library/add` gives `201` and then `200 {alreadyAdded}`.
- `GET /api/bots`, `GET /api/routines` and the Add response contain no
  `packageBase` or `memberKeys`, so the stamps stay on the server.
- Skills are on, routines are paused, and `state.json` holds the install.
- `POST /api/org-library/skills` puts an offered skill on a bot, switched on.
- A `null` relay hides the shelf and keeps the bots.

## Renderer

```sh
pnpm exec vitest run src/lib/org-library.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/org-library-ui.e2e.test.ts --silent=false
```

The first command renders the shelf cards and the preview to markup. It
checks:

- Add appears only for a checked file, and there is no confirm step;
- Added, "Update OpenMausBot to add this", the Recommended badge, the
  waiting-release sentence and "Withdrawn by …";
- "Included skills — switched on";
- a skills-only preview with no team;
- the provenance line.

The second command runs a disposable `control-omb ui` app, with the key
passed through `scripts/control-omb.ts`. It checks, in order:

- Templates has no organization tab before any relay.
- After the relay, **From Customer Co** is the first tab and opens first.
- **Details of Sales desk** shows the skills switched on.
- **Add Sales desk** adds the team in one click. Its skills are on and its
  routines are paused.
- The card then reads Added.
- **Add Sales skills** adds in place.
- The first bot's **Identity** shows "From Sales desk 1.3.0 · Acme
  Partners".
- **Skills → From Customer Co → Add follow-up to this bot** puts the skill
  on, switched on.

Screenshots go to `.omb-scratch/verify-evidence/org-library-*.png`.

## 2026-09-24: what was actually run

This ran on macOS (arm64) against disposable fixtures only. These passed:

- `pnpm typecheck`, `pnpm lint` and `pnpm i18n:check`;
- the four commands above, including the headless-renderer run with
  `OMB_UI_E2E=1`;
- `server/package-import.test.ts`, `server/package-export.test.ts`,
  `shared/package-format.test.ts`, `server/bot-package.test.ts`,
  `server/skills.test.ts`, `server/routines.test.ts`, `server/store.test.ts`,
  `server/team-share.e2e.test.ts`, `src/components/ShareTeamDialog.test.ts`
  and `src/lib/team-import.test.ts`.

Each of these was mutation-checked: the behaviour was broken, the named test
was seen failing, and the fix was restored.

- **Add:**
  - organization skills landing off;
  - organization routines landing on;
  - bot part hashes not written;
  - `w(name)` taken from the file instead of what was written;
  - offered skills added with a non-`org:` source.
- **The index:**
  - records not adopted after a lost `state.json`;
  - the index no-op removed (caught by the skills-only package);
  - deletions not watched;
  - the index written before the records were read on start;
  - skill state read on an installation with no organization.
- **Withdrawn releases:**
  - skills not switched off;
  - acting again on an already-withdrawn install.
- **Files and the relay:**
  - a file not checked against its SHA-256;
  - a foreign organization's catalog accepted;
  - a newer format read anyway;
  - the reconcile run before the acknowledgement;
  - the testing relay route answering without its key.
- **Stamps on the wire:**
  - the routine stamp;
  - the bot `packageBase`;
  - the group chat stamp.
- **Renderer:**
  - a card offering Add for a file that is not ready;
  - the preview saying skills arrive off;
  - the provenance line missing a withdrawal;
  - the shelf tab hidden (caught by the headless-renderer run).

Not production qualification: no real Admin, Electron relay, encrypted
store or packaged app was involved. The Electron side (fetch, file cache,
relay and posting the report) is separate work, and it was stood in for by
the testing route and files written by the tests.
