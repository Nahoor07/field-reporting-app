# Field Reports

A bare React Native (0.87, TypeScript) app for filing photo reports from a site where 2G is
normal and no signal is common. Reports are composed offline, saved on the phone, and
delivered to the server unattended: **nothing lost, nothing twice, progress on a bad link,
survives a kill.**

```
backend/   Fastify server: resumable chunked uploads, idempotent commit, fault injection
mobile/    The app. Upload logic is headless: it has no React imports and runs without rendering a screen.
```

---

## Run it

Requirements: Node ≥ 22.13, JDK 17, Android SDK, a device or emulator.

```bash
# 1. Backend (terminal 1)
cd backend && npm install && npm start          # listens on :4000, data in backend/data

# 2. App (terminal 2)
cd mobile && npm install
adb reverse tcp:4000 tcp:4000                   # phone's localhost:4000 → your machine
npm start                                        # Metro
npm run android                                  # terminal 3, or press "a" in Metro
```

The app talks to `http://localhost:4000` by default. On Wi-Fi without a cable, set the
address shown by `npm start` (e.g. `http://192.168.1.20:4000`) under **Settings → Server**.

## Make it fail

The backend fails on demand. Faults are injected per route and never touch the admin routes.

```bash
cd backend
npm run fault -- list                   # presets + current config
npm run fault -- 2g                     # 700 ms latency, ~48 kbps uploads
npm run fault -- flaky                  # 2g, and 30% of chunk uploads die mid-body
npm run fault -- drop-twice             # next two chunks: connection dropped mid-body
npm run fault -- lose-chunk-response    # next two chunks stored, response lost
npm run fault -- lose-commit-response   # commit stored, response lost (the duplicate trap)
npm run fault -- hang                   # next chunk never answers
npm run fault -- 503                    # next three requests fail with 503 (retryable)
npm run fault -- down                   # everything 503 until cleared
npm run fault -- refuse                 # new uploads refused with 422 (not retryable)
npm run fault -- clear                  # healthy again
npm run fault -- stats                  # how many reports/images the server holds
npm run fault -- wipe                   # delete everything on the server
```

One-shot presets (`drop-twice`, `lose-*`, `hang`, `503`, `down`, `refuse`) keep the current
network profile, so `2g` followed by `drop-twice` gives a slow link that also drops twice.
`clear` resets both. Airplane mode on the phone covers "no network at all".

---

## How it works

### Architecture

```
mobile/src
├── domain/     Pure types and rules: LocalReport state machine, limits, compose validation
├── sync/       UploadEngine + ports + retry policy. No React, no React Native imports.
├── outbox/     FileOutboxStore: the durable queue (implements the engine's ReportStore port)
├── compose/    DraftStore: the report being written, persisted as you type
├── images/     Resize ladder (pure) + native adapter
├── api/        XHR transport for the upload protocol; server list fetch
├── platform/   Adapters: file system, connectivity, camera/gallery, ids
├── app/        runtime.ts, the composition root. The only file that wires concrete adapters.
└── ui/         status.ts (all user-facing status copy, pure), hooks, components, screens
```

Dependencies only point inward: `ui → app → (outbox, compose, api, images, platform) → sync → domain`.
The engine lives outside React in `runtime.ts`, so the queue keeps draining whichever screen is
mounted and never restarts because a component re-rendered. Screens read state through
`useSyncExternalStore` over plain stores and call a handful of runtime commands; they hold
no delivery logic.

### The delivery guarantees, and where each comes from

| Guarantee | Mechanism |
|---|---|
| **Nothing lost to a force-quit** | A report becomes durable when its fully written directory is *renamed* into the outbox (atomic). Every engine step is persisted before the next one starts. On launch, anything left `uploading`/`committing` goes back to `queued`. |
| **Nothing lost to a dropped connection** | Photos go up in 64 KB chunks to a resumable upload. On every retry the client asks the server for its offset (the server is the truth), so a drop costs one chunk, not the photo. |
| **Nothing lost to a lost response** | Every call is idempotent. A chunk whose response was lost comes back as `409 offset_mismatch` with the real offset, and the client skips ahead without resending. |
| **Nothing lands twice** | Report and image ids are UUIDs generated on the phone before the first attempt. The server dedupes on them, and a report only becomes visible at one atomic commit. Replaying a commit returns `created: false`. |
| **Progress on 2G** | Small chunks, per-request deadlines that scale with chunk size, and backoff that resets whenever bytes moved, so slow isn't treated as failing. |
| **Only the right things are retried** | `sync/errors.ts#classify`: network, timeouts, 408, 429, 5xx → retry with exponential backoff and jitter (honouring `Retry-After`). 4xx means the server has definitively refused → `failed`, and the user decides (Try again / Delete). |
| **A hung request can't wedge the queue** | Each call is raced against its own deadline and abandoned if it never answers, even if the transport ignores the abort signal. |

Every adapter sits behind a port (`sync/ports.ts`, `platform/disk.ts`), so the engine can be
driven entirely in Node with in-memory fakes, with no screen and no device:

```bash
cd mobile && npm run test:sync     # ~5 s, 87 tests
cd backend && npm test             # upload protocol and fault injection, 14 tests
```

