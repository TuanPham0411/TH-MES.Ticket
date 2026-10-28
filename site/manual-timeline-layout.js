export const checkpointLayoutKey=point=>point.events.every(event=>event.role==='ongoing')?'present':point.date;
export function validateTimelineLayout(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>400)throw Error('Invalid timeline layout');
 for(const [key,position]of Object.entries(value)){
 if(key!=='present'&&(!/^\d{4}-\d{2}-\d{2}$/.test(key)||!Number.isFinite(Date.parse(key))||new Date(key).toISOString().slice(0,10)!==key))throw Error('Invalid timeline checkpoint');
 if(!position||typeof position!=='object'||Array.isArray(position)||Object.keys(position).some(key=>!['dx','dy','width','height','connectorSide','connectorPoint','connectorLength'].includes(key))||!Number.isFinite(position.dx)||!Number.isFinite(position.dy)||Math.abs(position.dx)>900||Math.abs(position.dy)>1000||position.width!==undefined&&(!Number.isFinite(position.width)||position.width<120||position.width>420)||position.height!==undefined&&(!Number.isFinite(position.height)||position.height<20||position.height>480)||position.connectorSide!==undefined&&!['left','right','top','bottom'].includes(position.connectorSide)||position.connectorPoint!==undefined&&![1,2,3].includes(position.connectorPoint)||position.connectorLength!==undefined&&(!Number.isFinite(position.connectorLength)||position.connectorLength<0||position.connectorLength>300))throw Error('Invalid timeline label position');
 }
 return value;
}
export function applyTimelinePositions(layout,positions={}){
 for(const point of layout.points){const saved=positions[checkpointLayoutKey(point)];if(!saved)continue;const label=point.label;if(saved.width!==undefined)label.width=saved.width;if(saved.height!==undefined)label.height=saved.height;label.sized=saved.height!==undefined;label.connectorSide=saved.connectorSide;label.connectorPoint=saved.connectorPoint;label.connectorLength=saved.connectorLength;label.left=Math.max(label.width/2+8,Math.min(992-label.width/2,point.x+saved.dx));label.top=point.y+saved.dy;label.side=label.top+label.height/2<point.y?'above':'below';label.hidden=false;label.compact=false;label.manual=true;label.leader=labelLeader(point);}
 const labels=layout.points.filter(p=>!p.label.hidden).map(p=>p.label),bottom=layout.originY+layout.height;
 layout.originY=Math.min(layout.originY,...labels.map(label=>label.top-12));layout.height=Math.max(bottom,...labels.map(label=>label.top+label.height+24))-layout.originY;return layout;
}
export function labelConnector(point,label=point.label){
 const side=label.connectorSide||(label.left>=point.x?'left':'right'),fraction=(label.connectorPoint||2)/4,length=label.connectorLength??28;
 const horizontal=side==='left'||side==='right',normal=side==='left'?[-1,0]:side==='right'?[1,0]:side==='top'?[0,-1]:[0,1];
 const end={x:horizontal?label.left+normal[0]*label.width/2:label.left-label.width/2+label.width*fraction,y:horizontal?label.top+label.height*fraction:label.top+(side==='bottom'?label.height:0)};
 const elbow={x:end.x+normal[0]*length,y:end.y+normal[1]*length},dx=elbow.x-point.x,dy=elbow.y-point.y,distance=Math.hypot(dx,dy)||1;
 const start={x:point.x+dx/distance*20,y:point.y+dy/distance*20};
 return{start,elbow,end,path:`M ${start.x} ${start.y} L ${elbow.x} ${elbow.y} L ${end.x} ${end.y}`};
}
export const labelLeader=point=>labelConnector(point).path;
