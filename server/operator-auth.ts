import type { Express, Request } from "express";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { db } from "./storage";
import { sql } from "drizzle-orm";

const COOKIE="wingwall_operator";
function password() {const p=process.env.WINGWALL_OPERATOR_PASSWORD??"";return p.length>=16?p:"";}
export function operatorConfigured() {return Boolean(password());}
function equal(a:string,b:string) {
  const x=Buffer.from(a), y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
}
function mac(value:string) {return createHmac("sha256",password()).update(value).digest("hex");}
function authorized(req:Request) {
  if(!password()) return false;
  const value=(req.headers.cookie??"").split(";").map(s=>s.trim()).find(s=>s.startsWith(COOKIE+"="))?.slice(COOKIE.length+1);
  if(!value) return false;
  const [expires,signature]=value.split(".");
  return Number(expires)>Date.now() && Number(expires)<=Date.now()+12*3600_000 && equal(signature??"",mac(expires));
}
function sameOrigin(req:Request) {
  const origin=req.get("origin");
  if(!origin) return true; // Non-browser requests must still supply a valid cookie/worker key.
  try {return new URL(origin).host===req.get("host");} catch{return false;}
}
export function installOperatorAuth(app:Express) {
  app.set("trust proxy",1);
  app.get("/api/auth/status",(req,res)=>res.json({configured:operatorConfigured(),authenticated:authorized(req)}));
  app.post("/api/auth/login",async(req,res,next)=>{
    try {
      if(!sameOrigin(req)) return res.status(403).json({message:"Origin rejected"});
      if(!operatorConfigured()) return res.status(503).json({message:"Set WINGWALL_OPERATOR_PASSWORD (16+ characters) in Render before signing in."});
      const bucket=`${createHash("sha256").update(req.ip??"unknown").digest("hex")}:${Math.floor(Date.now()/900_000)}`;
      const rate=await db.execute(sql`INSERT INTO operator_login_attempts (bucket, attempts)
        VALUES (${bucket},1) ON CONFLICT (bucket) DO UPDATE SET attempts=operator_login_attempts.attempts+1 RETURNING attempts`);
      if(Number(rate.rows[0]?.attempts)>10) return res.status(429).json({message:"Too many attempts. Try again in 15 minutes."});
      if(typeof req.body?.password!=="string" || !equal(req.body.password,password())) return res.status(401).json({message:"Incorrect passphrase"});
      const expires=String(Date.now()+12*3600_000);
      res.cookie(COOKIE,`${expires}.${mac(expires)}`,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"strict",maxAge:12*3600_000,path:"/"});
      res.json({authenticated:true});
    } catch(err){next(err);}
  });
  app.post("/api/auth/logout",(req,res)=>{
    if(!sameOrigin(req)) return res.status(403).json({message:"Origin rejected"});
    res.clearCookie(COOKIE,{path:"/"});res.json({authenticated:false});
  });
  app.use("/api",(req,res,next)=>{
    // Compatibility for the existing tracker only. No generic worker-key bypass.
    if(req.method==="POST" && req.path==="/track-all-open-peaks") {
      const secret=process.env.CRON_SECRET??"";
      if(secret.length>=16 && equal(req.get("x-cron-secret")??"",secret)) return next();
    }
    if(!authorized(req)) return res.status(401).json({message:"Operator sign-in required"});
    if(!["GET","HEAD","OPTIONS"].includes(req.method) && !sameOrigin(req)) return res.status(403).json({message:"Origin rejected"});
    next();
  });
}
