# Titanium WhatsApp linked-device bridge — local draft

This is an **unpaired, undeployed draft**, disabled by default. It has
not connected to WhatsApp or changed live tasks. It does not use the browser's
WhatsApp session, copy browser credentials, control a browser, or run commands
from chat messages. The phone remains registered in the normal Business app.

## What is implemented

- A separate Baileys linked device; owner-approved pairing code, once per new
  session. Only the configured account may run; unresolved/mismatched self identity
  stops processing without logging out or deleting anything.
- Durable SQLite authentication (credentials AND Signal keys), inbound queue,
  saved backend response, and bounded reply retry with a persistent outgoing ID.
- Incoming live plain text from explicitly allowlisted registered phone numbers.
  Every group also needs its exact allowlisted JID. Empty group list denies all
  groups. No names, quoted content or phone claims authorize a sender. Unknown
  LIDs fail closed; they are not interpreted as telephone numbers.
- No history/backfill, protocol messages, edits, reactions, forwarded media,
  statuses, broadcasts or own messages. Fresh means after first bridge activation,
  at most five minutes old, with at most one minute of future clock skew.
  Plain extended text may contain a quote, but only its new text is processed.
- Maximum twelve accepted messages per registered sender per minute and 1,000
  pending queue rows. Excess messages are ignored; there is no unlimited queue.
- Backend POST retries only for transport errors, HTTP 429 or HTTP 503, at most
  five attempts. Each request has a 30-second timeout to leave room for the
  backend's 12-second inference deadline plus database/result overhead.
  Other HTTP failures stop that row. Replies get at most three
  attempts and never cause the backend operation to execute again.
- Bare six-digit messages using English (`0–9`) or Arabic-Indic (`٠–٩`) digits,
  including mixed digits and surrounding whitespace, are ignored before queueing.
  Enter website login codes on the website. This is a narrow precaution, not a
  general secret detector: codes embedded in sentences or other formats are not
  automatically identified, and ordinary task text containing numbers remains eligible.

## Runtime / pairing prerequisites

Use **Node.js 22.23.2+** (this draft uses built-in `node:sqlite`), one persistent process,
a durable private local filesystem, and outbound HTTPS/WebSocket access. A normal
serverless request handler or a process tied to this conversation is insufficient.
The VPS must have a supervisor that starts one instance after reboot. Do not run
two instances against the same credentials/database; no multi-process lease is
implemented. Limit supervisor restart loops and surface stopped/failed states.

The package pins `baileys` **7.0.0-rc14** and `pino` 9.6.0. Dependencies were installed
locally with lifecycle scripts disabled and a lockfile generated. Importing the
installed Baileys module without constructing a socket passed. Its actual exports,
JID normalization, SQLite-backed auth serialization and socket factory interface
were checked. This is not a live network or VPS dependency test. Review the
lockfile/audit and verify the installed version before pairing; never downgrade to
an older unpatched release. `whatsapp-rust-bridge` 0.5.4 ships bundled Rust/WASM;
other optional dependencies can include platform-specific binaries.

The known VPS runtime is
`/home/titani24/nodevenv/management.titanium-pharmacy.com/22/bin/node` (22.23.2).
Its default shell `node` is version 16 and MUST NOT run this service. The APIs used
here exist on Node 22.23.2; built-in SQLite no longer needs an enabling flag after
22.13. Local verification used Node 24, so run the offline suite with the explicit
VPS Node 22 executable before deployment. User-level systemd was unavailable on
this host; choose and verify a supported supervisor instead of assuming
`systemctl --user` works. Exit code 78 means configuration/owner attention: do not
blindly restart it indefinitely. Normal SIGTERM/SIGINT uses exit code 0.

Copy the settings from `.env.example` into a private service environment, **not**
the project database, Git, browser or a publicly served file. A service manager
must load them; the application does not load `.env` automatically.

- `TEAM_CHAT_BRIDGE_ENABLED=0` is the safe default.
- `TEAM_CHAT_BOT_NUMBER`: actual management number, international digits only.
- `TEAM_CHAT_ALLOWED_NUMBERS`: actual employee numbers verified against the live
  management user records; do not infer owner/admin status from WhatsApp names.
- `TEAM_CHAT_ALLOWED_GROUPS`: exact group IDs, initially empty for private testing.
- `TEAM_CHAT_STATE_DIR`: an absolute private directory outside this repository and
  all web roots. Protect its parents too; symbolic-link ancestors and Windows ACLs
  require deployment inspection. The database and WAL contain authentication
  secrets and allowed employee message text. They must never be committed to Git.
- `TEAM_CHAT_SHARED_KEY`: a securely generated independent 32-byte secret as 64
  hexadecimal characters, matching the backend. Do not use an example/repeated key.
