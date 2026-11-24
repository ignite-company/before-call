import { createStore,deliverOne,jsonBody,noStore,readPrepToken,validUnlockProof } from "../lib/prep.mjs";

export function createEventHandler({env=process.env,now=Date.now,storage}={}) {
  return async (req,res) => {
    noStore(res);
    if (req.method!=="POST") {res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
    const v=jsonBody(req,1024);
    const booking=readPrepToken(v?.prep,env.PREP_SIGNING_SECRET,now());
    if (!booking || !["started","unlocked"].includes(v.kind)) return res.status(400).json({error:"Invalid event"});
    // A successful eligible reward response must precede the browser's unlock signal.
    if (v.kind==="unlocked"&&!validUnlockProof(v.proof,v.prep,env.PREP_SIGNING_SECRET)) return res.status(400).json({error:"Invalid event"});
    try {const db=storage??createStore({env});await db.event(booking.id,v.kind);await deliverOne(db,{env});return res.status(202).json({ok:true});}
    catch {return res.status(503).json({error:"Event unavailable"});}
  };
}
export default createEventHandler();
