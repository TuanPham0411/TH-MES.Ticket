function origin(value){
 const url=new URL(value);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['https:','http:'].includes(url.protocol)||url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Public origins require HTTPS (HTTP is allowed only on loopback).');
 return url.origin;
}
export function runtimeSites(env=process.env){return {mes:origin(env.MES_ORIGIN||'https://ticket.th.io.vn'),portfolio:origin(env.PORTFOLIO_ORIGIN||'https://th.io.vn')};}
export const hostOf=value=>new URL(value).hostname;
export function publicOrigin(req){const sites=req.app.locals.sites||runtimeSites();return req.hostname===hostOf(sites.mes)?sites.mes:sites.portfolio;}
