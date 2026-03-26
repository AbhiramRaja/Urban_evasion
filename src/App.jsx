import { useEffect, useRef, useState, useCallback } from 'react';
import {
  generateCity, getGrid, isRoad, w2g, g2w, snapToRoad,
  astar, minimaxIntercept, getTheme, getBuildingWindows,
  TILE, GRID_W, GRID_H, WORLD_W, WORLD_H,
} from './engine.js';

const GW = 900, GH = 600, MM = 170;

// ── Audio ──────────────────────────────────────────────────────
let _ac = null;
const ac = () => { if (!_ac) _ac = new (window.AudioContext||window.webkitAudioContext)(); if (_ac.state==='suspended') _ac.resume(); return _ac; };
const beep = (f,t,v,d,f2) => { try { const c=ac(),o=c.createOscillator(),g=c.createGain(); o.type=t; o.frequency.setValueAtTime(f,c.currentTime); if(f2) o.frequency.exponentialRampToValueAtTime(f2,c.currentTime+d); g.gain.setValueAtTime(v,c.currentTime); g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+d); o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime+d); } catch(e){} };
const SFX = { collect:()=>beep(660,'sine',0.14,0.15,1200), bust:()=>beep(150,'sawtooth',0.3,0.9,40), powerup:()=>beep(440,'triangle',0.17,0.4,1300), wantedUp:()=>[300,450,600].forEach((f,i)=>setTimeout(()=>beep(f,'square',0.12,0.1),i*110)), };

// ── Game factories ─────────────────────────────────────────────
const mkPlayer = () => ({
  x:WORLD_W/2, y:WORLD_H/2, angle:-Math.PI/2, speed:0,
  velX:0, velY:0, maxSpeed:290, accel:230, friction:0.91, turn:2.7,
  health:1, nitro:1, boostTimer:0, shieldTimer:0, hitTimer:0,
  alive:true, w:22, h:36, color:'#00f7ff', trail:[],
});
const mkCop = (x,y,isLead,wl) => ({
  x,y, angle:Math.random()*Math.PI*2, speed:0, velX:0, velY:0,
  maxSpeed:155+wl*22, w:20,h:33, color:'#ff2d6e', isLead,
  interceptTarget:null, aiTimer:Math.random()*1.2, trail:[],
  astarPath:[],  // each cop stores own A* route for minimap
});
const mkOrb = () => {
  let gx,gy,att=0;
  do { gx=1+Math.floor(Math.random()*(GRID_W-2)); gy=1+Math.floor(Math.random()*(GRID_H-2)); att++; } while (!isRoad(gx,gy)&&att<60);
  const {wx,wy}=g2w(gx,gy);
  const rare=Math.random()<0.28;
  return { x:wx+(Math.random()-.5)*TILE*.4, y:wy+(Math.random()-.5)*TILE*.4, gx,gy, r:rare?12:8, value:rare?60+Math.floor(Math.random()*40):10+Math.floor(Math.random()*30), pulse:Math.random()*Math.PI*2, color:rare?'#b14fff':'#00f7ff' };
};
const mkGame = () => ({
  player: mkPlayer(), cops:[], orbs:[], particles:[], popups:[],
  score:0, wantedLevel:0, prevWanted:0, surviveTime:0,
  camX:0, camY:0, shakeX:0, shakeY:0, shakeMag:0,
  astarPath:[], astarTimer:0, minimaxZones:[],
  copSpawnTimer:0, copSpawnInterval:10, lastTime:null, running:true,
});

function addParticles(g,x,y,color,count=16,speed=160,life=0.6) {
  for (let i=0;i<count;i++) {
    const a=Math.random()*Math.PI*2, s=speed*(0.4+Math.random()*0.6);
    g.particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life,ml:life,r:2+Math.random()*4,color});
  }
}
function spawnCopNear(g,px,py,isLead) {
  const a=Math.random()*Math.PI*2, d=520+Math.random()*260;
  let sx=Math.max(TILE,Math.min(WORLD_W-TILE,px+Math.cos(a)*d));
  let sy=Math.max(TILE,Math.min(WORLD_H-TILE,py+Math.sin(a)*d));
  const r=snapToRoad(sx,sy);
  g.cops.push(mkCop(r.wx,r.wy,isLead,g.wantedLevel));
}

