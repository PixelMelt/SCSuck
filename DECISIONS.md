# Architectural Decisions

Binding rulings for this codebase. Auditors and agents: treat entries here as
settled — do not re-raise them. Add a new entry (next number) when a recurring
audit finding gets a final ruling.

## D1 — No logging framework

`console.log`/`warn`/`error` with ` -> ` prefixes is the logging system.
This is a single-user CLI whose output is read in a terminal or cron mail;
structured logging, log levels beyond the `SCS_DEBUG` gate, and logger
injection are out of scope. Do not flag it.

## D2 — Manual constructor wiring, no DI container

`SoundcloudCollector.create()` is the single composition root. The module
count (~14) does not justify a container or factories-of-factories. Do not
flag the wiring style; do flag modules that bypass the composition root.

## D3 — I/O-heavy modules are not unit-tested

Network/DB/ffmpeg modules are exercised by real runs, not mocks. Tests are
reserved for pure logic (naming budgets, title parsing, config parsing).
Missing mock-based tests are not a finding.

## D4 — Sequential processing is a feature

No worker pools, no concurrent downloads, no batching of API calls beyond
what a single listing endpoint returns. Rate-limit avoidance outweighs
throughput. Do not propose parallelism.

## D5 — `withQuietLibLogs` console swap is accepted

The soundcloud.ts fork logs progress straight to `console.log` with no silent
option. Swapping the global during the awaited download and restoring it in
`finally` is the accepted containment: the process is a single sequential
pipeline, so nothing else logs concurrently except signal handlers, and that
trade is fine for a CLI. Fixing the fork is out of scope for this repo. Do
not flag it.

## D6 — What "write-only library" means

Write-only means archived content is never destructively rewritten. Three
removal paths are sanctioned and are NOT violations: (a) retiring a
stream-sourced copy after its download-upgrade replacement is persisted,
(b) failure-path cleanup of files the current run created, (c) artist rename
migration (directory rename/merge, DB path update, artist-tag rewrite) —
renames keep the library matching one artist identity and are documented in
the README. Do not propose an append-only commit boundary that removes these.

## D7 — Sound-change state is acknowledged at detection time

`detectSoundChange` writes the new waveform/duration before the revision
downloads, so a permanently failing revision cannot re-queue every run. The
trade (a transiently failed revision is not retried) is accepted for this
archive. Do not flag the ordering.

## D8 — configLoader stays a spec-driven loader with a final cast

The spec literal is compile-checked against `Config` via `satisfies`;
runtime validation is limited to required-variable presence and rejecting
non-numeric integer values. The final `as unknown as Config` on the
materialized object is accepted — per-entry parser/validator typing is more
machinery than this config surface warrants. Do not re-flag.

## D9 — Quality-probe fallbacks are archival-by-design

When ffprobe cannot report bit depth / sample rate / bitrate, defaults are
substituted and the download proceeds: an imperfectly-labeled file beats no
file in an archive. Folder-name quality tags are cosmetic (README). Do not
propose failing the preparation on probe gaps.

## D10 — `FileOrganizer.organize*` is the release-commit boundary

Naming policy (pure helpers), byte budgeting, the move into the library, and
release-local artwork (cover.jpg / folder.jpg / banner) belong together in
organizeSingle/organizeAlbum: they are one transaction-ish "materialize this
release" step with shared failure cleanup. `ArtworkManager` owns ongoing
image *revision* policy, not initial release artwork. Do not split
FileOrganizer further.

## D11 — Metadata-write failure does not fail the track

Once the audio file is in the library and its DB row is written, a tagging
failure is a warning, not a job failure: the audio is the artifact of record,
and deleting or re-downloading it because taglib choked on a container would
be anti-archival (same spirit as D9). Do not make metadata completion a
commit condition. The same applies to per-file tag rewrites during artist
renames: individual file failures are logged and do not block the rename
commit (one corrupt file must not re-trigger the whole migration forever).

## D12 — `utils.ts` stays one shared leaf-helper module

