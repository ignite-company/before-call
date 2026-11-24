import test from "node:test";
import assert from "node:assert/strict";
import { createBookingHandler } from "../api/prep-booking.mjs";
import { createOwnerHandler } from "../api/prep-owner.mjs";
import { createEventHandler } from "../api/prep-event.mjs";
import { createHandler } from "../api/reward.mjs";
import { deliverOne, readPrepToken } from "../lib/prep.mjs";

const ids=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","cccccccc-cccc-4ccc-8ccc-cccccccccccc","dddddddd-dddd-4ddd-8ddd-dddddddddddd"];
const env={PREP_CALENDAR_ID:"expected",PREP_LOCATION_ID:"location-test",PREP_SIGNING_SECRET:"fixture-prep-signing-key-32-or-more-",PREP_BOOKING_SECRET:"fixture-booking-auth-key-32-or-more-",PREP_OWNER_SECRET:"fixture-owner-access-key-32-or-more-",WATCH_REWARD_CODE:"ordinary-code",WATCH_SESSION_SECRET:"fixture-signed-watch-secret-32-or-more-",WATCH_DURATION_SECONDS:"10"};
const now=1700000000000;
function build() {
 let clock=now;
 const map=new Map(), events=new Map();
 const at=()=>clock;
 const storage={
  async book(v){
   if(!map.has(v.appointment))map.set(v.appointment,{id:ids[map.size],entry:v,expires_epoch:v.expiry});
   const row=map.get(v.appointment);await storage.event(row.id,"booked");return row;
  },
  async event(id,kind){
   const info=[...map.values()].find(r=>r.id===id);assert(info);
   const k=id+"."+kind;if(events.has(k)) return false;
   events.set(k,{event_id:ids[events.size%ids.length],booking_id:id,kind,contact_name:info.entry.name,scheduled_at:info.entry.scheduled,expires_epoch:info.expires_epoch,happened_at:new Date(clock).toISOString()});return true;
  },
  async list(){return [...events.values()];}
 };
 return {storage,at,advance:ms=>clock+=ms,booking:createBookingHandler({env,now:at,storage}),ev:createEventHandler({env,now:at,storage}),owner:createOwnerHandler({env,storage}),reward:createHandler({env,now:at})};
}
const booking=(id="appointment-A")=>({appointment_id:id,calendar_id:"expected",location_id:"location-test",status:"confirmed",contact_name:"Fixture Person",start_time:new Date(now+86400000).toISOString()});
async function call(handler,body,auth){
 let status,json;
 await handler({method:"POST",body,headers:auth?{authorization:"Bearer "+auth}:{}},{setHeader(){},status(n){status=n;return this},json(v){json=v;return this}});
 return {status,json};
}
function token(link){return new URLSearchParams(new URL(link).hash.slice(1)).get("prep")}
test("exact-calendar confirmed webhook requires auth and duplicate booking returns the same private URL",async()=>{
 const f=build();assert.equal((await call(f.booking,booking())).status,401);
 for(const changed of [{calendar_id:"wrong"},{location_id:"wrong"},{status:"pending"},{contact_name:""}]){
  assert.equal((await call(f.booking,{...booking(),...changed},env.PREP_BOOKING_SECRET)).status,400);
 }
 const a=(await call(f.booking,booking(),env.PREP_BOOKING_SECRET)).json.link;
 const b=(await call(f.booking,booking(),env.PREP_BOOKING_SECRET)).json.link;
 assert.equal(a,b);assert(!a.includes("appointment-A"));assert(!a.includes("Fixture"));assert.equal(readPrepToken(token(a),env.PREP_SIGNING_SECRET,now).id,ids[0]);
 const list=await call(f.owner,{action:"pending"},env.PREP_OWNER_SECRET);assert.equal(list.json.events.length,1);
 assert.equal(list.json.events[0].link,a);assert.equal((await call(f.owner,{action:"pending"})).status,401);
});
test("anonymous timer still unlocks; private claims must use their own timer and unlock once",async()=>{
 const f=build();
 const a=token((await call(f.booking,booking(),env.PREP_BOOKING_SECRET)).json.link);
 const b=token((await call(f.booking,booking("appointment-B"),env.PREP_BOOKING_SECRET)).json.link);
 const anon=(await call(f.reward,{action:"start"})).json.session;
 const sa=(await call(f.reward,{action:"start",prep:a})).json.session;
 const sb=(await call(f.reward,{action:"start",prep:b})).json.session;
 assert.equal((await call(f.ev,{prep:a,kind:"unlocked",proof:"forged"})).status,400);
 assert.equal((await call(f.reward,{action:"claim",prep:a,session:sa})).status,425);
 f.advance(5000);
 assert.equal((await call(f.reward,{action:"claim",prep:a,session:anon})).status,400);
 assert.equal((await call(f.reward,{action:"claim",prep:b,session:sa})).status,400);
 assert.equal((await call(f.reward,{action:"claim",session:anon})).json.code,env.WATCH_REWARD_CODE);
 const ra=(await call(f.reward,{action:"claim",prep:a,session:sa})).json;
 const rb=(await call(f.reward,{action:"claim",prep:b,session:sb})).json;
 assert.notEqual(ra.code,rb.code);
 assert.equal((await call(f.reward,{action:"claim",prep:a,session:sa})).json.code,ra.code);
 assert.equal((await call(f.ev,{prep:b,kind:"unlocked",proof:ra.proof})).status,400);
 for(let i=0;i<2;i++){
  assert.equal((await call(f.ev,{prep:a,kind:"started"})).status,202);
  assert.equal((await call(f.ev,{prep:a,kind:"unlocked",proof:ra.proof})).status,202);
 }
 const events=(await call(f.owner,{action:"pending"},env.PREP_OWNER_SECRET)).json.events;
 assert.deepEqual(events.map(e=>e.kind),["booked","booked","started","unlocked"]);
});
test("outbox failure keeps the notification pending; success acks its lease without exposing credentials",async()=>{
 const env2={...env,PREP_OWNER_WEBHOOK_URL:"https://services.leadconnectorhq.com/hooks/location-test/webhook-trigger/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
 let lease,acked=0;
 const store={async lease(key){lease=key;return {booking_id:ids[0],event_id:ids[1],contact_name:"Fixture Person",kind:"unlocked",expires_epoch:1900000000};},async ack(id,key){assert.equal(id,ids[1]);assert.equal(key,lease);acked++;return true;}};
 assert.equal(await deliverOne(store,{env:env2,fetcher:async()=>({ok:false})}),"retry");
 assert.equal(acked,0);
 assert.equal(await deliverOne(store,{env:env2,fetcher:async(url,opt)=>{
  assert.equal(url,env2.PREP_OWNER_WEBHOOK_URL);assert.equal(opt.headers["Idempotency-Key"],ids[1]);assert(!opt.headers.Authorization);
  const body=JSON.parse(opt.body);assert.equal(body.kind,"unlocked");assert.equal(body.prep_link,undefined);return {ok:true};}}),"sent");
 assert.equal(acked,1);
});
test("temporary QA is separately gated, fixed-shape and one synthetic booking per key",async()=>{
 const qaKey="fixture-independent-qa-key-32-or-more-";
 const receiver="https://services.leadconnectorhq.com/hooks/location-test/webhook-trigger/test";
 const e={...env,PREP_QA_SECRET:qaKey,PREP_OWNER_WEBHOOK_URL:receiver};
 const f=build(), samples=[], rows=[];
 const storage={...f.storage,book:async v=>{rows.push(v);return f.storage.book(v)},lease:async()=>null};
 const options={env:e,storage,now:()=>now,fetcher:async(url,opt)=>{
  assert.equal(url,receiver);assert.equal(opt.redirect,"error");samples.push(JSON.parse(opt.body));return {ok:true};
 }};
 const h=createOwnerHandler(options);
 assert.equal((await call(h,{action:"qa-sample"})).status,401);
 assert.equal((await call(h,{action:"qa-sample"},env.PREP_OWNER_SECRET)).status,401);
 assert.equal((await call(h,{action:"pending"},qaKey)).status,401);
 assert.equal((await call(h,{action:"qa-sample",url:"https://example.org/"},qaKey)).status,400);
 assert.equal((await call(createOwnerHandler({...options,env:{...e,PREP_QA_SECRET:undefined}}),{action:"qa-sample"},qaKey)).status,401);
 assert.equal((await call(createOwnerHandler({...options,env:{...e,PREP_QA_SECRET:env.PREP_OWNER_SECRET}}),{action:"qa-sample"},env.PREP_OWNER_SECRET)).status,401);
 assert.equal((await call(h,{action:"qa-sample"},qaKey)).status,200);
 assert.equal(rows.length,0);
 assert.deepEqual(Object.keys(samples[0]).sort(),["appointment_at","contact_name","event_id","happened_at","kind","prep_link"]);
 assert.equal(samples[0].prep_link,"https://before-call.vercel.app/");
 assert.equal((await call(h,{action:"qa-booking",appointment_id:"real"},qaKey)).status,400);
 const first=await call(h,{action:"qa-booking"},qaKey);
 const second=await call(h,{action:"qa-booking"},qaKey);
 assert.equal(first.status,200);assert.equal(first.json.link,second.json.link);
 assert.equal(rows.length,2);assert.match(rows[0].appointment,/^qa_[0-9a-f]{32}$/);
 assert.equal(rows[0].appointment,rows[1].appointment);assert.equal((await storage.list()).length,1);
 assert.equal(samples.length,1);
});
