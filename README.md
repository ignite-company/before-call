# Ignite Co. | Before your call

A noindex follow-up page for people who have already booked. It has no booking, checkout, or payment integration.

## Deployment checklist (Vercel)

1. Set `videoUrl` in `config.mjs` to the final before-call direct HTTPS MP4 URL. Use a URL that supports range requests and doesn't require viewers to sign in. Don't commit signed URLs, credentials, or the old funnel video. A blank URL shows an honest unavailable state and the reward stays locked.
2. In Vercel Project Settings → Environment Variables, set:
   - `WATCH_REWARD_CODE`: the approved discount code. Keep it in Vercel; never in Git or client code.
   - `WATCH_SESSION_SECRET`: a random server-only signing secret, at least 32 characters (for example, generate one with `openssl rand -hex 32`). Do not reuse the reward code.
   - `WATCH_DURATION_SECONDS`: the exact final MP4's duration in seconds, determined independently (for example, with `ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 final.mp4`).

   Restrict production values to production. Use dummy values for testing.
3. Deploy the repository with Vercel's Other preset and no custom build or output override. Verify on both desktop and phone with the actual MP4 and the environment variable set, including a full play and attempted skip.

The server function keeps the value out of public source and browser bundles. The endpoint requires a signed, time-limited session and a wait at least as long as the configured video duration at the maximum supported 2× playback speed. A browser visitor can still call the endpoint directly and wait, or share the code after revealing it. Foreground playback gating is not proof of attention or a security boundary. Do not use this as authorization for payments, account access, single-use offers, or discounts that must be secret from motivated site visitors. Noindex reduces discovery; it is not access control.

## Development

```sh
node --test
python3 -m http.server 8000
```

The Python server previews the static page; reward redemption also requires the Vercel function (or a local mock). For local Vercel development, use only a dummy code. Don't deploy this page to customers with the video unconfigured.

## Current video

The supplied video is 384.600 seconds long (6:24.6). Set `WATCH_DURATION_SECONDS` to `384.600` while this exact source is in use. The source is 3240 × 2160 HEVC with AAC, approximately 1.58 GB, and serves HTTP byte ranges. Its metadata is at the end of the file. Before sending this page to prospects, test on phones; for wider compatibility, use a fast-start H.264/AAC export of the same recording and set the duration from that export.

Playback progress, a short-lived signed watch session, and whether confetti has been shown are saved locally in the viewer’s browser for this video. Progress expires after 14 days; the token also expires after 14 days. Refreshing does not store or expose the discount code, and a missing or expired session must satisfy a replacement server timer before the code can be re-revealed. Clearing site data, switching devices, or blocking local storage prevents recovery.
