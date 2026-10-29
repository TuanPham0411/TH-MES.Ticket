const ease = 'cubic-bezier(.16,1,.3,1)';
const allowed = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
export function revealPage(page) {
  if (!allowed() || !page) return;
  page.getAnimations({subtree:true}).forEach(animation=>animation.cancel());
  page.animate([{opacity:0,transform:'perspective(1200px) translate3d(0,38px,-50px) rotateX(2deg)'},{opacity:1,transform:'perspective(1200px) translate3d(0,0,0) rotateX(0)'}],{duration:650,easing:ease});
  page.querySelectorAll('.metric,.card').forEach((card,n)=>card.animate([{opacity:0,transform:'translateY(36px) scale(.94)'},{opacity:1,transform:'translateY(0) scale(1)'}],{duration:700,delay:Math.min(n*65,390),easing:ease,fill:'backwards'}));
}
export function animateDashboard(root) {
  if (!allowed() || root.hidden) return;
  root.querySelectorAll('.activity-bars span,.bar-track>div,.ticket-track i').forEach((bar,n)=>{
    const vertical=bar.parentElement.classList.contains('activity-bars');
    bar.style.transformOrigin=vertical?'center bottom':'left center';
    bar.animate([{transform:vertical?'scaleY(0)':'scaleX(0)',opacity:.3},{transform:'scale(1)',opacity:1}],{duration:950,delay:Math.min(n*28,420),easing:ease,fill:'backwards'});
  });
  const donut=root.querySelector('.donut');
  donut?.animate([{transform:'rotate(-150deg) scale(.65)',opacity:0},{transform:'rotate(0) scale(1)',opacity:1}],{duration:1000,easing:ease});
  root.querySelectorAll('.metric-value').forEach(element=>{
    const value=Number(element.textContent); if(!Number.isFinite(value))return;
    const start=performance.now();
    const tick=now=>{
      if(!element.isConnected || !allowed()) { element.textContent=String(value); return; }
      const progress=Math.min(1,(now-start)/900);
      element.textContent=String(Math.round(value*(1-(1-progress)**4)));
      if(progress<1)requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
