# Decryption sidecar

The collector sends Widevine AAC renditions to this service after its existing download sources fail. The service runs headless Chrome with a pinned Widevine adapter and returns compressed, decrypted audio as M4A. It does not record audio output. The account OAuth token and library filesystem stay in the collector.

| Source                                          | Execution                      |
| ----------------------------------------------- | ------------------------------ |
| Original downloads and progressive audio        | Existing collector downloader  |
| Clear HLS                                       | Existing collector FFmpeg path |
| Identity-key AES-128 and SAMPLE-AES HLS         | Existing collector FFmpeg path |
| Widevine AAC-LC HLS                             | Decryption sidecar             |
| FairPlay/PlayReady without a Widevine rendition | Unsupported                    |

Build and start the service with:

```sh
docker compose build decryption
docker compose up -d decryption
docker build -t soundcloud-collector:latest .
```

The Compose collector configuration sets `SCS_DECRYPTION_SERVICE_URL=http://decryption:8080` and waits for its health check. Recreate the collector when ready to run collection with the new image. Nothing is requeued automatically: tracks already recorded as `drm-unrecoverable` stay that way until you ask for a recovery pass.

After taking a database backup, run the recovery with:

```sh
docker compose run --no-deps soundcloud-collector bun src/index.ts --retry-encrypted
```

It refuses to start unless the service URL is configured and `/health` answers. It then resets encryption skips to the retryable `drm-only` state and runs the normal update cycle for every active artist holding one, so album memberships, sound-change revisions and library finalization behave exactly as in a regular run. API-deleted tracks are rechecked by discovery, not blindly declared available. The usual run summary is printed and pushed at the end.

The service exposes port 8080 only on the Compose network, without a published host port. It needs outbound HTTPS to SoundCloud's CDN and license server. It accepts `POST /decrypt` with `{ "url": "<resolved CDN URL>", "licenseAuthToken": "<resolver token>" }`, and returns `audio/mp4`. `GET /health` reports readiness and whether the sequential worker is busy. Busy jobs return 503, invalid inputs 400, and failed jobs 502 with the worker's error in the body. The collector treats every sidecar failure as a permanent verdict for that track (`drm-unrecoverable`); fix the service and run `--retry-encrypted` again to give those tracks another pass.

Each job owns its request, encrypted input, AAC output, and Chrome profile in a temporary directory. The service terminates the entire job process group and removes that directory on success, failure, disconnect, or timeout. It returns the file only after matching the capture byte count, verifying the duration within 0.1 seconds, and decoding the whole file with FFmpeg. The collector also checks full decoding before accepting the returned file.

The adapter supports Linux amd64, Chrome 151.0.7922.173, and Widevine 4.10.3050.0. Startup checks the CDM SHA-256, not just the version string. Chrome component updates are disabled; upgrades require validating and updating the adapter. Chrome runs with `--no-sandbox` as an unprivileged user inside the container. No privileged container or host process access is required.

Supported manifests are finite AAC-LC media playlists with one init segment and one Widevine key declaration, without byte ranges or discontinuities. The worker accepts arbitrary track IDs and AAC bitrates through resolved URLs; it does not contain a sample track ID or preset. Long jobs have a duration-derived playback timeout and a one-hour overall limit. Unsupported layouts fail explicitly.