- `UploadEngine.test.ts`: the protocol against a fake server: resume from the server's offset,
  lost chunk and commit responses, which errors are retried and which go to `failed`, hangs,
  oldest-first ordering, the 5 MB ceiling, and discarding in-flight results on stop.
- `chaos.test.ts`: randomized runs that drop connections, lose responses and kill the engine
  at arbitrary points, then assert every report landed exactly once with every byte intact.
- `policy.test.ts`: error classification and backoff.

### Images

An 18 MB original is a valid selection. `images/prepare.ts` walks a small ladder (native decode,
resize, then JPEG encode, all off the JS thread) and takes the first result inside a **1.5 MB
budget**. The **5 MB ceiling** is a hard stop it can never return above.

- 2048 px on the long edge at q82 resolves a hairline crack and lands at 0.5–1.2 MB, which is
  the difference between 1 and 4 minutes per photo on 2G.
- The decoder subsamples while reading (`inSampleSize`), so a 50 MP photo never sits in memory
  at full size. Photos are processed one at a time for the same reason.
- EXIF orientation is applied to the pixels and the metadata is stripped: no GPS or device
  data leaves the phone.
- The SHA-256 is computed natively, and the server verifies it after assembly.
- The picker's temporary copy is deleted once the processed version exists.

### UX decisions

- **One glance, one answer.** A banner at the top of *On this phone* says whether work is
  safe (saved on this phone), moving (sending, with bytes), waiting (why, and the next retry as
  a countdown, with **Try now**), or needs a decision. The tab carries a count.
- **It never lies.** All status copy lives in `ui/status.ts`. "Saved on this phone" and "On the
  server" are separate facts, and no state puts them in one sentence. "On
  the server" appears only after the server confirmed the commit.
- **Nothing waits on the network except the network.** *Save & send* only writes to the phone.
  The *On the server* tab is the one place that waits for the network. It always fetches from
  the server, and when a refresh fails it keeps the last good list visible, marked stale,
  instead of swapping it for an error.
- **Failure is designed.** Each failure path has its own designed state: no signal, server
  unreachable (countdown), refused (Try again / Delete, with an explicit "there is no other
  copy" confirmation), a photo that couldn't be prepared, camera blocked (Open Settings,
  re-checked when you return, no restart), and storage unreadable at boot.
- **Drafts persist.** The description and processed photos are saved as you type, so a
  force-quit mid-compose loses nothing.
- **Limits are visible, not hit.** The counter shows "2 of 5". The gallery picker is limited to
  the remaining slots, and if a picker returns more anyway the app says what it kept. *Save &
  send* stays disabled and lists exactly what's missing.
- **Native feel.** 48 dp hit targets, safe-area insets (edge-to-edge), the footer rises above
  the keyboard, Android back closes compose (keeping the draft), and status changes are
  announced to screen readers.

### Permissions

- **Gallery: none.** Android uses the system Photo Picker and iOS uses PHPicker. Both run
  out-of-process and hand back only what the user picked, so there is nothing to refuse.
- **Camera: requested on first tap.** Denied lets you ask again. "Don't ask again" shows an
  inline card with **Open Settings**. Coming back to the app re-checks the permission and
  enables the camera without a restart. The gallery keeps working throughout.

### Start over (reset)

**Settings → Start over** clears *this phone*: every report (queued, failed, delivered), every
processed photo, the draft, and the picker/resizer temp files. The engine is stopped first:
the in-flight request is aborted and its result discarded, so nothing is written back after
the wipe.

It deliberately **does not** delete anything on the server (once a report has landed, it's the
record) and keeps the server address (configuration, not work). The confirmation lists exactly
what will go, and calls out separately the reports the server doesn't have.

---

## Known gaps (what I knowingly left out)

- **Background delivery on Android is best-effort.** Uploads continue while the process is
  alive, and resume immediately on reconnect or when the app returns to the foreground. But
  Android 14+ freezes cached background apps within seconds, and there is no foreground service
  yet, so a long 2G upload pauses while the app is backgrounded. Nothing is lost, it's just
  slower. This is the first thing I'd do with another day (see below).
- **A reset racing a commit.** If the commit request has already reached the server when you
  reset, the report lands on the server even though the phone has forgotten it. That is
  inherent: you can't un-send. It's rare, and the server copy is complete and valid.
- **No fsync.** Atomic rename protects against a process kill, which is the case this design targets. A
  power loss at exactly the wrong millisecond could still lose the last write.
- **Photos being prepared at the moment of a force-quit** are dropped from the draft. The
  description and already prepared photos survive.
- **Server thumbnails** cached by the image loader survive a reset. They come from the server
  and are not local work.
- **iOS** is configured (usage strings, PHPicker) but was only built and exercised on Android.
- **No auth**, per the brief.

## With another day

1. An Android **foreground service** (`dataSync` type) started while the outbox is non-empty, with
   an ongoing "Sending 2 reports" notification. On iOS, a `BGProcessingTask` plus background
   `URLSession` for chunks.
2. Tests beyond the engine: crash tests for the file-backed outbox and draft (kill between
   every write), the image ladder against real 50 MP originals, and Detox end-to-end tests of
   the main scenario against the fault-injecting backend.
3. A per-report detail view (photos, per-photo progress, error history).
4. Server-side 5 MB enforcement already exists (`413`). I'd add server-side JPEG validation too.
