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

/** Exercise real font rasterisation in the same isolated worker as agent art. */
export const textAlignmentStory = {
  project: 'Layout study',
  title: 'Labels belong to their containers',
  duration: 24,
  beats: [
    { title: 'Align', caption: 'Labels sit in the centre of each padded box.' },
    { title: 'Fit', caption: 'Longer labels wrap or fit while keeping a readable size.' },
    { title: 'Move', caption: 'Moving the container also moves its label.' },
  ],
  drawing: {
    styleName: 'Letterpress specimens',
    direction: 'Plain contrasting blocks reveal padding, alignment and movement.',
    background: '#172b39',
    ink: '#edf4ea',
    code: String.raw`
const {rect,textBox,ease}=helpers;
function bounds(){
 const pixels=ctx.getImageData(0,0,400,180).data;
 let left=400,right=-1,top=180,bottom=-1;
 for(let y=0;y<180;y++)for(let x=0;x<400;x++){
  if(pixels[(y*400+x)*4+3]<128)continue;
  left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
 }
 if(right<0)throw Error('Expected visible label');
 return {left,right,top,bottom};
}
function near(actual,expected){if(Math.abs(actual-expected)>1.5)throw Error('Misaligned label: '+actual+' versus '+expected)}
const cases=[
 ['APPROVE',{}],['gyp',{}],['Hello\ngyp',{}],
 ['Long labels stay readable',{size:32}],
 ['a_very_long_filename_without_spaces.ts',{size:30,maxLines:3}],
 ['Approve',{size:80,minSize:26,maxLines:1}],
 ['Top left',{align:'left',verticalAlign:'top'}],
 ['Bottom right',{align:'right',verticalAlign:'bottom'}],
 ['Ágj',{font:'serif',weight:400}],
 ['👨‍👩‍👧‍👦 family é',{size:32}],
];
for(const [label,options] of cases){
 ctx.clearRect(0,0,1280,480);
 ctx.font='17px serif';ctx.textAlign='right';ctx.textBaseline='bottom';ctx.fillStyle='#ff0000';
 textBox(label,20,20,360,130,{padding:16,...options});
 if(ctx.font!=='17px serif'||ctx.textAlign!=='right'||ctx.textBaseline!=='bottom'||ctx.fillStyle!=='#ff0000')throw Error('Text layout leaked canvas state');
 const b=bounds();
 if(b.left<35||b.right>364||b.top<35||b.bottom>134)throw Error('Text escaped padding');
 if(options.align==='left')near(b.left,36);
 else if(options.align==='right')near(b.right+1,364);
 else near((b.left+b.right+1)/2,200);
 if(options.verticalAlign==='top')near(b.top,36);
 else if(options.verticalAlign==='bottom')near(b.bottom+1,134);
 else near((b.top+b.bottom+1)/2,85);
}
ctx.clearRect(0,0,1280,480);
textBox('   ',20,20,360,130);
if(ctx.getImageData(0,0,400,180).data.some(v=>v!==0))throw Error('Empty label painted pixels');
ctx.save();ctx.translate(200,85);ctx.rotate(Math.PI/2);ctx.scale(.75,.75);
textBox('Move',-65,-35,130,70);ctx.restore();
const rotated=bounds();near((rotated.left+rotated.right+1)/2,200);near((rotated.top+rotated.bottom+1)/2,85);
ctx.clearRect(0,0,1280,480);
for(const [i,label] of ['Approve','gyp','Hello\nagain','Long labels stay readable'].entries()){
 const x=24+i*312;
 rect(x,26,296,130,'#f2d6a2',16);
 textBox(label,x,26,296,130,{size:36,color:'#172b39',padding:18});
}
rect(24,190,370,110,'#8fcfc0',12);
rect(46,223,44,44,'#172b39',8);textBox('✓',46,223,44,44,{padding:3});
textBox('Changes approved',104,190,276,110,{align:'left',padding:14,size:32,color:'#172b39'});
rect(428,190,340,110,'#b6bce9',12);
textBox('Top left',428,190,340,110,{align:'left',verticalAlign:'top',padding:20,size:32,color:'#172b39'});
rect(802,190,454,110,'#edac9a',12);
textBox('Bottom right',802,190,454,110,{align:'right',verticalAlign:'bottom',padding:20,size:32,color:'#172b39'});
const q=ease(frame.progress);
ctx.save();ctx.translate(640+120*(q-.5),395);ctx.rotate((q-.5)*.14);
rect(-218,-48,436,96,'#edf4ea',18);
textBox('Moving together',-218,-48,436,96,{size:36,color:'#172b39'});
ctx.restore();`,
  },
  source: 'Synthetic layout regression cases, independent of any project story.',
}
