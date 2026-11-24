import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^([0-9a-f-]{36})\.([0-9]{10})\.([A-Za-z0-9_-]{43})$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const DAY = 86400000;
const HMAC = (key, purpose, value) => createHmac("sha256",key).update(purpose + "\0" + value).digest("base64url");
const equal = (a,b) => typeof a === "string" && typeof b === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cleanName = x => typeof x === "string" ? Array.from(x.replace(/[\u0000-\u001f\u007f]/g," ").trim()).slice(0,140).join("") : "";
export const enough = x => typeof x === "string" && x.length >= 32;

export function authorized(req, secret) {
  return enough(secret) && equal(req.headers?.authorization, "Bearer " + secret);
}
export function noStore(res) {
  res.setHeader("Cache-Control","no-store, max-age=0");
  res.setHeader("X-Robots-Tag","noindex, nofollow");
  res.setHeader("Referrer-Policy","no-referrer");
}
export function jsonBody(req, max=4096) {
  const headers=req.headers??{};
  if (Number(headers["content-length"]) > max) return null;
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (typeof req.body !== "string" || Buffer.byteLength(req.body) > max) return null;
  try {const parsed=JSON.parse(req.body);return parsed && typeof parsed==="object" && !Array.isArray(parsed) ? parsed : null;} catch { return null; }
}
export function bookingPayload(input, env, now=Date.now()) {
  if (!input || !SAFE_ID.test(env.PREP_CALENDAR_ID??"")) return null;
  const scope=input.appointment??input;
  // Both the connector's native appointment object and a normalized workflow body are supported.
  const appointment=scope.id??scope.appointment_id, calendar=scope.calendarId??scope.calendar_id;
  const status=scope.appointmentStatus??scope.status, location=input.locationId??input.location_id;
  if (typeof appointment!=="string" || !SAFE_ID.test(appointment) || calendar!==env.PREP_CALENDAR_ID || status!=="confirmed" || (env.PREP_LOCATION_ID && location!==env.PREP_LOCATION_ID)) return null;
  const name=cleanName(input.contact_name ?? input.contact?.name ?? scope.contact_name);
  if (!name) return null;
  const time=scope.startTime??scope.start_time;
  let scheduled=null;
  if (time != null && time !== "") {
    if (typeof time!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) return null;
    scheduled=Date.parse(time);
    if (!Number.isFinite(scheduled) || scheduled < now-30*DAY || scheduled > now+365*DAY) return null;
  }
  return {appointment,calendar,name,scheduled:scheduled===null?null:new Date(scheduled).toISOString(),expiry:Math.floor((Math.max(scheduled??now,now)+30*DAY)/1000)};
}
export function createPrepToken(id, expiry, secret) {
  if (!UUID.test(id)||!Number.isSafeInteger(expiry)||!enough(secret)) throw Error("Invalid token settings");
  const body=id+"."+expiry;
  return body+"."+HMAC(secret,"prep-v1",body);
}
export function readPrepToken(token, secret, now=Date.now()) {
  if (!enough(secret)||typeof token!=="string"||token.length>100) return null;
  const m=TOKEN.exec(token);
  if (!m||!UUID.test(m[1])||Number(m[2])*1000<=now||!equal(m[3],HMAC(secret,"prep-v1",m[1]+"."+m[2]))) return null;
  return {id:m[1],expiry:Number(m[2])};
}
export const personalCode = (id,secret) => "IG-" + createHmac("sha256",secret).update("unique-code-v1\0"+id).digest("hex").slice(0,16).toUpperCase();
export const unlockProof = (token,secret) => HMAC(secret,"unlocked-v1",token);
export const validUnlockProof = (proof,token,secret) => equal(proof,unlockProof(token,secret));
export const watchBinding = (token,secret) => token ? HMAC(secret,"watch-binding-v1",token) : "";
export function prepLink(id, expiry, secret) {
  return "https://before-call.vercel.app/#prep="+createPrepToken(id,Number(expiry),secret);
}

export function createStore({env=process.env,fetcher=fetch}={}) {
  const root=(env.PREP_DB_URL||"").replace(/\/$/,""), key=env.PREP_DB_PUBLISHABLE_KEY, privateKey=env.PREP_DB_RPC_SECRET;
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(root)||!enough(key)||!enough(privateKey)) throw Error("Prep storage unavailable");
  async function rpc(name,data) {
    const res=await fetcher(root+"/rest/v1/rpc/before_call_private_gateway",{method:"POST",headers:{apikey:key,"Content-Type":"application/json"},body:JSON.stringify({p_action:name,p_payload:data,p_key:privateKey}),signal:AbortSignal.timeout(4500)});
    if (!res.ok) throw Error("Prep storage request failed: "+res.status);
    return res.json();
  }
  return {
    async book(v) {const result=await rpc("before_call_record_booking",{p_id:randomUUID(),p_appointment:v.appointment,p_calendar:v.calendar,p_name:v.name,p_scheduled:v.scheduled,p_expires:v.expiry});return result?.[0];},
    event(id,kind){return rpc("before_call_record_event",{p_booking:id,p_kind:kind});},
    list(){return rpc("before_call_pending_notifications",{});},
    async lease(token){const rows=await rpc("before_call_lease_notification",{p_lease:token});return rows?.[0];},
    ack(id,lease=null){return rpc("before_call_ack_notification",{p_event:id,p_lease:lease});}
  };
}

export const ownerPayload = (r,env) => ({
  event_id:r.event_id,kind:r.kind,happened_at:r.happened_at,contact_name:r.contact_name,
  appointment_at:r.scheduled_at,...(r.kind==="booked" ? {prep_link:prepLink(r.booking_id,r.expires_epoch,env.PREP_SIGNING_SECRET)} : {})
});
export const validOwnerWebhook = url => typeof url === "string" &&
  /^https:\/\/services\.leadconnectorhq\.com\/hooks\/[A-Za-z0-9_-]+\/webhook-trigger\/[A-Za-z0-9-]+$/.test(url);

export async function deliverOne(store,{env=process.env,fetcher=fetch}={}) {
  // Only the workspace's explicitly configured owner-only HighLevel ingress may receive this.
  const url=env.PREP_OWNER_WEBHOOK_URL;
  if (!url) return "not-configured";
  if (!validOwnerWebhook(url)) return "invalid-config";
  const lease=randomUUID();
  try {
    const item=await store.lease(lease);
    if (!item) return "empty";
    const body=ownerPayload(item,env);
    const response=await fetcher(url,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json","Idempotency-Key":item.event_id},
      body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
    if (!response.ok) return "retry";
    const acked=await store.ack(item.event_id,lease);
    return acked ? "sent" : "retry";
  } catch {return "retry";}
}