At ~100 lines it holds format constants, byte budgeting, path resolution,
track identity and date stamps — all dependency-free leaf helpers. Splitting
it into audio/filesystem/identity/path modules adds import churn without
ownership gains at this scale. Revisit only if one concern grows past ~50
lines; until then, do not propose splitting it.

## D13 — `coverArtProcessor.ts` is one acquisition pipeline

SoundCloud CDN size-variant policy, the concurrent variant fetch, and the
save-to-disk step only ever change together — the size identifiers ARE
soundcloud specifics, so there is no "generic image downloader" hiding in
here. Do not propose splitting URL policy from fetching/persistence.

## D14 — Error-string skip classification stays

`permanentSkipReason` (matching "Could not get stream link" etc.) exists
because some undownloadable tracks are only detectable at download time —
they would otherwise fail every run forever (shipped intent, commit
395218f). The skip state is self-healing: it is retried when downloads get
enabled and cleared by any successful download. Do not propose removing the
error-message classifier in favor of `isDrmOnly` alone.

## D15 — `formatDateStamp` falls back to today by design

API dates are untrusted; when `last_modified` is missing or malformed, a
revision still must be archived, and stamping it with today's date is the
sane archival behavior. Do not propose throwing on unparseable dates.

## D16 — `SoundcloudCollector` stays one application facade

index.ts owns the process/CLI surface; collector.ts owns composition plus
the application operations the CLI dispatches to. At ~500 lines that is one
coherent facade — extracting `MonitoredArtistService` / `CollectionRunner`
style classes adds hops and constructor plumbing without moving any real
ownership boundary (the operations already share the same collaborators).
Do not propose further service extraction unless the facade grows well past
this size.

## D17 — `EnrichedTrack`'s optional revision/upgrade markers are accepted

`revisionDate`/`revisionOf`/`upgradeOf` as independent optionals technically
permit contradictory combinations, but only discovery constructs these
objects and it never produces them. Restructuring into a discriminated
action union would re-plumb discovery, processing, organization, identity
and metadata for no observed defect. Do not propose the union.

## D18 — Encrypted-HLS downloads and the two skip reasons

Encrypted HLS (`cbc/ctr-encrypted-hls`) is downloaded by ffmpeg straight
from the signed manifest, which carries its own `EXT-X-KEY` key URI — there
is no custom crypto and no key extraction to maintain. Manifest key methods
AES-128 and SAMPLE-AES are both handed to ffmpeg, and a 60-second decode
probe verifies the encryption actually lifted before the file enters the
pipeline — ffprobe metadata alone cannot detect still-encrypted SAMPLE-AES
samples, since the container stays readable. For SAMPLE-AES fMP4 (cbcs) the
downloader assembles init+segments itself and decrypts via the MOV demuxer's
`-decryption_key` — ffmpeg's HLS demuxer never forwards EXT-X-KEY to the MOV
sub-demuxer, so do not "simplify" this back to a plain playlist fetch.
Manifests whose key lines use license-server delivery — `skd://` (FairPlay),
cenc PSSH (Widevine) or PlayReady data URIs — are recorded
'drm-unrecoverable' on sight: license responses are wrapped to CDM device
keys, so any client-side implementation requires extracted device key
material. That is the ruled boundary of this tool — do not propose CDM,
license-server, or keybox workarounds. `skip_reason` has two
states: `'drm-only'` rows predate this capability and are re-queued once;
`'drm-unrecoverable'` means the track failed even the encrypted path
(gated/gone/unsupported key method) and is never retried. Any successful
download clears the skip. Processing tries the advertised legacy stream
first and falls back to encrypted HLS when that fails and encrypted
transcodings exist (SoundCloud lists dead progressive transcodings that 404
at resolution — liveness is only knowable at resolution), so
'drm-unrecoverable' is only recorded once every available path has failed.
Migration 5 re-queued the first-generation rows classified before that
fallback existed. The re-queue converges — success clears, permanent
failure upgrades the reason, transient failure retries — so do not flag it
as a retry loop, and do not re-add a discovery-time pre-skip for
encrypted-only tracks.

## D19 — Stream resolve needs the browser auth shape; clear HLS beats encrypted

