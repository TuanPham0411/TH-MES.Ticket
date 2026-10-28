// Persistent scheduling runs independently of browser sessions. The SQL tick uses
// an advisory lock and unique recipient/event keys to survive restarts/retries.
export function startNotificationScheduler(pool,isBlocked=()=>false){
 let busy=false;async function tick(){if(busy||isBlocked())return;busy=true;try{await pool.query('select public.mes_notifications_tick()');}catch(error){console.error('Notification scheduler failed',{code:error.code||'unavailable'});}finally{busy=false;}}
 const timer=setInterval(tick,60000);timer.unref();tick();return ()=>clearInterval(timer);
}