// ─────────────────────────────────────────────────────────────
export default function App() {
  const canvasRef  = useRef(null);
  const mmRef      = useRef(null);
  const gRef       = useRef(null);
  const keysRef    = useRef({});
  const rafRef     = useRef(null);

  const [screen,  setScreen]   = useState('start');
  const [hud,     setHud]      = useState({score:0,time:'0:00',wantedLevel:0,health:1,nitro:1,boost:false,shield:false,keys:{}});
  const [toasts,  setToasts]   = useState([]);
  const [popups,  setPopups]   = useState([]);
  const [final,   setFinal]    = useState({score:0,time:'0:00',wanted:0});
  const [hs,      setHs]       = useState(()=>+localStorage.getItem('nh_hs')||0);

  const toast = useCallback((text,color)=>{
    const id=Date.now()+Math.random();
    setToasts(t=>[...t,{id,text,color}]);
    setTimeout(()=>setToasts(t=>t.filter(x=>x.id!==id)),2100);
  },[]);
  const popup = useCallback((text,sx,sy,color)=>{
    const id=Date.now()+Math.random();
    setPopups(p=>[...p,{id,text,x:sx,y:sy,color}]);
    setTimeout(()=>setPopups(p=>p.filter(x=>x.id!==id)),900);
  },[]);

  // ── Input ──────────────────────────────────────────────────
  useEffect(()=>{
    const dn=e=>{
      keysRef.current[e.code]=true;
      if ((e.code==='Escape'||e.code==='KeyP') && (screen==='playing'||screen==='paused'))
        setScreen(s=>s==='paused'?'playing':'paused');
      if (e.code==='Space' && screen==='playing') {
        const g=gRef.current; if (!g) return;
        const p=g.player;
        if (p.nitro>=1&&!p.boostTimer) { p.boostTimer=5; p.nitro=0; p.maxSpeed=430; SFX.powerup(); toast('NITRO BOOST!','#00ffaa'); }
      }
      e.preventDefault && e.code==='Space' && e.preventDefault();
    };
    const up=e=>{ keysRef.current[e.code]=false; };
    window.addEventListener('keydown',dn);
    window.addEventListener('keyup',up);
    return()=>{ window.removeEventListener('keydown',dn); window.removeEventListener('keyup',up); };
  },[screen,toast]);

  // ── Start ──────────────────────────────────────────────────
  const startGame=useCallback(()=>{
    generateCity();
    const g=mkGame();
    const sp=snapToRoad(WORLD_W/2,WORLD_H/2);
    g.player.x=sp.wx; g.player.y=sp.wy;
    g.camX=sp.wx-GW/2; g.camY=sp.wy-GH/2;
    for(let i=0;i<8;i++) g.orbs.push(mkOrb());
    spawnCopNear(g,sp.wx,sp.wy,true);
    gRef.current=g;
    setScreen('playing');
    setToasts([]); setPopups([]);
    setHud({score:0,time:'0:00',wantedLevel:0,health:1,nitro:1,boost:false,shield:false,keys:{}});
  },[]);

  // ── Game Loop ──────────────────────────────────────────────
  useEffect(()=>{
    if (screen!=='playing') { cancelAnimationFrame(rafRef.current); return; }
    const canvas=canvasRef.current, mmCanvas=mmRef.current;
    if (!canvas||!mmCanvas) return;
    const ctx=canvas.getContext('2d'), mmCtx=mmCanvas.getContext('2d');
    let hudT=0;

    function loop(ts) {
      const g=gRef.current;
      if (!g||!g.running) return;
      if (!g.lastTime) g.lastTime=ts;
      const dt=Math.min((ts-g.lastTime)/1000,0.05);
      g.lastTime=ts;
      update(g,dt,ts);
      render(ctx,mmCtx,g,ts);
      hudT+=dt;
      if (hudT>0.09) {
        hudT=0;
        const p=g.player;
        const m=Math.floor(g.surviveTime/60), s=Math.floor(g.surviveTime%60);
        setHud({score:g.score,time:`${m}:${s.toString().padStart(2,'0')}`,wantedLevel:g.wantedLevel,health:p.health,nitro:p.nitro,boost:p.boostTimer>0,shield:p.shieldTimer>0,keys:{...keysRef.current}});
      }
      rafRef.current=requestAnimationFrame(loop);
    }

    function update(g,dt,ts) {
      const p=g.player, k=keysRef.current;
      g.surviveTime+=dt;

      // ── Player movement ──────────────────────────────────
      const fwd = k['KeyW']||k['ArrowUp'];
      const bak = k['KeyS']||k['ArrowDown'];
      const lft = k['KeyA']||k['ArrowLeft'];
      const rgt = k['KeyD']||k['ArrowRight'];
      const ea  = p.boostTimer>0 ? p.accel*1.7 : p.accel;
      if (fwd) p.speed+=ea*dt;
      if (bak) p.speed-=ea*0.6*dt;
      p.speed*=p.friction;
      p.speed=Math.max(-80,Math.min(p.maxSpeed,p.speed));
      const tf=Math.min(1,Math.abs(p.speed)/90);
      if (lft) p.angle-=p.turn*tf*dt;
      if (rgt) p.angle+=p.turn*tf*dt;
      p.velX=Math.cos(p.angle)*p.speed; p.velY=Math.sin(p.angle)*p.speed;
      let nx=p.x+p.velX*dt, ny=p.y+p.velY*dt;
      const pg=w2g(nx,ny);
      if (!isRoad(pg.gx,pg.gy)) {
        if (isRoad(w2g(nx,p.y).gx,w2g(nx,p.y).gy)) { ny=p.y; p.speed*=0.55; }
        else if (isRoad(w2g(p.x,ny).gx,w2g(p.x,ny).gy)) { nx=p.x; p.speed*=0.55; }
        else { nx=p.x; ny=p.y; p.speed*=0.2; }
      }
      p.x=Math.max(10,Math.min(WORLD_W-10,nx));
      p.y=Math.max(10,Math.min(WORLD_H-10,ny));
      p.trail.unshift({x:p.x,y:p.y}); if(p.trail.length>28) p.trail.pop();

      // Timers
      if (p.boostTimer>0) { p.boostTimer-=dt; if(p.boostTimer<=0){p.boostTimer=0;p.maxSpeed=290;} }
      if (p.shieldTimer>0) p.shieldTimer-=dt;
      if (p.hitTimer>0)   p.hitTimer-=dt;
      if (!p.boostTimer&&p.nitro<1) p.nitro=Math.min(1,p.nitro+dt/14);

      // ── Orbs ────────────────────────────────────────────
      for (let i=g.orbs.length-1;i>=0;i--) {
        const o=g.orbs[i]; o.pulse+=dt*3;
        const dx=p.x-o.x,dy=p.y-o.y;
        if (dx*dx+dy*dy<(p.w+o.r+6)**2) {
          g.score+=o.value;
          addParticles(g,o.x,o.y,o.color,18,180,0.55);
          addParticles(g,o.x,o.y,'#fff',6,80,0.3);
          SFX.collect();
          const sx=o.x-g.camX, sy=o.y-g.camY;
          popup(`+${o.value}`,sx,sy,o.color);
          g.orbs.splice(i,1);
          if (g.orbs.length<6) { for(let j=0;j<3;j++) g.orbs.push(mkOrb()); }
          g.astarTimer=0; g.astarPath=[];
        }
      }

      // ── Wanted level ────────────────────────────────────
      const nw=Math.min(5,Math.floor(g.score/120));
      if (nw>g.wantedLevel) { g.wantedLevel=nw; SFX.wantedUp(); g.cops.forEach(c=>c.maxSpeed=155+nw*22); toast(`WANTED ★`.padEnd(7+(nw),'★').slice(0,7+nw),'#ff2d6e'); g.copSpawnInterval=Math.max(4,10-nw*1.2); }

      // ── Spawn cops ──────────────────────────────────────
      g.copSpawnTimer+=dt;
      if (g.copSpawnTimer>=g.copSpawnInterval && g.cops.length<2+g.wantedLevel) {
        g.copSpawnTimer=0;
        const isLead=g.cops.every(c=>!c.isLead);
        spawnCopNear(g,p.x,p.y,isLead);
      }

      // ── A* path to nearest orb (recalculate every 1s) ──
      // UNIT 2: Updates GPS route on minimap
      g.astarTimer-=dt;
      if (g.astarTimer<=0&&g.orbs.length) {
        g.astarTimer=1.0;
        let closest=null,bestD=Infinity;
        for (const o of g.orbs) { const d=(o.x-p.x)**2+(o.y-p.y)**2; if(d<bestD){bestD=d;closest=o;} }
        if (closest) {
          const pg2=w2g(p.x,p.y);
          g.astarPath=astar(pg2.gx,pg2.gy,closest.gx,closest.gy);
        }
      }

      // ── Police AI ───────────────────────────────────────
      const plGrid=w2g(p.x,p.y);
      for (let i=0;i<g.cops.length;i++) {
        const c=g.cops[i]; c.aiTimer-=dt;
        c.trail.unshift({x:c.x,y:c.y}); if(c.trail.length>18) c.trail.pop();

        let tx=p.x, ty=p.y;

        // UNIT 3: Lead cop uses Minimax intercept
        if (c.isLead&&c.aiTimer<=0) {
          c.aiTimer=0.8;
          const cg=w2g(c.x,c.y);
          const res=minimaxIntercept(cg.gx,cg.gy,plGrid.gx,plGrid.gy,p.velX,p.velY,3);
          c.interceptTarget=g2w(res.gx,res.gy);
          g.minimaxZones=res.zones;
          // Also compute A* for this cop's own route (shown on minimap)
          c.astarPath=astar(cg.gx,cg.gy,res.gx,res.gy);
        }
        if (!c.isLead&&c.aiTimer<=0) {
          // Follower cop: A* directly to player
          c.aiTimer=0.6;
          const cg=w2g(c.x,c.y);
          c.astarPath=astar(cg.gx,cg.gy,plGrid.gx,plGrid.gy);
        }

        if (c.isLead&&c.interceptTarget) {
          tx=c.interceptTarget.x; ty=c.interceptTarget.y;
          const dx=c.x-tx,dy=c.y-ty;
          if (dx*dx+dy*dy<(TILE*1.5)**2) { c.interceptTarget=null; }
        }

        const adx=tx-c.x,ady=ty-c.y;
        let da=Math.atan2(ady,adx)-c.angle;
        while(da>Math.PI)da-=Math.PI*2; while(da<-Math.PI)da+=Math.PI*2;
        c.angle+=da*Math.min(1,2.4*dt);
        c.speed=Math.min(c.maxSpeed,c.speed+190*dt); c.speed*=0.89;
        c.velX=Math.cos(c.angle)*c.speed; c.velY=Math.sin(c.angle)*c.speed;
        let ncx=c.x+c.velX*dt, ncy=c.y+c.velY*dt;
        const cgg=w2g(ncx,ncy);
        if (!isRoad(cgg.gx,cgg.gy)) {
          if (isRoad(w2g(ncx,c.y).gx,w2g(ncx,c.y).gy)) ncy=c.y;
          else if (isRoad(w2g(c.x,ncy).gx,w2g(c.x,ncy).gy)) ncx=c.x;
          else { ncx=c.x; ncy=c.y; c.speed=0; }
        }
        c.x=Math.max(10,Math.min(WORLD_W-10,ncx));
        c.y=Math.max(10,Math.min(WORLD_H-10,ncy));

        // Collision
        const cdx=p.x-c.x, cdy=p.y-c.y;
        if (cdx*cdx+cdy*cdy<(p.w+c.w)**2*0.55 && p.hitTimer<=0) {
          if (p.shieldTimer>0) { p.shieldTimer=0; toast('SHIELD HIT!','#00f7ff'); addParticles(g,p.x,p.y,'#00f7ff',14,160,0.4); }
          else {
            p.health=Math.max(0,p.health-0.34); p.hitTimer=2; g.shakeMag=14;
            addParticles(g,p.x,p.y,'#ff2d6e',22,240,0.7);
            if (p.health<=0) {
              p.alive=false; g.running=false; SFX.bust();
              addParticles(g,p.x,p.y,'#ff2d6e',60,300,1.2);
              addParticles(g,p.x,p.y,'#ffaa00',30,200,0.9);
              const newHs=Math.max(hs,g.score);
              setHs(newHs); localStorage.setItem('nh_hs',newHs);
              const m2=Math.floor(g.surviveTime/60),s2=Math.floor(g.surviveTime%60);
              setFinal({score:g.score,time:`${m2}:${s2.toString().padStart(2,'0')}`,wanted:g.wantedLevel});
              setTimeout(()=>setScreen('gameover'),1300); return;
            }
            toast('DAMAGE!','#ff2d6e');
          }
        }
      }

      // Particles
      for (let i=g.particles.length-1;i>=0;i--) {
        const pt=g.particles[i]; pt.x+=pt.vx*dt; pt.y+=pt.vy*dt; pt.vx*=0.93; pt.vy*=0.93; pt.life-=dt;
        if (pt.life<=0) g.particles.splice(i,1);
      }

      // Shake + camera
      g.shakeMag*=0.82; g.shakeX=(Math.random()-.5)*g.shakeMag*2; g.shakeY=(Math.random()-.5)*g.shakeMag*2;
      g.camX+=(p.x-GW/2-g.camX)*0.11; g.camY+=(p.y-GH/2-g.camY)*0.11;
    }

    // ── Render ──────────────────────────────────────────────
    function render(ctx,mmCtx,g,ts) {
      const now=ts*0.001, p=g.player, cx=g.camX, cy=g.camY;
      ctx.save(); ctx.fillStyle='#03030f'; ctx.fillRect(0,0,GW,GH);
      ctx.translate(g.shakeX,g.shakeY);

      // City
      const grid=getGrid();
      const x0=Math.max(0,Math.floor(cx/TILE)-1), y0=Math.max(0,Math.floor(cy/TILE)-1);
      const x1=Math.min(GRID_W-1,x0+Math.ceil(GW/TILE)+2), y1=Math.min(GRID_H-1,y0+Math.ceil(GH/TILE)+2);
      for (let gy=y0;gy<=y1;gy++) for (let gx=x0;gx<=x1;gx++) {
        const wx=gx*TILE-cx, wy=gy*TILE-cy;
        const th=getTheme(gx,gy);
        if (grid[gy][gx]===1) {
          const bi=(gx*3+gy*7)%th.b.length, ni=(gx*5+gy*11)%th.neon.length;
          ctx.fillStyle=th.b[bi]; ctx.fillRect(wx,wy,TILE,TILE);
          ctx.shadowBlur=9; ctx.shadowColor=th.neon[ni]; ctx.strokeStyle=th.neon[ni]; ctx.lineWidth=1.2;
          ctx.strokeRect(wx+1,wy+1,TILE-2,TILE-2); ctx.shadowBlur=0;
          // Windows
          const wins=getBuildingWindows(gx,gy);
          ctx.fillStyle=th.neon[ni]; ctx.globalAlpha=0.22;
          const flicker=Math.sin(now*0.9+gx*0.4+gy*0.6)>0.96;
          for (const w of wins) if (w.lit&&!flicker) ctx.fillRect(wx+w.x,wy+w.y,9,6);
          ctx.globalAlpha=1;
          // Antenna
          if ((gx+gy)%6===0) { ctx.strokeStyle=th.neon[ni]; ctx.lineWidth=1; ctx.globalAlpha=0.35; ctx.beginPath(); ctx.moveTo(wx+TILE/2,wy+2); ctx.lineTo(wx+TILE/2,wy-8); ctx.stroke(); ctx.globalAlpha=1; }
        } else {
          ctx.fillStyle=th.road; ctx.fillRect(wx,wy,TILE,TILE);
          ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1; ctx.setLineDash([9,13]);
          if (gx%4===0) { ctx.beginPath(); ctx.moveTo(wx+TILE/2,wy); ctx.lineTo(wx+TILE/2,wy+TILE); ctx.stroke(); }
          if (gy%4===0) { ctx.beginPath(); ctx.moveTo(wx,wy+TILE/2); ctx.lineTo(wx+TILE,wy+TILE/2); ctx.stroke(); }
          ctx.setLineDash([]);
          if (gx%4===0&&gy%4===0) { ctx.fillStyle=th.light+'0a'; ctx.fillRect(wx,wy,TILE,TILE); }
        }
      }

      // Trails
      const drawTrail=(trail,color,mw)=>{
        if (trail.length<2) return;
        for (let i=1;i<trail.length;i++) {
          const t=1-i/trail.length;
          ctx.globalAlpha=t*0.55; ctx.strokeStyle=color; ctx.lineWidth=mw*t;
          ctx.shadowBlur=mw*t*3; ctx.shadowColor=color; ctx.lineCap='round';
          ctx.beginPath(); ctx.moveTo(trail[i-1].x-cx,trail[i-1].y-cy); ctx.lineTo(trail[i].x-cx,trail[i].y-cy); ctx.stroke();
        }
        ctx.globalAlpha=1; ctx.shadowBlur=0;
      };
      drawTrail(p.trail,'#00f7ff',5);
      for (const cop of g.cops) drawTrail(cop.trail,'#ff2d6e',3.5);

      // Orbs
      for (const o of g.orbs) {
        const sx=o.x-cx, sy=o.y-cy, pr=Math.sin(o.pulse)*0.25+0.75, r=o.r*pr;
        const grd=ctx.createRadialGradient(sx,sy,0,sx,sy,r*3);
        grd.addColorStop(0,o.color+'bb'); grd.addColorStop(1,o.color+'00');
        ctx.fillStyle=grd; ctx.beginPath(); ctx.arc(sx,sy,r*3,0,Math.PI*2); ctx.fill();
        ctx.shadowBlur=22; ctx.shadowColor=o.color; ctx.fillStyle=o.color; ctx.beginPath(); ctx.arc(sx,sy,r,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='#fff'; ctx.shadowBlur=4; ctx.beginPath(); ctx.arc(sx-r*.25,sy-r*.25,r*.3,0,Math.PI*2); ctx.fill();
        ctx.shadowBlur=0;
        ctx.font=`bold 8px Orbitron`; ctx.fillStyle='#fff'; ctx.textAlign='center'; ctx.globalAlpha=0.6;
        ctx.fillText(`+${o.value}`,sx,sy+r*2+12); ctx.globalAlpha=1;
      }

      // Cars
      const drawCar=(x,y,angle,w,h,color,isP)=>{
        ctx.save(); ctx.translate(x-cx,y-cy); ctx.rotate(angle+Math.PI/2);
        ctx.shadowBlur=isP?24:16; ctx.shadowColor=color;
        ctx.fillStyle=isP?'#060e1a':'#140606'; ctx.strokeStyle=color; ctx.lineWidth=isP?2.5:2;
        ctx.beginPath(); ctx.roundRect(-w/2,-h/2,w,h,4); ctx.fill(); ctx.stroke();
        ctx.fillStyle=color; ctx.globalAlpha=0.35; ctx.beginPath(); ctx.roundRect(-w/2+3,-h/2+4,w-6,h*.27,2); ctx.fill(); ctx.globalAlpha=1;
        ctx.shadowBlur=12;
        ctx.fillStyle=isP?'#ccfeff':'#ffffcc'; ctx.shadowColor=isP?'#00ffff':'#ffffa0';
        ctx.fillRect(-w/2+2,-h/2+2,6,4); ctx.fillRect(w/2-8,-h/2+2,6,4);
        ctx.fillStyle=isP?'#ff2d6e':'#ff5500'; ctx.shadowColor=isP?'#ff2d6e':'#ff5500';
        ctx.fillRect(-w/2+2,h/2-6,6,4); ctx.fillRect(w/2-8,h/2-6,6,4);
        if (!isP) { const f=Math.floor(now*2.5)%2; ctx.fillStyle=f?'#ff4444':'#4444ff'; ctx.shadowColor=f?'#f00':'#00f'; ctx.fillRect(-w/2+3,-h/2+10,w-6,3); }
        if (isP&&p.shieldTimer>0) { ctx.globalAlpha=0.35+0.2*Math.sin(now*6); const sg=ctx.createRadialGradient(0,0,8,0,0,38); sg.addColorStop(0,'rgba(0,247,255,0.2)'); sg.addColorStop(1,'rgba(0,247,255,0)'); ctx.fillStyle=sg; ctx.beginPath(); ctx.arc(0,0,38,0,Math.PI*2); ctx.fill(); ctx.globalAlpha=1; }
        ctx.shadowBlur=0; ctx.restore();
      };
      for (const cop of g.cops) drawCar(cop.x,cop.y,cop.angle,cop.w,cop.h,cop.color,false);
      if (p.alive && !(p.hitTimer>0&&Math.floor(p.hitTimer*8)%2===0)) drawCar(p.x,p.y,p.angle,p.w,p.h,p.color,true);

      // Particles
      for (const pt of g.particles) {
        const a=pt.life/pt.ml; ctx.globalAlpha=a; ctx.fillStyle=pt.color; ctx.shadowBlur=8; ctx.shadowColor=pt.color;
        ctx.beginPath(); ctx.arc(pt.x-cx,pt.y-cy,Math.max(0.1,pt.r*a),0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha=1; ctx.shadowBlur=0;

      // Speed lines
      if (Math.abs(p.speed)>80) {
        const al=Math.min(0.28,(Math.abs(p.speed)-80)/280);
        ctx.globalAlpha=al; ctx.strokeStyle='#00f7ff'; ctx.lineWidth=1;
        for (let i=0;i<20;i++) { const a=i/20*Math.PI*2, ir=170+Math.sin(now*2+i)*12, or=ir+50+Math.random()*32; ctx.beginPath(); ctx.moveTo(GW/2+Math.cos(a)*ir,GH/2+Math.sin(a)*ir); ctx.lineTo(GW/2+Math.cos(a)*or,GH/2+Math.sin(a)*or); ctx.stroke(); }
        ctx.globalAlpha=1;
      }
      ctx.restore();

      // ── MINIMAP ─────────────────────────────────────────
      // Shows: city grid, A* GPS route (green), Minimax zones (red),
      //        orbs (dots), cops (dots), player (blinking)
      const sc=MM/(GRID_W*TILE);
      mmCtx.clearRect(0,0,MM,MM);
      mmCtx.fillStyle='rgba(0,5,18,0.97)'; mmCtx.fillRect(0,0,MM,MM);
      // Grid
      for (let gy2=0;gy2<GRID_H;gy2++) for (let gx2=0;gx2<GRID_W;gx2++) {
        mmCtx.fillStyle=grid[gy2][gx2]===1?'#07071a':'#0e0e28';
        mmCtx.fillRect(gx2*TILE*sc,gy2*TILE*sc,TILE*sc,TILE*sc);
      }
      // Minimax intercept zones (UNIT 3 visualization)
      mmCtx.globalAlpha=0.5;
      for (const z of g.minimaxZones) {
        const ms=TILE*sc;
        mmCtx.fillStyle=`rgba(255,45,110,${0.4-z.depth*0.08})`;
        mmCtx.shadowBlur=6; mmCtx.shadowColor='#ff2d6e';
        mmCtx.fillRect(z.gx*TILE*sc-ms*.4,z.gy*TILE*sc-ms*.4,ms*1.8,ms*1.8);
      }
      mmCtx.shadowBlur=0; mmCtx.globalAlpha=1;
      // A* path (UNIT 2 visualization) — player GPS route
      if (g.astarPath.length>1) {
        mmCtx.strokeStyle='#00ff88'; mmCtx.lineWidth=1.8; mmCtx.shadowBlur=5; mmCtx.shadowColor='#00ff88'; mmCtx.setLineDash([3,4]);
        mmCtx.beginPath(); mmCtx.moveTo(g.astarPath[0].gx*TILE*sc+TILE*sc/2,g.astarPath[0].gy*TILE*sc+TILE*sc/2);
        for (let i=1;i<g.astarPath.length;i++) mmCtx.lineTo(g.astarPath[i].gx*TILE*sc+TILE*sc/2,g.astarPath[i].gy*TILE*sc+TILE*sc/2);
        mmCtx.stroke(); mmCtx.setLineDash([]); mmCtx.shadowBlur=0;
      }
      // Cop A* routes (purple — each cop's path)
      for (const cop of g.cops) {
        if (cop.astarPath&&cop.astarPath.length>1) {
          mmCtx.strokeStyle='rgba(177,79,255,0.4)'; mmCtx.lineWidth=1; mmCtx.setLineDash([2,4]);
          mmCtx.beginPath(); mmCtx.moveTo(cop.astarPath[0].gx*TILE*sc+TILE*sc/2,cop.astarPath[0].gy*TILE*sc+TILE*sc/2);
          for (let i=1;i<cop.astarPath.length;i++) mmCtx.lineTo(cop.astarPath[i].gx*TILE*sc+TILE*sc/2,cop.astarPath[i].gy*TILE*sc+TILE*sc/2);
          mmCtx.stroke(); mmCtx.setLineDash([]);
        }
      }
      // Orbs
      for (const o of g.orbs) { mmCtx.fillStyle=o.color; mmCtx.shadowBlur=5; mmCtx.shadowColor=o.color; mmCtx.beginPath(); mmCtx.arc(o.x*sc,o.y*sc,2.5,0,Math.PI*2); mmCtx.fill(); }
      mmCtx.shadowBlur=0;
      // Cops
      for (const cop of g.cops) { mmCtx.fillStyle=cop.isLead?'#ff8800':'#ff2d6e'; mmCtx.shadowBlur=5; mmCtx.shadowColor='#ff2d6e'; mmCtx.beginPath(); mmCtx.arc(cop.x*sc,cop.y*sc,cop.isLead?3.5:2.5,0,Math.PI*2); mmCtx.fill(); }
      mmCtx.shadowBlur=0;
      // Player (blinking)
      const blink=Math.sin(now*7)*0.4+0.6;
      mmCtx.globalAlpha=blink; mmCtx.fillStyle='#00f7ff'; mmCtx.shadowBlur=10; mmCtx.shadowColor='#00f7ff';
      mmCtx.beginPath(); mmCtx.arc(p.x*sc,p.y*sc,4,0,Math.PI*2); mmCtx.fill();
      mmCtx.globalAlpha=1; mmCtx.shadowBlur=0;
      // Camera viewport
      mmCtx.strokeStyle='rgba(0,247,255,0.22)'; mmCtx.lineWidth=1; mmCtx.strokeRect(g.camX*sc,g.camY*sc,GW*sc,GH*sc);
      // Legend text
      mmCtx.font='6px monospace';
      mmCtx.fillStyle='rgba(0,255,136,0.5)'; mmCtx.fillText('A*',3,8);
      mmCtx.fillStyle='rgba(177,79,255,0.4)'; mmCtx.fillText('COP PATH',3,16);
      mmCtx.fillStyle='rgba(255,45,110,0.4)'; mmCtx.fillText('INTERCEPT',3,24);
    }

    rafRef.current=requestAnimationFrame(loop);
    return ()=>cancelAnimationFrame(rafRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[screen]);

  const {score,time,wantedLevel,health,nitro,boost,shield,keys}=hud;
  const hc=health>0.6?'#00ffaa':health>0.3?'#ffaa00':'#ff2d6e';
  const aL=keys['KeyA']||keys['ArrowLeft'], aR=keys['KeyD']||keys['ArrowRight'];
  const aU=keys['KeyW']||keys['ArrowUp'],   aD=keys['KeyS']||keys['ArrowDown'];

  return (
    <div className="root">
      <div className="scanlines"/>
      <canvas ref={canvasRef} width={GW} height={GH}
        style={{position:'absolute',width:Math.min(window.innerWidth,window.innerHeight*GW/GH),height:Math.min(window.innerHeight,window.innerWidth*GH/GW)}}/>

      {/* HUD */}
      {(screen==='playing'||screen==='paused')&&<>
        {wantedLevel>=2&&<div className="siren-edge"/>}
        <div className="hud">
          <div className="panel score-p"><div className="panel-label">Data Stolen</div><div className="panel-val">{score}</div></div>
          <div className="panel timer-p"><div className="panel-label">Survive</div><div className="panel-val">{time}</div></div>
          <div className="panel wanted-p">
            <div className="panel-label">Wanted Level</div>
            <div className="stars">{[1,2,3,4,5].map(i=><div key={i} className={`star${i<=wantedLevel?' on':''}`}/>)}</div>
          </div>
          <div className="panel hp-p">
            <div className="panel-label">Hull Integrity</div>
            <div className="bar-track"><div className="bar-fill" style={{width:`${health*100}%`,background:`linear-gradient(90deg,${hc},${hc}aa)`,color:hc}}/></div>
          </div>
          <div className="panel nitro-p">
            <div className="panel-label">{boost?'⚡ NITRO ACTIVE':shield?'🛡 SHIELD':'Nitro — SPACE'}</div>
            <div className="bar-track"><div className="bar-fill nitro-fill" style={{width:boost?'100%':`${nitro*100}%`,background:boost?'linear-gradient(90deg,#ffaa00,#ff2d6e)':shield?'linear-gradient(90deg,#00f7ff,#b14fff)':undefined}}/></div>
          </div>
          {/* AI Legend */}
          <div className="ai-legend">
            <div className="leg-row"><div className="leg-dot" style={{background:'#00ff88',boxShadow:'0 0 6px #00ff88'}}/><span style={{color:'rgba(0,255,136,0.7)'}}>A* GPS ROUTE</span></div>
            <div className="leg-row"><div className="leg-dot" style={{background:'#b14fff',boxShadow:'0 0 6px #b14fff'}}/><span style={{color:'rgba(177,79,255,0.7)'}}>COP A* PATH</span></div>
            <div className="leg-row"><div className="leg-dot" style={{background:'#ff2d6e',boxShadow:'0 0 6px #ff2d6e'}}/><span style={{color:'rgba(255,45,110,0.7)'}}>MINIMAX ZONE</span></div>
          </div>
          <div className="hints">
            <span className={aU?'ak':''}>W/↑</span> ACCEL &nbsp; <span className={aD?'ak':''}>S/↓</span> BRAKE<br/>
            <span className={aL?'ak':''}>A/←</span> <span className={aR?'ak':''}>D/→</span> STEER &nbsp; <span>SPACE</span> NITRO<br/>
            <span>ESC</span> PAUSE
          </div>
          {toasts.map(t=><div key={t.id} className="toast" style={{color:t.color,borderTop:`2px solid ${t.color}`,background:`${t.color}11`,boxShadow:`0 0 15px ${t.color}44`}}>{t.text}</div>)}
          {popups.map(pp=><div key={pp.id} className="spop" style={{left:pp.x,top:pp.y,color:pp.color,textShadow:`0 0 8px ${pp.color}`}}>{pp.text}</div>)}
          <div className="minimap-wrap">
            <canvas ref={mmRef} width={MM} height={MM}/>
            <div className="mm-label">TACTICAL RADAR</div>
          </div>
        </div>
      </>}

      {screen==='paused'&&<div className="pause-ov" onClick={()=>setScreen('playing')}><div className="pause-txt">PAUSED</div></div>}
      {screen==='start'&&<StartScreen onPlay={startGame} hs={hs}/>}
      {screen==='gameover'&&<GameOver stats={final} hs={hs} onRetry={startGame}/>}
    </div>
  );
}

function StartScreen({onPlay,hs}) {
  const bgRef=useRef(null), raf=useRef(null);
  useEffect(()=>{
    const c=bgRef.current; if(!c) return;
    const ctx=c.getContext('2d');
    const pts=Array.from({length:80},()=>({x:Math.random()*GW,y:Math.random()*GH,vx:(Math.random()-.5)*22,vy:(Math.random()-.5)*22,color:['#00f7ff','#b14fff','#ff2d6e','#00ffaa'][Math.floor(Math.random()*4)],r:Math.random()*1.5+0.3,a:Math.random()*0.5+0.2}));
    let lt=0;
    const draw=ts=>{const dt=Math.min((ts-lt)/1000,0.05);lt=ts;ctx.fillStyle='rgba(0,0,10,0.16)';ctx.fillRect(0,0,GW,GH);
      for(let i=0;i<pts.length;i++)for(let j=i+1;j<pts.length;j++){const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy);if(d<90){ctx.globalAlpha=(1-d/90)*0.12;ctx.strokeStyle=pts[i].color;ctx.lineWidth=0.5;ctx.beginPath();ctx.moveTo(pts[i].x,pts[i].y);ctx.lineTo(pts[j].x,pts[j].y);ctx.stroke();}}
      ctx.globalAlpha=1;
      for(const p of pts){p.x+=p.vx*dt;p.y+=p.vy*dt;if(p.x<0)p.x=GW;if(p.x>GW)p.x=0;if(p.y<0)p.y=GH;if(p.y>GH)p.y=0;ctx.globalAlpha=p.a;ctx.fillStyle=p.color;ctx.shadowBlur=7;ctx.shadowColor=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;}
      ctx.globalAlpha=1;raf.current=requestAnimationFrame(draw);};
    raf.current=requestAnimationFrame(draw);return()=>cancelAnimationFrame(raf.current);
  },[]);
  return (
    <div className="start">
      <canvas ref={bgRef} width={GW} height={GH} className="start-bg"/>
      <div className="scan"/>
      <div className="sct">
        <div className="eyebrow">// CLASSIFIED TRANSMISSION //</div>
        <div className="t1">CYBER</div><div className="t2">HEIST</div>
        <div className="t3">GETAWAY DASH</div>
        <button className="pbtn" onClick={onPlay}>JACK IN</button>
        <div className="tips-row">
          <div className="tip-item"><span className="tip-k">W A S D / Arrows</span>Drive</div>
          <div className="tip-item"><span className="tip-k">SPACE</span>Nitro</div>
          <div className="tip-item"><span className="tip-k">Orbs</span>Collect Data</div>
          <div className="tip-item"><span className="tip-k">Cops</span>Avoid / Escape</div>
          <div className="tip-item"><span className="tip-k">ESC</span>Pause</div>
        </div>
        {hs>0&&<div className="hs">BEST: {hs}</div>}
      </div>
    </div>
  );
}

function GameOver({stats,hs,onRetry}) {
  return (
    <div className="go">
      <div className="go-title">BUSTED</div>
      <div className="go-sub">SIGNAL LOST — TRANSMISSION TERMINATED</div>
      <div className="go-stats">
        <div className="go-stat"><div className="go-sl">Data Stolen</div><div className="go-sv">{stats.score}</div></div>
        <div className="go-stat"><div className="go-sl">Survived</div><div className="go-sv">{stats.time}</div></div>
        <div className="go-stat"><div className="go-sl">Wanted Level</div><div className="go-sv">{'★'.repeat(Math.max(1,stats.wanted))}</div></div>
        <div className="go-stat"><div className="go-sl">Best Score</div><div className="go-sv" style={{color:'#ffcc00',textShadow:'0 0 12px #ffcc00'}}>{hs}</div></div>
      </div>
      <button className="rbtn" onClick={onRetry}>RETRY HEIST</button>
    </div>
  );
}
