import {publicOrigin,hostOf} from './sites.js';
import {Router} from 'express';
import {createHash} from 'node:crypto';
import {token,hash} from './security.js';
import {setPortfolioCookie} from './portfolio.js';
export function oauthRouter(pool) {
 const r=Router();
 const cookie={httpOnly:true,secure:true,sameSite:'lax',path:'/api/oauth',maxAge:600000};
 r.get('/start',(req,res)=>{
  if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)return res.status(503).send('Google login is not configured.');
  const state=token(),verifier=token();res.cookie('oauth_state',state,cookie);res.cookie('oauth_verifier',verifier,cookie);
  const params=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:`${publicOrigin(req)}/api/oauth/callback`,response_type:'code',scope:'openid email profile',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
 });
 r.get('/callback',async(req,res)=>{
  const state=req.cookies.oauth_state, verifier=req.cookies.oauth_verifier;
  res.clearCookie('oauth_state',cookie);res.clearCookie('oauth_verifier',cookie);
  if(!state||req.query.state!==state||!verifier||typeof req.query.code!=='string')return res.status(400).send('Invalid OAuth state.');
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,code:req.query.code,code_verifier:verifier,grant_type:'authorization_code',redirect_uri:`${publicOrigin(req)}/api/oauth/callback`}),signal:AbortSignal.timeout(15000)});
  const credentials=await response.json();if(!response.ok||!credentials.access_token)return res.status(401).send('Google login failed.');
  const identity=await fetch('https://openidconnect.googleapis.com/v1/userinfo',{headers:{Authorization:`Bearer ${credentials.access_token}`},signal:AbortSignal.timeout(15000)});
  const user=await identity.json();if(!identity.ok||user.email_verified!==true||typeof user.email!=='string')return res.status(401).send('Verified email required.');
  if(req.hostname===hostOf(req.app.locals.sites.ticket)) {
   if(user.email.toLowerCase()!==(process.env.OWNER_EMAIL||'eric.scorp93@gmail.com').toLowerCase())return res.status(403).send('Owner account required.');
   const {rows:[row]}=await pool.query('select public.ticket_google_owner_session() as result');
   res.cookie('th_ticket',row.result.sessionToken,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:12*3600*1000});
  } else {
   const {rows:[u]}=await pool.query("insert into portfolio.users(email,password,name,verified,admin) values($1,extensions.crypt($2,extensions.gen_salt('bf',10)),$3,true,$4) on conflict(email) do update set password=case when portfolio.users.verified then portfolio.users.password else excluded.password end,verified=true,admin=excluded.admin returning *",[user.email.toLowerCase(),token(),String(user.name||'').slice(0,80),user.email.toLowerCase()===(process.env.OWNER_EMAIL||'eric.scorp93@gmail.com').toLowerCase()]);
   await pool.query('delete from portfolio.sessions where uid=$1',[u.id]);
   const value=token();await pool.query('insert into portfolio.sessions(hash,uid) values($1,$2)',[hash(value),u.id]);setPortfolioCookie(res,value);
  }
  res.redirect('/');
 });
 return r;
}
