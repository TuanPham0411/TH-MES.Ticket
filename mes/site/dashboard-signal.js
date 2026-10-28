import './dashboard-signal.css';
// Decorative SVG only: CSS moves the packets; JS measures on layout changes.
export function initDashboardSignal(){
 const hero=document.querySelector('#dashboard-page>.workspace-hero');if(!hero)return;
 const title=hero.querySelector('#dashboard-title')?.parentElement,actions=hero.querySelector('.heading-actions');if(!title||!actions)return;
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.classList.add('dashboard-signal');svg.setAttribute('viewBox','0 0 1000 100');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');svg.setAttribute('hidden','');
 const tracks=[['main','M0 53 H170 L193 53 L207 42 L223 68 L244 29 L267 73 L288 44 L309 53 H445 L465 48 L490 58 L515 53 H1000'],['upper','M95 53 H155 L225 18 H415 L465 34 H670 L715 53 H1000'],['lower','M205 53 H340 L402 84 H570 L630 67 H810 L860 53 H1000'],['top','M380 53 H465 L530 7 H725 L800 31 H895 L940 53 H1000'],['bottom','M505 53 H600 L655 92 H795 L855 73 H930 L970 53 H1000']];
 for(const [name,d]of tracks){const group=document.createElementNS(ns,'g');group.setAttribute('class','signal-track signal-'+name);for(const cls of ['signal-wire','signal-packet']){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);path.setAttribute('pathLength','1000');path.setAttribute('class',cls);path.setAttribute('vector-effect','non-scaling-stroke');group.append(path);}svg.append(group);}
 for(const [cx,cy]of [[155,53],[340,53],[465,53],[600,53],[715,53],[860,53],[990,53]]){const node=document.createElementNS(ns,'circle');node.setAttribute('cx',cx);node.setAttribute('cy',cy);node.setAttribute('r','2.6');node.setAttribute('class','signal-junction');svg.append(node);}
 hero.append(svg);
 const desktop=matchMedia('(min-width:1101px)'),motion=matchMedia('(prefers-reduced-motion:reduce)');let frame=0,inView=true;
 function measure(){const rect=hero.getBoundingClientRect(),left=title.getBoundingClientRect().right-rect.left+22,right=actions.getBoundingClientRect().left-rect.left-22,width=right-left,show=desktop.matches&&!motion.matches&&width>=160&&rect.height>0;svg.toggleAttribute('hidden',!show);svg.dataset.playing=String(show&&inView&&!document.hidden);if(show){svg.style.left=`${Math.round(left)}px`;svg.style.width=`${Math.floor(width)}px`;}}
 const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
 const resize=new ResizeObserver(schedule);for(const element of [hero,title,actions])resize.observe(element);
 if(typeof IntersectionObserver!=='undefined')new IntersectionObserver(entries=>{inView=entries[0].isIntersecting;schedule();}).observe(hero);
 desktop.addEventListener('change',schedule);motion.addEventListener('change',schedule);document.addEventListener('visibilitychange',()=>{if(document.hidden)svg.dataset.playing='false';else schedule();});measure();
}