- `TEAM_CHAT_BACKEND_URL`: the actual HTTPS management endpoint with exact path
  `/api/whatsapp/team-chat`, no credentials/query/fragment or redirects.

Enable the backend only after its permissions/idempotency tests pass. When ready
for an owner-supervised private test, enable this service and set
`TEAM_CHAT_PAIR=1` if no credentials exist. The private service console displays a
new pairing code. The owner enters it in the mobile app's Linked Devices flow.
This is a **new** device; a previous WhatsApp Web pairing is not reused. Set
`TEAM_CHAT_PAIR=0` after success. The credential update and normal socket restart
are persisted; later process restarts reconnect without another code.

Fresh pairing may synchronize identifiers/keys internally, but history is not
forwarded to the task endpoint. Existing browser devices need not be logged out.
For logout, wrong number, forbidden/replaced session, corrupted auth or repeatedly
failed reconnects, the service stops for owner attention; it never erases auth
or silently pairs another account.

## Backend contract

Raw UTF-8 JSON body, retaining the same bytes on retries:

```json
{"messageId":"WA_MESSAGE_ID","senderNumber":"15551234567","groupId":null,"text":"started the task","receivedAt":1800000000000}
```

The original authenticated group ID replaces null for a group. `receivedAt` is
local ingestion time in Unix milliseconds; the separate WhatsApp source timestamp
has already passed the freshness filter. Header signature:

```text
x-titanium-chat-timestamp: current Unix milliseconds as a decimal string
x-titanium-chat-signature: lowercase hex HMAC-SHA256(
  Buffer.from(TEAM_CHAT_SHARED_KEY, 'hex'), timestamp + '\n' + rawBody
)
```

The backend MUST verify HMAC and timestamp; validate its own active-user phone
mapping and group allowlist; scope durable deduplication by sender, group and
message ID; reject conflicting reused IDs; and commit task changes plus result
atomically. Client-side filters are not a replacement for backend authorization.
The model must never authorize a sender or select arbitrary operations/recipients.

Success is HTTP 200 with `{status: string, reply: string, taskId?: string}`. Empty
reply means remain silent. Extra fields are discarded, particularly recipients.
The reply goes only to the authenticated original chat. Backend-owned templates
and action policies must ensure a group reply does not disclose other users'
private task details. HMAC does not make a compromised bridge host trustworthy;
it authenticates that host, not every possible assertion made by malicious code.

## Verification and limitations

`npm test` (or `node --test tests/*.test.mjs`) runs offline tests without real
credentials, external requests or employee data. The core `bridge.test.mjs` suite
can run without dependencies installed. The `runtime.test.mjs` suite imports the
installed Baileys package for compatibility checks but replaces its socket factory
with a mock; no real socket is initialized. The combined suite covers
allowlists, PN/LID conflicts, history/spoof-envelope rejection, raw-body HMAC,
SQLite restart persistence, binary auth keys, deduplication and bounded retries,
actual-account pinning, pairing/reconnect lifecycle, and stale-socket event races.
It does **not** certify the live protocol or production readiness.

Required live tests: new phone pairing and correct account; real private message;
one harmless task update plus audit log; duplicate delivery; negative/ambiguous
Arabic; unknown employee; reconnect/reboot; backend rejection; group identity and
privacy before adding an explicit group allowlist. Keep the main site's original
Cloud API webhook disabled/unmodified until the transport decision is explicit.

WhatsApp may accept a reply immediately before a crash or lost acknowledgement.
Retry uses the same outgoing ID, but **exactly-once WhatsApp replies are not
guaranteed**. Backend atomic idempotency is what prevents duplicate task changes.
Sending retry plaintext is available from the queue via `getMessage`.
Failed rows are retained for inspection, not automatically re-executed. Records
currently have no automatic retention purge; set a deliberate retention policy.

This is an unofficial integration, not Meta/OBA approval. Protocol changes may
break it and account restrictions are possible. No guarantee of service uptime,
account safety or permanent free hosting is made.

## Primary references checked

- [Baileys release tags](https://github.com/WhiskeySockets/Baileys/releases)
- [7.0.0-rc14 package source](https://github.com/WhiskeySockets/Baileys/blob/v7.0.0-rc14/package.json)
- [Maintainer spoofing vulnerability advisory and patched versions](https://github.com/WhiskeySockets/Baileys/security/advisories/GHSA-qvv5-jq5g-4cgg)
- [Pairing code](https://baileys.wiki/authentication/pairing-code)
- [Session storage](https://baileys.wiki/authentication/session-management)
- [JIDs and LID mapping](https://baileys.wiki/concepts/jids)
- [Events](https://baileys.wiki/concepts/events)
- [Socket configuration](https://baileys.wiki/concepts/socket-config)
