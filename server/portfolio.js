import {Router} from 'express';
import {portfolioContentRouter} from './portfolio-content.js';
import nodemailer from 'nodemailer';
import {hash,token,passwordOK} from './security.js';
import {validInquiry} from './inquiry.js';
const cookie = {httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:12*3600*1000};
export const setPortfolioCookie = (res,value) => res.cookie('th_portfolio',value,cookie);
export const publicUser = u => u ? {uid:u.id,email:u.email,displayName:u.name,emailVerified:u.verified,isAdmin:u.admin} : null;
export function portfolioRouter(pool,filesRoot) {
 const router=Router();
 router.use('/content',portfolioContentRouter(pool,filesRoot));
 const mail=process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
 async function send(u,purpose) {
  if(!mail) throw Object.assign(new Error('Email service is not configured'),{status:503});
  const value=token();
  await pool.query('insert into portfolio.tokens(hash,uid,purpose) values($1,$2,$3)',[hash(value),u.id,purpose]);
  const link=`https://th.io.vn/#accountAction=${purpose}&token=${value}`;
  await mail.sendMail({from:process.env.MAIL_FROM,to:u.email,subject:purpose==='verify'?'Verify your TH email':'Reset your TH password',text:`Open this link within one hour: ${link}`});
 }
 async function session(res,u) {
  const value=token();await pool.query('insert into portfolio.sessions(hash,uid) values($1,$2)',[hash(value),u.id]);setPortfolioCookie(res,value);return {user:publicUser(u)};
 }
 router.post('/',async(req,res)=>{
  const {action,data={}}=req.body||{};
  const fail=(code='permission-denied',status=403)=>res.status(status).json({code,error:'Request denied'});
  const q=(sql,values=[])=>pool.query(sql,values);
  const {rows:[u]}=await q('select u.* from portfolio.users u join portfolio.sessions s on s.uid=u.id where s.hash=$1 and s.expires>now()',[hash(req.cookies.th_portfolio||'')]);
  if(action==='session') return res.json({user:publicUser(u)});
  if(action==='logout') {await q('delete from portfolio.sessions where hash=$1',[hash(req.cookies.th_portfolio||'')]);res.clearCookie('th_portfolio',cookie);return res.json({user:null});}
  if(['login','register','reset'].includes(action)) {
   const email=typeof data.email==='string'?data.email.trim().toLowerCase():'';
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254) return fail('auth/invalid-email',400);
   if(action==='reset') {const {rows:[user]}=await q('select * from portfolio.users where email=$1',[email]);if(!mail)return fail('mail-unavailable',503);if(user)await send(user,'reset');return res.json({ok:true});}
   if(!passwordOK(data.password)) return fail(action==='login'?'auth/invalid-credential':'auth/weak-password',400);
   if(action==='register') {
    if(!mail)return fail('mail-unavailable',503);
    const {rows:[user]}=await q("insert into portfolio.users(email,password) values($1,extensions.crypt($2,extensions.gen_salt('bf',10))) on conflict(email) do nothing returning *",[email,data.password]);
    if(!user)return fail('auth/email-already-in-use',409);
    // Account remains unverified until the emailed link is consumed.
    return res.json(await session(res,user));
   }
   const {rows:[user]}=await q('select * from portfolio.users where email=$1 and password=extensions.crypt($2,password)',[email,data.password]);
   if(!user)return fail('auth/invalid-credential',401);
   return res.json(await session(res,user));
  }
  if(action==='consumeToken') {
   if(!['verify','reset'].includes(data.purpose)||! /^[a-f0-9]{64}$/.test(data.token||''))return fail();
   if(data.purpose==='reset'&&!passwordOK(data.password))return fail('auth/weak-password',400);
   const client=await pool.connect();
   try {
    await client.query('begin');
    const {rows:[t]}=await client.query('delete from portfolio.tokens where hash=$1 and purpose=$2 and expires>now() returning uid',[hash(data.token),data.purpose]);
    if(!t){await client.query('rollback');return fail();}
    if(data.purpose==='verify')await client.query('update portfolio.users set verified=true where id=$1',[t.uid]);
    else {await client.query('update portfolio.users set password=extensions.crypt($2,extensions.gen_salt(\'bf\',10)) where id=$1',[t.uid,data.password]);await client.query('delete from portfolio.sessions where uid=$1',[t.uid]);}
    await client.query('delete from portfolio.tokens where uid=$1 and purpose=$2',[t.uid,data.purpose]);await client.query('commit');return res.json({ok:true});
   }catch(e){await client.query('rollback');throw e;}finally{client.release();}
  }
  if(!u)return fail('auth/invalid-credential',401);
  if(action==='verify'){await send(u,'verify');return res.json({ok:true});}
  if(action==='profile') {
   if(typeof data.displayName!=='string'||!data.displayName.trim()||data.displayName.length>80)return fail();
   await q('update portfolio.users set name=$2 where id=$1',[u.id,data.displayName.trim()]);return res.json({ok:true});
  }
  if(!u.verified)return fail();
  const path=data.path;
  const ownProfile=path===`users/${u.id}`;
  const bookmark=typeof path==='string'&&new RegExp(`^users/${u.id}/bookmarks/[a-zA-Z0-9_-]+$`).test(path);
  const ownBookmarks=path===`users/${u.id}/bookmarks`;
  const inquiry=typeof path==='string'&&/^inquiries\/[a-f0-9-]+$/.test(path);
  if(action==='get'&&ownProfile)return res.json({id:u.id,data:{displayName:u.name}});
  if(action==='set'&&ownProfile){if(typeof data.data?.displayName!=='string'||!data.data.displayName.trim()||data.data.displayName.length>80)return fail();await q('update portfolio.users set name=$2 where id=$1',[u.id,data.data.displayName.trim()]);return res.json({ok:true});}
  if(action==='list'&&(ownBookmarks||path==='inquiries')) {
   const all=path==='inquiries'&&u.admin&&!data.filters?.some(f=>f.field==='uid');
   const {rows}=await q(`select path,data from portfolio.records where path like $1 and ($2::boolean or uid=$3) order by (data->'createdAt'->>'seconds')::bigint desc nulls last,path limit 100`,[ownBookmarks?path+'/%':'inquiries/%',all,u.id]);
   return res.json({rows:rows.map(r=>({id:r.path.split('/').pop(),data:r.data}))});
  }
  if(action==='add'&&path==='inquiries') {
   if(!validInquiry(data.data))return fail();
   const value={name:data.data.name,topic:data.data.topic,message:data.data.message,uid:u.id,email:u.email,status:'New',createdAt:{seconds:Math.floor(Date.now()/1000)}};
   const id=crypto.randomUUID();await q('insert into portfolio.records values($1,$2,$3)',[`inquiries/${id}`,u.id,value]);return res.json({id});
  }
  if(action==='set'&&bookmark){await q('insert into portfolio.records values($1,$2,$3) on conflict(path) do nothing',[path,u.id,{projectId:path.split('/').pop()}]);return res.json({ok:true});}
  if(action==='set'&&inquiry&&u.admin&&['New','In progress','Replied','Closed'].includes(data.data?.status)){await q("update portfolio.records set data=data||jsonb_build_object('status',$2::text) where path=$1",[path,data.data.status]);return res.json({ok:true});}
  if(action==='delete'&&(bookmark||(inquiry&&u.admin))){await q('delete from portfolio.records where path=$1',[path]);return res.json({ok:true});}
  return fail();
 });
 return router;
}
