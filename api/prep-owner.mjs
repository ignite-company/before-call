import { authorized,createStore,deliverOne,enough,jsonBody,noStore,prepLink,UUID } from "../lib/prep.mjs";

export function createOwnerHandler({env=process.env,storage}={}) {
  return async (req,res) => {
    noStore(res);
    if (req.method!=="POST") {res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
    if (!authorized(req,env.PREP_OWNER_SECRET)) return res.status(401).json({error:"Unauthorized"});
    if (!enough(env.PREP_SIGNING_SECRET)) return res.status(503).json({error:"Queue unavailable"});
    const body=jsonBody(req,1024);
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
