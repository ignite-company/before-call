import { createHmac, randomUUID } from "node:crypto";
import { createBookingHandler } from "./prep-booking.mjs";
import { authorized,createStore,deliverOne,enough,jsonBody,noStore,prepLink,UUID,validOwnerWebhook } from "../lib/prep.mjs";

export function createOwnerHandler({env=process.env,storage,fetcher=fetch,now=Date.now}={}) {
  return async (req,res) => {
    noStore(res);
    if (req.method!=="POST") {res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
    const body=jsonBody(req,1024);
    if (body && ["qa-sample","qa-booking"].includes(body.action)) {
      // TEMPORARY: independently authenticated QA only. Remove after live verification.
      if (!authorized(req,env.PREP_QA_SECRET) ||
          [env.PREP_OWNER_SECRET,env.PREP_BOOKING_SECRET,env.PREP_SIGNING_SECRET,env.PREP_DB_RPC_SECRET].includes(env.PREP_QA_SECRET)) {
        return res.status(401).json({error:"Unauthorized"});
      }
      if (Object.keys(body).length!==1) return res.status(400).json({error:"Unexpected QA input"});
      if (body.action==="qa-sample") {
        if (!validOwnerWebhook(env.PREP_OWNER_WEBHOOK_URL)) return res.status(503).json({error:"Owner receiver unavailable"});
        try {
          const id=randomUUID(), happened_at=new Date(now()).toISOString();
          const sample={event_id:id,kind:"booked",happened_at,contact_name:"Ignite QA — mapping sample",
            appointment_at:happened_at,prep_link:"https://before-call.vercel.app/"};
          const r=await fetcher(env.PREP_OWNER_WEBHOOK_URL,{method:"POST",redirect:"error",
            headers:{"Content-Type":"application/json","Idempotency-Key":id},body:JSON.stringify(sample),
            signal:AbortSignal.timeout(4000)});
          if (!r.ok) throw Error();
          return res.status(200).json({ok:true});
        } catch {return res.status(502).json({error:"Owner receiver did not confirm"});}
      }
      if (!enough(env.PREP_BOOKING_SECRET) || !validOwnerWebhook(env.PREP_OWNER_WEBHOOK_URL)) {
        return res.status(503).json({error:"QA booking unavailable"});
      }
      // One stable synthetic booking per QA key; no caller-provided IDs, fields, or destinations.
      const id="qa_"+createHmac("sha256",env.PREP_QA_SECRET).update("before-call-temporary-qa").digest("hex").slice(0,32);
      return createBookingHandler({env,now,storage})({method:"POST",headers:{authorization:"Bearer "+env.PREP_BOOKING_SECRET},
        body:{appointment_id:id,calendar_id:env.PREP_CALENDAR_ID,location_id:env.PREP_LOCATION_ID,status:"confirmed",
          contact_name:"Ignite QA — synthetic booking"}},res);
    }
    if (!authorized(req,env.PREP_OWNER_SECRET)) return res.status(401).json({error:"Unauthorized"});
    if (!enough(env.PREP_SIGNING_SECRET)) return res.status(503).json({error:"Queue unavailable"});
    if (!body||!["pending","ack","dispatch"].includes(body.action)) return res.status(400).json({error:"Invalid operation"});
    if (body.action==="ack"&&(typeof body.event_id!=="string"||!UUID.test(body.event_id))) return res.status(400).json({error:"Invalid event"});
    try {
      const db=storage??createStore({env});
      if (body.action==="dispatch") return res.status(200).json({outcome:await deliverOne(db,{env})});
      if (body.action==="ack") {await db.ack(body.event_id);return res.status(200).json({ok:true});}
      const result=await db.list();
      const events=result.map(r=>({id:r.event_id,kind:r.kind,at:r.happened_at,contact_name:r.contact_name,appointment_at:r.scheduled_at,
        ...(r.kind==="booked" ? {link:prepLink(r.booking_id,r.expires_epoch,env.PREP_SIGNING_SECRET)} : {})}));
      return res.status(200).json({events});
    } catch {return res.status(503).json({error:"Queue unavailable"});}
  };
}
export default createOwnerHandler();
