import { authorized,bookingPayload,createStore,deliverOne,enough,jsonBody,noStore,prepLink } from "../lib/prep.mjs";

export function createBookingHandler({env=process.env,now=Date.now,storage}={}) {
  return async (req,res) => {
    noStore(res);
    if (req.method!=="POST") {res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
    if (!authorized(req,env.PREP_BOOKING_SECRET)) return res.status(401).json({error:"Unauthorized"});
    if (!enough(env.PREP_SIGNING_SECRET)) return res.status(503).json({error:"Prep link unavailable"});
    const data=bookingPayload(jsonBody(req),env,now());
    if (!data) return res.status(400).json({error:"Expected a confirmed booking for the configured calendar"});
    try {
      const db=storage??createStore({env});
      const record=await db.book(data);
      if (!record) throw Error();
      const link=prepLink(record.id,record.expires_epoch,env.PREP_SIGNING_SECRET);
      // This workflow is separate from booking confirmation and browser redirect.
      await deliverOne(db,{env});
      return res.status(200).json({link});
    } catch {return res.status(503).json({error:"Prep link unavailable"});}
  };
}
export default createBookingHandler();
