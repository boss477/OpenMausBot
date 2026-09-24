# Organization library: the desktop channel

What it covers: Electron main's half of the organization library
([../desktop-library.md](../desktop-library.md)): the capability, the session
pointer, the catalog and release downloads, their checks and cache,
`company-library.bin`, the relay to the local runtime and install reports.
The runtime's shelf and the Add path are verified with the runtime.

## Run

```sh
node --test electron/org-library.node-test.mjs
pnpm test:electron
pnpm check:electron
```

The first command needs no Electron, keychain, network or user data. Each test
makes its own temporary folder and removes it. Admin is a fake `fetch` (or a
fake `fetchBytes`) answering with the shapes of contract §5 and Admin's
`/api/desktop/library*` routes; the runtime is a fake utility process that
acknowledges every relay at once, as `server/org-library.ts` must. Release
bytes are the committed `shared/package-fixtures/*.v2.json` files.

It checks:

- **Catalog parser:** unknown fields are ignored; a bad entry (a control
  character, an array posing as a string, a bad count, a bad withdrawn
  release) is dropped alone; a bad envelope, more than 100 entries, or another
  Organization's catalog is refused whole; Off and format 3 entries stay listed.
- **Downloads:** a moved pointer fetches the catalog, then each release that is
  not Off and has format 2 or lower; files are owner-only and byte-exact;
  `company-library.bin` holds `{portalOrigin, organizationId, deviceId,
  libraryVersion, digest}`; the relay carries the parsed catalog and no token.
  An unchanged pointer fetches nothing. Bytes that do not match their SHA-256
  are never written and are retried after a delay; a cached file that no
  longer matches is replaced after the next catalog; a `429` pauses downloads
  for its `retry-after`.
- **Convergence:** the applied digest is the received bytes' SHA-256, not the
  pointer's. A foreign or malformed catalog keeps the last good one and backs off.
- **Restore:** at start the saved catalog reaches the runtime before any
  request to Admin, and a restored catalog with the same pointer is not
  fetched again. A tampered `catalog.json`, another device, Organization or
  Admin, or an expired sign-in is ignored.
- **Sign-out, revocation and an Admin that drops the library:** the runtime is
  sent `library: null`; `company-library.bin`, `catalog.json` and the cached
  release files go; the runtime's `state.json` and files this channel did not
  write stay.
- **Old Admin:** with no `capabilities.library`, the fake Admin never sees a
  `/api/desktop/library*` request, even when the session carries a pointer;
  the config is read once. A desktop that could not read the config at start
  asks again after 10 minutes, then fetches.
- **Runtime restarts:** the catalog is relayed again after `runtimeReady()`;
  an unacknowledged relay is retried on the next sync without a new download.
- **Reports:** 5 s debounce; only the newest snapshot; the first report of a
  start waits for a successful sync; a failed post is retried on the next
  sync, not by time alone; a snapshot for a digest this desktop did not relay,
  or after sign-out, is never sent; free-text reasons never leave.
- **Limits:** `fetchLibraryBytes` refuses every other route; 4 MiB of release
  bytes pass and 4 MiB + 1 is refused, and a caller can lower the cap but not
  raise it; the catalog stops at 256 KiB; a report body over 64 KiB is
  refused; the session keeps its own 512 KiB cap.
- **Pruning:** a release file the catalog stopped naming stays for 7 days.

`pnpm test:electron` also runs `company-backup-main.node-test.mjs`, which
evaluates the real `ensureManagedDesktop()` wiring in `main.mjs`.

## Mutation checks (2026-09-24)

Each change below was made to the code, `node --test
electron/org-library.node-test.mjs` failed, and the change was reverted:

| Broken on purpose | Failing test |
|---|---|
| no SHA-256 check before writing release bytes | release bytes that do not match … |
| no Organization check on the catalog | another organization's … catalog keeps the last good one |
| library requests without the capability | an Admin without the library capability … |
| restore without the digest check / the device check | restore relays the saved catalog … |
| no 5 s debounce / no retry flag after a failed report | install reports … |
| reporting a digest main did not relay | a snapshot for a catalog this desktop did not relay … |
| any route allowed / caller-raised caps | fetchLibraryBytes … |
| sign-out keeps `catalog.json` / sends no `library: null` | sign-out … |
| Off and format 3 entries downloaded | a moved pointer fetches … |
| pointer digest applied instead of the bytes' | the digest of the applied bytes wins … |
| restore not awaited before the first request | at start the saved catalog reaches the runtime … |
| no relay after a runtime restart | a restarted runtime gets the catalog again … |
| no pruning | cached release bytes … removed 7 days later |

## Not covered here

This is not production qualification. It does not run the real Electron app,
the OS keychain behind `company-library.bin`, a real utility process, or a
real Admin. The cross-repository test in Admin (contract §7.4, after the
runtime pin moves) drives this module against a real Admin fixture. The
runtime's handling of `openmausbot:managed-library` and its
`managed-library-state` snapshots belongs to `server/org-library.ts`.
