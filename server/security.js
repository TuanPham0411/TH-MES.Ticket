import {publicOrigin} from './sites.js';
import { createHash, randomBytes } from 'node:crypto';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export const validPath = value => typeof value === 'string' && /^issues\/[a-zA-Z0-9_-]{1,128}\/[a-zA-Z0-9_-]{1,128}$/.test(value);
export const passwordOK = value => typeof value === 'string' && value.length >= 10 && Buffer.byteLength(value) <= 72;
export function actorFor(session, tester) { return { ...(typeof session === 'string' && /^[a-f0-9]{64}$/.test(session) ? {session} : {}), ...(tester === 'true' ? {tester:true} : {}) }; }
export function sameOrigin(req,res,next) {
  // Google returns via a cross-site navigation. This exact GET endpoint is
  // protected by OAuth state and the PKCE verifier cookie in oauthRouter.
  if (req.method === 'GET' && ['/api/oauth/callback','/api/ticket/drive/callback'].includes(req.originalUrl.split('?')[0])) return next();
  if (req.headers.origin && req.headers.origin !== publicOrigin(req)) return res.status(403).json({error:'Origin denied'});
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({error:'Origin denied'});
  next();
}
