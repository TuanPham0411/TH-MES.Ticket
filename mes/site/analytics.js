const time = value => typeof value === 'number' ? value : new Date(value || 0).getTime();
export function submissionCohort(issues, period = 'all', now = Date.now()) {
  if (period === 'all') return issues;
  const start = new Date(now); start.setHours(0,0,0,0); start.setDate(start.getDate()-(Number(period)-1));
  return issues.filter(issue=>time(issue.createdAt)>=start.getTime() && time(issue.createdAt)<=now);
}
export function activitySeries(issues, period = 'all', now = Date.now()) {
  const end = new Date(now); end.setHours(0,0,0,0); end.setDate(end.getDate()+1);
  const timestamps = issues.flatMap(i => [time(i.createdAt),time(i.resolvedAt)]).filter(t => t>0 && t<=now);
  const start = new Date(end);
  if (period === 'all' && timestamps.length) { start.setTime(Math.min(...timestamps)); start.setHours(0,0,0,0); }
  else start.setDate(start.getDate()-Number(period === 'all' ? 7 : period));
  const length = Math.max(1,Math.round((end-start)/86400000));
  const step = Math.max(1,Math.ceil(length/12));
  const bins = [];
  for (let offset=0;offset<length;offset+=step) {
    const from=new Date(start); from.setDate(from.getDate()+offset);
    const to=new Date(start); to.setDate(to.getDate()+Math.min(length,offset+step));
    bins.push({day:from,end:to,created:0,resolved:0});
  }
  for (const issue of issues) for (const [key,field] of [['created','createdAt'],['resolved','resolvedAt']]) {
    const value=time(issue[field]);
    const bin=bins.find(b=>value>=b.day.getTime() && value<b.end.getTime() && value<=now);
    if(bin) bin[key]++;
  }
  return bins;
}
export function resolutionSummary(issues, now=Date.now()) {
  const complete = issues.filter(i=>['Resolved','Closed'].includes(i.status));
  const durations = complete.map(i=>time(i.resolvedAt)-time(i.createdAt)).filter(n=>Number.isFinite(n)&&n>=0);
  const pending=issues.filter(i=>!['Resolved','Closed'].includes(i.status));
  return {rate:issues.length?Math.round(100*complete.length/issues.length):0, averageHours:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length/3600000:null, aged:pending.filter(i=>time(i.createdAt)>0&&now-time(i.createdAt)>=7*86400000).length,pending};
}

// Group by stable identity: renaming a type must not split its ticket count,
// and two distinct types may legitimately share a display name.
export function issueTypeSummary(issues, types = []) {
  const names = new Map(types.map(type => [type.id, type.name]));
  const groups = new Map();
  for (const issue of issues) {
    const id = issue.issueTypeId || '__unclassified';
    const group = groups.get(id) || {id, name: names.get(id) || issue.issueTypeName || 'Unclassified', count: 0};
    group.count++;
    groups.set(id, group);
  }
  return [...groups.values()].sort((a,b) => b.count-a.count);
}
