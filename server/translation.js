import {Router} from 'express';
import {createHash} from 'node:crypto';
import {actorFor} from './security.js';
export function translationRouter(pool){
 const router=Router();const pending=new Set();
 router.get('/translation',(_req,res)=>res.json({available:!!process.env.GOOGLE_TRANSLATE_API_KEY}));
 router.post('/translation',async(req,res)=>{
  const actor=actorFor(req.cookies.th_mes,req.headers['x-mes-tester']);
  const dispatch=async(name,data)=>(await pool.query('select public.mes_dispatch($1,$2,$3) result',[name,data,actor])).rows[0].result;
  const session=await dispatch('getSession',{}),issue=await dispatch('readTicket',{id:req.body.id});
  if(!session.isOwner&&![issue.createdBy,issue.reporterUid].includes(session.user.uid))return res.status(403).json({error:'Translate your own feedback only'});
  if(!process.env.GOOGLE_TRANSLATE_API_KEY)return res.status(503).json({error:'Translation has not been configured by the administrator.'});
  const source=[issue.subject,issue.description];const sourceHash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const {rows:[cached]}=await pool.query('select data from public.mes_translations where issue_id=$1 and source_hash=$2',[issue.id,sourceHash]);
  if(cached)return res.json(cached.data);
  if(pending.has(session.user.uid))return res.status(429).json({error:'A translation is already in progress'});
  pending.add(session.user.uid);
  try{
   // Explicit button only. Only title and feedback text leave the Pi; never attachments or account details.
   const response=await fetch('https://translation.googleapis.com/language/translate/v2',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':process.env.GOOGLE_TRANSLATE_API_KEY},body:JSON.stringify({q:source,source:'vi',target:'en',format:'text'}),signal:AbortSignal.timeout(20000)});
   if(!response.ok)throw new Error('Translation provider unavailable');
   const value=await response.json(),translations=value.data?.translations;
   if(!Array.isArray(translations)||translations.length!==2||translations.some(t=>typeof t.translatedText!=='string'))throw new Error('Invalid translation response');
   const result={subject:translations[0].translatedText,description:translations[1].translatedText,sourceHash,translatedAt:Date.now()};
   await pool.query('insert into public.mes_translations(issue_id,source_hash,data) values($1,$2,$3) on conflict do nothing',[issue.id,sourceHash,result]);res.json(result);
  }catch{res.status(502).json({error:'Translation failed. Your original feedback is unchanged. Please try again later.'});}
  finally{pending.delete(session.user.uid);}
 });return router;
}
