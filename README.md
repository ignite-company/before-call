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

## Appointment-specific prep links (optional)

The public booking redirect and existing confirmation email are independent of this feature. Leave them unchanged. The generic video and reward still work if no private prep link is present. This feature sends no email or message to a prospect; the owner can copy and manually resend the same link.

**Provision only after confirming the exact calendar, workspace, owner recipient, and no-other-recipient action.** Booking intake uses `POST /api/prep-booking`, with a high-entropy bearer secret and a confirmed event filtered to the exact calendar. Its normalized shape is:

```json
{
  "appointment_id": "<verified HighLevel appointment ID>",
  "calendar_id": "<approved calendar ID>",
  "location_id": "<approved location ID>",
  "status": "confirmed",
  "contact_name": "<verified appointment contact's display name>",
  "start_time": "<ISO-8601 appointment start>"
}
```

Leave `start_time` out when the trigger exposes only a formatted local date. Supply it only when it includes an explicit UTC offset. With no exact time the link remains reusable for 30 days from intake.

The existing public completion event contains no appointment ID and must never be used as identity. Do not join on name, phone, email, or the widget fingerprint. An authenticated repeat of the same verified appointment returns the existing link, not a second alert. The fragment contains no prospect data or raw appointment ID. It is a bearer link: anyone who receives it can use it, so the alerts say activity on that booking's link, not identity of the actual viewer. The link expires 30 days after the later of booking intake or the scheduled appointment. A same-ID reschedule leaves the link stable within that window; replacing/canceling bookings is not yet an enabled integration.

- The SQL in `supabase/before-call-prep.sql` (then `supabase/before-call-optional-appointment-time.sql`) adds isolated RLS tables and a fixed, server-only authenticated gateway. It initially has **no credential configured**. In an approved database, add one `public.before_call_private_config` row with the SHA-256 hex **digest** of a securely generated, dedicated RPC secret. Never store or reveal the raw secret in SQL, Git, chat or logs. The Data API uses only a publishable key plus this scoped credential. Never reuse a CRM service-role key.
- Production Vercel settings: `PREP_DB_URL`, `PREP_DB_PUBLISHABLE_KEY`, `PREP_DB_RPC_SECRET`, `PREP_SIGNING_SECRET`, `PREP_BOOKING_SECRET`, `PREP_OWNER_SECRET`, `PREP_CALENDAR_ID`, and `PREP_LOCATION_ID`. Keep secrets server-only and distinct. Optional `PREP_OWNER_WEBHOOK_URL` must be a verified private owner-only HighLevel inbound webhook.
- Each booking has one durable record and one outbox record per event: booked, intentionally started playing, reward revealed. Initial muted preview, failure to play, raw clicks and SMS composer openings do not announce events. A proprietary code is stable per valid link, after the original watch gate. Code generation does not configure checkout restrictions or create a third-party coupon.
- Booking alert alone contains the reusable link. Started and unlocked alerts contain just the booking's display name and event metadata. Only owner workflows can poll `POST /api/prep-owner` with `{ "action": "pending" }` and acknowledge with `{ "action": "ack", "event_id": "..." }`, using their separate bearer secret. In webhook mode, single leases prevent concurrent delivery; use a real retry driver for `{ "action": "dispatch" }` and make downstream handling idempotent by event ID. The HTTP idempotency header is a hint, not proof a third-party workflow dedupes. Do not run a second delivery consumer alongside webhook mode.
- Prior to activation, verify intake auth/scope, owner notification and recipient, failure/retry, duplicate events, same-link resend, and that the normal booking experience is unaffected. Do not register a real test lead, create a booking, or message a prospect for testing.