Resolving a transcoding URL requires the `Authorization: OAuth` header and,
when the track object carries one, its `track_authorization` JWT (gated
uploads mint it on authed track fetches). The fork's `getStreamLink` omits
`track_authorization`, so `hlsStreams.ts` (formerly `encryptedHls.ts`)
resolves via the fork's `api.getURL` with the JWT as an extra param. That path
keeps the API client's `client_id`, OAuth query/header and proxy behavior
together; a bare `fetch` without the full auth shape gets intermittent 401s
under load. A resolve 404 is only a valid tombstone verdict under this full
auth shape — re-verified against a label upload whose clear
variants 404 and whose encrypted variants license-gate even with header +
JWT, so D18's boundary stands. The download
fallback chain is progressive/original (fork) → clear `hls` (unencrypted
fMP4/mp3, preferred over encrypted — some uploads offer only it) → encrypted
`cbc/ctr`; this amends D18's two-step fallback description. `audio/mpegurl`
(abr) transcodings are master playlists and are never selected. Migration 8
re-queued rows buried before the clear-hls step existed.

## D20 — Deterministic release paths, and moves that overwrite

A release's final path is a pure function of artist, title, year, format,
quality and id. Two consequences are intended, not bugs: (a) a download
upgrade whose original file has the same quality tag as the stream rip lands
on the same path, so the move IS the retirement (`retireUpgradedFile`'s
`oldAbs === newFinalPath` early return exists for exactly this), and (b) a
re-download after a failed run overwrites the orphan it left behind, which is
how the library self-heals. Do not propose exclusive-create moves, collision
failures, or path uniquifiers — they would break the upgrade path and turn
self-healing into permanent breakage.

## D21 — A failed database write never deletes the archived file

When the audio is in the library and `addTrack` then fails, the file stays.
The audio is the artifact of record (same principle as D11), the path is
deterministic (D20), and the next run re-downloads and persists over it. The
alternative — deleting a good archived file because postgres hiccuped — is
the one outcome an archiver must never produce. Do not propose rollback of
run-created audio on persistence failure.

## D22 — Migration 2 is frozen as it stands

Migration 2 was amended once, before this rule existed; migration 3 exists to
heal the databases that recorded the pre-amendment version. Rewriting
migration 2 back to its "original" body would be a second edit to a shipped
migration and would strand every database that has already recorded id 2.
The catalog is append-only going forward. Do not propose editing migrations
1-8.

## D23 — Direct commands fail loudly; the refresh cycle contains per-artist errors

`--artist`, `--delete` and `--following` propagate their failures so the CLI
exits non-zero. The update cycle does not: a per-artist discovery or download
failure is expected operation (transient API/network), it is reported in the
run summary, and `last_checked` is deliberately not advanced so the artist is
retried next run. `run()` contains onboarding failures for configured
artists/followers for the same reason. Do not propose throwing an aggregate
error from `refresh` — it would exit non-zero on ordinary transient failures
and fire a fatal push on top of the summary that already reported them.

## D24 — FLAC conversion failure keeps the lossless original

When ffmpeg cannot transcode a lossless source to FLAC, the preparation
continues with the original WAV/AIFF. The content is lossless either way;
only the container is inconsistent with the rest of the library. Failing the
download over a container conversion is anti-archival (same family as D9).
Do not propose making FLAC conversion a preparation success condition.

## D25 — Backup failure never aborts a collection run

`runBackupIfDue` logs and continues. A missing `pg_dump`, a full disk or an
unreachable socket must not stop the archiving the run exists to do; the
error is printed every run until fixed, and `SCS_BACKUP_INTERVAL=0` disables
the attempt entirely. Do not propose propagating the backup error.

## D26 — Rename path rewriting stays a bulk prefix update

