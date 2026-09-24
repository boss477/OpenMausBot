# The organization library

An organization's Admin can share packages (whole teams, or skills on their
own) with the desktops that belong to it, and with its Customers. In
OpenMausBot they appear under **Templates → From {Organization}**, the first
tab. One click on **Add** adds a package. There is no confirmation step,
because the person's click is the decision. **Details** opens the same
preview a shared file gets.

With no organization account nothing changes: the tab is absent, every
route below answers `{organization: null}`, no file is written and nothing
is reported.

## What Add does

The package goes through the same importer as a file (`server/package-import.ts`),
called with `trust: "org"` from `server/org-library.ts` and nowhere else.
Compared with a file:

- **Skills arrive switched on.** The organization's Admin published them,
  so Admin was the review. Their source reads `org:<publisher>/<package>@<release>`,
  and the file's own `source` is ignored.
- **Routines still arrive paused.** Bots still start on **Ask**, with no
  connected-app access and the installation's default model. Connections
  are still created switched off, without values.
- **Every record is stamped** with its install. A bot's wire-visible
  `installedPackage` gains `source: "org"`, `installId`, `publisher`, `ref`
  and `sha256`. Server-side only, each record also keeps two hashes for
  every part: `r`, the part as released, and `w`, the part as written here.
  The hashes live on bots (`packageBase`), group chats (`installedPackage`),
  routines (`installedPackage`) and skill state (`package`). The later
  automatic update uses them to tell your edits from the publisher's changes.
  Value shapes are in `server/package-parts.ts`.
- **A skills-only package** creates no records. Its skills are *offered*:
  **Bot → Skills → From {Organization}** lists them, and **Add** there puts
  one on that bot, switched on and stamped. A team's skills that no bot
  uses are offered the same way. Offered skills are read from the release
  file that was added. Electron removes a release file a week after the
  catalog stops naming it, and then those skills are no longer offered,
  though skills already on a bot stay.
- **Adding twice does nothing.** The install id is derived from the Admin
  address, the organization and the package, so the same package is the
  same install on every reconnect. A second Add answers `200
  {alreadyAdded: true}`.

A bot added from a package shows where it came from in **Bot settings →
Identity**: "From Sales desk 1.3.0 · Acme Partners". This version never
changes something it already added. When the catalog names a newer release,
the card says "Version X available. Updates arrive automatically in an
upcoming OpenMausBot update."

**Required** is treated as Available in this version, with a "Recommended
by …" badge. Entries the organization switched **off** are hidden, and
their copies stay.

## Withdrawn releases

When the catalog lists an added release under `withdrawnReleases`, its
skills are switched off, its routines are paused, the install is marked
**withdrawn**, and the bot's provenance line adds "Withdrawn by <publisher>".
This happens once, on the change. If you switch something back on
afterwards, it stays on. A package that disappears from the catalog changes
nothing: copies stay.

## How the catalog arrives

This runtime never talks to Admin. Electron main (`electron/managed-desktop.mjs`)
owns the Admin connection: it fetches the catalog and each release file,
checks their SHA-256, and writes the files to
`DATA_DIR/org-library/blobs/<sha256>.json`. It then relays the catalog over
the private utility port:

```jsonc
// Electron main → runtime
{ "type": "openmausbot:managed-library", "requestId": "…",
  "library": { "adminOrigin": "https://admin.example.com", "organizationId": "<uuid>",
               "organizationName": "Customer Co", "digest": "<sha256 of the catalog body>",
               "catalog": "<the raw catalog body, or the parsed object>" } }   // or library: null
// runtime → Electron main, at once, before any other work
{ "type": "openmausbot:managed-desktop-result", "requestId": "…", "ok": true }
```

- A catalog body sent as a string must hash to `digest`.
- The runtime reads the catalog as contract §5.3 defines it: unknown fields
  are ignored and a bad entry is dropped. A bad envelope, or a catalog for
  another organization, is refused (`ok: false`), and the last good catalog
  stays.
- `library: null` (sign-out, expiry or revocation) hides the shelf and
  changes nothing else.
- Release files are checked against their SHA-256 on every read, and never
  through a symbolic link. A file that does not match is treated as not
  downloaded.

After acknowledging, the runtime reconciles its index, handles withdrawn
releases, and sends a full snapshot back:

```jsonc
// runtime → Electron main, which posts it to POST /api/desktop/library/report
{ "type": "openmausbot:managed-library-state", "digest": "<applied digest>",
  "packages": [ { "packageId": "<uuid>", "release": "1.3.0", "sha256": "…",
                  "state": "installed" | "failed" | "removed" | "withdrawn",
                  "reason": "blob_unavailable" | "invalid_package" | "import_failed" | "newer_app_required"
                          | "removed_locally" | "withdrawn_by_publisher" } ] }
```

The runtime sends this snapshot at three points:

- after each relayed catalog;
- after each Add, whether it succeeds or fails;
- after the person deletes the last record of an install.

Debouncing, retries and the once-per-start report belong to Electron main.
A report lists only installs from the current organization. It never
contains names, paths or error text.

## Files

`DATA_DIR/org-library/`:

| File | Written by | What |
|---|---|---|
| `state.json` | runtime | The index of what was added (contract §3.4), plus `kind` and `name` per install. Mode 0600. |
| `blobs/<sha256>.json` | Electron | Release bytes, checked on every read. |
| `catalog.json` | Electron | The last applied catalog body. The runtime does not read it. |
| `presets.json` | runtime (`server/presets.ts`) | Preset bots, from files and from installs here ([presets.md](presets.md)). An install's presets are listed under `presets` in `state.json`. |

The records are the source of truth. `state.json` is rebuilt from them in
these cases:

- on start;
- before every Add;
- after each relayed catalog;
- whenever a bot or group chat is deleted, or a team is renamed.

A team's section is read from where its bots are now, so renaming the team
needs no hook. If the app stops after the records are written but before
the index is, the records are adopted once the catalog names their package,
and a second Add is still a no-op. An adopted install has no team-part
hashes, so a later update treats those parts as edited and keeps them.

## Routes

These routes use admin scope, like import.

| Route | Answer |
|---|---|
| `GET /api/org-library` | `{organization, packages: [entry + blob: "ready"\|"unavailable"\|"unsupported" + installed], installs}`. `{organization: null, packages: []}` with no organization. |
| `GET /api/org-library/packages/:packageId` | `{package, document}`: the preview, read from the checked file. |
| `POST /api/org-library/add {packageId}` | `201` with the added records · `200 {alreadyAdded: true}` · `404` not listed or switched off · `409 newer_app_required` · `503 blob_unavailable` · `422 invalid_package` |
| `GET /api/org-library/skills?botId=` | Offered skills of added packages, with `added` per bot. |
| `POST /api/org-library/skills {botId, installId, name}` | `201 {skill}`: puts one offered skill on a bot, switched on. |

Fixtures have no Electron parent. For tests, `POST /api/testing/org-library
{library}` relays a catalog instead. The route exists only when the server
starts with `OMB_TEST_ORG_LIBRARY_KEY`, and the request carries that key in
`x-openmausbot-test-org-library`. Production never sets the key.

## Not in this version

These arrive in v1.1 with no format change:

- automatic updates;
- Required with auto-install;
- honouring `offAction: "remove"`;
- the Admin Withdraw button.

Preset bots from a package go to **New bot** under **From {Organization}**,
and a bot made from one gets their skills switched on. A preset from a
withdrawn release is no longer offered. See [presets.md](presets.md).

See [verification/org-library.md](verification/org-library.md) for how this
is tested.
