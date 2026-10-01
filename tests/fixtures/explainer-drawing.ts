/** Regression art only. Production prompts and rendering never import this story. */
export const drawingStory = {
  project: 'Reservoir',
  title: 'One supply, two destinations',
  duration: 24,
  beats: [
    { title: 'Start', caption: 'A shared reservoir holds the available water.' },
    { title: 'Divide', caption: 'Separate channels carry water to two destinations.' },
    {
      title: 'Compare',
      caption: 'Each destination receives its own share; the source level falls.',
    },
    { title: 'Result', caption: 'The two shares add up to the amount removed from the source.' },
  ],
  drawing: {
    styleName: 'Reservoir cutaway',
    direction: 'Clear measuring vessels and flowing dots make the transfer visible.',
    background: '#172b39',
    ink: '#edf4ea',
    code: `
const {rect,text,line,circle,ease,mix}=helpers;
const q=frame.index===0?0:frame.index===1?ease(frame.progress):1;
const tanks=[{x:150,v:100-60*q,label:'Supply'},{x:550,v:40*q,label:'Garden'},{x:950,v:20*q,label:'Workshop'}];
for(const tank of tanks){
 rect(tank.x,80,180,260,'#385260',12);
 rect(tank.x+10,330-tank.v*2,160,tank.v*2,'#79d9db',4);
 text(tank.label,tank.x+90,40,28,'#edf4ea','center');
 text(Math.round(tank.v)+' litres',tank.x+90,380,28,'#edf4ea','center');
}
line(340,220,530,220,'#79d9db',5);line(740,220,930,220,'#79d9db',5);
if(frame.index===1){for(let i=0;i<4;i++){const p=(frame.progress*2+i/4)%1;circle(mix(355,515,p),220,8,'#f5cf7b');circle(mix(755,915,p),220,8,'#f5cf7b');}}
if(frame.index>=2)text('60 moved = 40 + 20',640,445,32,'#f5cf7b','center');`,
  },
  source: 'Illustrative conservation example for player validation; not a project claim.',
}