`updateArtistTrackPathPrefix` rewrites the artist-directory segment for every
row of the artist in one statement. The pattern is
`^(<libraryRoot>/)?<oldDir>/` — the optional root group migrates legacy
absolute rows while leaving rows outside this library alone — and the
replacement is `\1<newDir>/`. Verified against postgres 16: a non-participating
group substitutes empty, and in a `regexp_replace` replacement a bare `&` is
already literal while `\&` means the whole match, so escaping `&` is a bug,
not a safety measure. `artistDirName` runs every name through
sanitize-filename, which strips the one real metacharacter (`\`). The update
is unconditional — rows must name the directory future downloads will use
even when neither directory is present on disk. Merge conflicts (a same-named file already
in the destination) leave the old file in place but still repoint the row:
the destination holds the same release, so the row points at a real file and
the leftover is a duplicate. A row-aware migration that stats each file and
aborts the identity commit on collision adds a per-row filesystem pass to
protect against duplicates the library already tolerates. Do not propose it.

## D27 — Artwork revision filenames are date + URL tag

Revision images are named `<prefix>-<YYYY-MM-DD>-<sha1(url)[0:8]>.jpg`. The
URL tag is what makes them non-destructive: a second change on the same day
becomes its own file instead of overwriting the first, and a retry of the
same URL rewrites the same bytes. Do not propose dropping the tag back to
date-only, and do not propose exclusive-create — the deterministic name
already makes retries idempotent.

## D28 — `soundcloud.ts` stays pinned to the solver-free fork revision

The dependency is pinned to PixelMelt/soundcloud.ts commit `ef5b287`: it is the
last revision before the DataDome solver binary, cookie state, TLS-session
hooks and proactive/reactive solve paths entered the fork. Moebits master is
not a drop-in replacement: it lacks `users.albums`, the pure-numeric resolver
fix required by D56, and the download availability, redirect, error and
filename handling used by `TrackProcessor`. The pinned revision retains those
features and sets the static Authorization header in the API constructor.
Do not advance the fork past this commit or switch to Moebits until those
application dependencies have moved behind SCSuck-owned boundaries.

## D29 — `AudioQuality` is a single probe report, not two sources of truth

`isLossless` is produced in exactly one place (`getAudioQuality`, as
`isLosslessFormat(fileExt)`) and travels with the `fileExt` it was derived
from, so an "MP3 marked lossless" state has no producer. The unused arm
(`bitRate: 0` when lossless, bit depth/sample rate when lossy) is the shape a
probe report naturally has. Splitting it into a discriminated union re-plumbs
trackProcessor, fileOrganizer's naming policy, the `SinglePrep` boundary and
the tested `formatFolderName` signature for a contradiction that cannot
occur — the same trade D17 already refused. Do not propose the union.

## D30 — An empty listing for an artist with archived tracks fails the cycle

When the API returns 0 tracks for an artist whose rows include archived
tracks, discovery skips deletion detection (a mass delete is far less likely
than an API glitch) AND records `result.error`, so `last_checked` does not
advance and the artist is re-discovered on the next run instead of being
skipped as fresh for the discovery interval. The trade is accepted: for a
glitch this is exactly the retry we want, and for a genuine full-catalog
deletion the recurring summary error is the signal that the artist needs a
human decision — the tracks were never auto-flagged in that case anyway. Do
not propose silently treating the empty listing as a completed cycle.

## D31 — `tracks.downloadable` has one meaning: the flag we have acted on

The column is not three overlapping states. It records the API's downloadable
flag as of the last time this archive acted on it — which is exactly why
`existing.downloadable === false` implies the stored file is stream-sourced,
and why acknowledging `true` after an unrecoverable upgrade correctly stops
the re-queue (we have now acted on that flag; there is nothing further to
try). Discovery checks `detectDownloadUpgrade` before `detectSoundChange`, so
`updateTrackSoundState` can never quietly consume a false→true transition.
Adding `archive_source` / `upgrade_status` columns would split a state whose
only consumer is the upgrade trigger. Do not propose the migration.

## D32 — An upgrade job never falls back to a stream

`downloadViaStreams` returns failure for a job carrying `upgradeOf` when the
original-file download fails, instead of trying clear/encrypted HLS. The
whole point of an upgrade is replacing a stream rip with the original; an HLS
fallback would retire the archived copy (D6) in exchange for another stream
and report it as `upgraded`, and the persisted `downloadable: true` would
then prevent the real upgrade from ever being retried. Failure converges the
same way every other unrecoverable preparation does (D31): permanent failures
acknowledge the flag, transient ones retry next run. Do not reintroduce the
fallback for upgrades, and do not add a `DownloadSource` field to
`PreparationResult` to police it after the fact — the only path that could
produce a mislabeled upgrade is the one now closed.

## D33 — Revision identity is date-grained, and that is the shipped design

`buildTrackKey` appends `-r<YYYY-MM-DD>` and `displayTitle` appends the same
date, so two sound-file changes to one track within a single UTC day share an
identity and only the first is archived. AGENTS.md pins track identity to
`track_key`; adding a waveform or `last_modified` discriminator would change
that identity format, the on-disk release names derived from it, and every
existing row's relationship to both. The gap is the same accepted class as
D7 (a revision that is detected but not archived) and D15 (dates are this
feature's granularity). Do not propose a finer-grained revision key.

## D34 — Cleanup removes only what the current attempt created

Release paths are deterministic (D20), so a destination can already hold an
upgrade target or an orphan from an earlier failed run. `organizeSingle` and
`organizeAlbum` therefore record whether the destination existed *before* the
move and clean only paths this attempt brought into existence; `moveFile`
stages a cross-device copy beside the destination and renames over it, so a
failed copy can never truncate an archived file; `saveImage` stages the same
way; and `processSingleTrackJob` never deletes audio that `organizeSingle`
has committed (D21). Do not propose reverting to unconditional
`cleanupFile(finalPath)` on the failure paths, and do not propose a rollback
that removes a destination the attempt did not create.

## D35 — The `[id]` suffix is immutable during folder-name budgeting

`formatFolderName` shrinks only the "<artist> - <title>" head; the
" (year) [WEB-EXT] [quality] [id]" suffix is never truncated, because `[id]`
is the only thing keeping two releases of the same artist apart — a
suffix-truncating branch let two ids collapse to one folder and overwrite each
other. A budget too small to hold the suffix throws rather than inventing a
colliding name. Do not reintroduce a "truncate the suffix in extreme cases"
fallback.

## D36 — `last_modified` and `downloaded_at` are record-keeping columns

Neither is read by any code path: revision dating uses the API's
`track.last_modified` directly, and nothing queries `downloaded_at`. They are
kept because this database is also a hand-queryable archive record, and a
maintained column beats a stale one. What matters is that they are *truthful*:
`downloaded_at` is set on every successful `addTrack` and is NULL on rows that
only record a skip (migration 9 healed the pre-existing rows). `last_modified`
travels with waveform/duration as one "observed API state" snapshot so the
acknowledgement in `detectSoundChange` is auditable. Do not propose deleting
either column's writes for being unread, and do not propose consuming them.

## D37 — Artist rows outlive their SoundCloud accounts

`getActiveArtistByRef` is for refresh resolution — a known-dead artist should
not be re-discovered. Removal uses the unfiltered `getArtistByRef`, because a
404 is exactly what marked the artist inactive and `--delete` has to reach
that row. The two lookups are deliberately distinct; do not collapse them into
one method or an `activeOnly` flag.

## D38 — Tracks with no transcodings are passed over, not skip-recorded

Discovery's `if (!track.media || track.media.transcodings.length === 0) continue;`
is deliberate and is NOT a silent swallow. SoundCloud offers no audio for such
a track *yet* — transcoding can finish later, and a track that gains
transcodings is picked up on the very next run at no cost. Routing these
through `TrackProcessor` so they earn a `drm-unrecoverable` row would spend a
rate-limited download attempt each to reach a foregone conclusion and then
bury them permanently, which is strictly worse than the self-healing pass-over.
Do not propose removing the gate.

## D39 — Release-local artwork failure never fails the release

`cover.jpg` / `folder.jpg` / banners are saved best-effort inside
`organizeSingle`/`organizeAlbum`; a failure warns and the track still commits.
Failing an audio download because a CDN image blipped is the same anti-archival
trade D9 and D11 already rejected. The follow-on — that `ArtworkManager` then
sees matching URLs and never backfills the missing file — is accepted rather
than fixed with a per-track `pathExists` on every discovery run for every
archived track; the images are cosmetic and the README says so. Do not propose
throwing on release-artwork failure, and do not propose a per-run existence
sweep to restore them.

## D40 — Upgrade retirement stays best-effort cleanup

`retireUpgradedFile` uses `cleanupFile`, so a non-ENOENT unlink failure warns
and the run continues. The failure direction is a stale extra file in a
write-only library (D6) — never a lost one. A pending-retirement column, its
migration, and a drain pass on later runs is a durable-queue's worth of
machinery to eventually delete a leftover. Do not propose it.

## D41 — Permanence is a property of the whole fallback chain

`downloadViaStreams` → clear HLS → encrypted HLS threads a `sawRetryable` flag,
and `drm-unrecoverable` is recorded only when every path that existed for the
track failed permanently. Without it a transient progressive outage followed by
a permanent encrypted verdict buried a downloadable track forever. Do not
simplify the flag away by classifying on the last attempt alone.

## D42 — `requiresEncryptedHls`'s empty-transcoding branch stays

`if (transcodings.length === 0) return false;` is unreachable from the shipped
path because discovery's gate (D38) filters those tracks first, but it is not a
defensive guard against malformed data — it is the correct answer for an empty
set. Removing it hands the question to `[].every()`, whose vacuous truth would
report a track with no streams at all as "encrypted-only". Keep it.

## D43 — Shutdown is cooperative and owned by `main`'s `finally`

The signal handler does no async work: it raises a flag, calls
`collector.requestStop()` (which aborts the shared `AbortController`), and
returns. The sequential loops — artists in `runUpdateCycle`, jobs in
`processQueue` — check the signal at their boundaries, so an interrupted run
stops between units of work rather than having its temp files deleted and its
database closed underneath an in-flight download. `main`'s `finally` is the
only caller of `shutdown()`, and a second signal exits immediately with 130.
Do not move teardown back into the handler, and do not add `process.exit()`
to the first-signal path.

## D44 — Album directory reuse is learned from archived rows, never reconstructed

`existingTrackPath` comes from a map filled while iterating the canonical
`users.tracks` listing, where each track's `track_key` and archived row are
already in hand. The album payload's embedded `tracks[]` entries are partial
copies; rebuilding identity from them meant guessing at `user_id`, and a wrong
guess misses the archived row and splits the album across two directories. Do
not reintroduce a `buildTrackKey` call over `albumContext.tracks`.

## D45 — Per-file temp cleanup failures warn; the sweep does not fail the run

The temp directory is scratch: every download path writes deterministic names
and overwrites, so a file that resists deletion costs disk, not correctness,
and the next sweep retries it. An unreadable temp *directory* still throws —
that is a broken workspace. The "Cleaned up N files" line counts actual
removals, not listed entries. Do not propose throwing on individual unlink
failures.

## D46 — The HLS downloaders own variant selection

`downloadClearHls`/`downloadEncryptedHls` each select their own transcoding,
even though `TrackProcessor` calls the same selector first to decide whether
to attempt that path. The precheck answers "is this path available?", the
selector inside answers "which variant?" — the duplicate call is a pure
function over data already in memory, and keeping selection inside the
downloader is what lets the scripts in `scripts/` drive them with only a
track. Do not propose threading a pre-selected `SoundcloudTranscoding` through
the download signatures.

## D47 — `MediaPlaylist` lives in types.ts; `displayTitle` takes a `Pick`

`parseMediaPlaylist` is exported and exercised by `tests/hlsStreams.test.ts`,
so its return type is part of a contract that leaves the module and belongs in
`types.ts` — do not move it back into `hlsStreams.ts` (it has been proposed in
both directions). `displayTitle`'s parameter is the opposite case: it is a
narrowing of a type that already exists, expressed as
`Pick<EnrichedTrack, 'title' | 'revisionDate'>` rather than a new shared
interface. Neither needs revisiting.

## D48 — Empty release names fall back to permalink, then id

`saniTitle` and the album-title path substitute the permalink, then
`track-<id>` / `album-<id>`, when the sanitized title is empty. This is shipped
intent from commit 7d4e22a ("Never create extensionless or title-less files"),
which fixed real `01. .` files produced by glyph-only and whitespace titles.
Throwing instead would refuse to archive a track that SoundCloud is perfectly
willing to serve, purely because its name does not survive sanitization — the
same anti-archival trade as D9. The regression test in
`tests/fileOrganizer.test.ts` pins it. Do not propose failing on unusable
titles.

## D49 — `track.user_id` and `track.user.id` are not reconciled

Track identity and the DB owner column use `track.user_id`; the artist
directory uses `track.user.id`/`track.user.username`. Both come from the same
`users.tracks(artist.id)` payload for the same artist, so they agree. Rewriting
`EnrichedTrack`'s ownership fields from the resolved artist to force the
invariant re-plumbs identity construction for a divergence that has never been
observed — the same trade D17 refused. Do not propose the normalization.

## D50 — Container probing improves a label; it never gates the archive

`detectExtension` returns null when ffprobe fails, and preparation continues
with the filename's own extension. The probe exists to catch *mislabeled*
downloads (a WAV served as .mp3), not to certify the audio: refusing to archive
a file because ffprobe was unavailable or did not recognize an exotic container
is the same anti-archival trade D9 already rejected. The one case that does
throw is a download with no extension AND no successful probe, because there is
then no label at all. Do not propose making a successful probe mandatory.

## D51 — A missing temp directory at cleanup time is not an error

`cleanupTempFiles` tolerates ENOENT on the directory itself and throws on any
other read failure. A missing scratch directory means there is nothing to
clean — the desired end state — and `shutdown()` calls this from a `finally`,
where throwing would replace the real error the run is already reporting. Per
file, an unlink failure warns and the sweep continues (D45). Do not propose
removing the ENOENT tolerance.

## D52 — The per-job catch in `processQueue` is a kept backstop

`processSingleTrackJob` and `processAlbumJob` are written to contain every
failure and return stats, so the `try/catch` around them in the queue loop does
not fire today. It stays anyway: it is not a null guard, it is the boundary
that keeps one unexpected throw from abandoning every remaining job in a
sequential run, and the handlers it protects have grown new throw sites more
than once. Do not propose removing it as dead code.

## D53 — `rowCount` is asserted, not guarded

`updateArtistTrackPathPrefix` returns `rowCount!`. pg types the field nullable
because `QueryResult` also models commands without an affected-row count; a
plain `UPDATE` always supplies one, including zero. Both a `?? 0` fallback
(which would silently report "0 paths migrated") and a runtime throw (dead
code) have been proposed here — the assertion is the settled answer.

## D54 — Proxy configuration is validated, not best-guessed

`buildProxyUrl` rejects every SCS_PROXY_* combination that would silently drop
something the user set: a full URL in `SCS_PROXY_HOST` alongside
port/username/password, one credential without its pair, and any component
without a host. Credentials are applied through `URL` so reserved characters
are encoded. The previous shape quietly ignored the extra fields, which is the
worst outcome for a setting whose failure mode is "requests leave from the
wrong address". `tests/proxyUrl.test.ts` pins the combinations. Do not
re-introduce silent precedence between the URL and component forms.

## D55 — Discovery flushes accumulated album jobs on the failure path too

Album jobs are batched in a map during the track loop and materialized by
`flushAlbumJobs()`, which runs in both the success path and the catch. This is
required by D7: `detectSoundChange` acknowledges the new waveform at detection
time, so an album revision that was detected and then dropped by a later
mid-loop failure would never be detected again. Do not move the album
materialization back inside the try's happy path only.

## D56 — Artist references reach the API as typed; only DB lookups are normalized

`soundcloud.ts`'s `Resolve.get` treats `^\d+$` as a user id and resolves
anything containing "soundcloud" as a URL. Stripping a URL down to its tail
before the API call is therefore what let `--artist
https://soundcloud.com/123456` resolve an all-digit *permalink* as a user
*id* and touch the wrong artist. The API now receives the reference exactly as
typed; `normalizeArtistRef` survives only for DB lookups, which need the tail.

The database's `permalink = $1 OR id::text = $1` namespace can still match two
different artists for an all-digit reference, so both `*ByRef` queries order by
`(id::text = $1) DESC LIMIT 1` — the id interpretation wins, matching what the
fork does with the same bare token, and the result is at least deterministic
(verified against postgres 16). What remains is inherent: a bare `123456`
typed at the CLI cannot be known to mean a permalink rather than an id. Do not
propose a tagged reference type to close that last gap — the ambiguity is in
the input, not the code.

## D57 — Onboarding defers artwork when a rename has not been committed

`addResolvedArtist` records the alias on every path (a committed artist row is
not proof that onboarding finished), but processes images only when the artist
is new or its stored username already matches the API. Writing images under the
API's new name while the DB still holds the old one would create the new artist
directory before discovery migrates the audio into it, stranding the old one
behind an `artist.jpg` collision. Discovery owns renames (D6). Do not make the
image pass unconditional again.

## D58 — `cli.ts` owns the command surface; `index.ts` owns the process

Argument parsing, the alias table, arity rules and `HELP_TEXT` live in
`cli.ts`, and `parseCommand` runs *before* `SoundcloudCollector.create()` so a
malformed command costs no database connection. `index.ts` keeps only the
process lifecycle: signals, the fatal handler, shutdown. The split is what
makes the parser testable (`tests/cli.test.ts`) without executing `main()`.
Do not fold the parser back into `index.ts`.

## D59 — Widevine AAC decryption runs in a separate container

The user requested production integration after the standalone encrypted-only
decryption proof. This supersedes D18's prohibition on a CDM download path.
Original/progressive, clear HLS, and identity-key HLS remain in the collector.
When configured, the Widevine sidecar receives only the resolved CDN URL and
license authorization token and returns a fully decode-validated M4A. Account
credentials, database state, and library paths remain owned by the collector.

The sidecar runs one job at a time in a temporary Chrome process group. Chrome
and the Widevine binary are pinned to the tested adapter; startup rejects a
different CDM hash. The supported DRM surface is finite, single-init Widevine
AAC-LC HLS without byte ranges or discontinuities. FairPlay/PlayReady-only
renditions remain unsupported.

The sidecar is consulted at most once per track. `downloadEncryptedHls` walks
the encrypted renditions (the sidecar-capable `ctr` protocol first when a
service is configured) and the first one whose manifest carries a Widevine key
is handed off; the sidecar's answer is the verdict for the whole encrypted path.
Every sidecar-path failure — unreachable, non-2xx, undecodable output — is
`permanent`, so the track records `drm-unrecoverable` (D41's `sawRetryable`
still applies when an earlier stream in the chain failed transiently). The
alternative, a retryable verdict, made a `drm-only` row that keeps failing get
re-queued by discovery every run, each attempt costing a headless-Chrome
launch, and never converge. Renditions the sidecar did not see keep the AND
rule for permanence.

Recovery is explicit and never blanket. There is no migration that flips DRM
rows for the sidecar generation: a database without a sidecar keeps its skips,
and a misconfigured sidecar re-buries them in one pass instead of re-queueing
them forever. `--retry-encrypted` refuses to start without a configured,
healthy service, then flips `drm-unrecoverable` back to `drm-only` and runs
the ordinary per-artist update cycle (`updateArtist`) for every active artist
that holds such rows. It does not filter the queue to those keys: discovery
acknowledges sound changes at detection time (D7), so a revision job dropped
by a filter would be lost, and the unfiltered cycle is what the next run would
do for those artists anyway. Do not reintroduce a startup requeue migration or
a key-filtered recovery queue.

Pure manifest parsing (`parseMediaPlaylist`, key-method and license-delivery
classification) lives in `hlsPlaylist.ts`, which imports nothing but types, so
the sidecar image copies it and `types.ts` without the collector's dependency
tree. `hlsStreams.ts` keeps resolution, ffmpeg and the download chain.
