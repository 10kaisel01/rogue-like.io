(function(){
"use strict";

/* ============================================================
   SETUP
   ============================================================ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
resize(); window.addEventListener('resize', resize);

const $ = (id)=>document.getElementById(id);

/* ============================================================
   CONSTANTS / DATA
   ============================================================ */
const ARENA_PAD = 70;
const MAX_PLAYER_SPEED = 430;   // hard cap so speed items/synergies can't stack into an uncontrollable blur — raised to give flat speed items more room to matter
const MIN_ATK_CD = 0.18;        // attack-speed cap: can't fire faster than this regardless of cdMult stacking
const MIN_ABILITY_CD = 1.2;     // floor for Q/E cooldowns
const MIN_ULT_CD = 30;          // the R ultimate's cooldown never drops below this, no matter how much cdMult is stacked
const CD_MULT_FLOOR = 0.40;     // cdMult itself can't be reduced past this no matter how many cooldown items stack — caps total cooldown reduction around 60%
function effectiveCdMult(p){ return Math.max(CD_MULT_FLOOR, p.cdMult); }
function computeWorldBounds(){
  const baseW = canvas.width - ARENA_PAD*2;
  const baseH = canvas.height - ARENA_PAD*2 - 40;
  return { x: ARENA_PAD, y: ARENA_PAD+40, w: baseW*1.15, h: baseH*1.15 };
}
function arenaBounds(){
  return (game && game.world) ? game.world : computeWorldBounds();
}
// distance from (x,y) traveling at angle ang until it exits the arena bounds
function rayToBounds(x,y,ang,b){
  const dx=Math.cos(ang), dy=Math.sin(ang);
  let tMax = Infinity;
  if(dx>0.0001) tMax = Math.min(tMax, (b.x+b.w-x)/dx);
  else if(dx<-0.0001) tMax = Math.min(tMax, (b.x-x)/dx);
  if(dy>0.0001) tMax = Math.min(tMax, (b.y+b.h-y)/dy);
  else if(dy<-0.0001) tMax = Math.min(tMax, (b.y-y)/dy);
  return Math.max(0, tMax);
}

// Sistema Activo de Racha de Combo: any hero can register an effect that fires once their combo
// streak crosses a threshold. `trigger` is what has to happen while at/above that streak —
// 'melee' fires per melee hit (receives the target), 'q'/'e' fire when that ability resolves.
// Scales to all 39 heroes for free — adding one just means adding an entry here, nothing else
// needs to change (doBasicAttack and every ability already call triggerComboEffect).
// Declared above HEROES/buildRoster() on purpose: buildRoster() runs once at top level as soon
// as the script loads (to paint the character-select screen), and it reads COMBO_EFFECTS to show
// the passive on each hero's card — so this has to exist before that call, not just before combat.
const COMBO_EFFECTS = {
  guerrero: { threshold:10, trigger:'melee',
    desc:'Racha x10: tus golpes cuerpo a cuerpo aplican Hemorragia',
    apply:(p, target)=>{
      if(!target || !game.enemies.includes(target)) return; // the bleed DOT only works on common enemies — see updateEnemies
      target.bleedTimer = 3;
      target.bleedTick = Math.min(target.bleedTick||0, 0.5);
      target.bleedDmgBase = p.def.atk.dmg*0.25;
    } },
  maga: { threshold:15, trigger:'e',
    desc:'Racha x15: Parpadeo genera una onda de daño al aterrizar',
    apply:(p)=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<130) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.2), 'combo');
      });
      addParticles(p.x,p.y,'#6a8dff',20,180,0.4);
      spawnShockwave(p.x,p.y,'#6a8dff',130,0.3);
    } },
  picaro: { threshold:12, trigger:'e',
    desc:'Racha x12: Paso Sombrío deja tu próximo golpe con un súper crítico garantizado',
    apply:(p)=>{ p.effects.shadowCrit = true; addParticles(p.x,p.y,'#d24aff',14,150,0.3); } },
  paladin: { threshold:10, trigger:'e',
    desc:'Racha x10: Golpe Divino también te da un escudo',
    apply:(p)=>{ p.shield = Math.max(p.shield, 40); addParticles(p.x,p.y,'#ffcb47',16,160,0.3); } },
  nigromante: { threshold:12, trigger:'e',
    desc:'Racha x12: Velo de la Muerte drena mucha más vida',
    apply:(p)=>{
      let healed=0;
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<160){ const d=computeDamage(p.def.atk.dmg*0.6); dealDamageToTarget(t,d,'combo'); healed+=d.value*0.4; }
      });
      p.hp = Math.min(p.maxHp, p.hp+healed);
      addParticles(p.x,p.y,'#8a2fbf',16,160,0.3);
    } },
  vidrio: { threshold:8, trigger:'q',
    desc:'Racha x8: Golpe Fatal siempre sale como súper crítico',
    apply:(p)=>{ p.effects.shadowCrit = true; addParticles(p.x,p.y,'#e8e8f5',14,160,0.3); } },
  coloso: { threshold:10, trigger:'q',
    desc:'Racha x10: Grito Ominoso aturde por mucho más tiempo',
    apply:(p)=>{
      game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<260) t.stunTimer = Math.max(t.stunTimer||0, 1.4); });
      addParticles(p.x,p.y,'#9c8a6a',14,150,0.3);
    } },
  silvano: { threshold:10, trigger:'e',
    desc:'Racha x10: Sacrificio detona con mucha más fuerza',
    apply:(p)=>{
      if(game.pet){ explodeAt(game.pet.x, game.pet.y, 60, computeDamage(p.def.atk.dmg*1.2), '#5bbf7a'); }
    } },
  dual: { threshold:10, trigger:'e',
    desc:'Racha x10: Golpe Combinado deja una onda extra a tu alrededor',
    apply:(p)=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<120) dealDamageToTarget(t, computeDamage(p.def.atkMelee.dmg*0.9), 'combo'); });
      spawnShockwave(p.x,p.y,'#e8e8f5',120,0.3);
    } },
  monje: { threshold:12, trigger:'q',
    desc:'Racha x12: Ráfaga de Golpes te cura una porción de lo que golpea',
    apply:(p)=>{ p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.05); addParticles(p.x,p.y,'#e8e8f5',12,140,0.3); } },
  arquera: { threshold:12, trigger:'q',
    desc:'Racha x12: Flecha Perforante libera una ráfaga extra en cono al disparar',
    apply:(p)=>{
      game.enemies.forEach(t=>{
        const ang = Math.atan2(t.y-p.y,t.x-p.x);
        let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
        if(diff<0.35 && dist(p.x,p.y,t.x,t.y)<400) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.7), 'combo');
      });
      addParticles(p.x,p.y,'#8bffb0',10,150,0.25);
    } },
  elementalista: { threshold:12, trigger:'q',
    desc:'Racha x12: Cadena de Rayos aturde brevemente a todo lo que golpea',
    apply:(p)=>{
      game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<420) t.stunTimer = Math.max(t.stunTimer||0, 0.4); });
    } },
  berserker: { threshold:15, trigger:'melee',
    desc:'Racha x15: tus golpes cuerpo a cuerpo te curan un poco de vida',
    apply:(p)=>{ p.hp = Math.min(p.maxHp, p.hp+2); } },
  ilusionista: { threshold:10, trigger:'q',
    desc:'Racha x10: Espejismo invoca un señuelo más resistente y agresivo',
    apply:(p)=>{ if(game.pet){ game.pet.life = Math.min(game.pet.life+4, 20); game.pet.dmg = Math.round(game.pet.dmg*1.3); } } },
  alquimista: { threshold:10, trigger:'q',
    desc:'Racha x10: Frasco Corrosivo también infecta con Plaga',
    apply:(p)=>{
      game.enemies.forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<120){ t.plagueTimer=Math.max(t.plagueTimer||0,3); t.plagueTick=0; t.plagueDmgBase=p.def.atk.dmg*0.3; }
      });
    } },
  druida: { threshold:12, trigger:'melee',
    desc:'Racha x12: tus golpes cuerpo a cuerpo te curan un poco de vida',
    apply:(p)=>{ p.hp = Math.min(p.maxHp, p.hp+2.5); } },
  sangre: { threshold:10, trigger:'e',
    desc:'Racha x10: Pacto de Sangre también duplica tu robo de vida por 5s',
    apply:(p)=>{ p.lifestealBurstTimer = Math.max(p.lifestealBurstTimer||0, 5); addParticles(p.x,p.y,'#c9384a',14,150,0.3); } },
  centinela: { threshold:10, trigger:'q',
    desc:'Racha x10: Golpe Sísmico alcanza mucho más lejos',
    apply:(p)=>{
      game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<280) { dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.5), 'combo'); t.stunTimer=Math.max(t.stunTimer||0,0.5); } });
    } },
  cazador: { threshold:12, trigger:'e',
    desc:'Racha x12: Salto de Sombra deja al objetivo marcado, recibe daño extra por 3s',
    apply:(p)=>{
      const targets=[...game.enemies, ...bossTargets()];
      let nearest=null, nearestD=140;
      targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
      if(nearest){ nearest.weakenMarkTimer=3; dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*0.8), 'combo'); }
    } },
  torque: { threshold:10, trigger:'e',
    desc:'Racha x10: Cadena Punitiva golpea en un radio mayor',
    apply:(p)=>{
      const origin = (p.lastHookTarget && p.lastHookTarget.hp>0) ? p.lastHookTarget : p;
      [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(origin.x,origin.y,t.x,t.y)<100) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.7), 'combo'); });
    } },
  frey: { threshold:10, trigger:'q',
    desc:'Racha x10: Escarcha Total congela por más tiempo',
    apply:(p)=>{
      const targets=[...game.enemies, ...bossTargets()];
      let nearest=null, nearestD=340;
      targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
      if(nearest) nearest.stunTimer = Math.max(nearest.stunTimer||0, 0.8);
    } },
  dorian: { threshold:10, trigger:'e',
    desc:'Racha x10: Contragolpe libera una onda extra a tu alrededor',
    apply:(p)=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<110) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.6), 'combo'); });
    } },
  ferro: { threshold:10, trigger:'q',
    desc:'Racha x10: la Torreta sale sobrecargada, dispara más rápido',
    apply:(p)=>{ if(game.pet) game.pet.atkCd = Math.max(0.2, game.pet.atkCd*0.6); } },
  mecha: { threshold:10, trigger:'e',
    desc:'Racha x10: Detonación Remota deja una explosión extra en tu posición',
    apply:(p)=>{ explodeAt(p.x, p.y, 90, computeDamage(p.def.atk.dmg*1.1), '#c9a24a'); } },
  arakne: { threshold:10, trigger:'e',
    desc:'Racha x10: Embestida de Seda deja una zona de telaraña al terminar',
    apply:(p)=>{ game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<110) t.slowTimer = Math.max(t.slowTimer||0, 2); }); } },
  rasha: { threshold:10, trigger:'e',
    desc:'Racha x10: Embestida de Jauría hace más daño',
    apply:(p)=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<140) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.5), 'combo'); });
    } },
  marlow: { threshold:10, trigger:'e',
    desc:'Racha x10: Tirón de Hilo aturde por más tiempo',
    apply:(p)=>{ game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<180) t.stunTimer = Math.max(t.stunTimer||0, 0.5); }); } },
  orbis: { threshold:12, trigger:'e',
    desc:'Racha x12: Colapso también daña a los jefes cercanos con más fuerza',
    apply:(p)=>{ bossTargets().forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<250) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.6), 'combo'); }); } },
  skald: { threshold:10, trigger:'e',
    desc:'Racha x10: Detonar Runas también te cura',
    apply:(p)=>{ p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.06); } },
  morbus: { threshold:10, trigger:'q',
    desc:'Racha x10: Plaga inflige un golpe de daño instantáneo además de infectar',
    apply:(p)=>{
      const targets=[...game.enemies, ...bossTargets()];
      let nearest=null, nearestD=360;
      targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
      if(nearest) dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*0.6), 'combo');
    } },
  tempus: { threshold:12, trigger:'e',
    desc:'Racha x12: Rebobinado también te da un breve escudo',
    apply:(p)=>{ p.shield = Math.max(p.shield, 35); } },
  seren: { threshold:10, trigger:'e',
    desc:'Racha x10: Giro Final deja una onda extra',
    apply:(p)=>{ spawnShockwave(p.x,p.y,'#ff8fd0',110,0.25); [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<110) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.5), 'combo'); }); } },
  rowan: { threshold:10, trigger:'e',
    desc:'Racha x10: Desmontar aturde a todo lo que golpea',
    apply:(p)=>{ game.enemies.forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<150) t.stunTimer = Math.max(t.stunTimer||0, 0.5); }); } },
  talus: { threshold:10, trigger:'e',
    desc:'Racha x10: Emboscada deja una erupción extra al llegar',
    apply:(p)=>{ game.pendingBursts.push({ x:p.x, y:p.y, timer:0.3, radius:70, dmgBase:p.def.atk.dmg*0.8 }); } },
  lira: { threshold:12, trigger:'e',
    desc:'Racha x12: Crescendo también te da un breve escudo',
    apply:(p)=>{ p.shield = Math.max(p.shield, 35); } },
  amara: { threshold:10, trigger:'e',
    desc:'Racha x10: Autodestrucción hace más daño',
    apply:(p)=>{
      const possessed = game.pack.filter(m=>m.possessed);
      possessed.forEach(m=>{ explodeAt(m.x, m.y, 50, computeDamage(p.def.atk.dmg*0.8), '#9c6fd8'); });
    } },
  midas: { threshold:10, trigger:'q',
    desc:'Racha x10: Toque Dorado te da un escudo extra sin costo adicional',
    apply:(p)=>{ p.shield += 25; } },
  borea: { threshold:10, trigger:'e',
    desc:'Racha x10: Liberar hace más daño',
    apply:(p)=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{ if(dist(p.x,p.y,t.x,t.y)<170) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.5), 'combo'); });
    } },
  anselm: { threshold:10, trigger:'e',
    desc:'Racha x10: Romper Forma te deja un escudo residual',
    apply:(p)=>{ p.shield = Math.max(p.shield, 30); } },
};
function triggerComboEffect(trigger, target){
  const p = game.player;
  const cfg = COMBO_EFFECTS[p.def.id];
  if(!cfg || cfg.trigger!==trigger) return;
  if(p.combo < cfg.threshold) return;
  cfg.apply(p, target);
}

const HEROES = {
  guerrero: {
    id:'guerrero', name:'Bastión', className:'Guerrero', icon:'⚔', accent:'#ff6a3d', glow:'rgba(255,106,61,0.35)',
    hp:245, speed:250, atk:{cd:0.42, dmg:16, range:104, arc:75, kind:'melee'},
    q:{name:'Embestida', icon:'➳', cd:4.2, desc:'Dash largo con inmunidad, golpea fuerte a su paso'},
    e:{name:'Grito de Guerra', icon:'☠', cd:12, desc:'+35% daño y empuja enemigos cerca, 5s'},
    scaling:{stat:'hp', perLevel:0.035},
  },
  maga: {
    id:'maga', name:'Ignis', className:'Maga', icon:'✵', accent:'#6a8dff', glow:'rgba(106,141,255,0.35)',
    hp:56, speed:206, atk:{cd:0.38, dmg:10, range:520, projSpeed:520, radius:7, kind:'ranged'},
    q:{name:'Bola de Fuego', icon:'●', cd:5, desc:'Proyectil grande y lento que explota en área'},
    e:{name:'Parpadeo', icon:'❖', cd:8, desc:'Teletransporte corto de escape'},
    scaling:{stat:'dmg', perLevel:0.035},
  },
  picaro: {
    id:'picaro', name:'Sombra', className:'Pícaro', icon:'✦', accent:'#d24aff', glow:'rgba(210,74,255,0.35)',
    hp:80, speed:250, atk:{cd:0.28, dmg:7, range:480, projSpeed:640, radius:5, kind:'ranged'},
    q:{name:'Ráfaga de Dagas', icon:'⇶', cd:9, desc:'4 dagas en abanico'},
    e:{name:'Paso Sombrío', icon:'☾', cd:16, desc:'Invisibilidad breve + velocidad + golpe crítico'},
    scaling:{stat:'dmg', perLevel:0.03},
  },
  paladin: {
    id:'paladin', name:'Aurelio', className:'Paladín', icon:'✝', accent:'#ffcb47', glow:'rgba(255,203,71,0.35)',
    hp:190, speed:235, atk:{cd:0.5, dmg:15, range:100, arc:76, kind:'melee'},
    q:{name:'Escudo Sagrado', icon:'⛨', cd:9, desc:'Absorbe el próximo golpe de daño; si te pegan en los primeros 0.4s, es un bloqueo perfecto que reinicia tus habilidades'},
    e:{name:'Golpe Divino', icon:'✜', cd:11, desc:'Cura y daña a enemigos cercanos'},
    locked:true, unlockAch:'threeBosses',
    scaling:{stat:'hp', perLevel:0.035},
  },
  nigromante: {
    id:'nigromante', name:'Vesper', className:'Nigromante', icon:'☠', accent:'#8bff6b', glow:'rgba(139,255,107,0.35)',
    hp:95, speed:240, atk:{cd:0.5, dmg:11, range:440, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Estallido de Almas', icon:'☄', cd:6.5, desc:'Nova de daño alrededor tuyo'},
    e:{name:'Velo de la Muerte', icon:'✚', cd:12, desc:'Drena vida de enemigos cercanos'},
    locked:true, unlockAch:'depth6',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  vidrio: {
    id:'vidrio', name:'Fractal', className:'Vidrio', icon:'◆', accent:'#e8e8f5', glow:'rgba(232,232,245,0.4)',
    hp:48, speed:260, atk:{cd:0.48, dmg:26, range:82, arc:68, kind:'melee'},
    q:{name:'Golpe Fatal', icon:'✹', cd:5, desc:'Golpe crítico garantizado en área corta'},
    e:{name:'Piel de Cristal', icon:'⬡', cd:15, desc:'Escudo que absorbe un golpe grande'},
    locked:true, unlockAch:'noHitBoss',
    scaling:{stat:'dmg', perLevel:0.045},
  },
  coloso: {
    id:'coloso', name:'Grava', className:'Coloso', icon:'⛰', accent:'#9c8a6a', glow:'rgba(156,138,106,0.35)',
    hp:300, speed:205, atk:{cd:0.55, dmg:20, range:92, arc:80, kind:'melee'},
    q:{name:'Grito Ominoso', icon:'📯', cd:10, desc:'Atrae y aturde a los enemigos cercanos'},
    e:{name:'Muro de Voluntad', icon:'⛊', cd:14, desc:'Gran escudo y más resistencia por 4s; un golpe perfecto en los primeros 0.35s desata una onda a tu alrededor'},
    locked:true, unlockAch:'tankyRun',
    scaling:{stat:'hp', perLevel:0.045},
  },
  silvano: {
    id:'silvano', name:'Silvano', className:'Invocador', icon:'🐺', accent:'#5bbf7a', glow:'rgba(91,191,122,0.35)',
    hp:100, speed:245, atk:{cd:0.5, dmg:9, range:400, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Lobo Espectral', icon:'🐺', cd:9, desc:'Invoca un lobo que ataca solo'},
    e:{name:'Sacrificio', icon:'✳', cd:11, desc:'Detona al lobo en una explosión'},
    locked:true, unlockAch:'itemHoarder',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  dual: {
    id:'dual', name:'Ambos', className:'Dual', icon:'⚖', accent:'#5ac8d8', glow:'rgba(90,200,216,0.35)',
    hp:100, speed:255,
    atkMelee:{cd:0.4, dmg:14, range:82, arc:70, kind:'melee'},
    atkRanged:{cd:0.3, dmg:9, range:440, projSpeed:480, radius:6, kind:'ranged'},
    q:{name:'Cambio de Postura', icon:'⇄', cd:1.5, desc:'Alterna entre espada y cuchillos'},
    e:{name:'Golpe Combinado', icon:'✦', cd:8, desc:'Dash corto con daño en cualquier postura'},
    locked:true, unlockAch:'killStreak',
    scaling:[{stat:'hp', perLevel:0.02},{stat:'dmg', perLevel:0.02}],
  },
  monje: {
    id:'monje', name:'Kaelo', className:'Monje', icon:'☯', accent:'#ffb347', glow:'rgba(255,179,71,0.35)',
    hp:130, speed:265, atk:{cd:0.32, dmg:9, range:80, arc:72, kind:'melee'},
    q:{name:'Ráfaga de Golpes', icon:'☯', cd:6, desc:'4 golpes rápidos avanzando, cada uno en cono'},
    e:{name:'Postura de Calma', icon:'☮', cd:13, desc:'Invulnerabilidad breve, te cura y limpia todos los debuffs'},
    locked:true, unlockAch:'comboMaster',
    scaling:{stat:'dmg', perLevel:0.03},
  },
  arquera: {
    id:'arquera', name:'Yarah', className:'Arquera', icon:'➶', accent:'#8bffb0', glow:'rgba(139,255,176,0.35)',
    hp:70, speed:220, atk:{cd:0.55, dmg:17, range:620, projSpeed:680, radius:5, kind:'ranged'},
    q:{name:'Flecha Perforante', icon:'➹', cd:6.5, desc:'Flecha veloz que atraviesa a todos los enemigos en línea'},
    e:{name:'Lluvia de Flechas', icon:'☂', cd:12, desc:'Flechas caen sobre un área frente tuyo'},
    locked:true, unlockAch:'deepDescent15',
    scaling:{stat:'dmg', perLevel:0.04},
  },
  elementalista: {
    id:'elementalista', name:'Zephira', className:'Elementalista', icon:'♒', accent:'#6ad8ff', glow:'rgba(106,216,255,0.35)',
    hp:85, speed:215, atk:{cd:0.42, dmg:11, range:420, projSpeed:440, radius:7, kind:'ranged'},
    q:{name:'Cadena de Rayos', icon:'⚡', cd:6, desc:'Un rayo salta entre hasta 4 enemigos cercanos'},
    e:{name:'Escudo Elemental', icon:'✵', cd:14, desc:'Nova de daño alrededor tuyo y un escudo'},
    locked:true, unlockAch:'relicCollector',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  berserker: {
    id:'berserker', name:'Grum', className:'Berserker', icon:'🪓', accent:'#ff3d3d', glow:'rgba(255,61,61,0.35)',
    hp:220, speed:240, atk:{cd:0.4, dmg:18, range:96, arc:78, kind:'melee'},
    q:{name:'Giro Salvaje', icon:'🌀', cd:7, desc:'Gira golpeando todo alrededor durante 3s; más daño cuanta menos vida te queda'},
    e:{name:'Furia de Sangre', icon:'🩸', cd:14, desc:'Sacrificás vida a cambio de +daño temporal'},
    locked:true, unlockAch:'killStreak300',
    scaling:{stat:'hp', perLevel:0.04},
  },
  ilusionista: {
    id:'ilusionista', name:'Mirelle', className:'Ilusionista', icon:'🎭', accent:'#c9a8ff', glow:'rgba(201,168,255,0.35)',
    hp:75, speed:235, atk:{cd:0.45, dmg:9, range:460, projSpeed:500, radius:6, kind:'ranged'},
    q:{name:'Espejismo', icon:'👁', cd:8, desc:'Invoca un señuelo que ataca solo por un tiempo'},
    e:{name:'Intercambio', icon:'🔀', cd:12, desc:'Te teletransportás al señuelo y explota'},
    locked:true, unlockAch:'richRun',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  alquimista: {
    id:'alquimista', name:'Doc Brann', className:'Alquimista', icon:'⚗', accent:'#c9e85a', glow:'rgba(201,232,90,0.35)',
    hp:90, speed:230, atk:{cd:0.6, dmg:13, range:380, projSpeed:360, radius:8, kind:'ranged'},
    q:{name:'Frasco Corrosivo', icon:'🧪', cd:6, desc:'Frasco lanzado que explota en área'},
    e:{name:'Mezcla Volátil', icon:'💥', cd:11, desc:'Explosión que empuja enemigos y te cura'},
    locked:true, unlockAch:'veteranLevel',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  druida: {
    id:'druida', name:'Wren', className:'Druida', icon:'🐾', accent:'#9c7a4a', glow:'rgba(156,122,74,0.35)',
    hp:160, speed:245, atk:{cd:0.45, dmg:15, range:90, arc:74, kind:'melee'},
    q:{name:'Garras Salvajes', icon:'🐾', cd:5, desc:'Dash corto con zarpazo a su paso'},
    e:{name:'Forma Salvaje', icon:'🐺', cd:15, desc:'Transformación: +velocidad, +daño y algo de curación'},
    locked:true, unlockAch:'fiveBosses',
    scaling:{stat:'hp', perLevel:0.03},
  },
  sangre: {
    id:'sangre', name:'Ossian', className:'Mago de Sangre', icon:'🩸', accent:'#b91d3a', glow:'rgba(185,29,58,0.35)',
    hp:110, speed:220, atk:{cd:0.4, dmg:12, range:440, projSpeed:460, radius:6, kind:'ranged'},
    q:{name:'Golpe de Sangre', icon:'🩸', cd:5, desc:'Proyectil que hace más daño cuanta menos vida te queda; cuesta algo de vida'},
    e:{name:'Pacto de Sangre', icon:'⛧', cd:13, desc:'Convertís vida actual en un escudo mayor'},
    locked:true, unlockAch:'bloodCombo',
    scaling:{stat:'dmg', perLevel:0.04},
  },
  centinela: {
    id:'centinela', name:'Bram', className:'Centinela', icon:'🛡', accent:'#7a8a9c', glow:'rgba(122,138,156,0.35)',
    hp:280, speed:200, atk:{cd:0.58, dmg:19, range:98, arc:82, kind:'melee'},
    q:{name:'Golpe Sísmico', icon:'💢', cd:9, desc:'Onda que aturde y daña a los enemigos cercanos'},
    e:{name:'Fortificar', icon:'🛡', cd:15, desc:'Escudo grande y reducción de daño temporal'},
    locked:true, unlockAch:'fortressHp',
    scaling:{stat:'hp', perLevel:0.04},
  },
  cazador: {
    id:'cazador', name:'Nyx', className:'Cazador de Sombras', icon:'🗡', accent:'#8a6fd8', glow:'rgba(138,111,216,0.4)',
    hp:95, speed:258, atk:{cd:0.35, dmg:14, range:84, arc:66, kind:'melee'},
    q:{name:'Marca de Caza', icon:'☠', cd:6, desc:'Golpe certero: más daño cuanta menos vida le queda al objetivo'},
    e:{name:'Salto de Sombra', icon:'🌑', cd:11, desc:'Te teletransportás detrás del enemigo más cercano y lo apuñalás'},
    locked:true, unlockAch:'critMaster',
    scaling:{stat:'dmg', perLevel:0.04},
  },
  torque: {
    id:'torque', name:'Torque', className:'Arponero', icon:'🪝', accent:'#4fae9c', glow:'rgba(79,174,156,0.35)',
    hp:130, speed:225, atk:{cd:0.45, dmg:12, range:460, projSpeed:520, radius:6, kind:'ranged'},
    q:{name:'Garfio', icon:'🪝', cd:7, desc:'Engancha al enemigo más cercano frente tuyo, lo atrae y lo aturde'},
    e:{name:'Cadena Punitiva', icon:'⛓', cd:12, desc:'Golpea y aturde a los enemigos cerca del último objetivo enganchado'},
    locked:true, unlockAch:'deepDescent25',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  frey: {
    id:'frey', name:'Frey', className:'Portador de Escarcha', icon:'❄', accent:'#8fd8ff', glow:'rgba(143,216,255,0.35)',
    hp:100, speed:220, atk:{cd:0.5, dmg:12, range:420, projSpeed:440, radius:6, kind:'ranged'},
    q:{name:'Escarcha Total', icon:'❄', cd:8, desc:'Congela al enemigo más cercano, dejándolo indefenso'},
    e:{name:'Golpe Rompehielo', icon:'💠', cd:6, desc:'Golpe en área: hace añicos a los enemigos congelados para daño masivo'},
    locked:true, unlockAch:'armoredRun',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  dorian: {
    id:'dorian', name:'Dorian', className:'Duelista', icon:'🤺', accent:'#e0455a', glow:'rgba(224,69,90,0.35)',
    hp:150, speed:245, atk:{cd:0.4, dmg:14, range:88, arc:70, kind:'melee'},
    q:{name:'Postura de Parry', icon:'🤺', cd:9, desc:'Si te golpean durante la ventana, absorbés el golpe, explotás alrededor y ganás una carga de Contragolpe'},
    e:{name:'Contragolpe', icon:'⚔', cd:7, desc:'Golpe certero; consume una carga de Contragolpe (si la tenés) para un impacto devastador'},
    locked:true, unlockAch:'empoweredRun',
    scaling:{stat:'dmg', perLevel:0.04},
  },
  ferro: {
    id:'ferro', name:'Ferro', className:'Ingeniero', icon:'⚙', accent:'#c9a24a', glow:'rgba(201,162,74,0.35)',
    hp:120, speed:230, atk:{cd:0.42, dmg:11, range:380, projSpeed:480, radius:6, kind:'ranged'},
    q:{name:'Torreta', icon:'⚙', cd:10, desc:'Planta una torreta estacionaria que dispara sola a los enemigos cercanos'},
    e:{name:'Sobrecarga', icon:'💥', cd:8, desc:'Detona una carga en la posición de tu torreta y le recarga la vida útil (o te da un escudo si no tenés una activa)'},
    locked:true, unlockAch:'lifestealRun',
    scaling:{stat:'dmg', perLevel:0.03},
  },
  mecha: {
    id:'mecha', name:'Mecha', className:'Zapador', icon:'💣', accent:'#c96a4a', glow:'rgba(201,106,74,0.35)',
    hp:110, speed:235, atk:{cd:0.5, dmg:10, range:360, projSpeed:400, radius:7, kind:'ranged'},
    q:{name:'Sembrar Minas', icon:'💣', cd:6, desc:'Planta 2 minas de proximidad frente tuyo, se arman al toque y detonan solas con cualquier enemigo cerca'},
    e:{name:'Detonación Remota', icon:'💥', cd:10, desc:'Detona todas las minas activas al instante, estén donde estén'},
    locked:true, unlockAch:'veteranLevel15',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  arakne: {
    id:'arakne', name:'Arakne', className:'Tejedora', icon:'🕷', accent:'#b89cff', glow:'rgba(184,156,255,0.35)',
    hp:105, speed:240, atk:{cd:0.4, dmg:11, range:380, projSpeed:460, radius:6, kind:'ranged'},
    q:{name:'Red Pegajosa', icon:'🕸', cd:8, desc:'Un cono de telaraña enreda y ralentiza a los enemigos frente tuyo'},
    e:{name:'Embestida de Seda', icon:'🕷', cd:8, desc:'Dash que golpea a todo en tu camino; daño mucho mayor contra enemigos enredados'},
    locked:true, unlockAch:'regenRun',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  rasha: {
    id:'rasha', name:'Rasha', className:'Domadora de Manada', icon:'🦊', accent:'#e0a24a', glow:'rgba(224,162,74,0.35)',
    hp:115, speed:238, atk:{cd:0.42, dmg:10, range:360, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Convocar Manada', icon:'🦊', cd:5, desc:'Suma una cría a tu manada (hasta 4 a la vez); con la manada al máximo, les recarga la vida útil'},
    e:{name:'Embestida de Jauría', icon:'💥', cd:12, desc:'Toda tu manada converge y detona donde esté; si no tenés manada, te cura'},
    locked:true, unlockAch:'killStreak450',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  marlow: {
    id:'marlow', name:'Marlow', className:'Titiritero', icon:'🪆', accent:'#c98fd8', glow:'rgba(201,143,216,0.35)',
    hp:110, speed:230, atk:{cd:0.42, dmg:10, range:380, projSpeed:440, radius:6, kind:'ranged'},
    q:{name:'Marioneta', icon:'🪆', cd:9, desc:'Planta una marioneta ancla, quieta, que no ataca'},
    e:{name:'Tirón de Hilo', icon:'⛓', cd:9, desc:'Recuperás la marioneta de un tirón, dañando y arrastrando hacia vos todo lo que estaba cerca de ella'},
    locked:true, unlockAch:'richRun1000',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  orbis: {
    id:'orbis', name:'Orbis', className:'Gravimante', icon:'🪐', accent:'#8a5fd8', glow:'rgba(138,95,216,0.35)',
    hp:100, speed:215, atk:{cd:0.48, dmg:12, range:400, projSpeed:400, radius:7, kind:'ranged'},
    q:{name:'Pozo de Gravedad', icon:'🪐', cd:11, desc:'Crea un pozo que atrae y daña a los enemigos comunes cercanos por un tiempo'},
    e:{name:'Colapso', icon:'💥', cd:9, desc:'Hace colapsar el pozo activo en una explosión que lanza y daña a todo alrededor; si no hay pozo, te da un escudo'},
    locked:true, unlockAch:'comboMaster55',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  skald: {
    id:'skald', name:'Skald', className:'Caballero Rúnico', icon:'ᚱ', accent:'#b08d57', glow:'rgba(176,141,87,0.35)',
    hp:170, speed:225, atk:{cd:0.45, dmg:15, range:92, arc:72, kind:'melee'},
    q:{name:'Inscribir Runa', icon:'ᚱ', cd:5, desc:'Ganás una carga de runa (hasta 5) y un breve empuje de daño'},
    e:{name:'Detonar Runas', icon:'💥', cd:8, desc:'Consume todas tus runas en una explosión cuyo daño escala con cuántas tenías; sin runas, te da un escudo'},
    locked:true, unlockAch:'deepDescent35',
    scaling:{stat:'hp', perLevel:0.035},
  },
  morbus: {
    id:'morbus', name:'Morbus', className:'Médico de la Plaga', icon:'☣', accent:'#7ad14a', glow:'rgba(122,209,74,0.35)',
    hp:115, speed:225, atk:{cd:0.45, dmg:10, range:380, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Plaga', icon:'☣', cd:7, desc:'Infecta al enemigo más cercano; la plaga salta sola a otros enemigos cercanos mientras hace tictac'},
    e:{name:'Infección Propia', icon:'🧪', cd:9, desc:'Te infectás para robar vida de lo que contagiás o dañás a tu alrededor'},
    locked:true, unlockAch:'ironBody550',
    scaling:{stat:'dmg', perLevel:0.03},
  },
  tempus: {
    id:'tempus', name:'Tempus', className:'Crononauta', icon:'⏳', accent:'#5fc9e6', glow:'rgba(95,201,230,0.35)',
    hp:95, speed:220, atk:{cd:0.48, dmg:11, range:400, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Zona de Tiempo Lento', icon:'⏳', cd:10, desc:'Crea una zona que ralentiza a los enemigos comunes dentro por un tiempo'},
    e:{name:'Rebobinado', icon:'⏪', cd:14, desc:'Volvés a tu posición de hace unos segundos y recuperás parte de la vida perdida en esa ventana'},
    locked:true, unlockAch:'fastCooldownRun',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  seren: {
    id:'seren', name:'Seren', className:'Danzante de Cuchillas', icon:'💃', accent:'#ff8fd0', glow:'rgba(255,143,208,0.35)',
    hp:95, speed:255, atk:{cd:0.32, dmg:10, range:80, arc:64, kind:'melee'},
    q:{name:'Paso de Cuchilla', icon:'💃', cd:4, desc:'Dash corto que golpea; si conecta, encadena (hasta 3 seguidos)'},
    e:{name:'Giro Final', icon:'🌀', cd:8, desc:'Giro cuyo daño escala con cuántos dashes tenías encadenados'},
    locked:true, unlockAch:'comboMaster70',
    scaling:{stat:'dmg', perLevel:0.04},
  },
  rowan: {
    id:'rowan', name:'Rowan', className:'Jinete Espectral', icon:'🐴', accent:'#d9c98f', glow:'rgba(217,201,143,0.35)',
    hp:140, speed:235, atk:{cd:0.4, dmg:13, range:86, arc:68, kind:'melee'},
    q:{name:'Montar', icon:'🐴', cd:13, desc:'Montás un corcel espectral: +60% velocidad y atropellás a lo que toques'},
    e:{name:'Desmontar', icon:'💥', cd:10, desc:'Onda de choque; mucho más fuerte si seguís montado al usarla'},
    locked:true, unlockAch:'speedRun',
    scaling:{stat:'hp', perLevel:0.035},
  },
  talus: {
    id:'talus', name:'Talus', className:'Terramante', icon:'🗿', accent:'#c9a878', glow:'rgba(201,168,120,0.35)',
    hp:150, speed:210, atk:{cd:0.5, dmg:12, range:380, projSpeed:380, radius:7, kind:'ranged'},
    q:{name:'Erupción', icon:'🗿', cd:9, desc:'Telegrafía y luego erupciona una línea de picos de tierra frente tuyo'},
    e:{name:'Emboscada', icon:'💥', cd:11, desc:'Avanzás con invulnerabilidad hasta el enemigo más cercano y emergés con un golpe devastador'},
    locked:true, unlockAch:'armoredRun70',
    scaling:{stat:'hp', perLevel:0.04},
  },
  lira: {
    id:'lira', name:'Lira', className:'Bardo', icon:'🎵', accent:'#ffcb6a', glow:'rgba(255,203,106,0.35)',
    hp:110, speed:230, atk:{cd:0.4, dmg:10, range:380, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Canción', icon:'🎵', cd:3, desc:'Rota entre 3 canciones cada vez que la usás: daño, velocidad, curación'},
    e:{name:'Crescendo', icon:'🎶', cd:9, desc:'Amplifica la canción activa en una versión mucho más fuerte'},
    locked:true, unlockAch:'flatSpeedRun',
    scaling:{stat:'dmg', perLevel:0.03},
  },
  amara: {
    id:'amara', name:'Amara', className:'Poseedora', icon:'👻', accent:'#9c6fd8', glow:'rgba(156,111,216,0.35)',
    hp:95, speed:225, atk:{cd:0.42, dmg:11, range:380, projSpeed:420, radius:6, kind:'ranged'},
    q:{name:'Poseer', icon:'👻', cd:10, desc:'Tomás el control de un enemigo común cercano: pelea para vos por un tiempo'},
    e:{name:'Autodestrucción', icon:'💥', cd:8, desc:'Fuerza a lo poseído a explotar; si no tenés nada poseído, un golpe menor a tu alrededor'},
    locked:true, unlockAch:'sevenBosses',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  midas: {
    id:'midas', name:'Midas', className:'Transmutador', icon:'👑', accent:'#ffd24a', glow:'rgba(255,210,74,0.35)',
    hp:105, speed:225, atk:{cd:0.4, dmg:11, range:380, projSpeed:440, radius:6, kind:'ranged'},
    q:{name:'Toque Dorado', icon:'💰', cd:6, desc:'Convierte tu propio oro en un escudo de daño (mínimo 20 de oro)'},
    e:{name:'Desvío Dorado', icon:'👑', cd:8, desc:'Desvía los proyectiles enemigos cercanos y los convierte en oro'},
    locked:true, unlockAch:'richRun2000',
    scaling:{stat:'dmg', perLevel:0.03},
  },
  borea: {
    id:'borea', name:'Borea', className:'Domadora de Vientos', icon:'🌬', accent:'#a8e0ff', glow:'rgba(168,224,255,0.35)',
    hp:105, speed:245, atk:{cd:0.38, dmg:10, range:400, projSpeed:460, radius:6, kind:'ranged'},
    q:{name:'Vórtice', icon:'🌬', cd:11, desc:'Crea un vórtice que absorbe proyectiles enemigos cercanos y banca su daño'},
    e:{name:'Liberar', icon:'💨', cd:9, desc:'Libera todo lo absorbido en una ráfaga; más fuerte cuanto más absorbiste'},
    locked:true, unlockAch:'regenRun5',
    scaling:{stat:'dmg', perLevel:0.035},
  },
  anselm: {
    id:'anselm', name:'Anselm', className:'Peregrino de Piedra', icon:'🪨', accent:'#9c9c9c', glow:'rgba(156,156,156,0.35)',
    hp:190, speed:205, atk:{cd:0.5, dmg:13, range:90, arc:68, kind:'melee'},
    q:{name:'Petrificarse', icon:'🪨', cd:12, desc:'Te volvés piedra: inmune e inmóvil, reflejás daño a lo que te golpee cerca'},
    e:{name:'Romper Forma', icon:'💥', cd:9, desc:'Rompés la forma de piedra en una explosión; más daño cuanto más tiempo estuviste petrificado'},
    locked:true, unlockAch:'ironBody700',
    scaling:{stat:'hp', perLevel:0.04},
  },
};

const ACHIEVEMENTS = [
  { id:'threeBosses', name:'Cazador de Jefes', desc:'Derrota 3 jefes en una misma run', unlocks:'paladin',
    check: g=> g.stats.bossesThisRun>=3, target:3, progressVal: g=> g.stats.bossesThisRun },
  { id:'depth6', name:'Descenso Profundo', desc:'Alcanza la etapa 6', unlocks:'nigromante',
    check: g=> g.stats.stageReached>=6, target:6, progressVal: g=> g.stats.stageReached },
  { id:'noHitBoss', name:'Filo de Cristal', desc:'Derrota un jefe sin recibir daño en esa pelea', unlocks:'vidrio',
    check: g=> g.stats.noHitBoss===true, target:1, progressVal: g=> g.stats.noHitBoss?1:0 },
  { id:'tankyRun', name:'Muro Viviente', desc:'Alcanza 300 de HP máxima en una run', unlocks:'coloso',
    check: g=> g.player.maxHp>=300, target:300, progressVal: g=> Math.round(g.player.maxHp) },
  { id:'itemHoarder', name:'Coleccionista', desc:'Consigue 6 objetos en una misma run', unlocks:'silvano',
    check: g=> g.player.items.length>=6, target:6, progressVal: g=> g.player.items.length },
  { id:'killStreak', name:'Cazador Incansable', desc:'Elimina 150 enemigos en una misma run', unlocks:'dual',
    check: g=> g.kills>=150, target:150, progressVal: g=> g.kills },
  { id:'comboMaster', name:'Racha Perfecta', desc:'Alcanza una racha de combo de 25 en una misma run', unlocks:'monje',
    check: g=> g.player.combo>=25, target:25, progressVal: g=> g.player.combo },
  { id:'deepDescent15', name:'Exploradora Profunda', desc:'Alcanza la etapa 15', unlocks:'arquera',
    check: g=> g.stats.stageReached>=15, target:15, progressVal: g=> g.stats.stageReached },
  { id:'relicCollector', name:'Coleccionista de Reliquias', desc:'Consigue 3 reliquias en una misma run', unlocks:'elementalista',
    check: g=> Object.keys(g.player.relics||{}).length>=3, target:3, progressVal: g=> Object.keys(g.player.relics||{}).length },
  { id:'killStreak300', name:'Furia Incansable', desc:'Elimina 300 enemigos en una misma run', unlocks:'berserker',
    check: g=> g.kills>=300, target:300, progressVal: g=> g.kills },
  { id:'richRun', name:'Fortuna del Descenso', desc:'Junta 500 de oro en una misma run', unlocks:'ilusionista',
    check: g=> g.gold>=500, target:500, progressVal: g=> g.gold },
  { id:'veteranLevel', name:'Veterano', desc:'Alcanza el nivel 10 de personaje en una misma run', unlocks:'alquimista',
    check: g=> g.player.charLevel>=10, target:10, progressVal: g=> g.player.charLevel },
  { id:'fiveBosses', name:'Cazadora de Cinco', desc:'Derrota 5 jefes en una misma run', unlocks:'druida',
    check: g=> g.stats.bossesThisRun>=5, target:5, progressVal: g=> g.stats.bossesThisRun },
  { id:'bloodCombo', name:'Sed de Sangre', desc:'Alcanza una racha de combo de 40 en una misma run', unlocks:'sangre',
    check: g=> g.player.combo>=40, target:40, progressVal: g=> g.player.combo },
  { id:'fortressHp', name:'Fortaleza Andante', desc:'Alcanza 450 de HP máxima en una run', unlocks:'centinela',
    check: g=> g.player.maxHp>=450, target:450, progressVal: g=> Math.round(g.player.maxHp) },
  { id:'critMaster', name:'Filo Certero', desc:'Alcanza 30% de probabilidad de golpe crítico en una run', unlocks:'cazador',
    check: g=> g.player.critChance>=0.30, target:30, progressVal: g=> Math.round(g.player.critChance*100) },
  { id:'deepDescent25', name:'Sondeadora del Abismo', desc:'Alcanza la etapa 25', unlocks:'torque',
    check: g=> g.stats.stageReached>=25, target:25, progressVal: g=> g.stats.stageReached },
  { id:'armoredRun', name:'Coraza Inquebrantable', desc:'Alcanza 40 de armadura en una misma run', unlocks:'frey',
    check: g=> g.player.armor>=40, target:40, progressVal: g=> Math.round(g.player.armor) },
  { id:'empoweredRun', name:'Filo Potenciado', desc:'Alcanza 180% de multiplicador de daño en una misma run', unlocks:'dorian',
    check: g=> g.player.dmgMult>=1.8, target:180, progressVal: g=> Math.round(g.player.dmgMult*100) },
  { id:'lifestealRun', name:'Sed Mecánica', desc:'Alcanza 20% de robo de vida en una misma run', unlocks:'ferro',
    check: g=> g.player.lifesteal>=0.20, target:20, progressVal: g=> Math.round(g.player.lifesteal*100) },
  { id:'veteranLevel15', name:'Veterana de Guerra', desc:'Alcanza el nivel 15 de personaje en una misma run', unlocks:'mecha',
    check: g=> g.player.charLevel>=15, target:15, progressVal: g=> g.player.charLevel },
  { id:'regenRun', name:'Vitalidad Persistente', desc:'Alcanza 3 de regeneración de vida por segundo en una misma run', unlocks:'arakne',
    check: g=> g.player.regen>=3, target:3, progressVal: g=> Math.round(g.player.regen*10)/10 },
  { id:'killStreak450', name:'Exterminio Total', desc:'Elimina 450 enemigos en una misma run', unlocks:'rasha',
    check: g=> g.kills>=450, target:450, progressVal: g=> g.kills },
  { id:'richRun1000', name:'Fortuna Colosal', desc:'Junta 1000 de oro en una misma run', unlocks:'marlow',
    check: g=> g.gold>=1000, target:1000, progressVal: g=> g.gold },
  { id:'comboMaster55', name:'Racha Trascendente', desc:'Alcanza una racha de combo de 55 en una misma run', unlocks:'orbis',
    check: g=> g.player.combo>=55, target:55, progressVal: g=> g.player.combo },
  { id:'deepDescent35', name:'Guardiana del Umbral', desc:'Alcanza la etapa 35', unlocks:'skald',
    check: g=> g.stats.stageReached>=35, target:35, progressVal: g=> g.stats.stageReached },
  { id:'ironBody550', name:'Cuerpo de Hierro', desc:'Alcanza 550 de HP máxima en una run', unlocks:'morbus',
    check: g=> g.player.maxHp>=550, target:550, progressVal: g=> Math.round(g.player.maxHp) },
  { id:'fastCooldownRun', name:'Fuera del Tiempo', desc:'Alcanza 30% de reducción de cooldown en una misma run', unlocks:'tempus',
    check: g=> g.player.cdMult<=0.7, target:30, progressVal: g=> Math.round((1-g.player.cdMult)*100) },
  { id:'comboMaster70', name:'Danza Incesante', desc:'Alcanza una racha de combo de 70 en una misma run', unlocks:'seren',
    check: g=> g.player.combo>=70, target:70, progressVal: g=> g.player.combo },
  { id:'speedRun', name:'Viento Espectral', desc:'Alcanza 50% de velocidad de movimiento bonus en una misma run', unlocks:'rowan',
    check: g=> g.player.speedMult>=1.5, target:50, progressVal: g=> Math.round((g.player.speedMult-1)*100) },
  { id:'armoredRun70', name:'Baluarte de Piedra', desc:'Alcanza 70 de armadura en una misma run', unlocks:'talus',
    check: g=> g.player.armor>=70, target:70, progressVal: g=> Math.round(g.player.armor) },
  { id:'flatSpeedRun', name:'Paso Ligero', desc:'Alcanza 60 de velocidad plana bonus en una misma run', unlocks:'lira',
    check: g=> g.player.speedFlat>=60, target:60, progressVal: g=> Math.round(g.player.speedFlat) },
  { id:'sevenBosses', name:'Cazadora de Titanes', desc:'Derrota 7 jefes en una misma run', unlocks:'amara',
    check: g=> g.stats.bossesThisRun>=7, target:7, progressVal: g=> g.stats.bossesThisRun },
  { id:'richRun2000', name:'Rey Midas', desc:'Junta 2000 de oro en una misma run', unlocks:'midas',
    check: g=> g.gold>=2000, target:2000, progressVal: g=> g.gold },
  { id:'regenRun5', name:'Aliento Eterno', desc:'Alcanza 5 de regeneración de vida por segundo en una misma run', unlocks:'borea',
    check: g=> g.player.regen>=5, target:5, progressVal: g=> Math.round(g.player.regen*10)/10 },
  { id:'ironBody700', name:'Corazón de Montaña', desc:'Alcanza 700 de HP máxima en una run', unlocks:'anselm',
    check: g=> g.player.maxHp>=700, target:700, progressVal: g=> Math.round(g.player.maxHp) },
];
const progress = { unlocked:{ guerrero:true, maga:true, picaro:true, paladin:false, nigromante:false, vidrio:false, coloso:false, silvano:false, dual:false,
    monje:false, arquera:false, elementalista:false, berserker:false, ilusionista:false, alquimista:false, druida:false, sangre:false, centinela:false, cazador:false,
    torque:false, frey:false, dorian:false, ferro:false, mecha:false, arakne:false, rasha:false, marlow:false, orbis:false, skald:false, morbus:false,
    tempus:false, seren:false, rowan:false, talus:false, lira:false, amara:false, midas:false, borea:false, anselm:false },
  unlockedAbilities:[], essence:0, homeUpgrades:{}, bestStage:0,
  achievementProgress:{}, // best value ever seen per achievement id, so locked cards can show "18/25" instead of just the goal text
  runHistory:[], skins:{}, selectedSkins:{},
  selectedUltimate:null, // which unlocked Habilidad Prohibida gets brought into the next run
  unlockedShiftAbilities:[], selectedShiftAbility:null, // ASCENSO's tecla-Shift abilities (see SHIFT_ABILITIES)
  discoveredItems:{}, unlockedFamilyBonuses:{}, // Misterios del Compendio — lore + colecciones temáticas, forever, across every run
};

const PROGRESS_SAVE_KEY = 'descenso_progress_v1';
function saveProgress(){
  try{ localStorage.setItem(PROGRESS_SAVE_KEY, JSON.stringify(progress)); }catch(e){ /* storage unavailable — just skip saving */ }
}
function loadProgress(){
  try{
    const raw = localStorage.getItem(PROGRESS_SAVE_KEY);
    if(!raw) return;
    const saved = JSON.parse(raw);
    if(saved.unlocked) Object.assign(progress.unlocked, saved.unlocked);
    if(Array.isArray(saved.unlockedAbilities)) progress.unlockedAbilities = saved.unlockedAbilities;
    if(saved.homeUpgrades) Object.assign(progress.homeUpgrades, saved.homeUpgrades);
    if(typeof saved.essence==='number') progress.essence = saved.essence;
    if(typeof saved.bestStage==='number') progress.bestStage = saved.bestStage;
    if(saved.achievementProgress) Object.assign(progress.achievementProgress, saved.achievementProgress);
    if(Array.isArray(saved.runHistory)) progress.runHistory = saved.runHistory;
    if(saved.skins) Object.assign(progress.skins, saved.skins);
    if(saved.selectedSkins) Object.assign(progress.selectedSkins, saved.selectedSkins);
    if(typeof saved.selectedUltimate==='string') progress.selectedUltimate = saved.selectedUltimate;
    if(Array.isArray(saved.unlockedShiftAbilities)) progress.unlockedShiftAbilities = saved.unlockedShiftAbilities;
    if(typeof saved.selectedShiftAbility==='string') progress.selectedShiftAbility = saved.selectedShiftAbility;
    if(saved.discoveredItems) Object.assign(progress.discoveredItems, saved.discoveredItems);
    if(saved.unlockedFamilyBonuses) Object.assign(progress.unlockedFamilyBonuses, saved.unlockedFamilyBonuses);
  }catch(e){ /* corrupted/old save — just start fresh rather than crash */ }
}
loadProgress(); // pulls back whatever was unlocked/earned last time, so a page refresh doesn't wipe it

// ---------- single-slot run save/continue: pause mid-run, come back later ----------
// Only ever one saved run at a time — saving again just overwrites it. Loading it consumes it
// (so a stale save can't be reloaded twice by mistake); save again from pause if you want to
// preserve further progress.
const SAVED_RUN_KEY = 'descenso_savedrun_v1';
function findItemById(id){
  return ITEM_POOL.common.find(it=>it.id===id) || ITEM_POOL.rare.find(it=>it.id===id) ||
    ITEM_POOL.epic.find(it=>it.id===id) || CURSED_ITEMS.find(it=>it.id===id) ||
    RELICS.find(it=>it.id===id) || Object.values(BOSS_ITEMS).find(it=>it.id===id) || null;
}
function hasSavedRun(){
  try{ return !!localStorage.getItem(SAVED_RUN_KEY); }catch(e){ return false; }
}
function saveRun(){
  if(!game || !game.player) return false;
  const p = game.player;
  const snapshot = {
    heroId: p.def.id,
    pacts: {...selectedPacts},
    stageIndex: game.stageIndex,
    gold: game.gold,
    kills: game.kills,
    stats: {...game.stats},
    player: {
      hp:p.hp, maxHp:p.maxHp, dmgMult:p.dmgMult, speedMult:p.speedMult, speedFlat:p.speedFlat,
      cdMult:p.cdMult, armor:p.armor, critChance:p.critChance, lifesteal:p.lifesteal, regen:p.regen,
      curseDmgTakenMult:p.curseDmgTakenMult, goldMult:p.goldMult, charLevel:p.charLevel,
      itemIds: p.items.map(it=>it.id),
      relics:{...p.relics}, families:{...p.families}, synergiesUnlocked:{...p.synergiesUnlocked},
      phoenixUsed:p.phoenixUsed, stance:p.stance,
    },
    savedAt: Date.now(),
  };
  try{ localStorage.setItem(SAVED_RUN_KEY, JSON.stringify(snapshot)); return true; }
  catch(e){ return false; } // storage unavailable/full — save silently fails rather than crashing
}
function loadSavedRun(){
  try{
    const raw = localStorage.getItem(SAVED_RUN_KEY);
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; } // corrupted save — treat as if there wasn't one
}
function clearSavedRun(){
  try{ localStorage.removeItem(SAVED_RUN_KEY); }catch(e){ /* ignore */ }
}
function continueSavedRun(){
  const snap = loadSavedRun();
  if(!snap) return;
  const hero = HEROES[snap.heroId];
  if(!hero) return; // hero id no longer exists for some reason — nothing sane to resume into
  selectedHero = hero;
  selectedPacts = snap.pacts || {};
  game = newGame();
  const p = game.player;
  Object.assign(p, snap.player);
  p.items = (snap.player.itemIds||[]).map(id=>findItemById(id)).filter(Boolean);
  delete p.itemIds;
  game.stageIndex = snap.stageIndex;
  game.gold = snap.gold;
  game.kills = snap.kills;
  game.stats = snap.stats || game.stats;
  clearSavedRun();
  syncCharacterLevel(p, game.stageIndex);
  hideScreen('screen-menu');
  showScreen('screen-stage');
  setStageIntro(game.stageIndex);
}
function refreshContinueButton(){
  const btn = $('btn-continue-run');
  if(!btn) return;
  btn.classList.toggle('hidden', !hasSavedRun());
}
refreshContinueButton();

function checkAchievements(){
  if(!game) return;
  let progressChanged = false;
  ACHIEVEMENTS.forEach(a=>{
    if(progress.unlocked[a.unlocks]) return;
    if(a.check(game)){
      progress.unlocked[a.unlocks] = true;
      const hero = HEROES[a.unlocks];
      spawnToast(`🏆 Logro: ${a.name} — nuevo héroe: ${hero.name}`);
      progress.achievementProgress[a.id] = a.target;
      progressChanged = true;
    } else if(a.progressVal){
      // track the best value ever reached across all runs, so a locked hero card can show
      // "18/25" progress even if the current run doesn't clear the achievement
      const cur = a.progressVal(game);
      if(typeof cur==='number' && cur > (progress.achievementProgress[a.id]||0)){
        progress.achievementProgress[a.id] = Math.min(cur, a.target);
        progressChanged = true;
      }
    }
  });
  if(progressChanged) saveProgress();
}

const TOWER_MAX_FLOOR = 100; // the tower has a hard top: floor 100 holds the true final boss
const ZONES = [
  { key:'cripta', name:'La Cripta Olvidada', desc:'Huesos viejos y aire quieto. Algo aquí sigue montando guardia.',
    enemyKinds:['skeleton','archer','charger','boneWarden'], guardianBoss:'boneGuardian',
    baseHp:210, baseSpeed:95, baseDmg:13, baseRadius:29, baseContactCd:1.0, minion:'skeleton', baseColor:'#c9bda0',
    movePool:['boneVolley','risingSpikes','boneArmor','boneTrap','summon','boneCross','boneSpiral','skullBarrage','graveSpikes','boneWhip','deathRattle','hauntingWail','cryptCollapse','boneShrapnel','graveyardShift','deathMark','skeletalSwarm','tombstoneSlam','ribcage','deathToll','skullStorm','gravebind','boneChain','cryptWhisper','deathsDoor','rattlingBones','deathKnell'], dashMove:'charge',
    regularNames:['Centinela Óseo','Guardián Polvoriento','Custodio de Cenizas','Vigía sin Rostro','Heraldo de Tumba','Espectro de Cripta','Portador de Huesos','Sombra Sepulta','Centinela del Osario'] },
  { key:'pantano', name:'El Pantano Maldito', desc:'El barro respira. Las voces bajo el agua ya saben tu nombre.',
    enemyKinds:['zombie','witch','shaman','bogSpitter'], guardianBoss:'motherWitch',
    baseHp:250, baseSpeed:92, baseDmg:12, baseRadius:28, baseContactCd:1.0, minion:'zombie', baseColor:'#7fd98f',
    movePool:['toxicSpores','swampGrasp','witchesBlessing','hexTrail','mudSlow','bogBurst','leechSwarm','witchesCurse','numbTonic','rootSnare','quicksand','poisonBrew','witchsEye','cauldronBubble','swampSurge','willOWisp','vineLine','venomLash','shadowBrew','batSwarm','mireField','curseBind','witchsMark','spectralHex','gooBurst','plagueCloud','witchesRing'], dashMove:'blinkStrike',
    regularNames:['Bruja del Lodo','Susurro de Ciénaga','Hechicera Ahogada','Voz del Pantano','Tejedora de Niebla','Madre de Sapos','Encantadora Podrida','Sombra del Lodazal','Bruja de Raíces'] },
  { key:'fortaleza', name:'La Fortaleza Infernal', desc:'El calor sube desde abajo. Cada piso pesa más que el anterior.',
    enemyKinds:['demon','summoner','brute','cinderImp'], guardianBoss:'abyssLord',
    baseHp:310, baseSpeed:100, baseDmg:15, baseRadius:31, baseContactCd:0.95, minion:'demon', baseColor:'#ff8a5a',
    movePool:['cinderBurst','emberField','moltenCore','cinderRain','flameWhip','lavaSpurt','infernoRing','brimstoneRain','demonRoar','ashCloud','moltenTrap','cinderSwarm','flameSurge','infernalBond','sulfurBreath','pyreCollapse','scorchedEarth','demonEye','infernalChains','brimstoneSpiral','flameWreath','hellgate','cinderVolley','moltenWave','demonicHowl','infernalCrown','demonicBlast'], dashMove:null,
    regularNames:['Heraldo de Magma','Guardián en Llamas','Verdugo Infernal','Centinela Ardiente','Custodio del Fuego','Sombra Incandescente','Bestia de Cenizas','Portador de Brasas','Vigía del Cráter'] },
  { key:'jardin', name:'El Jardín Prismático', desc:'Pétalos de luz caen sin ruido. Algo hermoso te está observando.',
    enemyKinds:['wisp','summoner','frostSprite','petalNymph'], guardianBoss:'empressOfLight',
    baseHp:290, baseSpeed:128, baseDmg:11, baseRadius:27, baseContactCd:1.0, minion:'wisp', baseColor:'#ffd6f0',
    movePool:['thornVolley','bloomTrap','healingBloom','lightTwins','radiantPath','petalStorm','vineWhip','prismShard','nectarSwarm','gildedThorns','dewTrap','crystalBloom','thornCage','sunbeamLine','bloomRing','sunfireCross','radianceField','lightCascade','tangleRoots','mirrorBloom','verdantSurge','glowWisp','sunfireLance','lightPollen','witheringPetals','petalVeil','gardenGuardians'], dashMove:'prismDash',
    regularNames:['Doncella de Pétalos','Guardiana de Luz','Espíritu Floreciente','Susurro de Jardín','Custodia Radiante','Ninfa de Cristal','Bailarina de Luz','Centinela de Rocío','Doncella Prismática'] },
  { key:'espejos', name:'El Salón de Espejos', desc:'Cada reflejo se mueve un instante tarde. O un instante antes.',
    enemyKinds:['wisp','erratic','archer','glassSentinel'], guardianBoss:'mirrorLord',
    baseHp:330, baseSpeed:110, baseDmg:14, baseRadius:28, baseContactCd:1.0, minion:'skeleton', baseColor:'#cfd6e8',
    movePool:['mirrorDecoy','glassField','illusionSwap','mirrorGaze','fracturedBurst','shatterVolley','reflectedBarrage','prismaticShards','mirageSwarm','silverStrike','mirrorMaze','shatterZone','reflectivePool','glassSpikes','doubleVision','distortionField','echoChamber','hallOfMirrors','mirrorShatter','reflectivePulse','phantomChaser','reflectedLance','hauntingReflection','disorientingGaze','shatteredFocus','silveredSkin','mirroredEcho'], dashMove:'echoDash',
    regularNames:['Eco Fracturado','Reflejo Distante','Sombra Especular','Fragmento de Espejo','Doble Silencioso','Imagen Rota','Espejo Errante','Reflejo Tardío','Eco de Cristal'] },
  { key:'gemelo', name:'El Santuario Gemelo', desc:'Todo aquí viene de a dos. Vos sos el único que llegó solo.',
    enemyKinds:['witch','summoner','charger','boundWisp'], guardianBoss:'twinBoss',
    baseHp:290, baseSpeed:105, baseDmg:12, baseRadius:26, baseContactCd:1.0, minion:'wisp', baseColor:'#ffb0d9',
    movePool:['boundStrike','bondPulse','twinStrike','bondedShield','spiritLink','twinVolley','soulShards','pairedBolts','spiritBurst','boundArrows','soulTether','kinshipRing','dualBloom','sharedPain','weaveTrap','pactCircle','tetherLine','soulPulse','boundSurge','spiritChaser','soulLance','kinseeker','sharedWound','soulSap','boundCurse','sharedBlessing','twinSpirits'], dashMove:'charge',
    regularNames:['Espíritu Vinculado','Alma Gemela','Sombra Compartida','Eco Fraternal','Vínculo Roto','Espíritu Doble','Presencia Gemela','Aliento Compartido','Sombra Hermana'] },
  { key:'glaciar', name:'El Glaciar Eterno', desc:'El frío no muerde: espera. Cada aliento se ve, cada paso se oye.',
    enemyKinds:['frostSprite','charger','brute','frostStalker'], guardianBoss:'glacierMonarch',
    baseHp:370, baseSpeed:95, baseDmg:16, baseRadius:30, baseContactCd:0.95, minion:'frostSprite', baseColor:'#9fd8ff',
    movePool:['iceLance','crystalPrison','avalanche','frostBreath','numbingChill','frostShards','glacialVolley','iceShrapnel','crystalBarrage','polarWind','snowSquall','glacialSpike','frostRing','iceFissure','frozenTrail','hailfall','permafrost','crystalRain','blizzardGust','frostSlam','frostWisp','iceStalker','frostbite','brittleChill','glacialGrip','glacialWard','summon'], dashMove:'echoDash',
    regularNames:['Centinela de Escarcha','Guardián de Hielo','Custodio Glacial','Espíritu del Frío','Vigía Congelado','Sombra de Escarcha','Portador de Nieve','Centinela Blanco','Custodia del Hielo'] },
  { key:'tormenta', name:'El Yermo Tormentoso', desc:'El cielo nunca se queda quieto. Tampoco lo que vive en él.',
    enemyKinds:['sniper','charger','swarmling','stormWisp'], guardianBoss:'stormLord',
    baseHp:390, baseSpeed:115, baseDmg:17, baseRadius:29, baseContactCd:0.9, minion:'sniper', baseColor:'#ffe45a',
    movePool:['thunderStrike','stormVortex','staticField','skySiege','boltRunner','boltSpray','thunderClap','chargedBurst','windSlash','stormShards','arcVolley','thunderPatch','stormCell','lightningField','galeZone','thunderColumn','stormPocket','chainStrike','squallLine','thunderSlam','stormChaser','thunderEye','staticShock','galeForce','overcharge','stormShield','summon'], dashMove:'prismDash',
    regularNames:['Heraldo de la Tormenta','Portador del Trueno','Custodio del Rayo','Vigía Tormentoso','Espíritu del Viento','Sombra Eléctrica','Centinela del Cielo','Heraldo del Relámpago','Guardián de la Tempestad'] },
  { key:'abismo', name:'El Abismo Sin Fondo', desc:'Acá abajo, hasta el eco tarda en volver. Si es que vuelve.',
    enemyKinds:['erratic','shaman','brute','voidHusk'], guardianBoss:'starDevourer',
    baseHp:430, baseSpeed:100, baseDmg:18, baseRadius:30, baseContactCd:0.9, minion:'erratic', baseColor:'#8a5ad9',
    movePool:['voidTendrils','darkPulse','starlightDrain','umbraStep','collapsingStar','shadowShards','voidBurst','darkVolley','eclipseSpray','starfallShards','umbralArc','voidPool','shadowPatch','darkRift','eclipseZone','starfallField','umbralCage','voidColumn','nullGround','shadowSlam','voidWisp','shadowStalker','voidGrasp','starDrain','nullTouch','voidShroud','summon'], dashMove:'charge',
    regularNames:['Susurro del Vacío','Sombra Insondable','Eco de la Nada','Custodio Oscuro','Presencia del Abismo','Vigía sin Luz','Espíritu Vacío','Sombra Profunda','Heraldo de la Nada'] },
  { key:'trono', name:'El Trono del Descenso', desc:'Lo que sea que gobierna esta torre te espera arriba de todo.',
    enemyKinds:['demon','sniper','brute','royalGuard'], guardianBoss:'trueFinal',
    baseHp:470, baseSpeed:110, baseDmg:19, baseRadius:31, baseContactCd:0.9, minion:'demon', baseColor:'#e0c9a0',
    movePool:['royalDecree','throneSlam','crownfire','finalJudgment','soulBarrage','crownShards','royalVolley','soulBurst','radiantBlast','scepterShards','dominionSpray','thronePatch','judgmentZone','soulField','dominionCircle','regalSpikes','sovereignGround','crownfireField','royalGround','royalSlam','soulChaser','wraithMark','royalCurse','soulDrain','crownBind','royalAegis','summon'], dashMove:'blinkStrike',
    regularNames:['Guardián del Trono','Custodio Final','Centinela del Descenso','Sombra del Trono','Vigía Postrero','Heraldo del Final','Guardián Postrero','Custodio del Umbral','Sombra Final'] },
];

// Lightens (positive percent) or darkens (negative percent) a hex color, used to give each of a
// zone's 9 regular-floor bosses a subtly distinct shade of the zone's base color.
function shadeColor(hex, percent){
  const num = parseInt(hex.replace('#',''),16);
  let r = (num>>16)+Math.round(255*percent/100);
  let g = ((num>>8)&0xff)+Math.round(255*percent/100);
  let bch = (num&0xff)+Math.round(255*percent/100);
  r = clamp(r,0,255); g = clamp(g,0,255); bch = clamp(bch,0,255);
  return '#'+(0x1000000+r*0x10000+g*0x100+bch).toString(16).slice(1);
}

// Deterministic tiny PRNG (so a given floor always generates the same boss) — used only to pick
// which subset of the zone's move pool a given regular-floor boss gets.
function seededShuffle(arr, seed){
  const out = arr.slice();
  let s = seed;
  for(let i=out.length-1;i>0;i--){
    s = (s*9301+49297)%233280;
    const j = Math.floor((s/233280)*(i+1));
    [out[i],out[j]] = [out[j],out[i]];
  }
  return out;
}

// Every attack falls into one mechanical family: a spread of projectiles ("burst"), a telegraphed
// danger zone on the floor ("ground"), a self-centered melee hit ("self"), a threat that chases you
// ("homing"), a crowd-control pull ("pull"), or a pure status effect ("debuff"). Dash moves are their
// own thing, handled separately and budgeted to exactly 10 floors.
const MOVE_CATEGORY = {
  radialBurst:'burst', radiantNova:'burst', butterflyBurst:'burst', spiralBloom:'burst', petalRing:'burst',
  twinPulse:'burst', crossFire:'burst', frostNova:'burst', stormBolt:'burst', boneShards:'burst',
  rainbowLine:'burst', phantomBarrage:'burst', mirrorSplit:'burst', witchCauldron:'burst', chainLightning:'burst', thunderdome:'burst',
  boneVolley:'burst', toxicSpores:'burst', cinderBurst:'burst', thornVolley:'burst', flameWhip:'burst',
  poisonPool:'ground', meteor:'ground', boneCage:'ground', boneWall:'ground', magmaCross:'ground',
  blazingFissure:'ground', growingMagma:'ground', iceCage:'ground', stormField:'ground', voidRift:'ground',
  fireRain:'ground', lavaGeyser:'ground', gracefulVeil:'ground', glassRain:'ground', blizzardWall:'ground',
  frozenGround:'ground', starCollapse:'ground', abyssalCollapse:'ground',
  risingSpikes:'ground', boneTrap:'ground', swampGrasp:'ground', hexTrail:'ground',
  emberField:'ground', moltenCore:'ground', cinderRain:'ground', bloomTrap:'ground', radiantPath:'ground',
  slam:'self', boneSlam:'self', fireWave:'self',
  curseMark:'homing', voidLance:'homing', lightTwins:'homing',
  boneGrab:'pull', gravityWell:'pull',
  wither:'debuff', mudSlow:'debuff',
  sisterCall:'buff', boneArmor:'buff', witchesBlessing:'buff', healingBloom:'buff',
  petalStorm:'burst', vineWhip:'burst', prismShard:'burst', nectarSwarm:'burst', gildedThorns:'burst',
  dewTrap:'ground', crystalBloom:'ground', thornCage:'ground', sunbeamLine:'ground', bloomRing:'ground',
  sunfireCross:'ground', radianceField:'ground', lightCascade:'ground', tangleRoots:'ground',
  mirrorBloom:'self', verdantSurge:'self',
  glowWisp:'homing', sunfireLance:'homing',
  lightPollen:'debuff', witheringPetals:'debuff',
  petalVeil:'buff', gardenGuardians:'summon',
  shatterVolley:'burst', reflectedBarrage:'burst', prismaticShards:'burst', mirageSwarm:'burst', silverStrike:'burst',
  mirrorMaze:'ground', shatterZone:'ground', reflectivePool:'ground', glassSpikes:'ground', doubleVision:'ground',
  distortionField:'ground', echoChamber:'ground', hallOfMirrors:'ground',
  mirrorShatter:'self', reflectivePulse:'self',
  phantomChaser:'homing', reflectedLance:'homing', hauntingReflection:'homing',
  disorientingGaze:'debuff', shatteredFocus:'debuff',
  silveredSkin:'buff', mirroredEcho:'summon',
  twinVolley:'burst', soulShards:'burst', pairedBolts:'burst', spiritBurst:'burst', boundArrows:'burst',
  soulTether:'ground', kinshipRing:'ground', dualBloom:'ground', sharedPain:'ground', weaveTrap:'ground', pactCircle:'ground', tetherLine:'ground',
  soulPulse:'self', boundSurge:'self',
  spiritChaser:'homing', soulLance:'homing', kinseeker:'homing',
  sharedWound:'debuff', soulSap:'debuff', boundCurse:'debuff',
  sharedBlessing:'buff', twinSpirits:'summon',
  eyeLaser:'burst', cursedFlameBreath:'burst', twinCharge:'self',
  mirrorDecoy:'burst', fracturedBurst:'burst', boundStrike:'burst',
  glassField:'ground', bondPulse:'ground', spiritLink:'ground',
  illusionSwap:'self', twinStrike:'self',
  mirrorGaze:'debuff',
  bondedShield:'buff',
  iceLance:'homing', boltRunner:'homing', soulBarrage:'homing',
  crystalPrison:'ground', avalanche:'ground', stormVortex:'ground', skySiege:'ground',
  voidTendrils:'ground', collapsingStar:'ground', finalJudgment:'ground', thunderStrike:'ground',
  frostBreath:'burst', darkPulse:'burst', crownfire:'burst',
  numbingChill:'debuff', staticField:'debuff', starlightDrain:'debuff', royalDecree:'debuff',
  umbraStep:'self', throneSlam:'self', graveyardShift:'self', tombstoneSlam:'self', rattlingBones:'self',
  skullBarrage:'burst', boneShrapnel:'burst', skeletalSwarm:'burst', skullStorm:'burst',
  boneCross:'ground', boneSpiral:'ground', graveSpikes:'ground', cryptCollapse:'ground',
  ribcage:'ground', deathToll:'ground', deathsDoor:'ground', deathKnell:'ground',
  boneWhip:'burst',
  deathRattle:'debuff', hauntingWail:'debuff', gravebind:'debuff',
  deathMark:'homing', boneChain:'homing',
  cryptWhisper:'buff', shadowBrew:'buff', infernalBond:'buff',
  lavaSpurt:'burst', cinderSwarm:'burst', sulfurBreath:'burst', cinderVolley:'burst', infernalCrown:'burst',
  demonEye:'homing', infernalChains:'homing',
  demonRoar:'debuff', ashCloud:'debuff', demonicHowl:'debuff',
  infernoRing:'ground', brimstoneRain:'ground', moltenTrap:'ground', flameSurge:'ground',
  pyreCollapse:'ground', scorchedEarth:'ground', brimstoneSpiral:'ground', moltenWave:'ground',
  flameWreath:'self', hellgate:'self', demonicBlast:'self',
  bogBurst:'burst', willOWisp:'burst', batSwarm:'burst', gooBurst:'burst',
  leechSwarm:'homing', witchsEye:'homing', witchsMark:'homing',
  witchesCurse:'debuff', numbTonic:'debuff', curseBind:'debuff',
  rootSnare:'ground', quicksand:'ground', poisonBrew:'ground', swampSurge:'ground',
  vineLine:'ground', mireField:'ground', plagueCloud:'ground', witchesRing:'ground',
  cauldronBubble:'self', spectralHex:'self',
  venomLash:'burst',
  summon:'summon',
  frostShards:'burst', glacialVolley:'burst', iceShrapnel:'burst', crystalBarrage:'burst', polarWind:'burst', snowSquall:'burst', glacialSpike:'ground', frostRing:'ground', iceFissure:'ground', frozenTrail:'ground', hailfall:'ground', permafrost:'ground', crystalRain:'ground', blizzardGust:'ground', frostSlam:'self', frostWisp:'homing', iceStalker:'homing', frostbite:'debuff', brittleChill:'debuff', glacialGrip:'debuff', glacialWard:'buff', boltSpray:'burst', thunderClap:'burst', chargedBurst:'burst', windSlash:'burst', stormShards:'burst', arcVolley:'burst', thunderPatch:'ground', stormCell:'ground', lightningField:'ground', galeZone:'ground', thunderColumn:'ground', stormPocket:'ground', chainStrike:'ground', squallLine:'ground', thunderSlam:'self', stormChaser:'homing', thunderEye:'homing', staticShock:'debuff', galeForce:'debuff', overcharge:'debuff', stormShield:'buff', shadowShards:'burst', voidBurst:'burst', darkVolley:'burst', eclipseSpray:'burst', starfallShards:'burst', umbralArc:'burst', voidPool:'ground', shadowPatch:'ground', darkRift:'ground', eclipseZone:'ground', starfallField:'ground', umbralCage:'ground', voidColumn:'ground', nullGround:'ground', shadowSlam:'self', voidWisp:'homing', shadowStalker:'homing', voidGrasp:'debuff', starDrain:'debuff', nullTouch:'debuff', voidShroud:'buff', crownShards:'burst', royalVolley:'burst', soulBurst:'burst', radiantBlast:'burst', scepterShards:'burst', dominionSpray:'burst', thronePatch:'ground', judgmentZone:'ground', soulField:'ground', dominionCircle:'ground', regalSpikes:'ground', sovereignGround:'ground', crownfireField:'ground', royalGround:'ground', royalSlam:'self', soulChaser:'homing', wraithMark:'homing', royalCurse:'debuff', soulDrain:'debuff', crownBind:'debuff', royalAegis:'buff',
};

// Picks `count` moves from `pool`, preferring one move per distinct mechanical category (so a boss's
// kit reads as e.g. "a bullet spread + a ground hazard + a chasing threat" instead of three flavors
// of the same idea). Falls back to any leftover moves if the pool doesn't span enough categories.
function pickCategoryDiverseMoves(pool, seed, count){
  const byCategory = {};
  pool.forEach(m=>{
    const cat = MOVE_CATEGORY[m] || 'burst';
    (byCategory[cat] = byCategory[cat]||[]).push(m);
  });
  const categories = seededShuffle(Object.keys(byCategory), seed);
  const picked = [];
  for(let i=0;i<categories.length && picked.length<count;i++){
    const opts = seededShuffle(byCategory[categories[i]], seed+i*17+3);
    picked.push(opts[0]);
  }
  if(picked.length<count){
    const remaining = seededShuffle(pool.filter(m=>!picked.includes(m)), seed+99);
    for(let i=0;i<remaining.length && picked.length<count;i++) picked.push(remaining[i]);
  }
  return picked;
}

// Builds the 90 unique regular-floor bosses (every floor from 1-100 except the 10 Guardian floors)
// directly into BOSS_DEFS/BOSS_ATTACKS, keyed as 'floor_<N>'. Each zone's 5th regular floor gets
// the zone's one designated dash move; the Fortaleza zone gets none at all — together with
// trueFinal (floor 100), this keeps the whole 100-floor tower at exactly 10 dash-capable bosses.
// A move is "support" (buff/debuff/summon) if it doesn't threaten the player with dodgeable damage
// on its own. Spreading these evenly (at most one per floor) keeps every floor's kit from
// accidentally clustering into 2-3 non-threatening moves, which made some floors trivial.
function isSupportMove(m){
  const cat = MOVE_CATEGORY[m];
  return cat==='buff' || cat==='debuff' || cat==='summon';
}
function partitionZoneMoves(pool, zoneIdx){
  const support = pool.filter(isSupportMove);
  const threat = pool.filter(m=>!isSupportMove(m));
  const shuffledSupport = seededShuffle(support, zoneIdx*1000+11);
  const shuffledThreat = seededShuffle(threat, zoneIdx*1000+23);
  const groups = []; for(let f=0; f<9; f++) groups.push([]);
  shuffledSupport.forEach((m,i)=>{ if(i<9) groups[i].push(m); }); // at most 1 support move per floor
  let ti=0;
  for(let f=0; f<9; f++){ while(groups[f].length<3 && ti<shuffledThreat.length){ groups[f].push(shuffledThreat[ti++]); } }
  return groups;
}
// Manual per-floor tuning knobs, layered on top of the normal formula — for individual floors
// that turned out too easy or too hard once actually played.
const FLOOR_STAT_OVERRIDES = {
  12: { hpMult:1.35, dmgMult:1.15 }, // felt too weak in playtesting
};
function generateFloorBosses(){
  ZONES.forEach((zone, zoneIdx)=>{
    for(let floorInZone=0; floorInZone<9; floorInZone++){
      const floor = zoneIdx*10 + floorInZone + 1;
      const kind = `floor_${floor}`;
      const shade = -22 + floorInZone*6; // gradient from a darker to a lighter shade across the zone
      const override = FLOOR_STAT_OVERRIDES[floor] || {};
      BOSS_DEFS[kind] = {
        name: zone.regularNames[floorInZone],
        hp: Math.round(zone.baseHp*(1+floorInZone*0.05)*(override.hpMult||1)),
        speed: zone.baseSpeed,
        dmg: Math.round(zone.baseDmg*(1+floorInZone*0.04)*(override.dmgMult||1)),
        radius: zone.baseRadius,
        color: shadeColor(zone.baseColor, shade),
        contactCd: zone.baseContactCd,
        minion: zone.minion,
        title: zone.desc,
      };
      let moves;
      if(zone.movePool.length>=27){
        // the zone has been expanded to exactly 9x3 unique moves — partition once, balancing
        // support moves evenly, so no floor ends up with more than one non-threatening move
        if(!zone._groups) zone._groups = partitionZoneMoves(zone.movePool, zoneIdx);
        moves = zone._groups[floorInZone].slice();
      } else {
        moves = pickCategoryDiverseMoves(zone.movePool, floor*7+13, 3);
      }
      if(zone.dashMove && floorInZone===4) moves.push(zone.dashMove);
      BOSS_ATTACKS[kind] = moves;
    }
  });
}

// stageAt(i) builds a fixed 100-floor tower (i is 0-indexed, floor = i+1). Every block of 10 floors
// is one zone; the 10th floor of each zone (floor 10, 20, 30...) is that zone's stronger Guardian.
function stageAt(i){
  const floor = clamp(i, 0, TOWER_MAX_FLOOR-1);
  const zoneIndex = Math.floor(floor/10);
  const zone = ZONES[Math.min(zoneIndex, ZONES.length-1)];
  const isGuardianFloor = (floor+1)%10===0;
  const hpMult = 1 + floor*0.24;       // steeper HP growth than before — damage scaling felt right, HP didn't
  // BUG (real): this used to be 1 + floor*0.12 forever, uncapped, for the whole 100-floor tower.
  // At floor 20 that's already 3.28x a boss's base hit; floor 50 is 6.88x; floor 100 is 12.88x.
  // Player max HP grows nowhere near that fast (character level only ticks once every 5 floors,
  // and plenty of loot/curses actively cut max HP — see CURSED_CHEST_CHANCE), so somewhere around
  // floor 20 a single boss hit started to outright one-shot a full-HP player. Mirrors the same
  // ramp-then-hold shape already used for lateGameHpMult (boss durability) below, just applied to
  // damage: unchanged through floor 20 (where none of this was reported as a problem), then grows
  // much more gently and caps instead of climbing forever.
  const dmgMult = floor<=19 ? 1+floor*0.12 : Math.min(4.6, 3.28+(floor-19)*0.045);
  const mult = dmgMult;                // kept for any old code still reading .mult (damage-oriented)
  const enemyHpMult = 1 + floor*0.10;  // normal (non-boss) enemies scale more gently so runs don't get out of hand
  const enemyDmgMult = 1 + floor*0.055; // damage scales noticeably slower than HP for trash mobs
  const CHEST_BASE_COST = 18;
  const chestCost = Math.round(CHEST_BASE_COST * (1 + floor*0.12));
  return { ...zone, floor:floor+1, zoneIndex, isGuardianFloor,
    bossKind: isGuardianFloor ? zone.guardianBoss : `floor_${floor+1}`,
    mult, hpMult, dmgMult, enemyHpMult, enemyDmgMult,
    name: isGuardianFloor ? `${zone.name} — Guardián` : zone.name,
    chestCost,
  };
}

const ENEMY_DEFS = {
  skeleton: { name:'Esqueleto', hp:34, speed:118, dmg:9, kind:'melee', range:26, atkCd:0.9, radius:16, color:'#ccc3b0', gold:[1,3] },
  archer:   { name:'Arquero en Ruinas', hp:22, speed:96, dmg:7, kind:'ranged', range:300, atkCd:1.7, projSpeed:300, radius:15, color:'#8fae7a', gold:[1,3] },
  zombie:   { name:'Rastrero Podrido', hp:58, speed:78, dmg:13, kind:'melee', range:28, atkCd:1.1, radius:19, color:'#6f8a53', gold:[2,4] },
  witch:    { name:'Bruja Venenosa', hp:30, speed:92, dmg:6, kind:'ranged', range:280, atkCd:1.9, projSpeed:260, radius:15, color:'#8a4fae', gold:[2,4], poison:true },
  demon:    { name:'Demonio Menor', hp:44, speed:168, dmg:12, kind:'melee', range:26, atkCd:0.8, radius:17, color:'#c23a3a', gold:[2,5] },
  summoner: { name:'Invocador de Llamas', hp:34, speed:100, dmg:11, kind:'ranged', range:320, atkCd:1.6, projSpeed:320, radius:16, color:'#d97b2b', gold:[2,5] },
  wisp:     { name:'Chispa Errante', hp:20, speed:150, dmg:6, kind:'ranged', range:260, atkCd:1.3, projSpeed:340, radius:13, color:'#ffb3ec', gold:[2,4] },
  bomber:   { name:'Reventado', hp:26, speed:130, dmg:8, kind:'melee', range:24, atkCd:1.0, radius:16, color:'#ff8a3d', gold:[2,4],
    explodesOnDeath:true, explodeRadius:70, explodeDmg:16 },
  shielded: { name:'Escudero Óseo', hp:40, speed:88, dmg:10, kind:'melee', range:26, atkCd:1.1, radius:18, color:'#8a8f9c', gold:[2,5],
    armor:24 },
  erratic:  { name:'Fantasma Errático', hp:24, speed:150, dmg:7, kind:'ranged', range:270, atkCd:1.5, projSpeed:280, radius:14, color:'#c9b8ff', gold:[2,5],
    erratic:true, dodgeChance:0.3 },
  charger:  { name:'Embestidor Óseo', hp:36, speed:104, dmg:15, kind:'melee', range:26, atkCd:1.0, radius:17, color:'#e0a15a', gold:[2,4],
    charger:true, chargeSpeed:540, chargeWindup:0.55, chargeDur:0.35, chargeCd:1.6 },
  brute:    { name:'Bestia del Osario', hp:100, speed:60, dmg:20, kind:'melee', range:32, atkCd:1.3, radius:24, color:'#8a3a2a', gold:[3,6] },
  shaman:   { name:'Chamán del Pantano', hp:26, speed:88, dmg:5, kind:'ranged', range:260, atkCd:2.2, projSpeed:240, radius:15, color:'#5ad98a', gold:[2,5],
    healer:true, healRadius:150, healAmount:6, healCd:3 },
  sniper:   { name:'Francotirador Óseo', hp:24, speed:68, dmg:23, kind:'ranged', range:430, atkCd:2.6, projSpeed:480, radius:14, color:'#d9d0a0', gold:[2,5],
    chargeShot:true, chargeShotWindup:0.9 },
  frostSprite: { name:'Espina de Escarcha', hp:22, speed:112, dmg:7, kind:'ranged', range:270, atkCd:1.8, projSpeed:300, radius:14, color:'#9fd8ff', gold:[2,4],
    slowOnHit:true, slowFactor:0.55, slowDur:1.2 },
  swarmling: { name:'Enjambre Óseo', hp:12, speed:172, dmg:4, kind:'melee', range:20, atkCd:0.6, radius:10, color:'#b8ada0', gold:[1,2] },

  // ---- zone-exclusive enemies: one thematic type per zone, added to their `movePool`-sibling
  // `enemyKinds` list below. Each reuses an existing generic mechanic flag (armor/poison/healer/
  // erratic/chargeShot/explodesOnDeath) so no new AI code is needed — only new stats/name/color. ----
  boneWarden:   { name:'Centinela Encadenado', hp:52, speed:80, dmg:11, kind:'melee', range:28, atkCd:1.2, radius:19, color:'#e8dcc0', gold:[2,4],
    armor:30 }, // cripta — a heavier bone guard, hard to bring down quickly
  bogSpitter:   { name:'Escupidor de Ciénaga', hp:24, speed:86, dmg:6, kind:'ranged', range:260, atkCd:1.6, projSpeed:250, radius:14, color:'#5fae4f', gold:[2,4],
    poison:true }, // pantano — a ranged poison spitter, distinct from the healer shaman
  cinderImp:    { name:'Diablillo de Ceniza', hp:22, speed:150, dmg:7, kind:'melee', range:22, atkCd:0.9, radius:14, color:'#ffab5a', gold:[2,4],
    explodesOnDeath:true, explodeRadius:64, explodeDmg:14 }, // fortaleza — quick, detonates on death
  petalNymph:   { name:'Ninfa de Pétalos', hp:26, speed:110, dmg:5, kind:'ranged', range:250, atkCd:2.0, projSpeed:230, radius:14, color:'#ffcdeb', gold:[2,4],
    healer:true, healRadius:140, healAmount:5, healCd:2.8 }, // jardin — a second healer type, softer but heals more often
  glassSentinel:{ name:'Guardián de Cristal', hp:46, speed:90, dmg:12, kind:'melee', range:26, atkCd:1.15, radius:18, color:'#dfe6f5', gold:[2,5],
    armor:26 }, // espejos — armored, fitting the reflective/hardened theme
  boundWisp:    { name:'Espíritu Atado', hp:20, speed:140, dmg:6, kind:'ranged', range:260, atkCd:1.4, projSpeed:280, radius:13, color:'#ff8fc0', gold:[2,5],
    erratic:true, dodgeChance:0.32 }, // gemelo — erratic, evokes the "moves a beat off" twin motif
  frostStalker: { name:'Acechador de Escarcha', hp:26, speed:72, dmg:24, kind:'ranged', range:420, atkCd:2.5, projSpeed:460, radius:14, color:'#bfe9ff', gold:[2,5],
    chargeShot:true, chargeShotWindup:0.85 }, // glaciar — a precise cold sniper
  stormWisp:    { name:'Chispa Errática', hp:20, speed:158, dmg:7, kind:'ranged', range:270, atkCd:1.3, projSpeed:340, radius:13, color:'#fff0a0', gold:[2,4],
    erratic:true, dodgeChance:0.3 }, // tormenta — a second erratic type, quicker and squishier
  voidHusk:     { name:'Cáscara del Vacío', hp:24, speed:120, dmg:8, kind:'melee', range:22, atkCd:1.0, radius:15, color:'#6a4fb0', gold:[2,5],
    explodesOnDeath:true, explodeRadius:74, explodeDmg:18 }, // abismo — collapses into a small void burst
  royalGuard:   { name:'Guardia Real', hp:64, speed:85, dmg:14, kind:'melee', range:30, atkCd:1.1, radius:20, color:'#e0c060', gold:[3,6],
    armor:32 }, // trono — the toughest of the armored rank-and-file, fitting the final zone
};
const ELITE_CHANCE = 0.055;
const ELITE_MULT = { hp:2.3, dmg:1.5, gold:2.0 };

const BOSS_DEFS = {
  boneGuardian: { name:'Guardián de Hueso', hp:340, speed:100, dmg:20, radius:34, color:'#d9cdb3', contactCd:1.0,
    minion:'skeleton', title:'El primer centinela' },
  motherWitch:  { name:'Bruja Madre', hp:460, speed:90, dmg:16, radius:32, color:'#a44fd9', contactCd:1.0,
    minion:'zombie', title:'La que teje el pantano' },
  abyssLord:    { name:'Señor del Abismo', hp:640, speed:115, dmg:24, radius:38, color:'#ff5a3d', contactCd:0.9,
    minion:'demon', title:'Lo que espera abajo' },
  empressOfLight: { name:'Emperatriz de la Luz', hp:560, speed:150, dmg:15, radius:30, color:'#ffb3ec', contactCd:1.0,
    minion:'wisp', title:'Gracia letal del jardín' },
  mirrorLord: { name:'Reflejo', hp:420, speed:120, dmg:18, radius:30, color:'#e8e8f5', contactCd:1.0,
    minion:'skeleton', title:'Todo lo que sos, vuelto en tu contra' },
  twinBoss: { name:'Hermanas Gemelas', hp:260, speed:110, dmg:14, radius:26, color:'#ff9ad1', contactCd:1.0,
    minion:'wisp', title:'Ninguna cae sola' },
  trueFinal: { name:'El Verdadero Abismo', hp:1100, speed:120, dmg:22, radius:40, color:'#ffffff', contactCd:0.85,
    minion:'demon', title:'No queda ceremonia. Solo esto.' },

  // zone guardians — the notably stronger boss on floors 10, 20, 30... (70/80/90 are new; the rest reuse the kinds above)
  glacierMonarch: { name:'Monarca del Glaciar', hp:900, speed:100, dmg:24, radius:38, color:'#c8ecff', contactCd:0.85,
    minion:'frostSprite', title:'Señor de un frío que no perdona' },
  stormLord:      { name:'Señor del Trueno', hp:980, speed:120, dmg:26, radius:38, color:'#fff05a', contactCd:0.85,
    minion:'sniper', title:'La tormenta hecha carne' },
  starDevourer:   { name:'Devorador de Estrellas', hp:1060, speed:110, dmg:28, radius:40, color:'#5a3d8a', contactCd:0.8,
    minion:'erratic', title:'Se traga hasta la luz' },
  // the 90 regular-floor bosses (one unique boss per non-guardian floor, 1-100) are generated
  // programmatically right after ZONES is defined — see generateFloorBosses() below.

  // ---- ASCENSO — the tower above floor 100. Every boss here has its own hand-built kit, none
  // shared or generated (unlike the 90 regular-floor Descenso bosses above). Piso 1 is barely a
  // threat; piso 100 (El Sol) is the true final boss of the whole game. ----
  shadowLarva: { name:'Larva de Sombra', hp:280, speed:95, dmg:12, radius:28, color:'#3a2f52', contactCd:1.1,
    minion:null, title:'Lo primero que se agita en la oscuridad' },
  hollowEcho: { name:'Eco Hueco', hp:340, speed:105, dmg:13, radius:26, color:'#4a3d68', contactCd:1.05,
    minion:null, title:'Repite un grito que nadie soltó' },
  crackWeaver: { name:'Tejedor de Grietas', hp:400, speed:90, dmg:15, radius:27, color:'#5a4a7a', contactCd:1.0,
    minion:null, title:'Hila fisuras donde antes no había nada' },
  muteGuardian: { name:'Guardiana Muda', hp:520, speed:70, dmg:16, radius:32, color:'#6a5a8c', contactCd:1.15,
    minion:null, title:'No hace falta hablar para golpear fuerte' },
  echoDevourer: { name:'Devorador de Ecos', hp:560, speed:115, dmg:17, radius:29, color:'#7a6a9e', contactCd:0.95,
    minion:null, title:'Se traga hasta el silencio' },
  ashSentinel: { name:'Centinela de Ceniza', hp:620, speed:85, dmg:18, radius:30, color:'#8a7ab0', contactCd:1.0,
    minion:null, title:'Lo que queda cuando la sombra empieza a arder' },
  crackWhisper: { name:'Susurro de Grieta', hp:660, speed:130, dmg:19, radius:27, color:'#9a5ac0', contactCd:0.9,
    minion:null, title:'Habla desde huecos que no deberían tener eco' },
  shadowThorn: { name:'Espina de Sombra', hp:700, speed:95, dmg:20, radius:28, color:'#5c2f7a', contactCd:1.0,
    minion:null, title:'Cada corte que deja sigue sangrando oscuridad' },
  silentWarden: { name:'Custodio Callado', hp:820, speed:65, dmg:20, radius:34, color:'#7a6a9e', contactCd:1.2,
    minion:null, title:'Vigila una puerta que nadie más recuerda' },
  ashSwarm: { name:'Enjambre de Cenizas', hp:760, speed:140, dmg:18, radius:24, color:'#9a8ab8', contactCd:0.85,
    minion:null, title:'Mil motas que alguna vez fueron una sola sombra' },
  fissureHerald: { name:'Heraldo de la Grieta', hp:950, speed:100, dmg:22, radius:32, color:'#aa7ad0', contactCd:0.95,
    minion:null, title:'El primer nombre que la grieta aprendió a pronunciar' },
  drownedScream: { name:'Grito Ahogado', hp:1020, speed:100, dmg:22, radius:30, color:'#4a2f6a', contactCd:1.0,
    minion:null, title:'Un grito que nunca llegó a salir' },
  duskWeave: { name:'Tejido de Penumbra', hp:1080, speed:105, dmg:23, radius:29, color:'#6a4a8a', contactCd:0.95,
    minion:null, title:'Ni sombra ni luz — apenas el borde entre las dos' },
  facelessGuard: { name:'Guardián sin Rostro', hp:1250, speed:68, dmg:24, radius:35, color:'#7a5a9a', contactCd:1.2,
    minion:null, title:'Custodia algo que ni él recuerda ya' },
  darkVine: { name:'Enredadera Oscura', hp:1150, speed:88, dmg:22, radius:28, color:'#3a5a3a', contactCd:1.05,
    minion:null, title:'Crece hacia la luz aunque la odie' },
  twinWhisper: { name:'Susurro Doble', hp:1220, speed:120, dmg:23, radius:27, color:'#8a4a9a', contactCd:0.9,
    minion:null, title:'Dos voces que olvidaron ser una sola' },
  brokenShard: { name:'Fragmento Roto', hp:1300, speed:95, dmg:24, radius:28, color:'#9a6ac0', contactCd:0.95,
    minion:null, title:'Se quebró y decidió que le gustaba así' },
  ashCustodian: { name:'Custodia de Cenizas', hp:1400, speed:70, dmg:25, radius:33, color:'#a08ac0', contactCd:1.15,
    minion:null, title:'Guarda lo que ya se apagó hace mucho' },
  namelessLament: { name:'Lamento sin Nombre', hp:1350, speed:130, dmg:24, radius:27, color:'#b07ad0', contactCd:0.85,
    minion:null, title:'Perdió el nombre antes que la voz' },
  fissureHeart: { name:'Corazón de Grieta', hp:1600, speed:100, dmg:26, radius:34, color:'#c08ae0', contactCd:0.95,
    minion:null, title:'Late al mismo ritmo que la torre entera' },
  thresholdEchoes: { name:'Ecos del Umbral', hp:1450, speed:105, dmg:25, radius:29, color:'#a070c0', contactCd:0.9,
    minion:null, title:'Marca dónde termina la sombra y no sabe qué sigue' },
  hollowChoir: { name:'Coro Hueco', hp:1520, speed:100, dmg:26, radius:28, color:'#9a5ab0', contactCd:0.9,
    minion:null, title:'Cantan al unísono aunque ninguno tenga voz propia' },
  duskMarauder: { name:'Merodeador del Ocaso', hp:1580, speed:145, dmg:25, radius:26, color:'#b06ac0', contactCd:0.8,
    minion:null, title:'Caza en el instante exacto entre la sombra y la luz' },
  graniteWarden: { name:'Custodio de Granito', hp:1900, speed:60, dmg:27, radius:37, color:'#8a7a9a', contactCd:1.25,
    minion:null, title:'Ni la torre entera lo movería de su sitio' },
  witheredBloom: { name:'Florecer Marchito', hp:1650, speed:95, dmg:26, radius:29, color:'#6a8a5a', contactCd:1.0,
    minion:null, title:'Intentó florecer hacia la luz y se quedó a mitad de camino' },
  crownOfEmbers: { name:'Corona de Brasas', hp:1850, speed:110, dmg:28, radius:33, color:'#d0906a', contactCd:0.9,
    minion:null, title:'La sombra empieza a arder de verdad a esta altura' },
  wanderingAsh: { name:'Ceniza Errante', hp:1780, speed:148, dmg:27, radius:25, color:'#c07850', contactCd:0.85,
    minion:null, title:'Va dejando su propio rastro de brasas al andar' },
  achingEmber: { name:'Brasa Doliente', hp:2050, speed:78, dmg:30, radius:34, color:'#a8452c', contactCd:1.05,
    minion:null, title:'Cada golpe le duele tanto a él como a quien lo recibe' },
  paleFlame: { name:'Llama Pálida', hp:1950, speed:100, dmg:28, radius:29, color:'#8a6a7a', contactCd:0.95,
    minion:null, title:'Ni fuego ni sombra — apenas los dos negándose a apagarse' },
  emberWarden: { name:'Custodio de Rescoldos', hp:2200, speed:58, dmg:30, radius:38, color:'#903a20', contactCd:1.3,
    minion:null, title:'La segunda mitad del ascenso empieza a pesar de verdad' },
  emberSwarm: { name:'Enjambre de Rescoldos', hp:1900, speed:150, dmg:26, radius:23, color:'#d68a4a', contactCd:0.8,
    minion:null, title:'Cientos de brasas que alguna vez fueron una corona entera' },

  // ---- Pisos 32-36: el fuego se apaga y vuelve la penumbra — sub-arco "apagado" ----
  dimmedMist: { name:'Bruma Apagada', hp:2000, speed:95, dmg:27, radius:29, color:'#5a5468', contactCd:1.0,
    minion:null, title:'Lo que queda del humo cuando ya no hay brasa que lo alimente' },
  dimmedWarden: { name:'Custodio Apagado', hp:2150, speed:65, dmg:29, radius:36, color:'#4a4658', contactCd:1.25,
    minion:null, title:'Guardó una llama tanto tiempo que olvidó que ya no ardía' },
  dimmedThorn: { name:'Espina Apagada', hp:1980, speed:100, dmg:27, radius:27, color:'#524a5a', contactCd:1.0,
    minion:null, title:'El veneno que deja es frío, no como el fuego que fue' },
  dimmedWhisper: { name:'Susurro Apagado', hp:1900, speed:135, dmg:26, radius:26, color:'#4e485c', contactCd:0.9,
    minion:null, title:'Ni siquiera su propio eco recuerda el calor' },
  dimmedHeart: { name:'Corazón Apagado', hp:2250, speed:100, dmg:29, radius:31, color:'#403c50', contactCd:0.95,
    minion:null, title:'Cierra el arco: de la ceniza a la nada, otra vez' },

  // ---- Pisos 37-41: lo que queda se asienta como polvo — último tramo antes de la mitad ----
  wanderingDust: { name:'Polvo Errante', hp:2100, speed:140, dmg:28, radius:24, color:'#8a8478', contactCd:0.85,
    minion:null, title:'Ni ceniza ni piedra — solo lo que sobra de ambas' },
  ashFissure: { name:'Fisura de Ceniza', hp:2300, speed:90, dmg:29, radius:30, color:'#6a6258', contactCd:1.0,
    minion:null, title:'El suelo mismo empieza a resentir tanto peso encima' },
  hollowReflection: { name:'Reflejo Hueco', hp:2200, speed:105, dmg:28, radius:28, color:'#9a948c', contactCd:0.95,
    minion:null, title:'Devuelve una imagen que ya no reconoce a nadie' },
  stoneWhisper: { name:'Susurro de Piedra', hp:2050, speed:138, dmg:27, radius:26, color:'#78726a', contactCd:0.85,
    minion:null, title:'Habla lento, pero nunca dos veces desde el mismo sitio' },
  dustHeart: { name:'Corazón de Polvo', hp:2600, speed:100, dmg:30, radius:33, color:'#7a746a', contactCd:0.95,
    minion:null, title:'Punto medio del camino — late con el peso de todo lo que ya cayó' },

  // ---- Pisos 42-46: primeros brillos — la luz empieza a filtrarse entre la penumbra ----
  dimmedGleam: { name:'Brillo Apagado', hp:2350, speed:105, dmg:28, radius:28, color:'#948a78', contactCd:0.95,
    minion:null, title:'Apenas un destello, pero ya no es solo sombra' },
  stoneWarden: { name:'Custodio de Piedra', hp:2450, speed:62, dmg:31, radius:37, color:'#6a645c', contactCd:1.3,
    minion:null, title:'Octavo en guardia, y ninguno tan inmóvil como este' },
  lightThorn: { name:'Espina de Luz', hp:2300, speed:100, dmg:29, radius:27, color:'#c9b878', contactCd:0.95,
    minion:null, title:'El primer dolor que quema en vez de pudrir' },
  greyEchoes: { name:'Ecos Grises', hp:2250, speed:118, dmg:28, radius:26, color:'#8a8290', contactCd:0.9,
    minion:null, title:'Cada eco repite un poco menos de sombra que el anterior' },
  ashLightGuardian: { name:'Guardiana de Ceniza y Luz', hp:2550, speed:95, dmg:30, radius:30, color:'#b0a488', contactCd:0.95,
    minion:null, title:'Cierra el tramo — ya no defiende solo la sombra' },

  // ---- Pisos 47-51: el límite — donde termina la penumbra y empieza a crecer la luz ----
  faintVeil: { name:'Velo Tenue', hp:2400, speed:120, dmg:29, radius:27, color:'#a89ccc', contactCd:0.9,
    minion:null, title:'Ni sombra ni luz — un velo que todavía no decide qué es' },
  edgeGuardian: { name:'Guardiana del Límite', hp:2650, speed:60, dmg:31, radius:38, color:'#7a6e98', contactCd:1.3,
    minion:null, title:'Novena en guardia — custodia la frontera misma' },
  dawnThorn: { name:'Espina del Alba', hp:2450, speed:102, dmg:29, radius:28, color:'#d8b878', contactCd:0.95,
    minion:null, title:'Ya no es fuego ni sombra lo que quema — es el alba' },
  edgeHeart: { name:'Corazón del Límite', hp:2850, speed:98, dmg:31, radius:34, color:'#8878a8', contactCd:0.95,
    minion:null, title:'Cierra el tramo 26-50 entero — la penumbra termina acá' },
  wanderingDawn: { name:'Alba Errante', hp:2350, speed:152, dmg:28, radius:24, color:'#e8c888', contactCd:0.8,
    minion:null, title:'Abre el siguiente tramo — la luz empieza a crecer de verdad' },

  // ---- Pisos 52-56: la luz gana terreno — décimo tramo antes de acercarse al Sol ----
  dawnGuardian: { name:'Guardiana del Alba', hp:2700, speed:64, dmg:31, radius:37, color:'#c8a848', contactCd:1.25,
    minion:null, title:'Décima en guardia — la luz también sabe ser paciente' },
  goldenEcho: { name:'Eco Dorado', hp:2500, speed:120, dmg:29, radius:26, color:'#e0b858', contactCd:0.9,
    minion:null, title:'Cada eco brilla un poco más que el anterior' },
  goldenThorn: { name:'Espina Dorada', hp:2550, speed:104, dmg:30, radius:28, color:'#f0c868', contactCd:0.95,
    minion:null, title:'El dolor del alba ya pesa más que el de la sombra' },
  dawnWhisper: { name:'Susurro del Alba', hp:2400, speed:140, dmg:28, radius:26, color:'#e8d078', contactCd:0.85,
    minion:null, title:'Ni siquiera necesita esconderse ya en la penumbra' },
  brightHollow: { name:'Hueco Brillante', hp:2750, speed:100, dmg:30, radius:31, color:'#f4d888', contactCd:0.95,
    minion:null, title:'Cierra el tramo — lo que fue vacío ahora refleja luz' },

  // ---- Pisos 57-61: la luz ya domina — se acerca la mitad del camino al Sol ----
  goldenSwarm: { name:'Enjambre Dorado', hp:2450, speed:158, dmg:27, radius:23, color:'#f0d068', contactCd:0.78,
    minion:null, title:'Cientos de chispas que ya no recuerdan haber sido sombra' },
  radiantWarden: { name:'Custodio Radiante', hp:2900, speed:66, dmg:32, radius:38, color:'#e8c048', contactCd:1.25,
    minion:null, title:'Undécimo en guardia — ni la luz más fuerte lo hace parpadear' },
  radiantThorn: { name:'Espina Radiante', hp:2650, speed:106, dmg:31, radius:29, color:'#ffd868', contactCd:0.95,
    minion:null, title:'Duele más de lo que cualquier sombra dolió jamás' },
  sunHerald: { name:'Heraldo del Sol', hp:3100, speed:100, dmg:32, radius:35, color:'#ffdc78', contactCd:0.95,
    minion:null, title:'Anuncia lo que viene — todavía falta, pero ya se siente el calor' },
  goldenSentinel: { name:'Centinela Dorado', hp:2500, speed:150, dmg:28, radius:25, color:'#ffe088', contactCd:0.82,
    minion:null, title:'Abre el tramo final antes del ecuador del camino' },

  // ---- Pisos 62-66: el sol ya se siente cerca — se acerca la mitad del camino a la cima ----
  solarWarden: { name:'Custodio Solar', hp:3050, speed:68, dmg:32, radius:38, color:'#ffcc48', contactCd:1.25,
    minion:null, title:'Duodécimo en guardia — ya casi no queda sombra que proteger' },
  solarWhisper: { name:'Susurro Solar', hp:2650, speed:142, dmg:29, radius:26, color:'#ffd858', contactCd:0.85,
    minion:null, title:'Su voz ya no es un susurro — apenas logra contenerse' },
  solarEcho: { name:'Eco Solar', hp:2700, speed:122, dmg:29, radius:27, color:'#ffe068', contactCd:0.9,
    minion:null, title:'Cada eco es un poco más brillante que la fuente' },
  blazeSwarm: { name:'Enjambre de Llamas', hp:2600, speed:160, dmg:28, radius:23, color:'#ffb848', contactCd:0.76,
    minion:null, title:'Ya no quedan cenizas — solo llama pura y en movimiento' },
  solarGuardian: { name:'Guardiana Solar', hp:2950, speed:98, dmg:31, radius:32, color:'#ffe488', contactCd:0.95,
    minion:null, title:'Cierra el tramo — el ecuador del camino al Sol está cerca' },

  // ---- Pisos 67-71: la corona del Sol ya se distingue en el horizonte ----
  flareWarden: { name:'Custodio de Flare', hp:3150, speed:70, dmg:33, radius:38, color:'#ffb828', contactCd:1.25,
    minion:null, title:'Decimotercero en guardia — hasta el fuego respeta su turno' },
  flareThorn: { name:'Espina de Flare', hp:2750, speed:108, dmg:31, radius:29, color:'#ffa838', contactCd:0.95,
    minion:null, title:'Cada espina es una pequeña llamarada que no se apaga' },
  coronaWhisper: { name:'Susurro de Corona', hp:2800, speed:144, dmg:29, radius:26, color:'#ffc048', contactCd:0.85,
    minion:null, title:'Ya brilla tanto que cuesta verlo moverse' },
  coronaHeart: { name:'Corazón de Corona', hp:3300, speed:100, dmg:32, radius:35, color:'#ffb438', contactCd:0.95,
    minion:null, title:'Cierra el tramo — la corona del Sol ya se distingue entera' },
  flareSwarm: { name:'Enjambre de Flare', hp:2750, speed:162, dmg:29, radius:23, color:'#ffcc58', contactCd:0.75,
    minion:null, title:'Abre el siguiente tramo — cada vez menos falta para la cima' },

  // ---- Pisos 72-76: el cenit — se acerca el tres cuartos del camino ----
  zenithWarden: { name:'Custodio del Cenit', hp:3250, speed:72, dmg:33, radius:39, color:'#ffdc38', contactCd:1.25,
    minion:null, title:'Decimocuarto en guardia — arriba, el sol ya pesa sobre todos' },
  zenithThorn: { name:'Espina del Cenit', hp:2850, speed:110, dmg:32, radius:29, color:'#ffe048', contactCd:0.95,
    minion:null, title:'A esta altura, hasta el dolor tiene su propio brillo' },
  zenithWhisper: { name:'Susurro del Cenit', hp:2900, speed:146, dmg:30, radius:27, color:'#ffe458', contactCd:0.85,
    minion:null, title:'Ya no necesita sombra ninguna para moverse rápido' },
  zenithEcho: { name:'Eco del Cenit', hp:2950, speed:124, dmg:30, radius:28, color:'#ffe868', contactCd:0.9,
    minion:null, title:'Marca los tres cuartos del camino — cada eco es puro mediodía' },
  zenithGuardian: { name:'Guardiana del Cenit', hp:3100, speed:100, dmg:32, radius:33, color:'#ffec78', contactCd:0.95,
    minion:null, title:'Cierra el tramo — desde acá, todo el camino es cuesta de luz' },

  // ---- Pisos 77-81: luz cegadora — el último tramo antes de la recta final ----
  blindingWarden: { name:'Custodio Cegador', hp:3350, speed:74, dmg:34, radius:39, color:'#fff088', contactCd:1.25,
    minion:null, title:'Decimoquinto en guardia — casi no se distingue ya su forma' },
  blindingThorn: { name:'Espina Cegadora', hp:2950, speed:112, dmg:32, radius:29, color:'#fff498', contactCd:0.95,
    minion:null, title:'El dolor y la luz son, a esta altura, la misma cosa' },
  blindingWhisper: { name:'Susurro Cegador', hp:3000, speed:148, dmg:31, radius:27, color:'#fff6a8', contactCd:0.85,
    minion:null, title:'Ya nadie recuerda si alguna vez fue penumbra' },
  blindingHeart: { name:'Corazón Cegador', hp:3550, speed:102, dmg:33, radius:36, color:'#fff8b8', contactCd:0.95,
    minion:null, title:'Cierra el tramo, 4 ataques — falta poco para el final del camino' },
  blindingSwarm: { name:'Enjambre Cegador', hp:2950, speed:165, dmg:30, radius:23, color:'#fffac8', contactCd:0.74,
    minion:null, title:'Abre la recta final — cada chispa ya es casi Sol' },

  // ---- Pisos 82-86: lo ascendente — ya casi no hay distancia entre el jefe y la cima ----
  ascendantWarden: { name:'Custodio Ascendente', hp:3450, speed:76, dmg:34, radius:40, color:'#fff4a0', contactCd:1.2,
    minion:null, title:'Decimosexto en guardia — sube con el camino, nunca lo abandona' },
  ascendantThorn: { name:'Espina Ascendente', hp:3050, speed:114, dmg:33, radius:30, color:'#fff6b0', contactCd:0.9,
    minion:null, title:'Cada paso hacia arriba se paga con un poco de dolor propio' },
  ascendantWhisper: { name:'Susurro Ascendente', hp:3100, speed:150, dmg:31, radius:28, color:'#fff8c0', contactCd:0.85,
    minion:null, title:'Habla en el idioma que solo se escucha cerca de la cima' },
  ascendantEcho: { name:'Eco Ascendente', hp:3150, speed:126, dmg:31, radius:29, color:'#fffad0', contactCd:0.9,
    minion:null, title:'Cada eco sube un poco más que el anterior, sin cansarse nunca' },
  ascendantGuardian: { name:'Guardiana Ascendente', hp:3300, speed:104, dmg:33, radius:34, color:'#fffce0', contactCd:0.95,
    minion:null, title:'Cierra el tramo — desde acá se ve, por fin, la cima entera' },

  // ---- Pisos 87-91: la cumbre — el último tramo antes de enfrentar al Sol mismo ----
  summitWarden: { name:'Custodio de la Cumbre', hp:3550, speed:78, dmg:35, radius:40, color:'#fffef0', contactCd:1.2,
    minion:null, title:'Decimoséptimo en guardia — el último que custodia algo antes del Sol' },
  summitThorn: { name:'Espina de la Cumbre', hp:3150, speed:116, dmg:34, radius:31, color:'#fffff4', contactCd:0.9,
    minion:null, title:'A esta altura, el dolor y la luz ya no se distinguen en nada' },
  summitWhisper: { name:'Susurro de la Cumbre', hp:3200, speed:152, dmg:32, radius:28, color:'#fffff8', contactCd:0.85,
    minion:null, title:'El último susurro — después de este, solo queda gritar' },
  summitHeart: { name:'Corazón de la Cumbre', hp:3700, speed:106, dmg:34, radius:37, color:'#fffffc', contactCd:0.95,
    minion:null, title:'Cierra el tramo, 4 ataques — el Sol ya está del otro lado de la puerta' },
  summitSwarm: { name:'Enjambre de la Cumbre', hp:3050, speed:168, dmg:31, radius:24, color:'#ffffff', contactCd:0.72,
    minion:null, title:'Abre el tramo final — después de esto ya no hay más tramos' },

  // ---- Pisos 92-96: el portal — el último tramo antes de enfrentar al Sol mismo ----
  portalWarden: { name:'Custodio del Portal', hp:3650, speed:80, dmg:35, radius:41, color:'#fffef5', contactCd:1.2,
    minion:null, title:'Decimoctavo en guardia — el último que custodia la entrada' },
  portalThorn: { name:'Espina del Portal', hp:3250, speed:118, dmg:34, radius:31, color:'#fffff6', contactCd:0.9,
    minion:null, title:'Ya no queda distancia entre el dolor y la luz misma' },
  portalWhisper: { name:'Susurro del Portal', hp:3300, speed:154, dmg:32, radius:28, color:'#fffff9', contactCd:0.85,
    minion:null, title:'Lo que susurra ya no es un idioma — es solo calor' },
  portalEcho: { name:'Eco del Portal', hp:3350, speed:128, dmg:32, radius:29, color:'#fffffb', contactCd:0.9,
    minion:null, title:'El último eco antes del silencio total del Sol' },
  portalGuardian: { name:'Guardiana del Portal', hp:3500, speed:108, dmg:34, radius:35, color:'#fffffd', contactCd:0.95,
    minion:null, title:'Cierra el tramo — el Sol está justo del otro lado' },

  // ---- Pisos 97-99: los últimos tres — después de esto, solo queda El Sol ----
  lastWarden: { name:'Último Custodio', hp:3800, speed:82, dmg:36, radius:42, color:'#fffefb', contactCd:1.15,
    minion:null, title:'El último que hace guardia — nadie viene después de él' },
  lastThorn: { name:'Última Espina', hp:3400, speed:120, dmg:35, radius:32, color:'#fffefe', contactCd:0.9,
    minion:null, title:'El último dolor antes de que ya no haya más que luz' },
  sunPrecursor: { name:'Precursor del Sol', hp:4200, speed:112, dmg:36, radius:38, color:'#ffffff', contactCd:0.9,
    minion:null, title:'Anuncia al Sol en persona — después de él, ya no hay más puertas' },

  theSun: { name:'El Sol', hp:2200, speed:110, dmg:26, radius:48, color:'#fff3c4', contactCd:0.7,
    minion:null, title:'Lo único que queda al final de la luz' },
};

const BOSS_ATTACKS = {
  boneGuardian: ['boneShards','boneCage','boneWall','boneGrab'],
  motherWitch: ['poisonPool','curseMark','witchCauldron','wither','acidDeluge','venomousWeb'],
  abyssLord: ['slam','magmaCross','blazingFissure','growingMagma','plasmaBeam'],
  empressOfLight: ['gracefulVeil','radiantNova','rainbowLine','spiralBloom','petalRing','solarSporeSpiral','dandelionWave','lightDeluge','prismaticCascade','radiantMandala'],
  mirrorLord: ['mirrorSplit','phantomBarrage','glassRain','infiniteReflections','boundlessBeam','crystalCage'],
  twinBoss: ['eyeLaser','cursedFlameBreath','twinCharge','sisterCall','megaLaser','pincerScan','orbitalCross','desperateRush','energyBond'],
  trueFinal: [
    // Guardián de Hueso (piso 10)
    'boneGrab','boneCage',
    // Bruja Madre (piso 20)
    'witchCauldron','venomousWeb',
    // Señor del Abismo (piso 30)
    'blazingFissure','growingMagma',
    // Emperatriz de Luz (piso 40)
    'radiantMandala','prismaticCascade',
    // Señor de los Espejos (piso 50)
    'infiniteReflections','boundlessBeam',
    // Gemelas Espectrales (piso 60) — twinCharge is the one Twins move that works without a
    // live twin (it's just a straight-line charge with a wind-up line telegraph)
    'twinCharge',
    // Monarca Glacial (piso 70)
    'absoluteZero','iceAvalanche',
    // Señor de la Tormenta (piso 80)
    'thunderdome','closingBarrier',
    // Devorador de Estrellas (piso 90)
    'massSingularity','eventHorizonPulse',
    // El Verdadero Abismo's own signature finisher
    'abyssalCollapse',
  ],

  // zone guardians — every move below is exclusive to its own Guardian; none of the 9 non-final
  // Guardians share a single attack with any other Guardian
  glacierMonarch: ['frostNova','iceCage','blizzardWall','frozenGround','iceSlide','growingSpikes','absoluteZero','movingIceWalls','iceAvalanche'],
  stormLord: ['chainLightning','stormField','thunderdome','circuitPanels','polarityPull','closingBarrier','predictiveLightning'],
  starDevourer: ['voidLance','voidRift','gravityWell','starCollapse','massSingularity','gravityFlip','voidCrackCollapse','eventHorizonPulse'],

  // ASCENSO
  shadowLarva: ['voidClaw','voidPuddles','shadowBurst'],
  hollowEcho: ['echoSlam','hollowVolley','duplicantPulse'],
  crackWeaver: ['crackLine','tendrilBloom','weaverBurst'],
  muteGuardian: ['silentSlam','mutePulse','whisperVolley'],
  echoDevourer: ['devourLunge','echoSwarmBurst','voidMawPuddles'],
  ashSentinel: ['ashSlam','cinderRing','ashStorm'],
  crackWhisper: ['whisperDodge','crackVolley','whisperCrawl'],
  shadowThorn: ['thornLash','thornField','thornBurst'],
  silentWarden: ['wardenCrush','wardenBarrier','wardenVolley'],
  ashSwarm: ['swarmDash','swarmPepper','swarmField'],
  fissureHerald: ['heraldSlam','heraldLine','heraldBurst','heraldCollapse'],
  drownedScream: ['screamSlam','drownedVolley','echoTrap'],
  duskWeave: ['duskLash','duskWeb','twilightBurst'],
  facelessGuard: ['facelessCrush','facelessWard','facelessGaze'],
  darkVine: ['vineLash','vineField','vineBurst'],
  twinWhisper: ['whisperTwinDash','doubleVolley','twinCrawl'],
  brokenShard: ['shardSlam','shardRain','shardBurst'],
  ashCustodian: ['custodianSlam','custodianRing','custodianVolley'],
  namelessLament: ['lamentDodge','lamentCrawl','lamentWail'],
  fissureHeart: ['heartSlam','heartLine','heartBurst','heartCollapse'],
  thresholdEchoes: ['thresholdSlam','thresholdField','voidBeam'],
  hollowChoir: ['choirSlam','choirWave','choirEcho'],
  duskMarauder: ['marauderPounce','marauderRake','marauderHail'],
  graniteWarden: ['graniteCrush','graniteWall','graniteVolley'],
  witheredBloom: ['bloomLash','bloomField','bloomBurst'],
  crownOfEmbers: ['emberSlam','crownAshfall','emberBurst'],
  wanderingAsh: ['ashDash','emberWake','cinderScatter'],
  achingEmber: ['emberCrush','achingRing','emberVolley'],
  paleFlame: ['paleFlicker','paleWake','paleBurst'],
  emberWarden: ['wardenEmberSlam','emberWardenRing','emberWardenVolley'],
  emberSwarm: ['swarmEmberDash','emberSwarmField','emberSwarmBurst'],
  dimmedMist: ['mistSlam','mistField','mistBurst'],
  dimmedWarden: ['dimmedCrush','dimmedRing','dimmedVolley'],
  dimmedThorn: ['greyThornLash','greyThornField','greyThornBurst'],
  dimmedWhisper: ['dimWhisperDodge','dimmedCrawl','dimmedWhisperVolley'],
  dimmedHeart: ['heartDimSlam','dimmedHeartLine','dimmedHeartBurst'],
  wanderingDust: ['dustDash','dustTrail','dustScatter'],
  ashFissure: ['fissureLash','fissureField','fissureBurst'],
  hollowReflection: ['hollowSlam','hollowField','hollowBurst'],
  stoneWhisper: ['stoneWhisperDodge','stoneCrawl','stoneVolley'],
  dustHeart: ['dustHeartSlam','dustHeartLine','dustHeartBurst','dustHeartCollapse'],
  dimmedGleam: ['gleamSlam','gleamField','gleamBurst'],
  stoneWarden: ['stoneWardenCrush','stoneWardenRing','stoneWardenVolley'],
  lightThorn: ['lightThornLash','lightThornField','lightThornBurst'],
  greyEchoes: ['greyEchoDash','greyEchoField','greyEchoBurst'],
  ashLightGuardian: ['ashLightSlam','ashLightField','ashLightBurst'],
  faintVeil: ['veilSlam','veilField','veilBurst'],
  edgeGuardian: ['edgeGuardCrush','edgeGuardRing','edgeGuardVolley'],
  dawnThorn: ['dawnThornLash','dawnThornField','dawnThornBurst'],
  edgeHeart: ['edgeHeartSlam','edgeHeartLine','edgeHeartBurst','edgeHeartCollapse'],
  wanderingDawn: ['dawnDash','dawnTrail','dawnScatter'],
  dawnGuardian: ['dawnGuardCrush','dawnGuardRing','dawnGuardVolley'],
  goldenEcho: ['goldenEchoDash','goldenEchoField','goldenEchoBurst'],
  goldenThorn: ['goldenThornLash','goldenThornField','goldenThornBurst'],
  dawnWhisper: ['dawnWhisperDodge','dawnWhisperCrawl','dawnWhisperVolley'],
  brightHollow: ['brightSlam','brightField','brightBurst'],
  goldenSwarm: ['swarmGoldenDash','goldenSwarmField','goldenSwarmBurst'],
  radiantWarden: ['radiantCrush','radiantRing','radiantVolley'],
  radiantThorn: ['radiantThornLash','radiantThornField','radiantThornBurst'],
  sunHerald: ['sunHeraldSlam','sunHeraldLine','sunHeraldBurst','sunHeraldCollapse'],
  goldenSentinel: ['sentinelDash','sentinelTrail','sentinelScatter'],
  solarWarden: ['solarWardenCrush','solarWardenRing','solarWardenVolley'],
  solarWhisper: ['solarWhisperDodge','solarWhisperCrawl','solarWhisperVolley'],
  solarEcho: ['solarEchoDash','solarEchoField','solarEchoBurst'],
  blazeSwarm: ['swarmBlazeDash','blazeSwarmField','blazeSwarmBurst'],
  solarGuardian: ['solarGuardSlam','solarGuardField','solarGuardBurst'],
  flareWarden: ['flareWardenCrush','flareWardenRing','flareWardenVolley'],
  flareThorn: ['flareThornLash','flareThornField','flareThornBurst'],
  coronaWhisper: ['coronaWhisperDodge','coronaWhisperCrawl','coronaWhisperVolley'],
  coronaHeart: ['coronaHeartSlam','coronaHeartLine','coronaHeartBurst','coronaHeartCollapse'],
  flareSwarm: ['swarmFlareDash','flareSwarmField','flareSwarmBurst'],
  zenithWarden: ['zenithWardenCrush','zenithWardenRing','zenithWardenVolley'],
  zenithThorn: ['zenithThornLash','zenithThornField','zenithThornBurst'],
  zenithWhisper: ['zenithWhisperDodge','zenithWhisperCrawl','zenithWhisperVolley'],
  zenithEcho: ['zenithEchoDash','zenithEchoField','zenithEchoBurst'],
  zenithGuardian: ['zenithGuardSlam','zenithGuardField','zenithGuardBurst'],
  blindingWarden: ['blindWardenCrush','blindWardenRing','blindWardenVolley'],
  blindingThorn: ['blindThornLash','blindThornField','blindThornBurst'],
  blindingWhisper: ['blindWhisperDodge','blindWhisperCrawl','blindWhisperVolley'],
  blindingHeart: ['blindHeartSlam','blindHeartLine','blindHeartBurst','blindHeartCollapse'],
  blindingSwarm: ['swarmBlindDash','blindSwarmField','blindSwarmBurst'],
  ascendantWarden: ['ascWardenCrush','ascWardenRing','ascWardenVolley'],
  ascendantThorn: ['ascThornLash','ascThornField','ascThornBurst'],
  ascendantWhisper: ['ascWhisperDodge','ascWhisperCrawl','ascWhisperVolley'],
  ascendantEcho: ['ascEchoDash','ascEchoField','ascEchoBurst'],
  ascendantGuardian: ['ascGuardSlam','ascGuardField','ascGuardBurst'],
  summitWarden: ['summitWardenCrush','summitWardenRing','summitWardenVolley'],
  summitThorn: ['summitThornLash','summitThornField','summitThornBurst'],
  summitWhisper: ['summitWhisperDodge','summitWhisperCrawl','summitWhisperVolley'],
  summitHeart: ['summitHeartSlam','summitHeartLine','summitHeartBurst','summitHeartCollapse'],
  summitSwarm: ['swarmSummitDash','summitSwarmField','summitSwarmBurst'],
  portalWarden: ['portalWardenCrush','portalWardenRing','portalWardenVolley'],
  portalThorn: ['portalThornLash','portalThornField','portalThornBurst'],
  portalWhisper: ['portalWhisperDodge','portalWhisperCrawl','portalWhisperVolley'],
  portalEcho: ['portalEchoDash','portalEchoField','portalEchoBurst'],
  portalGuardian: ['portalGuardSlam','portalGuardField','portalGuardBurst'],
  lastWarden: ['lastWardenCrush','lastWardenRing','lastWardenVolley'],
  lastThorn: ['lastThornLash','lastThornField','lastThornBurst'],
  sunPrecursor: ['precursorSlam','precursorRing','precursorLine','precursorBurst','precursorCollapse'],
  theSun: ['geoSweep','stormSpiral','eruptionConvergence','zeroGravityRings','totalCollapse'],
};
// Any boss attack that restores boss HP (direct heal, regen-over-time, or life-drain-from-player).
// Nerf: a boss can only roll one of these once every 10 attacks it executes (see pickBossAttack).
const HEAL_ATTACK_TYPES = new Set([
  'sisterCall','cryptWhisper','witchesBlessing','shadowBrew','infernalBond',
  'healingBloom','sharedBlessing','glacialWard','stormShield','starlightDrain',
  'voidShroud','royalAegis'
]);
generateFloorBosses(); // now that BOSS_DEFS/BOSS_ATTACKS exist, fill in the 90 regular-floor bosses

const BOSS_ITEMS = {
  boneGuardian: { id:'bossBone', name:'Corona de Hueso Antiguo', icon:'♛', desc:'+5% daño y +3% reducción de daño', apply:p=>{ p.dmgMult*=1.05; p.armor+=0.03; },
    lore:'Tallada de las costillas del primer guardián que juró proteger la Cripta Olvidada — sigue jurando, aunque hace siglos que nadie recuerda a quién.' },
  motherWitch:  { id:'bossWitch', name:'Frasco de la Bruja Madre', icon:'☘', desc:'+2.5% robo de vida y +9 velocidad', apply:p=>{ grantLifesteal(p,0.025); p.speedFlat+=9; },
    lore:'El caldero de la Bruja Madre nunca se enfría del todo. Este frasco guarda un último resto, todavía tibio, todavía hambriento.' },
  abyssLord:    { id:'bossAbyss', name:'Núcleo del Abismo', icon:'⚡', desc:'+6% daño y -8% enfriamiento', apply:p=>{ p.dmgMult*=1.06; p.cdMult*=0.92; },
    lore:'Late como un corazón que ya no debería latir. Cuanto más cerca lo llevás, más rápido parece pensar el Abismo entero.' },
  empressOfLight:{ id:'bossEmpress', name:'Pluma Prismática', icon:'✦', desc:'+5% crítico y +18 HP máx', apply:p=>{ p.critChance+=0.05; p.maxHp+=18; p.hp+=18; },
    lore:'Una sola pluma de la Emperatriz basta para partir la luz en mil colores — y, si sabés mirarla bien, en mil advertencias.' },
  mirrorLord: { id:'bossMirror', name:'Esquirla de Espejo', icon:'◈', desc:'+4% daño y +5% enfriamiento reducido', apply:p=>{ p.dmgMult*=1.04; p.cdMult*=0.95; },
    lore:'Un fragmento del Reflejo que todavía muestra algo moviéndose del otro lado, un segundo después de que vos ya te fuiste.' },
  twinBoss: { id:'bossTwin', name:'Lazo de las Gemelas', icon:'⚭', desc:'+2.5% robo de vida y +4% crítico', apply:p=>{ grantLifesteal(p,0.025); p.critChance+=0.04; },
    lore:'Ni siquiera partido en dos deja de tirar hacia el mismo lado. Las Hermanas Gemelas nunca aprendieron a estar solas.' },
  trueFinal: { id:'bossTrueFinal', name:'Corazón del Verdadero Abismo', icon:'☉', desc:'+7% daño, +14 velocidad y +20 HP máx', apply:p=>{ p.dmgMult*=1.07; p.speedFlat+=14; p.maxHp+=20; p.hp+=20; },
    lore:'Lo que queda cuando los nueve Guardianes caen a la vez. No es un trofeo — es lo único del Abismo que sigue creyendo que puede ganar.' },
};

const ULTIMATE_ABILITIES = [
  { id:'ira_celeste', name:'Ira Celeste', icon:'⚡', cd:42, color:'#ffd54a',
    desc:'Rayos golpean a todos los enemigos en pantalla',
    cast: p=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{
        dealDamageToTarget(t, computeDamage(16), 'ult');
        addParticles(t.x,t.y,'#ffd54a',12,180,0.4);
      });
      shake(12);
    } },
  { id:'velo_vacio', name:'Velo del Vacío', icon:'◈', cd:30, color:'#6a8dff',
    desc:'Invulnerabilidad breve y explosión de daño a tu alrededor',
    cast: p=>{
      p.invuln = Math.max(p.invuln, 1.6);
      explodeAt(p.x,p.y,120, computeDamage(20));
    } },
  { id:'pacto_sangre', name:'Pacto de Sangre', icon:'♥', cd:38, color:'#e8434f',
    desc:'Cura el 28% de tu vida máxima al instante',
    cast: p=>{
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.28);
      addParticles(p.x,p.y,'#e8434f',24,170,0.5);
    } },
  { id:'pliegue_temporal', name:'Pliegue Temporal', icon:'⏳', cd:36, color:'#8affe0',
    desc:'Detiene a todos los enemigos y al jefe en pantalla por 1.8s y los golpea',
    cast: p=>{
      game.enemies.forEach(en=>{
        en.stunTimer = Math.max(en.stunTimer||0, 1.8);
        dealDamageToTarget(en, computeDamage(10), 'ult');
      });
      bossTargets().forEach(t=>{
        t.stunTimer = Math.max(t.stunTimer||0, 1.8);
        dealDamageToTarget(t, computeDamage(10), 'ult');
      });
      addParticles(p.x,p.y,'#8affe0',20,120,0.4);
      shake(6);
    } },
  { id:'escudo_especular', name:'Escudo Especular', icon:'◎', cd:34, color:'#6ad8ff',
    desc:'Por 4s, todo el daño que recibís se refleja al enemigo más cercano',
    cast: p=>{
      p.effects.mirrorShield = 4;
      addParticles(p.x,p.y,'#6ad8ff',22,150,0.45);
      shake(3);
    } },
  { id:'guardian_efimero', name:'Guardián Efímero', icon:'⚚', cd:40, color:'#c9a8ff',
    desc:'Invoca un guardián espectral que ataca solo durante 8s',
    cast: p=>{
      // reuses the same single pet slot/AI as Silvano's wolf summon (updatePet/drawPet are
      // generic over any {x,y,radius,color,speed,dmg,atkCd,life} shape) — if Silvano already has
      // a wolf out, this simply replaces it with the guardian for its duration
      game.pet = { x:p.x-30, y:p.y, hp:1, maxHp:1, radius:15, speed:210,
        dmg:Math.round(p.def.atk ? p.def.atk.dmg*1.6 : 16),
        atkCd:0.6, atkTimer:0, hitFlash:0, life:8, color:'#c9a8ff' };
      addParticles(p.x,p.y,'#c9a8ff',26,170,0.5);
    } },
  { id:'consumir_almas', name:'Consumir Almas', icon:'👁', cd:38, color:'#7a2fbf',
    desc:'Golpea a todo enemigo en pantalla con más fuerza cuanto más herido esté, y te cura según el daño hecho',
    cast: p=>{
      let healed=0;
      [...game.enemies, ...bossTargets()].forEach(t=>{
        const missingFrac = t.maxHp ? 1-clamp(t.hp/t.maxHp,0,1) : 0;
        const dmgObj = computeDamage(10 + missingFrac*30);
        dealDamageToTarget(t, dmgObj, 'ult');
        healed += dmgObj.value*0.3;
        addParticles(t.x,t.y,'#7a2fbf',10,150,0.3);
      });
      p.hp = Math.min(p.maxHp, p.hp+healed);
      shake(8);
    } },
  { id:'grito_ancestral', name:'Grito de Guerra Ancestral', icon:'🔥', cd:32, color:'#ff6a3d',
    desc:'Gran aumento temporal de daño y velocidad de movimiento',
    cast: p=>{
      p.potionEffects.dmg = Math.max(p.potionEffects.dmg, 8);
      p.potionEffects.spd = Math.max(p.potionEffects.spd, 8);
      p.invuln = Math.max(p.invuln, 0.4);
      addParticles(p.x,p.y,'#ff6a3d',24,190,0.5);
      shake(6);
    } },
  { id:'colapso_estrella', name:'Colapso de Estrella', icon:'☄', cd:44, color:'#ffe08a',
    desc:'El golpe más fuerte del juego a tu alrededor, pero te cuesta un 12% de tu vida máxima',
    cast: p=>{
      explodeAt(p.x, p.y, 220, computeDamage(46));
      p.hp = Math.max(1, p.hp - p.maxHp*0.12);
      shake(16);
      addParticles(p.x,p.y,'#ffe08a',36,240,0.6);
    } },
  { id:'enjambre_espectral', name:'Enjambre Espectral', icon:'🦇', cd:36, color:'#8a6fd8',
    desc:'Invoca hasta 3 espíritus que pelean a tu lado',
    cast: p=>{
      for(let i=0; i<3 && game.pack.length<4; i++){
        game.pack.push({ x:p.x+rand(-30,30), y:p.y+rand(-30,30), hp:1, maxHp:1, radius:12, speed:260,
          dmg:14, atkTimer:0, atkCd:0.5, color:'#8a6fd8', hitFlash:0, life:10 });
      }
      addParticles(p.x,p.y,'#8a6fd8',20,170,0.4);
    } },
  { id:'grieta_dimensional', name:'Grieta Dimensional', icon:'🌀', cd:30, color:'#c9a8ff',
    desc:'Te teletransportás a un punto seguro del área y dejás una trampa retardada donde estabas',
    cast: p=>{
      const b = arenaBounds();
      const oldX=p.x, oldY=p.y;
      game.pendingBursts.push({ x:oldX, y:oldY, timer:0.4, radius:130, dmgBase:22 });
      p.x = clamp(b.x+rand(60,b.w-60), b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(b.y+rand(60,b.h-60), b.y+p.radius, b.y+b.h-p.radius);
      p.invuln = Math.max(p.invuln, 0.5);
      addParticles(oldX,oldY,'#c9a8ff',18,160,0.35);
      addParticles(p.x,p.y,'#c9a8ff',18,160,0.35);
    } },
];

// ---------- ASCENSO's key-Shift abilities ----------
// Unlocked through Ascenso progress (currently just: beat El Sol) rather than boss drops, and
// selected the same single-active way as ULTIMATE_ABILITIES (see selectShiftAbility). Only one
// real ability exists so far — more are planned once more of the tower above floor 100 is built,
// see the continuation doc for the backlog.
const SHIFT_ABILITIES = [
  { id:'mantoLuz', name:'Manto de Luz', icon:'☀', cd:20, color:'#fff3c4',
    desc:'1.5s de invulnerabilidad y +40% de velocidad — un respiro robado del Sol mismo',
    cast: p=>{
      p.invuln = Math.max(p.invuln, 1.5);
      p.effects.mantoLuz = Math.max(p.effects.mantoLuz||0, 1.5); // dedicated field — reusing 'shadow' would
      // wrongly show Picaro's "Paso Sombrío" tooltip and only grant +15% instead of the advertised +40%
      addParticles(p.x,p.y,'#fff3c4',24,180,0.45);
    } },
  { id:'coronaSolar', name:'Corona Solar', icon:'🌞', cd:16, color:'#ffdb6a',
    desc:'Libera un estallido de luz alrededor tuyo, dañando a todo lo cercano',
    cast: p=>{
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<170) dealDamageToTarget(t, computeDamage(24), 'shift');
      });
      addParticles(p.x,p.y,'#ffdb6a',26,200,0.5);
      spawnShockwave(p.x,p.y,'#ffdb6a',170,0.4);
      shake(8);
    } },
  { id:'bendicionRadiante', name:'Bendición Radiante', icon:'✨', cd:24, color:'#fff3c4',
    desc:'Cura el 45% de tu vida máxima y te vuelve inmune por un instante',
    cast: p=>{
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.45);
      p.invuln = Math.max(p.invuln, 1.0);
      addParticles(p.x,p.y,'#fff3c4',28,190,0.5);
    } },
  { id:'alasDelAlba', name:'Alas del Alba', icon:'🕊', cd:18, color:'#ffe9b0',
    desc:'Dash largo e invulnerable que golpea todo en tu camino',
    cast: p=>{
      const dashDist=260, steps=8;
      const b = arenaBounds();
      const hitSet=new Set();
      p.invuln = Math.max(p.invuln, 0.5);
      for(let i=1;i<=steps;i++){
        p.x = clamp(p.x+p.facingX*(dashDist/steps), b.x+p.radius, b.x+b.w-p.radius);
        p.y = clamp(p.y+p.facingY*(dashDist/steps), b.y+p.radius, b.y+b.h-p.radius);
        [...game.enemies, ...bossTargets()].forEach(t=>{
          if(!hitSet.has(t) && dist(p.x,p.y,t.x,t.y)<60+t.radius){
            hitSet.add(t);
            dealDamageToTarget(t, computeDamage(18), 'shift');
          }
        });
      }
      addParticles(p.x,p.y,'#ffe9b0',20,180,0.4);
    } },
  { id:'ojoDelMediodia', name:'Ojo del Mediodía', icon:'☉', cd:26, color:'#ffcf6a',
    desc:'Por 5s, tu daño aumenta considerablemente',
    cast: p=>{
      p.potionEffects.dmg = Math.max(p.potionEffects.dmg, 5);
      addParticles(p.x,p.y,'#ffcf6a',22,180,0.45);
    } },
];

const ITEM_POOL = {
  common: [
    { id:'potion', name:'Poción de Vida', icon:'♥', desc:'+8 HP máx', apply:p=>{ p.maxHp+=8; p.hp+=8; } },
    { id:'boots', name:'Botas Veloces', icon:'👢', desc:'+9 velocidad', apply:p=>{ p.speedFlat+=9; } },
    { id:'clover', name:'Trébol de la Suerte', icon:'☘', desc:'+3% prob. crítico', apply:p=>{ p.critChance+=0.03; } },
    { id:'flask', name:'Frasco Templado', icon:'✚', desc:'Regenera un poco de HP', apply:p=>{ p.regen+=0.35; } },
    { id:'dagger', name:'Filo Menor', icon:'✊', desc:'+2.5% daño', apply:p=>{ p.dmgMult*=1.025; } },
    { id:'c_bandage', name:'Vendaje Áspero', icon:'♥', desc:'+6 HP máx', apply:p=>{ p.maxHp+=6; p.hp+=6; } },
    { id:'c_sandals', name:'Sandalias Gastadas', icon:'👢', desc:'+6 velocidad', apply:p=>{ p.speedFlat+=6; } },
    { id:'c_whetstone', name:'Piedra de Afilar', icon:'✊', desc:'+2% daño', apply:p=>{ p.dmgMult*=1.02; } },
    { id:'c_bitterherb', name:'Hierba Amarga', icon:'✚', desc:'Regenera un poco de HP', apply:p=>{ p.regen+=0.25; } },
    { id:'c_bentcoin', name:'Moneda Doblada', icon:'🜏', desc:'+5% de oro', apply:p=>{ p.goldMult+=0.05; } },
    { id:'c_glove', name:'Guante Remendado', icon:'☘', desc:'+2% prob. crítico', apply:p=>{ p.critChance+=0.02; } },
    { id:'c_cord', name:'Cordón Tenso', icon:'☥', desc:'-3% enfriamiento', apply:p=>{ p.cdMult*=0.97; } },
    { id:'c_scale', name:'Escama Suelta', icon:'▣', desc:'+2% reducción de daño', apply:p=>{ p.armor+=0.02; } },
    { id:'c_halfflask', name:'Frasco a Medio Llenar', icon:'♥', desc:'+5 HP máx y regenera un poco de HP', apply:p=>{ p.maxHp+=5; p.hp+=5; p.regen+=0.15; } },
    { id:'c_coldember', name:'Brasa Fría', icon:'✊', desc:'+2% daño', apply:p=>{ p.dmgMult*=1.02; } },
    { id:'c_whitefeather', name:'Pluma Blanca', icon:'👢', desc:'+2% velocidad de movimiento', apply:p=>{ p.speedMult*=1.02; } },
    { id:'c_stonedust', name:'Polvo de Piedra', icon:'▣', desc:'+3% reducción de daño', apply:p=>{ p.armor+=0.03; } },
    { id:'c_minorspark', name:'Chispa Menor', icon:'☘', desc:'+2% prob. crítico', apply:p=>{ p.critChance+=0.02; } },
    { id:'c_huntercord', name:'Cordel de Cazador', icon:'👢', desc:'+7 velocidad', apply:p=>{ p.speedFlat+=7; } },
    { id:'c_witheredseed', name:'Semilla Marchita', icon:'✚', desc:'Regenera un poco de HP', apply:p=>{ p.regen+=0.3; } },
  ],
  rare: [
    { id:'gauntlet', name:'Guantelete de Fuerza', icon:'✊', desc:'+6% daño', apply:p=>{ p.dmgMult*=1.06; } },
    { id:'amulet', name:'Amuleto Arcano', icon:'☥', desc:'-8% enfriamiento', apply:p=>{ p.cdMult*=0.92; } },
    { id:'skin', name:'Piel de Piedra', icon:'▣', desc:'+6% reducción de daño', apply:p=>{ p.armor+=0.06; } },
    { id:'regen', name:'Cristal de Regeneración', icon:'✚', desc:'Regenera HP con el tiempo', apply:p=>{ p.regen+=0.75; } },
    { id:'boots2', name:'Botas del Cazador', icon:'👢', desc:'+18 velocidad', apply:p=>{ p.speedFlat+=18; } },
    { id:'effect_execute', name:'Filo Ejecutor', icon:'☠', desc:'Los golpes críticos ejecutan enemigos con menos de 12% de vida', apply:p=>{ p.relics.effect_execute=true; } },
    { id:'effect_thorns', name:'Talismán de Represalia', icon:'⛊', desc:'20% de prob. de liberar una onda de daño al recibir un golpe', apply:p=>{ p.relics.effect_thorns=true; } },
    { id:'r_fireglove', name:'Guantelete Ígneo', icon:'✊', desc:'+8% daño', apply:p=>{ p.dmgMult*=1.08; } },
    { id:'r_dawnveil', name:'Velo del Alba', icon:'☥', desc:'-10% enfriamiento', apply:p=>{ p.cdMult*=0.90; } },
    { id:'r_ashplate', name:'Coraza de Ceniza', icon:'▣', desc:'+8% reducción de daño', apply:p=>{ p.armor+=0.08; } },
    { id:'r_emberheart', name:'Corazón de Rescoldo', icon:'♥', desc:'+12 HP máx y regenera HP', apply:p=>{ p.maxHp+=12; p.hp+=12; p.regen+=0.4; } },
    { id:'r_solarboots', name:'Botas del Viento Solar', icon:'👢', desc:'+22 velocidad', apply:p=>{ p.speedFlat+=22; } },
    { id:'r_nighthunter', name:'Anillo del Cazador Nocturno', icon:'☘', desc:'+4% crítico y +3% daño', apply:p=>{ p.critChance+=0.04; p.dmgMult*=1.03; } },
    { id:'r_goldensap', name:'Frasco de Savia Dorada', icon:'✚', desc:'Regenera bastante HP con el tiempo', apply:p=>{ p.regen+=1.0; } },
    { id:'r_echotalisman', name:'Talismán del Eco', icon:'⦿', desc:'+5% robo de vida', apply:p=>{ grantLifesteal(p,0.05); } },
    { id:'r_curvedthorn', name:'Espina Curva', icon:'✊', desc:'+6% daño', apply:p=>{ p.dmgMult*=1.06; } },
    { id:'r_ashmantle', name:'Manto Ceniciento', icon:'▣', desc:'+7% reducción de daño', apply:p=>{ p.armor+=0.07; } },
    { id:'r_brokenhourglass', name:'Reloj de Arena Roto', icon:'☥', desc:'-9% enfriamiento', apply:p=>{ p.cdMult*=0.91; } },
    { id:'r_frostfang', name:'Colmillo de Escarcha', icon:'☘', desc:'+5% crítico', apply:p=>{ p.critChance+=0.05; } },
    { id:'r_pilgrim', name:'Brazalete del Peregrino', icon:'👢', desc:'+16 velocidad y +4 HP máx', apply:p=>{ p.speedFlat+=16; p.maxHp+=4; p.hp+=4; } },
    { id:'r_minorsolar', name:'Anillo Solar Menor', icon:'✊', desc:'+5% daño y +6 velocidad', apply:p=>{ p.dmgMult*=1.05; p.speedFlat+=6; } },
    { id:'r_amberflask', name:'Frasco de Ámbar', icon:'▣', desc:'+9% reducción de daño', apply:p=>{ p.armor+=0.09; } },
  ],
  epic: [
    { id:'phoenix', name:'Corazón de Fénix', icon:'♦', desc:'+20 HP máx', apply:p=>{ p.maxHp+=20; p.hp+=20; } },
    { id:'rage', name:'Fragmento de Furia', icon:'⚡', desc:'+10% daño, -16 HP máx', apply:p=>{ p.dmgMult*=1.10; p.maxHp=Math.max(20,p.maxHp-16); p.hp=Math.max(1,p.hp-16); } },
    { id:'crown', name:'Corona del Abismo', icon:'♛', desc:'+6% daño y +14 velocidad', apply:p=>{ p.dmgMult*=1.06; p.speedFlat+=14; } },
    { id:'core', name:'Núcleo Arcano', icon:'☥', desc:'-14% enfriamiento', apply:p=>{ p.cdMult*=0.86; } },
    { id:'ring', name:'Anillo Vampírico', icon:'⦿', desc:'+2% robo de vida', apply:p=>{ grantLifesteal(p,0.02); } },
    { id:'soul', name:'Fragmento de Alma', icon:'✦', desc:'+3% robo de vida y +5% crítico', apply:p=>{ grantLifesteal(p,0.03); p.critChance+=0.05; } },
    { id:'effect_deathburst', name:'Núcleo Volátil', icon:'☄', desc:'25% de prob. de que un enemigo derrotado libere una explosión de daño', apply:p=>{ p.relics.effect_deathburst=true; } },
    { id:'e_solarheart', name:'Corazón Solar', icon:'♦', desc:'+24 HP máx', apply:p=>{ p.maxHp+=24; p.hp+=24; } },
    { id:'e_zenithfragment', name:'Fragmento del Cenit', icon:'⚡', desc:'+8% daño y -10% enfriamiento', apply:p=>{ p.dmgMult*=1.08; p.cdMult*=0.90; } },
    { id:'e_ashwing', name:'Ala de Ceniza', icon:'👢', desc:'+20 velocidad y +3% crítico', apply:p=>{ p.speedFlat+=20; p.critChance+=0.03; } },
    { id:'e_dimmedcrown', name:'Corona Apagada', icon:'♛', desc:'+7% daño y +6% reducción de daño', apply:p=>{ p.dmgMult*=1.07; p.armor+=0.06; } },
    { id:'e_voidseal', name:'Sello del Vacío', icon:'⛊', desc:'20% de prob. de aturdir brevemente al enemigo golpeado', apply:p=>{ p.relics.effect_voidSeal=true; } },
    { id:'e_frostcore', name:'Núcleo Gélido', icon:'❄', desc:'15% de prob. de ralentizar al enemigo golpeado', apply:p=>{ p.relics.effect_frostCore=true; } },
    { id:'e_echorelic', name:'Reliquia del Eco', icon:'⦿', desc:'Cada 10º ataque básico no gasta el enfriamiento de Q', apply:p=>{ p.relics.effect_echoRelic=true; } },
    { id:'e_minorphoenix', name:'Anillo del Fénix Menor', icon:'♦', desc:'Al caer bajo 20% de vida, curás 15 HP — una vez por run', apply:p=>{ p.relics.effect_minorPhoenix=true; } },
    { id:'e_combopact', name:'Pacto del Combo', icon:'✦', desc:'El bonus de daño por racha se duplica', apply:p=>{ p.relics.effect_comboPact=true; } },
    { id:'e_persistenceseal', name:'Sello de Persistencia', icon:'✦', desc:'Cada golpe conectado extiende un poco más el temporizador de racha', apply:p=>{ p.relics.effect_persistenceSeal=true; } },
    { id:'e_impactwave', name:'Onda de Impacto', icon:'☄', desc:'Al usar Q, liberás una onda de daño en área a tu alrededor', apply:p=>{ p.relics.effect_impactWave=true; } },
    { id:'e_fireembers', name:'Estela de Fuego', icon:'☄', desc:'Al usar E, herís a los enemigos cercanos con una ráfaga de fuego', apply:p=>{ p.relics.effect_fireEmbers=true; } },
    { id:'e_huntersmark', name:'Marca de Caza', icon:'☠', desc:'El primer golpe contra cada enemigo hace 30% más daño', apply:p=>{ p.relics.effect_huntersMark=true; } },
    { id:'e_chainbond', name:'Vínculo de Cadenas', icon:'⚡', desc:'15% de prob. de que tus golpes salten como rayo a otro enemigo cercano', apply:p=>{ p.relics.relic_storm=true; } },
    { id:'e_instantreflex', name:'Reflejo Instantáneo', icon:'⛊', desc:'Un golpe que te dejaría con menos de 1 HP te deja con 1 en su lugar — una vez por run', apply:p=>{ p.relics.effect_instantReflex=true; } },
    { id:'e_shadowstep', name:'Paso de Sombra', icon:'👢', desc:'Al terminar tu invulnerabilidad, ganás un impulso de velocidad breve', apply:p=>{ p.relics.effect_shadowStep=true; } },
    { id:'e_warcrystreak', name:'Grito de Batalla', icon:'⚡', desc:'Matar 3 enemigos en 2 segundos activa un fuerte bonus de daño temporal', apply:p=>{ p.relics.effect_warcryStreak=true; } },
    { id:'e_frostspine', name:'Espina de Escarcha', icon:'❄', desc:'Los enemigos que te golpean cuerpo a cuerpo quedan lentos', apply:p=>{ p.relics.effect_frostSpine=true; } },
    { id:'e_altarblessing', name:'Bendición del Altar', icon:'♥', desc:'Las pociones de vida curan 50% más', apply:p=>{ p.relics.effect_altarBlessing=true; } },
    { id:'e_repeatrune', name:'Runa de Repetición', icon:'✦', desc:'10% de prob. de que un ataque básico no gaste su enfriamiento', apply:p=>{ p.relics.effect_repeatRune=true; } },
    { id:'e_allseeingeye', name:'Ojo que Todo Ve', icon:'👁', desc:'Usar tu Habilidad Prohibida te da unos segundos de invulnerabilidad', apply:p=>{ p.relics.effect_allSeeingEye=true; } },
    { id:'e_lifecurrent', name:'Corriente de Vida', icon:'♥', desc:'Recoger oro te cura un poco de HP', apply:p=>{ p.relics.effect_lifeCurrent=true; } },
    { id:'e_reactiveshield', name:'Escudo de Reacción', icon:'⛊', desc:'Al caer bajo 30% de vida, ganás un escudo que absorbe el próximo golpe — una vez por piso', apply:p=>{ p.relics.effect_reactiveShield=true; } },
    { id:'e_ghoststep', name:'Paso Fantasma', icon:'👻', desc:'La primera vez que tocás cada tipo de peligro elemental en un piso, no te hace daño', apply:p=>{ p.relics.effect_ghostStep=true; } },
    { id:'e_unstablecore', name:'Núcleo Inestable', icon:'☄', desc:'Tus golpes críticos tienen 15% de prob. de causar una explosión en área', apply:p=>{ p.relics.effect_unstableCore=true; } },
  ],
};
const CURSED_ITEMS = [
  { id:'curse_blood', name:'Pacto de Sangre Eterno', icon:'☠', desc:'+13% daño, pero -32 HP máx', cursed:true,
    apply:p=>{ p.dmgMult*=1.13; p.maxHp=Math.max(20,p.maxHp-32); p.hp=Math.max(1,p.hp-32); },
    lore:'Firmado con algo que ya no era del todo sangre. El pacto se cumple siempre — nunca a tu favor del todo.' },
  { id:'curse_whisper', name:'Susurro del Abismo', icon:'👁', desc:'+7% daño y +14 velocidad, pero recibís 20% más daño', cursed:true,
    apply:p=>{ p.dmgMult*=1.07; p.speedFlat+=14; p.curseDmgTakenMult*=1.20; },
    lore:'Te promete velocidad y fuerza al oído, en una voz que suena casi como la tuya. No lo es.' },
  { id:'curse_gold', name:'Oro Maldito', icon:'🜏', desc:'+20% de oro, pero perdés 36 HP máx ya mismo', cursed:true,
    apply:p=>{ p.goldMult+=0.2; p.maxHp=Math.max(20,p.maxHp-36); p.hp=Math.max(1,p.hp-36); },
    lore:'Cada moneda que rinde te cuesta algo que no es oro. El Abismo siempre cobra en la misma moneda: vos.' },
  { id:'curse_haste', name:'Sed de Poder', icon:'⏳', desc:'-15% enfriamiento, pero -15% daño causado', cursed:true,
    apply:p=>{ p.cdMult*=0.85; p.dmgMult*=0.85; },
    lore:'Acelera todo menos la puntería. Quien la llevó antes golpeaba rápido, y flojo, hasta el final.' },
  { id:'curse_shackle', name:'Grillete de Sombra', icon:'⛓', desc:'+34 velocidad de movimiento, pero -18% velocidad de ataque', cursed:true,
    apply:p=>{ p.speedFlat+=34; p.cdMult*=1.18; },
    lore:'Te deja correr como si nunca hubieras estado encadenado — pero el peso sigue ahí, tirando del brazo.' },
  { id:'curse_eye', name:'Ojo Codicioso', icon:'👁‍🗨', desc:'+30% de oro, pero -10% velocidad de movimiento', cursed:true,
    apply:p=>{ p.goldMult+=0.3; p.speedMult*=0.90; },
    lore:'Ve el oro antes que vos, y se queda mirándolo un segundo de más cada vez. Ese segundo tiene un costo.' },
  { id:'curse_coldheart', name:'Corazón Frío', icon:'❄', desc:'+10% crítico, pero reduce tu robo de vida a la mitad', cursed:true,
    apply:p=>{ p.critChance+=0.10; p.lifesteal*=0.5; },
    lore:'Golpea con precisión perfecta y ninguna piedad — ni siquiera la que te debería a vos mismo.' },
  { id:'curse_yoke', name:'Yugo del Poder', icon:'🔗', desc:'-18% enfriamiento de habilidades, pero -8% de armadura', cursed:true,
    apply:p=>{ p.cdMult*=0.82; p.armor=Math.max(0,p.armor-0.08); },
    lore:'Te da más poder del que podés sostener cómodamente. Se nota en cómo cruje tu guardia.' },
  { id:'curse_lastspark', name:'Última Chispa', icon:'✨', desc:'+9% crítico, pero -20% velocidad de ataque', cursed:true,
    apply:p=>{ p.critChance+=0.09; p.cdMult*=1.20; },
    lore:'Guarda toda su fuerza para un solo golpe perfecto, y te hace esperar cada vez a que llegue.' },
  { id:'curse_blooddebt', name:'Deuda de Sangre', icon:'🩸', desc:'+15% daño, pero cada golpe que recibís te quita 1% de tu HP máximo actual', cursed:true,
    apply:p=>{ p.dmgMult*=1.15; p.relics.effect_bloodDebt=true; },
    lore:'Todo poder se paga. Este simplemente cobra la cuota antes de que termines de sentir el golpe.' },
  { id:'curse_dawnweight', name:'Peso del Alba', icon:'⚖', desc:'+25% de oro, pero -12 HP máx ya mismo', cursed:true,
    apply:p=>{ p.goldMult+=0.25; p.maxHp=Math.max(20,p.maxHp-12); p.hp=Math.max(1,p.hp-12); },
    lore:'Es liviano como la luz de la mañana y pesa exactamente lo mismo que todo lo que te quita.' },
];
// Was 0.14 — every *ordinary* chest you pay for (not just the ones from the "Objetos Malditos"
// cursed-chest path, which is opt-in) had a hidden 14% chance to hand you a cursed item instead
// of the tier you paid for. 3 of the 11 curses cut maxHp outright (-12 to -36) and a 4th
// (Deuda de Sangre) taxes 1% of *current* maxHp on every hit taken, uncapped and compounding —
// over a long run that one alone can nearly halve your max HP with no visible running total.
// Cut to 5% so curses stay a real (rare) risk on normal loot without being the main reason max HP
// stalls out over a run. The dedicated cursed-chest content (Objetos Malditos tab) is unaffected.
const CURSED_CHEST_CHANCE = 0.05;
const POTIONS = [
  { id:'hp', key:'Digit1', name:'Poción de Vida', icon:'❤', desc:'Cura 25 HP al instante', color:'#e8434f' },
  { id:'def', key:'Digit2', name:'Poción de Resistencia', icon:'🛡', desc:'+30% reducción de daño por 6s', color:'#8a8f9c' },
  { id:'dmg', key:'Digit3', name:'Poción de Furia', icon:'⚔', desc:'+25% daño por 6s', color:'#ff6a3d' },
  { id:'spd', key:'Digit4', name:'Poción de Viento', icon:'💨', desc:'+30% velocidad por 6s', color:'#6a8dff' },
];
const UTILITY_CHEST_CHANCE = 0.05;
const RELICS = [
  { id:'relic_heart', name:'Corazón Eterno', icon:'❤', desc:'+50 HP máx instantáneo', apply:p=>{ p.maxHp+=50; p.hp+=50; },
    lore:'Nunca dejó de latir, aunque hace mucho que nadie recuerda a quién perteneció el pecho que lo alojaba.' },
  { id:'relic_storm', name:'Tormenta Contenida', icon:'🌩', desc:'12% de prob. de encadenar un rayo a otro enemigo cercano', apply:p=>{},
    lore:'Un trueno atrapado hace tanto que se olvidó de cómo caer una sola vez.' },
  { id:'relic_greed', name:'Codicia Infinita', icon:'💰', desc:'+25% de oro por el resto de la run', apply:p=>{ p.goldMult+=0.25; },
    lore:'Cuanto más oro toca, más oro pide. Nadie que la llevó volvió a sentirse verdaderamente rico.' },
  { id:'relic_phoenix', name:'Pluma de Fénix', icon:'🔥', desc:'Revive una vez con 50% de vida al morir', apply:p=>{},
    lore:'Todavía tibia. El Fénix que la perdió sigue, en alguna parte del Abismo, buscando cómo recuperarla.' },
  { id:'relic_dawnFeather', name:'Pluma de Alba', icon:'🌅', desc:'Revive una vez con 30% de vida al morir', apply:p=>{},
    lore:'Más pálida que la del Fénix, y más fría — pero alcanza para un último aliento.' },
  { id:'relic_doubleHeart', name:'Corazón Doble', icon:'❤️‍🔥', desc:'Duplica tu robo de vida por 8s después de derrotar a un jefe', apply:p=>{ p.relics.effect_doubleHeart=true; },
    lore:'Late dos veces por cada vez que debería. Se dice que perteneció a alguien que se negó a morir una sola muerte.' },
];
const RELIC_DROP_CHANCE = 0.35;

const ITEM_FAMILIES = {
  ofensiva: ['dagger','gauntlet','rage','crown','curse_blood','curse_whisper','bossBone','bossAbyss',
    'c_whetstone','c_glove','c_coldember','c_minorspark',
    'r_fireglove','r_nighthunter','r_curvedthorn','r_frostfang','r_minorsolar',
    'e_zenithfragment','e_dimmedcrown','e_voidseal','e_frostcore','e_impactwave','e_fireembers','e_huntersmark','e_warcrystreak','e_repeatrune','e_unstablecore',
    'curse_lastspark','curse_blooddebt'],
  vital: ['potion','phoenix','flask','regen','bossEmpress','curse_gold','curse_eye',
    'c_bandage','c_bitterherb','c_bentcoin','c_halfflask','c_witheredseed',
    'r_emberheart','r_goldensap','r_echotalisman',
    'e_solarheart','e_minorphoenix','e_instantreflex','e_altarblessing','e_lifecurrent','e_reactiveshield',
    'curse_dawnweight'],
  mistica: ['amulet','core','clover','soul','curse_haste','curse_coldheart','curse_yoke','bossWitch','bossMirror','bossTwin','bossTrueFinal',
    'c_cord','c_scale','c_stonedust',
    'r_dawnveil','r_ashplate','r_ashmantle','r_brokenhourglass','r_amberflask',
    'e_echorelic','e_combopact','e_persistenceseal','e_chainbond','e_frostspine','e_allseeingeye','e_ghoststep'],
  veloz: ['boots','boots2','ring','curse_shackle',
    'c_sandals','c_whitefeather','c_huntercord',
    'r_solarboots','r_pilgrim',
    'e_ashwing','e_shadowstep'],
};
const SYNERGY_THRESHOLD = 3;
const SYNERGIES = {
  ofensiva: { name:'Sinergia: Furia de Combate', desc:'+7% daño adicional', apply:p=>{ p.dmgMult*=1.07; } },
  vital: { name:'Sinergia: Vitalidad Plena', desc:'+4% robo de vida adicional', apply:p=>{ grantLifesteal(p,0.04); } },
  mistica: { name:'Sinergia: Resonancia Arcana', desc:'-10% enfriamiento adicional', apply:p=>{ p.cdMult*=0.90; } },
  veloz: { name:'Sinergia: Paso Ligero', desc:'+23 velocidad adicional', apply:p=>{ p.speedFlat+=23; } },
};
function checkSynergies(p){
  Object.keys(ITEM_FAMILIES).forEach(fam=>{
    if(p.synergiesUnlocked[fam]) return;
    const count = p.items.filter(it=>ITEM_FAMILIES[fam].includes(it.id)).length;
    if(count>=SYNERGY_THRESHOLD){
      p.synergiesUnlocked[fam]=true;
      SYNERGIES[fam].apply(p);
      spawnToast(`🔗 ${SYNERGIES[fam].name} — ${SYNERGIES[fam].desc}`);
      addParticles(p.x,p.y,'#8ec9ff',24,200,0.5);
    }
  });
}
// Misterios del Compendio — meta-progression, persisted forever in `progress` (unlike the
// per-run stuff above): collecting every item in a family at least once, across any number of
// runs, permanently unlocks a small passive applied from then on in every future run.
const FAMILY_BONUS_DEFS = {
  ofensiva: { label:'+2% de daño', apply:p=>{ p.dmgMult*=1.02; } },
  vital:    { label:'+15 HP máxima', apply:p=>{ p.maxHp+=15; p.hp+=15; } },
  mistica:  { label:'-3% de enfriamiento', apply:p=>{ p.cdMult*=0.97; } },
  veloz:    { label:'+6 de velocidad', apply:p=>{ p.speedFlat+=6; } },
};
function checkFamilySetCompletion(){
  Object.keys(ITEM_FAMILIES).forEach(fam=>{
    if(progress.unlockedFamilyBonuses[fam]) return;
    if(!ITEM_FAMILIES[fam].every(id=>progress.discoveredItems[id])) return;
    progress.unlockedFamilyBonuses[fam] = true;
    saveProgress();
    const def = FAMILY_BONUS_DEFS[fam];
    spawnToast(`🏆 ¡Colección completa! ${SYNERGIES[fam].name.replace('Sinergia: ','')} — bonus permanente: ${def.label}`);
    if(game && game.player) def.apply(game.player); // applies retroactively to the run in progress too, not just future ones
  });
}
// Called every time an item actually reaches the player's hands (chest, jefe, mercader, altar,
// reliquia de élite, botín de Ascenso) — first time for a given id reveals its lore fragment and
// checks whether that finishes off a family collection.
function registerItemDiscovery(item){
  if(!item || !item.id || progress.discoveredItems[item.id]) return;
  progress.discoveredItems[item.id] = true;
  saveProgress();
  spawnToast(`📖 Fragmento de historia revelado: ${item.name}`);
  checkFamilySetCompletion();
}
const CHEST_TIERS = {
  common: { label:'Común', costMult:1,   color:'#a89a8c', glow:'rgba(168,154,140,0.35)', wood:'#4a3620' },
  rare:   { label:'Raro',  costMult:2.2, color:'#6a8dff', glow:'rgba(106,141,255,0.45)', wood:'#213055' },
  epic:   { label:'Épico', costMult:4,   color:'#d24aff', glow:'rgba(210,74,255,0.55)', wood:'#3a1a4a' },
};

// ---------- traveling merchant: every 3 floors (3,6,9...), offers a curated choice of 3 items ----------
const MERCHANT_INTERVAL = 3;
function isMerchantFloor(stageIndex){
  const floor = stageIndex+1;
  return floor%MERCHANT_INTERVAL===0 && floor%10!==0 && floor<TOWER_MAX_FLOOR;
}
// Reroll cost scales with how many times this merchant visit has already been rerolled, and with
// depth (mirrors chest-cost scaling so it stays meaningful at every floor).
function merchantRerollCost(stageIndex, rerollCount){
  const s = stageAt(stageIndex);
  return Math.round(s.chestCost*0.6*Math.pow(1.6, rerollCount)*essenceDiscountMult());
}
function rerollMerchantOffers(){
  const m = game.merchant;
  if(!m || m.chosen) return;
  const cost = merchantRerollCost(game.stageIndex, m.rerollCount||0);
  if(game.gold<cost){ spawnToast(`Necesitas ${cost} de oro para volver a tirar.`); return; }
  game.gold -= cost;
  m.rerollCount = (m.rerollCount||0)+1;
  m.offers = rollMerchantOffers(game.stageIndex);
  spawnToast('🔄 El mercader baraja una nueva selección');
  buildMerchantPanel();
}
function rollMerchantOffers(stageIndex){
  const s = stageAt(stageIndex);
  const pool = [
    ...ITEM_POOL.rare.map(it=>({item:it, tier:'rare'})),
    ...ITEM_POOL.epic.map(it=>({item:it, tier:'epic'})),
  ];
  const picks = [];
  const usedIds = new Set();
  while(picks.length<3 && picks.length<pool.length){
    const cand = pool[Math.floor(Math.random()*pool.length)];
    if(usedIds.has(cand.item.id)) continue;
    usedIds.add(cand.item.id);
    const cost = Math.round(s.chestCost*CHEST_TIERS[cand.tier].costMult*1.3*essenceDiscountMult());
    picks.push({ item:cand.item, tier:cand.tier, cost, bought:false });
  }
  return picks;
}


/* ============================================================
   INPUT
   ============================================================ */
const keys = {};
const mouse = { x:0, y:0, down:false };
let devKeyBuffer = '';
window.addEventListener('keydown', e=>{
  keys[e.code]=true;
  if(e.code==='Escape'){ if(merchantOpen) closeMerchant(); else togglePause(); }
  if(e.code==='Tab' && !merchantOpen){ e.preventDefault(); toggleInventory(); }
  // Cero Absoluto: mashing a direction key chips away at the ice trapping you, faster than it
  // would melt on its own
  if(!e.repeat && ['KeyW','KeyA','KeyS','KeyD'].includes(e.code) && game && game.player && game.player.frozenTimer>0){
    game.player.frozenTimer = Math.max(0, game.player.frozenTimer - 0.45);
  }
  if(['Space','KeyW','KeyA','KeyS','KeyD','KeyR','Digit1','Digit2','Digit3','Digit4'].includes(e.code)) e.preventDefault();
  // secret dev code: type "diosmodo" anywhere to toggle infinite HP + infinite damage for testing
  if(e.key && e.key.length===1){
    devKeyBuffer = (devKeyBuffer + e.key.toLowerCase()).slice(-8);
    if(devKeyBuffer==='diosmodo'){
      devMode = !devMode;
      devKeyBuffer='';
      spawnToast(devMode ? '🛠️ Modo desarrollador ACTIVADO — vida infinita, daño infinito y todos los personajes desbloqueados' : '🛠️ Modo desarrollador desactivado');
      updateDevModeBadge();
      buildRoster(); // refresh in case we're already on the character-select screen
    }
  }
});
window.addEventListener('keyup', e=>{ keys[e.code]=false; });
function updateDevModeBadge(){
  let el = document.getElementById('dev-mode-badge');
  if(!el){
    el = document.createElement('div');
    el.id = 'dev-mode-badge';
    el.textContent = '🛠️ MODO DESARROLLADOR — vida infinita / daño infinito';
    el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'background:rgba(164,79,217,0.92);color:#fff;font-family:monospace;font-size:12px;'
      + 'padding:5px 14px;border-radius:0 0 8px 8px;letter-spacing:0.5px;pointer-events:none;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,0.4);';
    document.body.appendChild(el);
  }
  el.style.display = devMode ? 'block' : 'none';

  // floor-jump box: only usable once a run is in progress, lets you warp straight to any
  // floor's boss fight (skipping the regular wave) to test it in isolation
  let jumpEl = document.getElementById('dev-floor-jump');
  if(!jumpEl){
    jumpEl = document.createElement('div');
    jumpEl.id = 'dev-floor-jump';
    jumpEl.style.cssText = 'position:fixed;top:36px;left:50%;transform:translateX(-50%);z-index:99999;'
      + 'display:flex;gap:6px;align-items:center;background:rgba(20,12,30,0.94);padding:5px 10px;'
      + 'border-radius:0 0 8px 8px;font-family:monospace;font-size:12px;color:#fff;'
      + 'box-shadow:0 2px 10px rgba(0,0,0,0.4);';
    jumpEl.innerHTML = `
      <span>Ir al piso (101+ = Ascenso):</span>
      <input id="dev-floor-input" type="number" min="1" max="${TOWER_MAX_FLOOR+ASCENSO_MAX_FLOOR}" value="10"
        style="width:52px;background:#1a1024;border:1px solid #a44fd9;color:#fff;border-radius:4px;padding:2px 4px;font-family:monospace;">
      <button id="dev-floor-go" style="background:#a44fd9;border:none;color:#fff;border-radius:4px;padding:3px 10px;cursor:pointer;font-family:monospace;">Ir</button>
    `;
    document.body.appendChild(jumpEl);
    const input = document.getElementById('dev-floor-input');
    const go = document.getElementById('dev-floor-go');
    const jump = ()=>{ const val = parseInt(input.value,10); if(!isNaN(val)) devJumpToFloor(val); };
    go.addEventListener('click', jump);
    // stop keystrokes here from reaching the game's own WASD/dev-code listener on window
    input.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key==='Enter') jump(); });
  }
  jumpEl.style.display = devMode ? 'flex' : 'none';
  syncDevAttackPanel();
}

// Forces the current boss to immediately drop whatever it's doing and perform a specific attack
// right now, regardless of cooldown — for testing a single attack in isolation without waiting
// for the random rotation to eventually roll it.
function devForceBossAttack(type){
  if(!game || !game.boss){ spawnToast('No hay un jefe activo para probar'); return; }
  game.boss.telegraph = null;
  game.boss.forceNextAttack = type;
  game.boss.attackTimer = 0;
  spawnToast(`🛠️ Forzando ataque: ${ATTACK_NAMES[type]||type}`);
}

let devAttackPanelBossKind = null; // tracks which boss the button list was last built for
// Right-side panel, dev-mode only: lists every attack in the active boss's kit as a clickable
// button so each one can be tested on demand instead of waiting on the random rotation.
function syncDevAttackPanel(){
  let el = document.getElementById('dev-attack-panel');
  if(!el){
    el = document.createElement('div');
    el.id = 'dev-attack-panel';
    el.style.cssText = 'position:fixed;top:36px;right:8px;z-index:99999;max-height:80vh;overflow-y:auto;'
      + 'background:rgba(20,12,30,0.94);padding:8px 10px;border-radius:8px;font-family:monospace;'
      + 'font-size:11px;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,0.4);min-width:170px;';
    document.body.appendChild(el);
  }
  const show = devMode && game && game.boss;
  el.style.display = show ? 'block' : 'none';
  if(!show){ devAttackPanelBossKind = null; return; }
  const boss = game.boss;
  if(devAttackPanelBossKind !== boss.kind){
    devAttackPanelBossKind = boss.kind;
    const pool = BOSS_ATTACKS[boss.kind] || [];
    const uniquePool = [...new Set(pool)];
    el.innerHTML = `<div style="color:#ffcb47;margin-bottom:6px;font-weight:bold;">🛠️ Ataques: ${boss.def.name}</div>`
      + uniquePool.map(type=>`<button class="dev-atk-btn" data-type="${type}" style="display:block;width:100%;text-align:left;`
        + `background:#2a1a3a;border:1px solid #a44fd9;color:#fff;border-radius:4px;padding:4px 7px;margin-bottom:4px;`
        + `cursor:pointer;font-family:monospace;font-size:11px;">${ATTACK_NAMES[type]||type}</button>`).join('')
      + `<div style="color:#8a7a9a;margin-top:4px;font-size:10px;">Fuerza el ataque ya mismo, sin esperar cooldown.</div>`;
    el.querySelectorAll('.dev-atk-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>devForceBossAttack(btn.getAttribute('data-type')));
    });
  }
}

// Warps straight to a given floor's boss fight, skipping the normal enemy wave — for testing a
// specific boss in isolation. Requires a run already in progress (a hero picked, game.player set).
function devJumpToFloor(floor){
  if(!game || !game.player){ spawnToast('Iniciá una partida primero para poder saltar de piso'); return; }
  floor = clamp(Math.round(floor), 1, TOWER_MAX_FLOOR+ASCENSO_MAX_FLOOR);
  hideScreen('screen-stage'); hideScreen('screen-clear'); hideScreen('screen-victory');
  hideScreen('screen-ascenso-altar'); hideScreen('screen-ascenso-loot');
  if(floor <= TOWER_MAX_FLOOR){
    game.ascenso = false;
    game.stageIndex = floor-1;
    syncCharacterLevel(game.player, game.stageIndex);
    $('hud').classList.remove('hidden');
    startStage(game.stageIndex);
    game.spawnQueue = []; // skip the wave entirely
    game.enemies = [];
    beginBossPhase();
    startLoop();
    spawnToast(`🛠️ Saltaste al piso ${floor}: ${game.currentStage.name}`);
  } else {
    // 101-200 maps to Ascenso floor 1-100 — jumps straight past the Altar de Fe screen and the
    // 3-2-1 countdown, same "skip everything, go straight to the boss" spirit as the Descenso jump
    const ascensoIdx = floor - TOWER_MAX_FLOOR - 1;
    game.ascenso = true;
    enterAscensoFloor(ascensoIdx);
    if(!ASCENSO_FLOORS[ascensoIdx]){ spawnToast(`🛠️ Piso ${floor-TOWER_MAX_FLOOR} de Ascenso todavía no está construido`); return; }
    hideScreen('screen-ascenso-altar');
    $('hud').classList.remove('hidden');
    beginAscensoBossPhase();
    startLoop();
    spawnToast(`🛠️ Saltaste a Ascenso piso ${floor-TOWER_MAX_FLOOR}: ${game.currentStage.name}`);
  }
}
canvas.addEventListener('mousemove', e=>{ mouse.x=e.clientX; mouse.y=e.clientY; });
canvas.addEventListener('mousedown', ()=>{ mouse.down=true; });
window.addEventListener('mouseup', ()=>{ mouse.down=false; });
function keyPressed(code){ // edge trigger
  if(keys[code] && !keys['__prev_'+code]){ return true; }
  return false;
}
function updateKeyEdges(){
  ['KeyQ','KeyE','Space','KeyR','Digit1','Digit2','Digit3','Digit4','ShiftLeft','ShiftRight'].forEach(c=>{ keys['__prev_'+c]=keys[c]; });
}

/* ============================================================
   GAME STATE
   ============================================================ */
let game = null; // active run state
let devMode = false; // secret dev/test mode: infinite HP + one-shot damage (toggled by typing "diosmodo")
let selectedHero = null;
const PACTS = [
  { id:'hardMode', name:'Pacto del Enjambre', desc:'+30% vida/daño de enemigos, pero +15% de oro', icon:'⚔' },
  { id:'noHeal', name:'Pacto de Sangre Seca', desc:'Sin regeneración pasiva ni robo de vida, pero +20% daño', icon:'☠' },
  { id:'glassRun', name:'Pacto Frágil', desc:'-25% de tu vida máxima inicial, pero +25% de velocidad', icon:'💨' },
  { id:'heavyMode', name:'Pacto de Plomo', desc:'-15% de velocidad, pero +25% de vida máxima inicial', icon:'⛓' },
  { id:'vultureMode', name:'Pacto del Buitre', desc:'+25% de todo el oro que consigas, pero no aparece el mercader errante', icon:'🦅' },
];
let selectedPacts = {};
let selectedUltimate = progress.selectedUltimate || null; // id of the one ULTIMATE_ABILITIES entry chosen to bring into the run (see buildUltimates)
let selectedShiftAbility = progress.selectedShiftAbility || null; // id of the one SHIFT_ABILITIES entry chosen (see buildShiftAbilities)
function buildPacts(){
  const row = $('pacts-row');
  if(!row) return;
  row.innerHTML = PACTS.map(pc=>`
    <div class="route-card${selectedPacts[pc.id]?' selected':''}" data-pact="${pc.id}">
      <div class="ic">${pc.icon}</div>
      <div class="nm">${pc.name}</div>
      <div class="ds">${pc.desc}</div>
    </div>
  `).join('');
  row.querySelectorAll('.route-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      const id = card.dataset.pact;
      selectedPacts[id] = !selectedPacts[id];
      card.classList.toggle('selected');
    });
  });
}

const HOME_UPGRADES = [
  { id:'hp', name:'Vitalidad', desc:'+6 HP máx inicial', icon:'♥', baseCost:20 },
  { id:'gold', name:'Fortuna', desc:'+5% de oro (aditivo)', icon:'◆', baseCost:25 },
  { id:'dmg', name:'Instinto', desc:'+2% daño inicial', icon:'⚔', baseCost:30 },
  { id:'potion', name:'Alforja del Peregrino', desc:'+1 poción de vida al empezar cada run', icon:'🧪', baseCost:35 },
  { id:'discount', name:'Favor del Mercader', desc:'-4% costo de cofres y del mercader errante (aditivo, hasta 50%)', icon:'💰', baseCost:28 },
];
// Aditive discount from the "Favor del Mercader" upgrade, applied to chest and merchant costs.
// Floored at 50% off so it stays a meaningful sink instead of ever making things free.
function essenceDiscountMult(){
  const d = progress.homeUpgrades.discount||0;
  return Math.max(0.5, 1 - 0.04*d);
}
// ---------- cosmetic skins: purchased once with essence, then usable on any unlocked hero ----------
// Skins only recolor the glow/ring/icon tint (p.def.accent) when drawing the player — purely
// cosmetic, no stat effect. Owning a palette is account-wide; which palette is worn is chosen
// per-hero via progress.selectedSkins[heroId].
const SKIN_PALETTES = [
  { id:'ember', name:'Brasa', color:'#ff6a3d', cost:40 },
  { id:'frost', name:'Escarcha', color:'#7fd8ff', cost:40 },
  { id:'void', name:'Vacío', color:'#a44fd9', cost:50 },
  { id:'gold', name:'Áureo', color:'#ffd54a', cost:60 },
  { id:'jade', name:'Jade', color:'#4fd98a', cost:50 },
];
function buySkin(id){
  if(progress.skins[id]) return;
  const sk = SKIN_PALETTES.find(s=>s.id===id);
  if(!sk || progress.essence<sk.cost) return;
  progress.essence -= sk.cost;
  progress.skins[id] = true;
  saveProgress();
  buildHomeAltar();
  buildRoster();
}
function selectHeroSkin(heroId, skinId){
  if(skinId && !progress.skins[skinId]) return; // must own it (or skinId is null/'' for default)
  progress.selectedSkins[heroId] = skinId || null;
  saveProgress();
  buildRoster();
}
function homeUpgradeCost(id){
  const count = progress.homeUpgrades[id]||0;
  const def = HOME_UPGRADES.find(u=>u.id===id);
  return Math.round(def.baseCost * Math.pow(1.35, count));
}
function buyHomeUpgrade(id){
  const cost = homeUpgradeCost(id);
  if(progress.essence<cost) return;
  progress.essence -= cost;
  progress.homeUpgrades[id] = (progress.homeUpgrades[id]||0)+1;
  saveProgress();
  buildHomeAltar();
}
function buildHomeAltar(){
  const row = $('home-altar-row');
  if(!row) return;
  $('essence-count').textContent = progress.essence;
  $('best-stage-count').textContent = progress.bestStage;
  row.innerHTML = HOME_UPGRADES.map(u=>{
    const count = progress.homeUpgrades[u.id]||0;
    const cost = homeUpgradeCost(u.id);
    const affordable = progress.essence>=cost;
    return `<div class="ult-card">
      <div class="ic" style="color:var(--gold)">${u.icon}</div>
      <div class="nm">${u.name}${count>0?` (x${count})`:''}</div>
      <div class="ds">${u.desc}</div>
      <button class="btn ghost" style="margin-top:8px; padding:6px 14px; font-size:11px;" ${affordable?'':'disabled'} data-upgrade="${u.id}">${cost} esencia</button>
    </div>`;
  }).join('');
  row.querySelectorAll('button[data-upgrade]').forEach(btn=>{
    btn.addEventListener('click', ()=> buyHomeUpgrade(btn.dataset.upgrade));
  });
  const skinRow = $('skins-row');
  if(skinRow){
    skinRow.innerHTML = SKIN_PALETTES.map(sk=>{
      const owned = !!progress.skins[sk.id];
      const affordable = !owned && progress.essence>=sk.cost;
      return `<div class="ult-card">
        <div class="ic" style="color:${sk.color}">◆</div>
        <div class="nm">${sk.name}</div>
        <div class="ds">${owned?'Ya lo tenés — elegilo desde la ficha de cada héroe':'Paleta cosmética, no cambia stats'}</div>
        <button class="btn ghost" style="margin-top:8px; padding:6px 14px; font-size:11px;" ${owned?'disabled':(affordable?'':'disabled')} data-skin="${sk.id}">${owned?'Adquirida':(sk.cost+' esencia')}</button>
      </div>`;
    }).join('');
    skinRow.querySelectorAll('button[data-skin]').forEach(btn=>{
      btn.addEventListener('click', ()=> buySkin(btn.dataset.skin));
    });
  }
}
let paused = false;
let inventoryOpen = false;
let merchantOpen = false;
let animId = null;

function freshPlayerStats(heroDef){
  const ultCooldowns = {};
  // only one Habilidad Prohibida is active per run (see selectUltimate) — unlocking more just
  // widens the choice for next time, it no longer means "use whichever is off cooldown"
  const activeUlt = (selectedUltimate && progress.unlockedAbilities.includes(selectedUltimate)) ? selectedUltimate : null;
  if(activeUlt) ultCooldowns[activeUlt] = 0;
  const shiftCooldowns = {};
  const activeShift = (selectedShiftAbility && progress.unlockedShiftAbilities.includes(selectedShiftAbility)) ? selectedShiftAbility : null;
  if(activeShift) shiftCooldowns[activeShift] = 0;
  const hpMult = (selectedPacts.glassRun ? 0.75 : 1) * (selectedPacts.heavyMode ? 1.25 : 1);
  const startHp = heroDef.hp*hpMult;
  const p = {
    def:heroDef,
    x:0,y:0, radius:18, facing:0,
    hp:startHp, maxHp:startHp,
    speedMult: (selectedPacts.glassRun ? 1.25 : 1) * (selectedPacts.heavyMode ? 0.85 : 1),
    speedFlat: 0, // flat speed bonuses from items — additive, doesn't compound like speedMult does
    dmgMult: selectedPacts.noHeal ? 1.2 : 1,
    cdMult:1, armor:0, critChance:0.05, lifesteal:0, regen:0, shield:0,
    curseDmgTakenMult:1, goldMult:1, slowTimer:0, slowFactor:1,
    atkTimer:0, qTimer:0, eTimer:0, ultCooldowns, activeUltimate:activeUlt,
    shiftCooldowns, activeShiftAbility:activeShift,
    invuln:0, // brief i-frames
    effects:{ warcry:0, blink:0, shadow:0, shadowCrit:false, wall:0, mirrorShield:0, mantoLuz:0 },
    items:[], families:{}, synergiesUnlocked:{}, relics:{}, phoenixUsed:false, dawnFeatherUsed:false,
    stance:'melee', // hybrid class only
    combo:0, comboMult:1, comboTimer:0, timeSinceHit:999, witherTimer:0,
    potions:{hp:0,def:0,dmg:0,spd:0}, potionEffects:{def:0,dmg:0,spd:0},
    facingX:1, facingY:0,
    charLevel:1, // starts at 1 each run, rises as the player descends (see levelUpCharacterTo)
    iceSlideTimer:0, slideVX:0, slideVY:0, freezeMeter:0, frozenTimer:0, frozenBurnTick:0,
    spinTimer:0, spinTick:0,
    parryWindow:0, parryCharge:false, // Dorian (Duelista)
    lastHookTarget:null, // Torque (Arponero)
    runeStacks:0, // Skald (Caballero Rúnico)
    chainCount:0, chainWindow:0, // Seren (Danzante de Cuchillas)
    mountTimer:0, mountTrampleTick:0, // Rowan (Jinete Espectral)
    rewindHistory:[], rewindSampleTimer:0, // Tempus (Crononauta)
    songIndex:0, // Lira (Bardo)
    stoneTimer:0, stoneElapsed:0, // Anselm (Peregrino de Piedra)
    corruptionCurse:false, // Altar de Corrupción
  };
  const hpUp = progress.homeUpgrades.hp||0;
  const goldUp = progress.homeUpgrades.gold||0;
  const dmgUp = progress.homeUpgrades.dmg||0;
  const potionUp = progress.homeUpgrades.potion||0;
  if(hpUp){ p.maxHp += 8*hpUp; p.hp += 8*hpUp; }
  if(goldUp){ p.goldMult += 0.05*goldUp; }
  if(dmgUp){ p.dmgMult *= Math.pow(1.03, dmgUp); }
  if(potionUp){ p.potions.hp += potionUp; }
  // Misterios del Compendio: any family collection completed in the past applies its permanent
  // passive to every run from now on, same spot as the Altar del Hogar upgrades above
  Object.keys(progress.unlockedFamilyBonuses).forEach(fam=>{
    if(progress.unlockedFamilyBonuses[fam] && FAMILY_BONUS_DEFS[fam]) FAMILY_BONUS_DEFS[fam].apply(p);
  });
  const skinId = progress.selectedSkins[heroDef.id];
  const skin = skinId && progress.skins[skinId] ? SKIN_PALETTES.find(s=>s.id===skinId) : null;
  p.skinAccent = skin ? skin.color : null;
  return p;
}

// ---------- character level scaling ----------
// Each hero grows in whichever stat defines their class (melee -> HP, caster -> damage, etc,
// see the `scaling` field on each HEROES entry). Level starts at 1 each run and rises with depth.
const LEVEL_FLOORS_PER_STEP = 5; // one level every 5 floors (independent of the merchant's own cadence)
function characterLevelForFloorIndex(stageIndex){
  return 1 + Math.floor(stageIndex / LEVEL_FLOORS_PER_STEP);
}
function applyStatScaling(p, scaling){
  if(scaling.stat==='hp'){
    const add = p.maxHp*scaling.perLevel;
    p.maxHp += add; p.hp += add;
  } else if(scaling.stat==='dmg'){
    p.dmgMult *= (1+scaling.perLevel);
  } else if(scaling.stat==='crit'){
    p.critChance += scaling.perLevel;
  } else if(scaling.stat==='cd'){
    p.cdMult *= (1-scaling.perLevel);
  }
}
function levelUpCharacterOnce(p){
  const scaling = p.def.scaling;
  if(!scaling) return;
  (Array.isArray(scaling) ? scaling : [scaling]).forEach(s=>applyStatScaling(p, s));
}
const LIFESTEAL_CAP = 0.10;
// Lifesteal is capped at 10% healing — anything an item/relic/synergy would push past that cap
// is instead converted into a permanent bonus to whatever stat defines the character's class,
// so the value isn't just wasted once you're capped out.
function grantLifesteal(p, amount){
  p.lifesteal += amount;
  if(p.lifesteal > LIFESTEAL_CAP){
    const overflow = p.lifesteal - LIFESTEAL_CAP;
    p.lifesteal = LIFESTEAL_CAP;
    const scaling = p.def.scaling;
    if(scaling){
      const first = Array.isArray(scaling) ? scaling[0] : scaling;
      applyStatScaling(p, { stat:first.stat, perLevel: overflow*1.5 });
    }
  }
}
// Call whenever game.stageIndex changes — brings the character up to the level the current
// floor calls for, applying each intermediate level-up in order so bonuses compound correctly.
function syncCharacterLevel(p, stageIndex){
  const target = characterLevelForFloorIndex(stageIndex);
  while(p.charLevel < target){
    levelUpCharacterOnce(p);
    p.charLevel++;
  }
}

function newGame(){
  // defensive reset — otherwise if the previous run ended mid-boss-fight (player died to the
  // boss), the HP bar's "show" flag never got cleared and it reappears showing stale HP the
  // moment this new run's HUD becomes visible, before any boss has actually spawned
  const bossHpWrap = $('boss-hp-wrap');
  if(bossHpWrap) bossHpWrap.classList.remove('show');
  return {
    stageIndex:0,
    currentStage: stageAt(0),
    gold:0,
    player: freshPlayerStats(selectedHero),
    world: computeWorldBounds(),
    camera: {x:0, y:0},
    enemies:[], projectiles:[], hazards:[], particles:[], goldOrbs:[], chests:[], swings:[], relicPickups:[], utilityChests:[], mines:[], pack:[], pendingBursts:[], pullLines:[],
    altar:null, boss:null, bossCountdown:null, portal:null, pet:null, gravityWell:null, slowZone:null, vortex:null, sacrificeAltar:null, merchant:null,
    phase:'combat', // combat | shopping | bossIntro | boss | portal | clear
    spawnQueue:[],
    stagesSinceMirror:0, stagesSinceTwin:0, // bad-luck protection so these bosses can't stay hidden by pure RNG
    shake:0,
    kills:0,
    time:0,
    pacts: {...selectedPacts}, pendingRoute:null, routeGoldMult:1, routeEliteBoost:false, routeSpecialBuff:false,
    stats:{ bossesThisRun:0, stageReached:0, noHitBoss:false, bossTookDamage:false },
    ascenso:false, ascensoFloor:0, ascensoLight:0, ascensoLootOptions:[], ascensoLootPicked:[],
    roomsSinceCorruption:0, // Altar de Corrupción — see corruptionAltar
  };
}

/* ============================================================
   MENU / CHARACTER SELECT
   ============================================================ */
function buildRoster(){
  const roster = $('roster');
  roster.innerHTML='';
  Object.values(HEROES).forEach(h=>{
    const isLocked = h.locked && !progress.unlocked[h.id] && !devMode;
    const card = document.createElement('div');
    card.className='hero-card'+(isLocked?' locked':'');
    card.dataset.heroId = h.id;
    card.style.setProperty('--accent-c', isLocked ? '#4a4256' : h.accent);
    card.style.setProperty('--glow-c', isLocked ? 'rgba(74,66,86,0.25)' : h.glow);
    if(isLocked){
      const ach = ACHIEVEMENTS.find(a=>a.unlocks===h.id);
      card.style.opacity='0.55'; card.style.cursor='not-allowed';
      const best = progress.achievementProgress[ach.id]||0;
      const progressBar = ach.target ? `
        <div style="margin-top:7px;">
          <div style="height:5px; border-radius:3px; background:#2a2436; overflow:hidden;">
            <div style="height:100%; width:${clamp(best/ach.target*100,0,100)}%; background:var(--bone-dim);"></div>
          </div>
          <div style="margin-top:3px; font-size:10px; color:var(--bone-dim);">${best}/${ach.target}</div>
        </div>` : '';
      card.innerHTML = `
        <div class="rune-circle" style="filter:grayscale(1);">🔒</div>
        <div class="hero-name">???</div>
        <div class="hero-class">${h.className}</div>
        <div class="hero-abilities" style="text-align:center; border-top:1px solid var(--line); padding-top:10px;">
          <div style="color:var(--bone-dim);">Logro: <b style="color:var(--bone);">${ach.name}</b></div>
          <div style="margin-top:4px; font-size:11px;">${ach.desc}</div>
          ${progressBar}
        </div>
      `;
    } else {
      const ownedSkins = SKIN_PALETTES.filter(s=>progress.skins[s.id]);
      const currentSkin = progress.selectedSkins[h.id] || null;
      const swatchesHTML = ownedSkins.length ? `
        <div class="hero-abilities" style="border-top:1px solid var(--line); padding-top:8px; margin-top:8px;">
          <div style="font-size:10px; color:var(--bone-dim); margin-bottom:5px;">SKIN</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <div class="skin-swatch${!currentSkin?' selected':''}" data-hero="${h.id}" data-skin="" title="Por defecto"
              style="width:18px; height:18px; border-radius:50%; cursor:pointer; background:${h.accent}; border:2px solid ${!currentSkin?'#fff':'transparent'};"></div>
            ${ownedSkins.map(sk=>`<div class="skin-swatch${currentSkin===sk.id?' selected':''}" data-hero="${h.id}" data-skin="${sk.id}" title="${sk.name}"
              style="width:18px; height:18px; border-radius:50%; cursor:pointer; background:${sk.color}; border:2px solid ${currentSkin===sk.id?'#fff':'transparent'};"></div>`).join('')}
          </div>
        </div>` : '';
      card.innerHTML = `
        <div class="rune-circle">${h.icon}</div>
        <div class="hero-name">${h.name}</div>
        <div class="hero-class">${h.className}</div>
        <div class="hero-stats">
          <div class="hero-stat"><b>${h.hp}</b>VIDA</div>
          <div class="hero-stat"><b>${(h.atk||h.atkMelee).kind==='melee'?'Cuerpo':'Distancia'}</b>ATAQUE</div>
        </div>
        <div class="hero-abilities">
          <div><span class="k">Q</span>${h.q.name} — ${h.q.desc}</div>
          <div style="margin-top:5px;"><span class="k">E</span>${h.e.name} — ${h.e.desc}</div>
          ${COMBO_EFFECTS[h.id] ? `<div style="margin-top:5px; color:var(--gold,#ffcb47);"><span class="k" style="background:var(--gold,#ffcb47); color:#1a1420;">🔥</span>${COMBO_EFFECTS[h.id].desc}</div>` : ''}
        </div>
        ${swatchesHTML}
      `;
      card.querySelectorAll('.skin-swatch').forEach(sw=>{
        sw.addEventListener('click', (ev)=>{
          ev.stopPropagation(); // don't also trigger the card's "select this hero" click
          selectHeroSkin(sw.dataset.hero, sw.dataset.skin);
        });
      });
      card.addEventListener('click', ()=>{
        document.querySelectorAll('.hero-card').forEach(c=>c.classList.remove('selected'));
        card.classList.add('selected');
        selectedHero = h;
        $('btn-start').disabled=false;
      });
    }
    roster.appendChild(card);
  });
  if(selectedHero){
    const match = [...roster.children].find(c=>c.dataset.heroId===selectedHero.id);
    if(match) match.classList.add('selected');
  }
}

function selectUltimate(id){
  if(!progress.unlockedAbilities.includes(id)) return;
  selectedUltimate = (selectedUltimate===id) ? null : id; // click again to deselect (go into the run with no R)
  progress.selectedUltimate = selectedUltimate;
  saveProgress();
  buildUltimates();
}
function selectShiftAbility(id){
  if(!progress.unlockedShiftAbilities.includes(id)) return;
  selectedShiftAbility = (selectedShiftAbility===id) ? null : id;
  progress.selectedShiftAbility = selectedShiftAbility;
  saveProgress();
  buildShiftAbilities();
}
function buildShiftAbilities(){
  const row = $('shift-abilities-row');
  if(!row) return;
  if(!selectedShiftAbility && progress.unlockedShiftAbilities.length){
    selectedShiftAbility = progress.unlockedShiftAbilities[0];
    progress.selectedShiftAbility = selectedShiftAbility;
    saveProgress();
  }
  row.innerHTML = SHIFT_ABILITIES.map(a=>{
    const unlocked = progress.unlockedShiftAbilities.includes(a.id);
    const chosen = unlocked && selectedShiftAbility===a.id;
    return `<div class="ult-card${unlocked?'':' locked'}${chosen?' selected':''}" ${unlocked?`data-shift="${a.id}" style="cursor:pointer;"`:''}>
        <div class="ic" style="color:${unlocked?a.color:'var(--bone-dim)'}">${unlocked?a.icon:'🔒'}</div>
        <div class="nm">${unlocked?a.name:'???'}</div>
        <div class="ds">${unlocked?a.desc:'Se consigue venciendo a El Sol, en lo alto de Ascenso'}</div>
        ${unlocked?`<div style="margin-top:6px; font-size:10px; color:${chosen?'var(--gold,#ffcb47)':'var(--bone-dim)'};">${chosen?'✓ Equipada para la próxima run':'Tocar para equipar'}</div>`:''}
      </div>`;
  }).join('');
  row.querySelectorAll('[data-shift]').forEach(card=>{
    card.addEventListener('click', ()=> selectShiftAbility(card.dataset.shift));
  });
}
function buildUltimates(){
  const row = $('ultimates-row');
  if(!row) return;
  // default to the first unlocked ability the first time this ever renders with nothing chosen,
  // so existing saves don't suddenly show up with no R equipped
  if(!selectedUltimate && progress.unlockedAbilities.length){
    selectedUltimate = progress.unlockedAbilities[0];
    progress.selectedUltimate = selectedUltimate;
    saveProgress();
  }
  row.innerHTML = ULTIMATE_ABILITIES.map(a=>{
    const unlocked = progress.unlockedAbilities.includes(a.id);
    const chosen = unlocked && selectedUltimate===a.id;
    return `<div class="ult-card${unlocked?'':' locked'}${chosen?' selected':''}" ${unlocked?`data-ult="${a.id}" style="cursor:pointer;"`:''}>
        <div class="ic" style="color:${unlocked?a.color:'var(--bone-dim)'}">${unlocked?a.icon:'🔒'}</div>
        <div class="nm">${unlocked?a.name:'???'}</div>
        <div class="ds">${unlocked?a.desc:'Cae raramente (5%) al derrotar a un jefe'}</div>
        ${unlocked?`<div style="margin-top:6px; font-size:10px; color:${chosen?'var(--gold,#ffcb47)':'var(--bone-dim)'};">${chosen?'✓ Equipada para la próxima run':'Tocar para equipar'}</div>`:''}
      </div>`;
  }).join('');
  row.querySelectorAll('[data-ult]').forEach(card=>{
    card.addEventListener('click', ()=> selectUltimate(card.dataset.ult));
  });
}
const FAMILY_COLOR_VAR = { ofensiva:'--ember', vital:'--blood', mistica:'--arcane', veloz:'--toxic' };
function itemFamilyOf(id){
  for(const fam of Object.keys(ITEM_FAMILIES)){
    if(ITEM_FAMILIES[fam].includes(id)) return fam;
  }
  return null;
}
function compendiumItemHTML(it, cursed, alwaysShown){
  const fam = itemFamilyOf(it.id);
  const fcAttr = fam ? ` style="--fc:var(${FAMILY_COLOR_VAR[fam]})"` : '';
  const discovered = alwaysShown || !!progress.discoveredItems[it.id];
  if(!discovered){
    return `<div class="compendium-item locked"${fcAttr}>
        <div class="ic">?</div>
        <div class="body"><div class="nm">???</div><div class="ds">Todavía no descubierto — encontralo en una run para revelarlo</div></div>
      </div>`;
  }
  const lore = it.lore || 'Un objeto de origen incierto, hallado en las profundidades del Abismo.';
  return `<div class="compendium-item${cursed?' cursed':''}"${fcAttr}>
      <div class="ic">${it.icon}</div>
      <div class="body"><div class="nm">${it.name}</div><div class="ds">${it.desc}</div><div class="lore">${lore}</div></div>
    </div>`;
}
function buildCompendium(){
  const familiesHTML = Object.keys(ITEM_FAMILIES).map(fam=>{
    const syn = SYNERGIES[fam];
    const all = ITEM_FAMILIES[fam];
    const found = all.filter(id=>progress.discoveredItems[id]).length;
    const complete = !!progress.unlockedFamilyBonuses[fam];
    const bonus = FAMILY_BONUS_DEFS[fam];
    return `<div class="family-card${complete?' complete':''}" style="--fc:var(${FAMILY_COLOR_VAR[fam]})">
        <div class="nm">${syn.name}</div>
        <div class="ds">${syn.desc}</div>
        <div class="thr">${SYNERGY_THRESHOLD} objetos de esta familia (en una run)</div>
        <div class="collect">${complete?'✓ ':''}Colección: ${found}/${all.length} descubiertos${complete?` — bonus permanente activo: ${bonus.label}`:''}</div>
      </div>`;
  }).join('');

  const sections = [
    ['Objetos Comunes', ITEM_POOL.common, false, false],
    ['Objetos Raros', ITEM_POOL.rare, false, false],
    ['Objetos Épicos', ITEM_POOL.epic, false, false],
    ['Objetos Malditos · cofres malditos', CURSED_ITEMS, true, false],
    [`Reliquias · caída de jefe (${Math.round(RELIC_DROP_CHANCE*100)}%)`, RELICS, false, false],
    ['Objetos Únicos de Jefe', Object.values(BOSS_ITEMS), false, false],
    ['Pociones de Combate', POTIONS, false, true],
  ];
  const sectionsHTML = sections.map(([title, list, cursed, alwaysShown])=>{
    const itemsHTML = list.map(it=> compendiumItemHTML(it, cursed, alwaysShown)).join('');
    return `<div class="compendium-section-title">${title}</div><div class="compendium-grid">${itemsHTML}</div>`;
  }).join('');

  $('compendium').innerHTML = `<div class="family-row">${familiesHTML}</div>` + sectionsHTML;
}

function buildRunHistory(){
  const el = $('run-history-list');
  if(!el) return;
  if(!progress.runHistory.length){
    el.innerHTML = '<div class="inv-empty">Todavía no completaste ninguna run. Cuando mueras o llegues al final, tu historial va a aparecer acá.</div>';
    return;
  }
  el.innerHTML = progress.runHistory.map(r=>{
    const outcomeColor = r.outcome==='victory' ? 'var(--gold, #ffcb47)' : 'var(--blood, #e8434f)';
    const outcomeLabel = r.outcome==='victory' ? '🏆 Victoria' : '💀 ' + r.cause;
    return `<div class="merchant-item">
      <div class="ic" style="color:${outcomeColor}">${r.outcome==='victory'?'🏆':'💀'}</div>
      <div class="body">
        <div class="nm">${r.hero} — Piso ${r.floor}/${TOWER_MAX_FLOOR}</div>
        <div class="ds">${outcomeLabel} · ${formatRunTime(r.time)} · ◆${r.gold} oro · ${r.kills} bajas · ${r.bosses} jefes</div>
      </div>
    </div>`;
  }).join('');
}

buildRoster();
buildCompendium();
buildUltimates();
buildHomeAltar();
buildPacts();
buildRunHistory();
buildShiftAbilities();

// menu tab switching — one section visible at a time (Personajes / Habilidades / Altar / Pactos)
document.querySelectorAll('.menu-tab').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    const tab = btn.dataset.tab;
    document.querySelectorAll('.menu-tab').forEach(b=> b.classList.toggle('active', b===btn));
    document.querySelectorAll('.menu-tab-panel').forEach(panel=>{
      panel.classList.toggle('hidden', panel.dataset.tab!==tab);
    });
  });
});

$('btn-start').addEventListener('click', ()=>{
  game = newGame();
  hideScreen('screen-menu');
  showScreen('screen-stage');
  setStageIntro(0);
});

$('btn-enter-stage').addEventListener('click', ()=>{
  hideScreen('screen-stage');
  $('hud').classList.remove('hidden');
  startStage(game.stageIndex);
  startLoop();
});

$('btn-next-stage').addEventListener('click', ()=>{
  hideScreen('screen-clear');
  game.stageIndex++;
  syncCharacterLevel(game.player, game.stageIndex);
  // Altar de Corrupción: the curse purges itself after 3 rooms cleared while it was active —
  // counted here, at the same "you survived and moved on" moment as the stage index itself
  if(game.player.corruptionCurse){
    game.roomsSinceCorruption = (game.roomsSinceCorruption||0) + 1;
    if(game.roomsSinceCorruption>=3){
      game.player.corruptionCurse = false;
      game.roomsSinceCorruption = 0;
      spawnToast('☠ La maldición se disipa — sobreviviste 3 salas');
    }
  }
  showScreen('screen-stage');
  setStageIntro(game.stageIndex);
});

$('btn-victory-restart').addEventListener('click', ()=>{ resetToMenu(); });
$('btn-ascend').addEventListener('click', ()=>{ startAscensoMode(); });
$('btn-enter-ascenso').addEventListener('click', ()=>{
  hideScreen('screen-ascenso-altar');
  $('hud').classList.remove('hidden');
  game.phase = 'ascensoBossIntro';
  game.bossCountdown = 3;
  startLoop();
});
$('btn-ascenso-loot-confirm').addEventListener('click', ()=>{ confirmAscensoLoot(); });
$('btn-retry').addEventListener('click', ()=>{
  game = newGame();
  hideScreen('screen-gameover');
  $('hud').classList.remove('hidden');
  startStage(0);
  startLoop();
});
$('btn-menu').addEventListener('click', ()=>{ resetToMenu(); });
$('btn-resume').addEventListener('click', ()=>{ togglePause(); });
$('btn-pause-menu').addEventListener('click', ()=>{ resetToMenu(); });
$('btn-save-quit').addEventListener('click', ()=>{
  const ok = saveRun();
  spawnToast(ok ? '💾 Run guardada' : '⚠️ No se pudo guardar la run');
  resetToMenu();
});
$('btn-continue-run').addEventListener('click', ()=>{ continueSavedRun(); });

function resetToMenu(){
  stopLoop();
  game=null;
  paused=false;
  closeInventory();
  document.querySelectorAll('.screen').forEach(s=>s.classList.add('hidden'));
  $('hud').classList.add('hidden');
  $('screen-menu').classList.remove('hidden');
  buildRoster();
  buildUltimates();
  buildHomeAltar();
  buildPacts();
  buildRunHistory();
buildShiftAbilities();
  refreshContinueButton();
}

function showScreen(id){ $(id).classList.remove('hidden'); }
function hideScreen(id){ $(id).classList.add('hidden'); }

document.querySelectorAll('.screen').forEach(s=>{ if(s.id!=='screen-menu') s.classList.add('hidden'); });

const ROUTES = [
  { id:'blood', name:'Camino de Sangre', icon:'⚔', desc:'+35% enemigos, pero -22% oro por enemigo' },
  { id:'risk', name:'Camino del Riesgo', icon:'☠', desc:'Los enemigos especiales tienen +50% vida y velocidad' },
];

function setStageIntro(i){
  const s = stageAt(i);
  $('stage-eyebrow').textContent = `Piso ${i+1} / ${TOWER_MAX_FLOOR}`;
  $('stage-title').textContent = s.name;
  $('stage-desc').textContent = s.desc;
  buildRoutes();
}

function buildRoutes(){
  const row = $('route-row');
  if(!row || !game) return;
  if(!game.pendingRoute) game.pendingRoute = 'blood';
  row.innerHTML = ROUTES.map(r=>`
    <div class="route-card${game.pendingRoute===r.id?' selected':''}" data-route="${r.id}">
      <div class="ic">${r.icon}</div>
      <div class="nm">${r.name}</div>
      <div class="ds">${r.desc}</div>
    </div>
  `).join('');
  row.querySelectorAll('.route-card').forEach(card=>{
    card.addEventListener('click', ()=>{
      game.pendingRoute = card.dataset.route;
      row.querySelectorAll('.route-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected');
    });
  });
}

/* ============================================================
   STAGE / WAVE SETUP
   ============================================================ */
function startStage(i){
  const s = stageAt(i);
  game.currentStage = s;
  const b = arenaBounds();
  game.arenaDecor = generateArenaDecor(s, b);
  game.player.x = b.x + b.w/2;
  game.player.y = b.y + b.h/2;
  game.player.hp = game.player.maxHp; // full heal on every floor transition, including floor 1
  game.player._reactiveShieldUsedThisFloor = false;
  game.player._ghostStepUsed = {};
  game.enemies=[]; game.projectiles=[]; game.hazards=[]; game.goldOrbs=[]; game.chests=[]; game.swings=[]; game.shockwaves=[]; game.afterimages=[]; game.mines=[]; game.pullLines=[];
  game.altar=null; game.boss=null; game.bossCountdown=null; game.portal=null; game.pet=null; game.pack=[]; game.gravityWell=null; game.slowZone=null; game.pendingBursts=[]; game.vortex=null; game.sacrificeAltar=null; game.corruptionAltar=null; game.relicPickups=[]; game.utilityChests=[]; game.merchant=null;
  game.phase='combat';

  const route = game.pendingRoute || 'blood';
  game.routeGoldMult = route==='blood' ? 0.78 : 1; // more kills but less gold per kill — used to be a free lunch
  game.routeEliteBoost = false;
  game.routeSpecialBuff = route==='risk';
  const routeEnemyMult = route==='blood' ? 1.35 : 1;
  game.pendingRoute = null;

  const kinds = s.enemyKinds;
  const total = Math.max(4, Math.round((6 + Math.round(i*3.6)) * routeEnemyMult));
  const specialChance = i<2 ? 0 : clamp(0.06+i*0.012, 0.06, 0.3);
  const specialKinds = ['bomber','shielded','erratic','sniper','swarmling'];
  // BUG (real): enemies used to spawn one at a time on a fixed per-enemy delay that bottomed out
  // at 0.22s by ~floor 19 and never got faster — so from there on, the only thing that changed
  // with floor was the *count*, all trickling in one by one. At floor 50 that's 182 enemies fed in
  // individually over ~40s, then however long it took to actually mop up whatever was left — the
  // "5 minutes" feeling reported. Total enemy count is unchanged here (still `total`, same formula
  // as before), but now it arrives in bursts whose size grows with the floor, so later floors throw
  // real simultaneous swarms at you instead of a longer single-file line — more chaotic and dynamic
  // per burst, without inflating spawn duration further as the tower goes on.
  const burstSize = Math.max(1, Math.round(3 + i*0.14)); // 3 at floor 1, ~10 by floor 50, ~17 by floor 100
  const burstGap = 1.05; // seconds of breathing room between bursts (roughly constant across the run)
  const queue=[];
  let n = 0, burstIndex = 0;
  while(n<total){
    const thisBurst = Math.min(burstSize, total-n);
    for(let k=0;k<thisBurst;k++){
      let kind = kinds[n%kinds.length];
      if(Math.random()<specialChance) kind = specialKinds[Math.floor(Math.random()*specialKinds.length)];
      // small jitter within the burst so everyone doesn't spawn on the exact same frame
      queue.push({ kind, delay: burstIndex*burstGap + Math.random()*0.18 });
      n++;
    }
    burstIndex++;
  }
  game.spawnQueue = queue;
  $('hud-stage-eyebrow').textContent = `Piso ${i+1} / ${TOWER_MAX_FLOOR}`;
  $('hud-stage-name').textContent = s.name;
  updatePhaseNote();

  game.stats.stageReached = Math.max(game.stats.stageReached, i+1);
  checkAchievements();
}

function updatePhaseNote(){
  const notes = {
    combat:'Elimina a todos los enemigos',
    shopping:'Compra cofres y activa el altar',
    bossIntro:'El jefe está despertando...',
    boss:'¡Derrota al jefe!',
    portal:'Entra al portal para continuar',
    ascensoBossIntro:'El jefe está despertando...',
  };
  $('hud-phase-note').textContent = notes[game.phase] || '';
}

const SPECIAL_ENEMY_KINDS = ['bomber','shielded','erratic','sniper','swarmling'];

function spawnEnemyAt(kind, x, y, isBossMinion, isElite){
  const def = ENEMY_DEFS[kind];
  const hardMult = game.pacts.hardMode ? 1.3 : 1;
  const hpMult = ((game.currentStage && game.currentStage.enemyHpMult) || 1) * hardMult;
  const dmgMult = ((game.currentStage && game.currentStage.enemyDmgMult) || 1) * hardMult;
  let hp = Math.round(def.hp*hpMult);
  let dmg = Math.round(def.dmg*dmgMult);
  let goldMin = def.gold[0], goldMax = def.gold[1];
  if(isElite){
    hp = Math.round(hp*ELITE_MULT.hp);
    dmg = Math.round(dmg*ELITE_MULT.dmg);
    goldMin = Math.round(goldMin*ELITE_MULT.gold); goldMax = Math.round(goldMax*ELITE_MULT.gold);
  }
  const specialBuffed = game.routeSpecialBuff && SPECIAL_ENEMY_KINDS.includes(kind);
  let speedMult = 1;
  if(specialBuffed){ hp = Math.round(hp*1.3); speedMult = 1.25; }
  game.enemies.push({
    kind, def, x, y, hp, maxHp:hp, dmg, radius:def.radius*(isElite?1.35:1),
    atkTimer: Math.random()*def.atkCd, hitFlash:0, poisonTimer:0, isBossMinion:!!isBossMinion,
    isElite:!!isElite, goldMin, goldMax, armorHp: def.armor||0, wanderAng: Math.random()*Math.PI*2,
    speedMult,
  });
}

function spawnFromEdge(kind){
  const b = arenaBounds();
  const side = Math.floor(Math.random()*4);
  let x,y;
  if(side===0){ x=b.x+Math.random()*b.w; y=b.y+8; }
  else if(side===1){ x=b.x+Math.random()*b.w; y=b.y+b.h-8; }
  else if(side===2){ x=b.x+8; y=b.y+Math.random()*b.h; }
  else { x=b.x+b.w-8; y=b.y+Math.random()*b.h; }
  spawnEnemyAt(kind, x, y, false, Math.random()<ELITE_CHANCE*(game.routeEliteBoost?2.5:1));
}

function beginShoppingPhase(){
  sweepLoot();
  game.phase='shopping';
  updatePhaseNote();
  const b = arenaBounds();
  const s = game.currentStage;
  const layout = [
    { x:b.x+b.w*0.20, y:b.y+b.h*0.76, tier:'common' },
    { x:b.x+b.w*0.40, y:b.y+b.h*0.86, tier:'common' },
    { x:b.x+b.w*0.62, y:b.y+b.h*0.86, tier:'rare' },
    { x:b.x+b.w*0.82, y:b.y+b.h*0.76, tier:'epic' },
  ];
  game.chests = layout.map(p=>{
    const t = CHEST_TIERS[p.tier];
    return { x:p.x, y:p.y, radius: p.tier==='epic'?24:(p.tier==='rare'?21:18), tier:p.tier,
      cost: Math.round(s.chestCost*t.costMult*essenceDiscountMult()), opened:false, bob:Math.random()*10, sparkTimer:Math.random()*0.6 };
  });
  game.altar = { x:b.x+b.w/2, y:b.y+b.h*0.22, radius:30, active:true, pulse:0 };
  game.sacrificeAltar = { x:b.x+b.w*0.10, y:b.y+b.h*0.48, radius:24, used:false, pulse:0 };
  // Altar de Corrupción: only offered while the player isn't already cursed by a previous one, and
  // only some of the time — a guaranteed epic item is a big pull, the curse needs to stay a real cost
  if(!game.player.corruptionCurse && Math.random()<0.22){
    game.corruptionAltar = { x:b.x+b.w*0.75, y:b.y+b.h*0.30, radius:24, used:false, pulse:0 };
  }
  if(isMerchantFloor(game.stageIndex) && !game.pacts.vultureMode){
    game.merchant = { x:b.x+b.w*0.90, y:b.y+b.h*0.48, radius:26, offers: rollMerchantOffers(game.stageIndex), pulse:0 };
    spawnToast(`Un mercader errante ofrece 3 objetos a elección.`);
  }
  spawnToast(`Sala del tesoro. Cofres comunes, raros y épicos disponibles.`);
}

// Player walks up to the active altar -> a 3..2..1 countdown plays before the boss actually appears,
// so nothing can hit the player the instant the fight starts.
function startBossCountdown(){
  game.phase='bossIntro';
  updatePhaseNote();
  game.bossCountdown = 3.0;
  game.altar.active=false;
  game.chests.forEach(c=>c.opened=true); // chests close once the ritual begins
  game.sacrificeAltar = null;
  game.corruptionAltar = null;
  spawnToast('El altar se enciende...');
  shake(3);
}

function pickBossKindForStage(i){
  return stageAt(i).bossKind;
}

function beginBossPhase(){
  game.phase='boss';
  updatePhaseNote();
  // the traveling merchant is done once the boss fight starts — it used to just stay standing
  // there for the whole fight since nothing ever cleared it
  if(merchantOpen) closeMerchant();
  game.merchant = null;
  const s = game.currentStage;
  const bossKind = pickBossKindForStage(game.stageIndex);
  const def = BOSS_DEFS[bossKind];
  const b = arenaBounds();
  const isTrueFinal = bossKind==='trueFinal';
  const guardianMult = s.isGuardianFloor && !isTrueFinal ? 1.5 : 1; // guardian floors (10, 20, 30...) hit noticeably harder
  // used to be a hard step (1x through floor 15, then an instant 4x at floor 16) — now it ramps
  // smoothly from 1x at floor 15 up to 4x by floor 40, then holds at 4x for the rest of the tower
  const lateGameHpMult = s.floor <= 15 ? 1 : Math.min(4, 1 + (s.floor-15)*(3/25));
  const hp = Math.round(def.hp*s.hpMult*(isTrueFinal?1.3:2.6)*guardianMult*lateGameHpMult);
  let dmg = Math.round(def.dmg*s.dmgMult*guardianMult);
  const hover = bossKind==='empressOfLight';
  const isGuardian = s.isGuardianFloor && !isTrueFinal;
  // regular bosses attack frequently with lower per-hit damage; guardians (10, 20, 30...) instead
  // attack less often, a bit harder, but the real difficulty comes from those attacks being much
  // harder to dodge (faster projectiles, shorter reaction windows — see isGuardian usage below)
  let dmgReduceFactor = hover ? 0.55 : 0.72;
  if(isGuardian) dmgReduceFactor *= 1.15;
  dmg = Math.round(dmg*dmgReduceFactor);
  game.boss = {
    kind:bossKind, def, x:b.x+b.w/2, y:b.y+b.h*0.3, hp, maxHp:hp, dmg, radius:def.radius,
    attackTimer:1.4, phase:1, telegraph:null, contactTimer:0, hitFlash:0, spawnGrace:1.1, hover, petalTimer:0,
    twin:null, strafeDir: Math.random()<0.5?1:-1, isGuardian,
  };
  if(bossKind==='twinBoss'){
    game.boss.twin = { x:b.x+b.w/2-90, y:b.y+b.h*0.3, hp, maxHp:hp, radius:def.radius*0.85, hitFlash:0, alive:true, def };
  }
  $('boss-hp-wrap').classList.add('show');
  $('boss-name').textContent = def.name + (s.isGuardianFloor && !isTrueFinal ? ' — Guardián de Piso' : '');
  spawnToast(`${def.title}`);
  game.player.invuln = Math.max(game.player.invuln, 1.1); // safety cushion as the boss materializes
  game.stats.bossTookDamage = false;
  shake(6);
}

// Sweeps up anything still lying on the floor — gold, relics, un-opened potion-chest rewards —
// so nothing is lost if the player didn't walk over it. Previously this only ran in onStageClear()
// (after the boss died), so gold/relics dropped by the *regular* enemy wave sat on the ground,
// unswept, for the whole shopping/boss phase — easy to miss and looked like "auto-pickup isn't
// working". Now it also runs the moment the common-enemy wave finishes (see beginShoppingPhase).
function sweepLoot(){
  if(game.goldOrbs && game.goldOrbs.length){
    let swept = 0;
    const p = game.player;
    game.goldOrbs.forEach(g=>{ swept += Math.round(g.value * p.goldMult * (game.pacts.hardMode ? 1.15 : 1) * (game.pacts.vultureMode ? 1.25 : 1) * comboFactor(p) * game.routeGoldMult); });
    if(swept>0){ game.gold += swept; spawnToast(`💰 Recogiste ${swept} de oro que quedó en el piso`); }
    game.goldOrbs = [];
  }
  if(game.utilityChests && game.utilityChests.length){
    game.utilityChests.forEach(uc=>{
      const potion = POTIONS[Math.floor(Math.random()*POTIONS.length)];
      game.player.potions[potion.id]++;
    });
    game.utilityChests = [];
  }
  if(game.relicPickups && game.relicPickups.length){
    game.relicPickups.forEach(rp=>{
      if(!game.player.relics[rp.relic.id]){
        rp.relic.apply(game.player);
        game.player.relics[rp.relic.id] = true;
        game.player.items.push({ id:rp.relic.id, name:rp.relic.name, icon:rp.relic.icon, desc:rp.relic.desc });
      }
    });
    game.relicPickups = [];
  }
}

function onStageClear(){
  // sweep up anything still lying on the floor from the boss fight itself
  sweepLoot();
  game.phase='clear';
  closeInventory();
  $('boss-hp-wrap').classList.remove('show');
  stopLoop();
  if(game.stageIndex >= TOWER_MAX_FLOOR-1){
    finishVictory();
    return;
  }
  $('clear-title').textContent = `${game.currentStage.name}: superada`;
  showScreen('screen-clear');
}

const RUN_HISTORY_MAX = 20;
function formatRunTime(seconds){
  const m = Math.floor(seconds/60), s = Math.floor(seconds%60);
  return `${m}:${String(s).padStart(2,'0')}`;
}
// Records a finished run (victory or death) into progress.runHistory, newest first, capped at
// RUN_HISTORY_MAX entries — shown in the Estadísticas tab of the menu.
function recordRunHistory(outcome){
  if(!game || !game.player) return;
  let cause = 'Victoria';
  if(outcome==='death'){
    if(game.phase==='boss' && game.boss){
      cause = `Derrotado por ${game.boss.def.name}`;
    } else {
      cause = `Derrotado en ${game.currentStage ? game.currentStage.name : 'la torre'}`;
    }
  }
  progress.runHistory.unshift({
    hero: game.player.def.name,
    heroId: game.player.def.id,
    floor: game.stageIndex+1,
    outcome,
    cause,
    time: game.time,
    gold: game.gold,
    kills: game.kills,
    bosses: game.stats.bossesThisRun,
    at: Date.now(),
  });
  if(progress.runHistory.length > RUN_HISTORY_MAX) progress.runHistory.length = RUN_HISTORY_MAX;
  saveProgress();
}

function finishVictory(){
  stopLoop();
  $('hud').classList.add('hidden');
  progress.bestStage = Math.max(progress.bestStage, TOWER_MAX_FLOOR);
  saveProgress();
  recordRunHistory('victory');
  $('victory-summary').innerHTML = `
    <div id="run-summary">
      Personaje: <b>${game.player.def.name}</b><br>
      Torre conquistada: <b>Piso ${TOWER_MAX_FLOOR}/${TOWER_MAX_FLOOR}</b><br>
      Enemigos eliminados: <b>${game.kills}</b><br>
      Oro final: <b>${game.gold}</b><br>
      Objetos obtenidos: <b>${game.player.items.length}</b>
    </div>`;
  $('btn-ascend').classList.remove('hidden'); // only Descenso's own floor-100 clear offers this
  showScreen('screen-victory');
}

/* ============================================================
   ASCENSO — the tower above floor 100. Same save, same run, straight continuation.
   No common-enemy waves: every floor is Altar de Fe -> boss-only fight -> loot table
   (5 items, pick 2) -> portal -> next floor. The arena brightens from pure darkness
   (piso 1) to full light (piso 100, El Sol). See the continuation doc for the full
   design and the floor-by-floor content backlog (only piso 1 and piso 100 are built
   so far — everything between is a documented placeholder).
   ============================================================ */
const ASCENSO_MAX_FLOOR = 100;
// index 0 = piso 1 ... index 99 = piso 100 (El Sol). null = not yet built — see the
// continuation doc for the backlog of the other 98 floors.
const ASCENSO_FLOORS = new Array(ASCENSO_MAX_FLOOR).fill(null);
ASCENSO_FLOORS[0] = 'shadowLarva';
ASCENSO_FLOORS[1] = 'hollowEcho';
ASCENSO_FLOORS[2] = 'crackWeaver';
ASCENSO_FLOORS[3] = 'muteGuardian';
ASCENSO_FLOORS[4] = 'echoDevourer';
ASCENSO_FLOORS[5] = 'ashSentinel';
ASCENSO_FLOORS[6] = 'crackWhisper';
ASCENSO_FLOORS[7] = 'shadowThorn';
ASCENSO_FLOORS[8] = 'silentWarden';
ASCENSO_FLOORS[9] = 'ashSwarm';
ASCENSO_FLOORS[10] = 'fissureHerald';
ASCENSO_FLOORS[11] = 'drownedScream';
ASCENSO_FLOORS[12] = 'duskWeave';
ASCENSO_FLOORS[13] = 'facelessGuard';
ASCENSO_FLOORS[14] = 'darkVine';
ASCENSO_FLOORS[15] = 'twinWhisper';
ASCENSO_FLOORS[16] = 'brokenShard';
ASCENSO_FLOORS[17] = 'ashCustodian';
ASCENSO_FLOORS[18] = 'namelessLament';
ASCENSO_FLOORS[19] = 'fissureHeart';
ASCENSO_FLOORS[20] = 'thresholdEchoes';
ASCENSO_FLOORS[21] = 'hollowChoir';
ASCENSO_FLOORS[22] = 'duskMarauder';
ASCENSO_FLOORS[23] = 'graniteWarden';
ASCENSO_FLOORS[24] = 'witheredBloom';
ASCENSO_FLOORS[25] = 'crownOfEmbers';
ASCENSO_FLOORS[26] = 'wanderingAsh';
ASCENSO_FLOORS[27] = 'achingEmber';
ASCENSO_FLOORS[28] = 'paleFlame';
ASCENSO_FLOORS[29] = 'emberWarden';
ASCENSO_FLOORS[30] = 'emberSwarm';
ASCENSO_FLOORS[31] = 'dimmedMist';
ASCENSO_FLOORS[32] = 'dimmedWarden';
ASCENSO_FLOORS[33] = 'dimmedThorn';
ASCENSO_FLOORS[34] = 'dimmedWhisper';
ASCENSO_FLOORS[35] = 'dimmedHeart';
ASCENSO_FLOORS[36] = 'wanderingDust';
ASCENSO_FLOORS[37] = 'ashFissure';
ASCENSO_FLOORS[38] = 'hollowReflection';
ASCENSO_FLOORS[39] = 'stoneWhisper';
ASCENSO_FLOORS[40] = 'dustHeart';
ASCENSO_FLOORS[41] = 'dimmedGleam';
ASCENSO_FLOORS[42] = 'stoneWarden';
ASCENSO_FLOORS[43] = 'lightThorn';
ASCENSO_FLOORS[44] = 'greyEchoes';
ASCENSO_FLOORS[45] = 'ashLightGuardian';
ASCENSO_FLOORS[46] = 'faintVeil';
ASCENSO_FLOORS[47] = 'edgeGuardian';
ASCENSO_FLOORS[48] = 'dawnThorn';
ASCENSO_FLOORS[49] = 'edgeHeart';
ASCENSO_FLOORS[50] = 'wanderingDawn';
ASCENSO_FLOORS[51] = 'dawnGuardian';
ASCENSO_FLOORS[52] = 'goldenEcho';
ASCENSO_FLOORS[53] = 'goldenThorn';
ASCENSO_FLOORS[54] = 'dawnWhisper';
ASCENSO_FLOORS[55] = 'brightHollow';
ASCENSO_FLOORS[56] = 'goldenSwarm';
ASCENSO_FLOORS[57] = 'radiantWarden';
ASCENSO_FLOORS[58] = 'radiantThorn';
ASCENSO_FLOORS[59] = 'sunHerald';
ASCENSO_FLOORS[60] = 'goldenSentinel';
ASCENSO_FLOORS[61] = 'solarWarden';
ASCENSO_FLOORS[62] = 'solarWhisper';
ASCENSO_FLOORS[63] = 'solarEcho';
ASCENSO_FLOORS[64] = 'blazeSwarm';
ASCENSO_FLOORS[65] = 'solarGuardian';
ASCENSO_FLOORS[66] = 'flareWarden';
ASCENSO_FLOORS[67] = 'flareThorn';
ASCENSO_FLOORS[68] = 'coronaWhisper';
ASCENSO_FLOORS[69] = 'coronaHeart';
ASCENSO_FLOORS[70] = 'flareSwarm';
ASCENSO_FLOORS[71] = 'zenithWarden';
ASCENSO_FLOORS[72] = 'zenithThorn';
ASCENSO_FLOORS[73] = 'zenithWhisper';
ASCENSO_FLOORS[74] = 'zenithEcho';
ASCENSO_FLOORS[75] = 'zenithGuardian';
ASCENSO_FLOORS[76] = 'blindingWarden';
ASCENSO_FLOORS[77] = 'blindingThorn';
ASCENSO_FLOORS[78] = 'blindingWhisper';
ASCENSO_FLOORS[79] = 'blindingHeart';
ASCENSO_FLOORS[80] = 'blindingSwarm';
ASCENSO_FLOORS[81] = 'ascendantWarden';
ASCENSO_FLOORS[82] = 'ascendantThorn';
ASCENSO_FLOORS[83] = 'ascendantWhisper';
ASCENSO_FLOORS[84] = 'ascendantEcho';
ASCENSO_FLOORS[85] = 'ascendantGuardian';
ASCENSO_FLOORS[86] = 'summitWarden';
ASCENSO_FLOORS[87] = 'summitThorn';
ASCENSO_FLOORS[88] = 'summitWhisper';
ASCENSO_FLOORS[89] = 'summitHeart';
ASCENSO_FLOORS[90] = 'summitSwarm';
ASCENSO_FLOORS[91] = 'portalWarden';
ASCENSO_FLOORS[92] = 'portalThorn';
ASCENSO_FLOORS[93] = 'portalWhisper';
ASCENSO_FLOORS[94] = 'portalEcho';
ASCENSO_FLOORS[95] = 'portalGuardian';
ASCENSO_FLOORS[96] = 'lastWarden';
ASCENSO_FLOORS[97] = 'lastThorn';
ASCENSO_FLOORS[98] = 'sunPrecursor';
ASCENSO_FLOORS[ASCENSO_MAX_FLOOR-1] = 'theSun';

function startAscensoMode(){
  game.ascenso = true;
  game.ascensoFloor = 0;
  hideScreen('screen-victory');
  enterAscensoFloor(0);
}

function enterAscensoFloor(i){
  game.ascensoFloor = i;
  game.ascensoLight = ASCENSO_MAX_FLOOR>1 ? i/(ASCENSO_MAX_FLOOR-1) : 0;
  const bossKind = ASCENSO_FLOORS[i];
  const b = arenaBounds();
  game.arenaDecor = null; // Ascenso floors are deliberately stark — no zone decor, just the light
  game.player.x = b.x + b.w/2;
  game.player.y = b.y + b.h/2;
  game.player.hp = game.player.maxHp;
  game.player._reactiveShieldUsedThisFloor = false;
  game.player._ghostStepUsed = {};
  game.enemies=[]; game.projectiles=[]; game.hazards=[]; game.goldOrbs=[]; game.chests=[]; game.swings=[]; game.shockwaves=[]; game.afterimages=[]; game.mines=[]; game.pullLines=[];
  game.altar=null; game.boss=null; game.bossCountdown=null; game.portal=null; game.pet=null; game.pack=[]; game.gravityWell=null; game.slowZone=null; game.pendingBursts=[]; game.vortex=null; game.sacrificeAltar=null; game.corruptionAltar=null; game.relicPickups=[]; game.utilityChests=[]; game.merchant=null;
  const def = bossKind ? BOSS_DEFS[bossKind] : null;
  game.currentStage = { key:'ascenso', name: def ? def.name : 'Piso en construcción', floor:i+1 };
  $('hud-stage-eyebrow').textContent = `Piso ${i+1} / ${ASCENSO_MAX_FLOOR} · Ascenso`;
  $('hud-stage-name').textContent = def ? def.name : 'Piso en construcción';
  game.phase = 'ascensoAltar';
  $('ascenso-eyebrow').textContent = `Altar de Fe · Piso ${i+1} / ${ASCENSO_MAX_FLOOR}`;
  if(def){
    $('ascenso-title').textContent = def.name;
    $('ascenso-desc').textContent = def.title;
    $('btn-enter-ascenso').classList.remove('hidden');
    $('ascenso-construction').classList.add('hidden');
  } else {
    $('ascenso-title').textContent = 'El llamado se apaga aquí';
    $('ascenso-desc').textContent = '';
    $('btn-enter-ascenso').classList.add('hidden');
    $('ascenso-construction').classList.remove('hidden');
  }
  showScreen('screen-ascenso-altar');
}

function beginAscensoBossPhase(){
  game.phase='boss';
  updatePhaseNote();
  const bossKind = ASCENSO_FLOORS[game.ascensoFloor];
  const def = BOSS_DEFS[bossKind];
  const b = arenaBounds();
  const hp = def.hp;
  const dmg = Math.round(def.dmg*0.72); // same per-hit damage-reduction factor Descenso's regular bosses use
  game.boss = {
    kind:bossKind, def, x:b.x+b.w/2, y:b.y+b.h*0.3, hp, maxHp:hp, dmg, radius:def.radius,
    attackTimer:1.4, phase:1, telegraph:null, contactTimer:0, hitFlash:0, spawnGrace:1.1, hover:false, petalTimer:0,
    twin:null, strafeDir: Math.random()<0.5?1:-1, isGuardian:false,
  };
  $('boss-hp-wrap').classList.add('show');
  $('boss-name').textContent = def.name;
  spawnToast(def.title);
  game.player.invuln = Math.max(game.player.invuln, 1.1);
  game.stats.bossTookDamage = false;
  shake(6);
}

function onAscensoBossDeath(){
  const boss = game.boss;
  if(game.player.relics.effect_doubleHeart){ game.player.lifestealBurstTimer = 8; spawnToast('❤️‍🔥 Corazón Doble: robo de vida potenciado'); }
  addParticles(boss.x, boss.y, boss.def.color, 40, 260, 0.7);
  shake(14);
  game.boss = null;
  $('boss-hp-wrap').classList.remove('show');
  spawnToast(`¡${boss.def.name} derrotado!`);
  game.stats.bossesThisRun++;
  if(!game.stats.bossTookDamage) game.stats.noHitBoss = true;
  checkAchievements();
  game.phase = 'ascensoLoot';
  openAscensoLootTable();
}

// Rolls 5 items from the same pools Descenso uses (common/rare/epic + relics) — no new item
// content needed, just a different way of handing them out: pick 2 of 5, no gold cost.
function rollAscensoLootOptions(){
  const pool = [...ITEM_POOL.common, ...ITEM_POOL.rare, ...ITEM_POOL.epic, ...RELICS];
  const shuffled = [...pool].sort(()=>Math.random()-0.5);
  return shuffled.slice(0,5);
}
function openAscensoLootTable(){
  game.ascensoLootOptions = rollAscensoLootOptions();
  game.ascensoLootPicked = [];
  renderAscensoLootTable();
  showScreen('screen-ascenso-loot');
}
function renderAscensoLootTable(){
  const row = $('ascenso-loot-row');
  if(!row) return;
  const picked = game.ascensoLootPicked;
  row.innerHTML = game.ascensoLootOptions.map((it,idx)=>{
    const isPicked = picked.includes(idx);
    const disabled = !isPicked && picked.length>=2;
    return `<div class="ult-card${isPicked?' selected':''}" ${disabled?'':`data-loot="${idx}" style="cursor:pointer;"`}>
      <div class="ic">${it.icon}</div>
      <div class="nm">${it.name}</div>
      <div class="ds">${it.desc}</div>
    </div>`;
  }).join('');
  row.querySelectorAll('[data-loot]').forEach(card=>{
    card.addEventListener('click', ()=>{
      const idx = parseInt(card.getAttribute('data-loot'));
      const i2 = picked.indexOf(idx);
      if(i2>=0) picked.splice(i2,1);
      else if(picked.length<2) picked.push(idx);
      renderAscensoLootTable();
      $('btn-ascenso-loot-confirm').disabled = picked.length!==2;
    });
  });
  $('btn-ascenso-loot-confirm').disabled = picked.length!==2;
}
function confirmAscensoLoot(){
  const p = game.player;
  game.ascensoLootPicked.forEach(idx=>{
    const it = game.ascensoLootOptions[idx];
    it.apply(p);
    p.items.push({ id:it.id, name:it.name, icon:it.icon, desc:it.desc });
    registerItemDiscovery(it);
  });
  checkSynergies(p);
  hideScreen('screen-ascenso-loot');
  const b = arenaBounds();
  game.portal = { x:b.x+b.w/2, y:b.y+b.h*0.3, radius:34, pulse:0 };
  game.phase = 'portal';
}

function onAscensoStageClear(){
  stopLoop();
  $('boss-hp-wrap').classList.remove('show');
  game.ascensoFloor++;
  if(game.ascensoFloor >= ASCENSO_MAX_FLOOR){
    finishAscensoVictory();
    return;
  }
  $('hud').classList.add('hidden');
  enterAscensoFloor(game.ascensoFloor);
}

function finishAscensoVictory(){
  $('hud').classList.add('hidden');
  progress.bestStage = Math.max(progress.bestStage, TOWER_MAX_FLOOR); // Ascenso doesn't have its own separate high-score field yet — see continuation doc
  const newlyUnlockedShift = [];
  SHIFT_ABILITIES.forEach(a=>{
    if(!progress.unlockedShiftAbilities.includes(a.id)){
      progress.unlockedShiftAbilities.push(a.id);
      newlyUnlockedShift.push(a);
      spawnToast(`☀ Habilidad de Luz desbloqueada: ${a.name}`);
    }
  });
  saveProgress();
  recordRunHistory('victory');
  // the toast above can get missed since it fades after ~3s — put it in the summary too so it's
  // impossible to miss what you just unlocked
  const shiftLine = newlyUnlockedShift.length
    ? `<br>☀ Habilidad${newlyUnlockedShift.length>1?'es':''} de Luz desbloqueada${newlyUnlockedShift.length>1?'s':''}: <b>${newlyUnlockedShift.map(a=>a.name).join(', ')}</b> — tecla Shift, elegila en Habilidades Prohibidas`
    : '';
  $('victory-summary').innerHTML = `
    <div id="run-summary">
      Personaje: <b>${game.player.def.name}</b><br>
      <b>Ascendiste hasta El Sol y volviste</b><br>
      Enemigos eliminados: <b>${game.kills}</b><br>
      Oro final: <b>${game.gold}</b><br>
      Objetos obtenidos: <b>${game.player.items.length}</b>${shiftLine}
    </div>`;
  $('btn-ascend').classList.add('hidden'); // already ascended — nothing more to offer here yet
  showScreen('screen-victory');
}

function onPlayerDeath(){
  stopLoop();
  closeInventory();
  $('hud').classList.add('hidden');
  $('boss-hp-wrap').classList.remove('show'); // otherwise it's still flagged "show" and reappears
                                               // stale (last boss's HP) the moment the next run starts
  const essenceGained = Math.round(game.stats.stageReached*1.5 + game.kills*0.12 + game.stats.bossesThisRun*4);
  progress.essence += essenceGained;
  progress.bestStage = Math.max(progress.bestStage, game.stats.stageReached);
  saveProgress();
  recordRunHistory('death');
  $('gameover-summary').innerHTML = `
    <div id="run-summary">
      Piso alcanzado: <b>${game.currentStage.name}</b> (#${game.stageIndex+1} / ${TOWER_MAX_FLOOR})<br>
      Jefes derrotados: <b>${game.stats.bossesThisRun}</b><br>
      Enemigos eliminados: <b>${game.kills}</b><br>
      Oro reunido: <b>${game.gold}</b><br>
      Esencia ganada: <b>+${essenceGained}</b> (total: ${progress.essence})<br>
      Récord de profundidad: <b>Piso ${progress.bestStage}</b>
    </div>`;
  showScreen('screen-gameover');
}

/* ============================================================
   PAUSE / LOOP
   ============================================================ */
function togglePause(){
  if(!game || game.phase==='clear') return;
  if(!$('hud') || $('hud').classList.contains('hidden')) return;
  paused=!paused;
  if(paused){ showScreen('screen-pause'); }
  else { hideScreen('screen-pause'); }
}

function toggleInventory(){
  if(!game) return;
  if(!$('hud') || $('hud').classList.contains('hidden')) return;
  if(paused) return;
  inventoryOpen = !inventoryOpen;
  if(inventoryOpen){ buildInventoryPanel(); $('inventory-panel').classList.remove('hidden'); }
  else { $('inventory-panel').classList.add('hidden'); }
}

function closeInventory(){
  inventoryOpen = false;
  $('inventory-panel').classList.add('hidden');
}

function openMerchant(){
  if(!game || !game.merchant) return;
  if(paused || inventoryOpen) return;
  merchantOpen = true;
  buildMerchantPanel();
  $('merchant-panel').classList.remove('hidden');
}
function closeMerchant(){
  merchantOpen = false;
  $('merchant-panel').classList.add('hidden');
}
function buildMerchantPanel(){
  const m = game.merchant;
  if(!m) return;
  $('merchant-gold').textContent = game.gold;
  $('merchant-list').innerHTML = m.offers.map((o,idx)=>{
    const tier = CHEST_TIERS[o.tier];
    const afford = game.gold>=o.cost && !o.bought && !m.chosen;
    return `
    <div class="merchant-item ${o.bought?'bought':''}" style="--tc:${tier.color}" data-idx="${idx}">
      <div class="ic">${o.item.icon}</div>
      <div class="body">
        <div class="nm">[${tier.label}] ${o.item.name}</div>
        <div class="ds">${o.item.desc}</div>
      </div>
      <button class="btn ghost merchant-buy" data-idx="${idx}" ${afford?'':'disabled'}>${o.bought?'Comprado':(o.cost+' ◆')}</button>
    </div>`;
  }).join('');
  $('merchant-list').querySelectorAll('.merchant-buy').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const idx = parseInt(btn.getAttribute('data-idx'));
      buyMerchantOffer(idx);
    });
  });
  const rerollEl = $('merchant-reroll');
  if(rerollEl){
    const rerollCost = merchantRerollCost(game.stageIndex, m.rerollCount||0);
    const canReroll = !m.chosen && game.gold>=rerollCost;
    rerollEl.textContent = `🔄 Tirar de nuevo — ${rerollCost} ◆`;
    rerollEl.disabled = !canReroll;
  }
}
function buyMerchantOffer(idx){
  const m = game.merchant;
  if(!m || m.chosen) return;
  const o = m.offers[idx];
  if(!o || o.bought) return;
  if(game.gold<o.cost){ spawnToast(`Necesitas ${o.cost} de oro para este objeto.`); return; }
  game.gold -= o.cost;
  o.bought = true;
  m.chosen = true; // the merchant only sells one item per visit — the choice is made
  const p = game.player;
  o.item.apply(p);
  p.items.push(o.item);
  registerItemDiscovery(o.item);
  checkSynergies(p);
  spawnToast(`${o.item.icon} [Mercader] ${o.item.name} — ${o.item.desc}`);
  addParticles(m.x,m.y,CHEST_TIERS[o.tier].color,26,200,0.5);
  buildMerchantPanel();
}
$('merchant-close') && $('merchant-close').addEventListener('click', closeMerchant);
$('merchant-reroll') && $('merchant-reroll').addEventListener('click', rerollMerchantOffers);

// Category + accent color for an inventory entry — used to color-code and group the inventory
// panel (previously every item looked identical regardless of whether it was a permanent relic,
// a run-only stat item, or a cursed trade-off).
function classifyItem(item){
  if(item.cursed) return { label:'Malditos', color:'var(--blood)' };
  if(RELICS.some(r=>r.id===item.id)) return { label:'Reliquias', color:'var(--gold)' };
  if(Object.values(BOSS_ITEMS).some(b=>b.id===item.id)) return { label:'Objetos de Jefe', color:'var(--shade)' };
  if(ITEM_POOL.epic.some(x=>x.id===item.id)) return { label:'Épicos', color:'#d24aff' };
  if(ITEM_POOL.rare.some(x=>x.id===item.id)) return { label:'Raros', color:'#6a8dff' };
  if(ITEM_POOL.common.some(x=>x.id===item.id)) return { label:'Comunes', color:'#a89a8c' };
  return { label:'Objetos', color:'var(--line)' };
}
// Most items in p.items are permanent passive stat boosts with nothing left to "use" — but a
// handful are one-shot triggers that fire once per run and then sit inert (Pluma de Fénix, Pluma
// de Alba, Reflejo Instantáneo). Before this, the inventory list showed them identically whether
// or not they'd already saved you, which reads as "I still have this charge" when you don't.
// (Escudo de Reacción is deliberately excluded — it recharges every floor, so it's never really
// "spent" for the run the way these are.)
function itemUsedLabel(item, p){
  if(item.id==='relic_phoenix' && p.phoenixUsed) return 'Usado';
  if(item.id==='relic_dawnFeather' && p.dawnFeatherUsed) return 'Usado';
  if(item.id==='e_instantreflex' && p._instantReflexUsed) return 'Usado';
  return null;
}
const INV_CATEGORY_ORDER = ['Reliquias','Objetos de Jefe','Épicos','Raros','Comunes','Objetos','Malditos'];

function buildInventoryPanel(){
  const p = game.player;
  // Velocidad used to show only p.speedMult as a ×multiplier, but almost every speed item
  // (boots, crown, curse_shackle...) grants +flat speed instead, so that multiplier barely moved
  // even after stacking several speed items. Show the actual resulting move speed instead.
  const effSpeed = Math.round(Math.min(MAX_PLAYER_SPEED, p.def.speed*p.speedMult + p.speedFlat));
  $('inv-stats').innerHTML = `
    <div class="stat-chip"><span class="ic">✊</span><span class="lb">Daño</span><b>×${p.dmgMult.toFixed(2)}</b></div>
    <div class="stat-chip"><span class="ic">👢</span><span class="lb">Velocidad</span><b>${effSpeed}</b></div>
    <div class="stat-chip"><span class="ic">☥</span><span class="lb">Enfriamiento</span><b>×${p.cdMult.toFixed(2)}</b></div>
    <div class="stat-chip"><span class="ic">▣</span><span class="lb">Armadura</span><b>${Math.round(p.armor*100)}%</b></div>
    <div class="stat-chip"><span class="ic">♥</span><span class="lb">Robo de vida</span><b>${Math.round(p.lifesteal*100)}%</b></div>
    <div class="stat-chip"><span class="ic">☘</span><span class="lb">Crítico</span><b>${Math.round(p.critChance*100)}%</b></div>
    <div class="stat-chip"><span class="ic">✚</span><span class="lb">Regeneración</span><b>${p.regen.toFixed(1)}/s</b></div>
    <div class="stat-chip"><span class="ic">🜏</span><span class="lb">Oro</span><b>${game.gold}</b></div>
  `;
  const list = $('inv-list');
  if(!p.items.length){
    list.innerHTML = '<div class="inv-empty">Todavía no conseguiste objetos en esta run.</div>';
    return;
  }
  const counts = {};
  p.items.forEach(it=>{
    if(!counts[it.id]) counts[it.id] = { item:it, n:0 };
    counts[it.id].n++;
  });
  // group by category so relics/curses/tiers are easy to scan instead of one long flat list
  const groups = {};
  Object.values(counts).forEach(entry=>{
    const cat = classifyItem(entry.item);
    if(!groups[cat.label]) groups[cat.label] = { color:cat.color, entries:[] };
    groups[cat.label].entries.push(entry);
  });
  list.innerHTML = INV_CATEGORY_ORDER.filter(label=>groups[label]).map(label=>{
    const g = groups[label];
    const items = g.entries.map(({item,n})=>{
      const used = itemUsedLabel(item, p);
      return `
      <div class="inv-item${used?' used':''}" style="--tc:${g.color}">
        <div class="ic">${item.icon}</div>
        <div class="body">
          <div class="nm">${item.name}${n>1?` <span class="cnt">×${n}</span>`:''}${used?` <span class="used-tag">${used}</span>`:''}</div>
          <div class="ds">${item.desc}</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="inv-cat-label" style="--tc:${g.color}">${label}</div>${items}`;
  }).join('');
}

let lastT = 0;
let stopRequested = false;
function startLoop(){
  stopRequested = false;
  lastT = performance.now();
  if(animId) cancelAnimationFrame(animId);
  animId = requestAnimationFrame(loop);
}
function stopLoop(){ stopRequested = true; if(animId) cancelAnimationFrame(animId); animId=null; }

function loop(t){
  if(stopRequested) return;
  const dt = Math.min(0.033, (t-lastT)/1000);
  lastT=t;
  if(!paused && !inventoryOpen && !merchantOpen && game && (game.phase==='combat'||game.phase==='shopping'||game.phase==='bossIntro'||game.phase==='boss'||game.phase==='portal'||game.phase==='ascensoBossIntro')){
    update(dt);
  }
  if(stopRequested) return;
  render();
  updateKeyEdges();
  animId = requestAnimationFrame(loop);
}

/* ============================================================
   HELPERS
   ============================================================ */
function dist(ax,ay,bx,by){ return Math.hypot(ax-bx, ay-by); }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function rand(a,b){ return a+Math.random()*(b-a); }
function spawnToast(msg){
  const el = document.createElement('div');
  el.className='item-toast';
  el.textContent = msg;
  $('toast-layer').appendChild(el);
  setTimeout(()=>el.remove(), 3100);
}
function shake(amount){ game.shake = Math.max(game.shake, amount); }

function addParticles(x,y,color,count,speed,life){
  for(let i=0;i<count;i++){
    const a = Math.random()*Math.PI*2;
    const s = rand(speed*0.4, speed);
    game.particles.push({ x,y, vx:Math.cos(a)*s, vy:Math.sin(a)*s, life, maxLife:life, color, r:rand(2,4), type:'circle' });
  }
}
function addDamageText(x,y,val,color,crit){
  game.particles.push({ x, y, vx:rand(-20,20), vy:-70, life:0.7, maxLife:0.7, color, type:'text',
    text:(crit?'¡':'')+Math.round(val)+(crit?'!':''), size: crit?20:15 });
}
// combo-streak popup shown over whatever you just hit — bigger the higher the streak, always a
// quick 0.5s pop-and-fade so it never lingers or clutters the screen during a long fight
function addComboPop(x,y,combo){
  const size = clamp(10+combo*0.7, 11, 34);
  game.particles.push({ x, y, vx:0, vy:-16, life:0.5, maxLife:0.5, color:'#ffb347', type:'combo', text:'x'+combo, size });
}

/* ============================================================
   UPDATE
   ============================================================ */
function update(dt){
  game.time+=dt;
  const b = arenaBounds();
  const p = game.player;

  // --- boss ritual countdown (3..2..1) before the boss actually appears ---
  if(game.phase==='bossIntro'){
    game.bossCountdown -= dt;
    if(game.bossCountdown<=0){ beginBossPhase(); }
  }
  if(game.phase==='ascensoBossIntro'){
    game.bossCountdown -= dt;
    if(game.bossCountdown<=0){ beginAscensoBossPhase(); }
  }

  // --- spawn queue ---
  if(game.phase==='combat'){
    game.spawnQueue.forEach(s=>s.delay-=dt);
    while(game.spawnQueue.length && game.spawnQueue[0].delay<=0){
      const s = game.spawnQueue.shift();
      spawnFromEdge(s.kind);
    }
    if(game.spawnQueue.length===0 && game.enemies.length===0){
      beginShoppingPhase();
    }
  }

  // --- player timers ---
  p.atkTimer = Math.max(0,p.atkTimer-dt);
  p.qTimer = Math.max(0,p.qTimer-dt);
  p.eTimer = Math.max(0,p.eTimer-dt);
  // Paso de Sombra: catch the exact frame invulnerability (i-frames) ends to grant a brief burst
  const _wasInvuln = p.invuln>0;
  p.invuln = Math.max(0,p.invuln-dt);
  if(_wasInvuln && p.invuln<=0 && p.relics.effect_shadowStep){
    p.speedBurstTimer = 1.0;
  }
  p.speedBurstTimer = Math.max(0,(p.speedBurstTimer||0)-dt);
  p.lifestealBurstTimer = Math.max(0,(p.lifestealBurstTimer||0)-dt);
  p.effects.warcry = Math.max(0,p.effects.warcry-dt);
  p.effects.shadow = Math.max(0,p.effects.shadow-dt);
  p.effects.wall = Math.max(0,p.effects.wall-dt);
  p.effects.mirrorShield = Math.max(0,p.effects.mirrorShield-dt);
  p.effects.mantoLuz = Math.max(0,(p.effects.mantoLuz||0)-dt);
  p.potionEffects.def = Math.max(0,p.potionEffects.def-dt);
  p.potionEffects.dmg = Math.max(0,p.potionEffects.dmg-dt);
  p.potionEffects.spd = Math.max(0,p.potionEffects.spd-dt);
  p.witherTimer = Math.max(0,p.witherTimer-dt);
  p.slowTimer = Math.max(0,(p.slowTimer||0)-dt);
  p.invertTimer = Math.max(0,(p.invertTimer||0)-dt);
  p.chillTimer = Math.max(0,(p.chillTimer||0)-dt);
  p.weakenTimer = Math.max(0,(p.weakenTimer||0)-dt);
  p.qLockTimer = Math.max(0,(p.qLockTimer||0)-dt);
  p.eLockTimer = Math.max(0,(p.eLockTimer||0)-dt);
  p.iceSlideTimer = Math.max(0,(p.iceSlideTimer||0)-dt);
  p.parryWindow = Math.max(0,(p.parryWindow||0)-dt); // Dorian: parry-stance window, see doAbilityQ/hitPlayer
  p.chainWindow = Math.max(0,(p.chainWindow||0)-dt); // Seren: dash-chain window
  if(p.chainWindow<=0) p.chainCount = 0;
  // Rowan: mount duration + periodic trample tick while mounted
  if(p.mountTimer>0){
    p.mountTimer -= dt;
    p.mountTrampleTick = (p.mountTrampleTick||0) - dt;
    if(p.mountTrampleTick<=0){
      p.mountTrampleTick = 0.25;
      const b = arenaBounds();
      game.enemies.forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<p.radius+t.radius+6){
          dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.6), 'q');
          const ang = Math.atan2(t.y-p.y,t.x-p.x);
          t.x = clamp(t.x+Math.cos(ang)*40, b.x+t.radius, b.x+b.w-t.radius);
          t.y = clamp(t.y+Math.sin(ang)*40, b.y+t.radius, b.y+b.h-t.radius);
        }
      });
    }
    if(p.mountTimer<=0){ p.speedMult /= 1.6; p.mountTimer = 0; }
  }
  // Tempus: sample position/hp history for Rebobinado (E)
  p.rewindSampleTimer = (p.rewindSampleTimer||0) - dt;
  if(p.rewindSampleTimer<=0){
    p.rewindSampleTimer = 0.1;
    p.rewindHistory = p.rewindHistory || [];
    p.rewindHistory.push({x:p.x, y:p.y, hp:p.hp, t:performance.now()});
    if(p.rewindHistory.length>40) p.rewindHistory.shift();
  }
  // Anselm: petrified duration — E's shatter damage scales with how long you held the form
  if(p.stoneTimer>0){
    p.stoneTimer -= dt;
    p.stoneElapsed = (p.stoneElapsed||0) + dt;
  }
  if(!(game.boss && game.boss.blizzardActive)) p.freezeMeter = Math.max(0,(p.freezeMeter||0)-dt*60); // melts fast once the blizzard itself ends
  if(p.frozenTimer>0){
    // Cero Absoluto: locked in ice, taking steady damage until it breaks (mashing WASD speeds
    // this up — see the keydown handler) — always ticks down, even if the blizzard itself ends
    const before = p.frozenTimer;
    p.frozenTimer = Math.max(0, p.frozenTimer-dt);
    p.frozenBurnTick = (p.frozenBurnTick||0) - dt;
    if(p.frozenBurnTick<=0){ p.frozenBurnTick = 0.5; hitPlayer(4); }
  }
  if(p.combo>0){ p.comboTimer -= dt; if(p.comboTimer<=0) p.combo=0; }
  if(p.effects.shadow<=0) p.effects.shadowCrit=false;
  if(!game.pacts.noHeal && p.regen>0 && p.hp<p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.regen*(p.witherTimer>0?0.5:1)*dt);
  p.timeSinceHit += dt;
  if(!game.pacts.noHeal && p.timeSinceHit>=5 && p.hp<p.maxHp) p.hp = Math.min(p.maxHp, p.hp + (p.witherTimer>0?0.5:1)*dt);
  Object.keys(p.ultCooldowns).forEach(id=>{ p.ultCooldowns[id] = Math.max(0, p.ultCooldowns[id]-dt); });
  Object.keys(p.shiftCooldowns).forEach(id=>{ p.shiftCooldowns[id] = Math.max(0, p.shiftCooldowns[id]-dt); });

  // --- Giro Salvaje channel tick (Grum/berserker's Q) ---
  if(p.spinTimer>0){
    p.spinTimer = Math.max(0, p.spinTimer-dt);
    p.spinTick = (p.spinTick||0)-dt;
    if(p.spinTick<=0){
      p.spinTick = 0.3; // 10 ticks over the 3s channel
      const hpFrac = clamp(p.hp/p.maxHp,0,1);
      const mult = 1.2 + (1-hpFrac)*1.3; // up to +130% more damage the lower your own HP is
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y) < 115) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult*0.4), 'q');
      });
      addParticles(p.x,p.y,'#ff3d3d',12,170,0.28);
      spawnShockwave(p.x,p.y,'#ff3d3d',115,0.25);
      shake(2.5);
    }
  }

  // --- movement ---
  let mx=0,my=0;
  if(keys['KeyW']) my-=1;
  if(keys['KeyS']) my+=1;
  if(keys['KeyA']) mx-=1;
  if(keys['KeyD']) mx+=1;
  let mlen = Math.hypot(mx,my);
  if(mlen>0){ mx/=mlen; my/=mlen; }
  const speed = Math.min(MAX_PLAYER_SPEED, (p.def.speed*p.speedMult+p.speedFlat)*(p.effects.shadow>0?1.15:1)*((p.effects.mantoLuz||0)>0?1.40:1)*(p.potionEffects.spd>0?1.30:1)*(p.slowTimer>0?p.slowFactor:1)*((p.speedBurstTimer||0)>0?1.2:1)*(p.corruptionCurse?0.72:1));
  if(p.invertTimer>0){ mx=-mx; my=-my; } // mirrorGaze: your own reflection turns your movement against you
  if(p.frozenTimer>0){
    // Cero Absoluto: locked in a block of ice — no movement input gets through until it breaks
    mx=0; my=0;
  }
  if(p.spinTimer>0){
    // Giro Salvaje: rooted in place for the whole 3s channel, spinning where you stand
    mx=0; my=0;
  }
  if(p.stoneTimer>0){
    // Anselm (Peregrino de Piedra): rooted while petrified — see hitPlayer for the reflect-on-hit
    mx=0; my=0;
  }
  if(p.iceSlideTimer>0){
    // Pista de Escarcha Glacial: momentum instead of direct control — you can't stop or turn on
    // a dime, your velocity only gradually catches up to where you're pointing
    const accel = 3.0;
    const targetVX = mx*speed, targetVY = my*speed;
    p.slideVX = (p.slideVX||0) + (targetVX-(p.slideVX||0))*clamp(accel*dt,0,1);
    p.slideVY = (p.slideVY||0) + (targetVY-(p.slideVY||0))*clamp(accel*dt,0,1);
    p.x += p.slideVX*dt;
    p.y += p.slideVY*dt;
  } else {
    p.slideVX = 0; p.slideVY = 0;
    p.x += mx*speed*dt;
    p.y += my*speed*dt;
  }
  p.x = clamp(p.x, b.x+p.radius, b.x+b.w-p.radius);
  p.y = clamp(p.y, b.y+p.radius, b.y+b.h-p.radius);

  // facing toward mouse (convert screen-space mouse to world-space using camera offset)
  const worldMouseX = mouse.x + game.camera.x;
  const worldMouseY = mouse.y + game.camera.y;
  const dx = worldMouseX-p.x, dy = worldMouseY-p.y;
  const flen = Math.hypot(dx,dy)||1;
  p.facingX = dx/flen; p.facingY = dy/flen;
  p.facing = Math.atan2(dy,dx);

  // --- basic attack ---
  if(mouse.down && p.atkTimer<=0){
    doBasicAttack();
    p.atkTimer = Math.max(MIN_ATK_CD, currentAtk(p).cd * effectiveCdMult(p) * (p.chillTimer>0 ? p.chillFactor : 1));
    // Runa de Repetición: a chance the attack you just landed doesn't cost you the cooldown at all
    if(p.relics.effect_repeatRune && Math.random()<0.10){ p.atkTimer = 0; }
  }

  // --- abilities ---
  if(keyPressed('KeyQ') && p.qTimer<=0 && !(p.qLockTimer>0)){
    doAbilityQ();
    // Onda de Impacto: every Q also releases a small area burst centered on the player
    if(p.relics.effect_impactWave){
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y) < 130) dealDamageToTarget(t, computeDamage(9), 'q');
      });
      addParticles(p.x,p.y,'#ff6a3d',14,160,0.3);
    }
  }
  if(keyPressed('KeyE') && p.eTimer<=0 && !(p.eLockTimer>0)){
    doAbilityE();
    // Estela de Fuego: every E also sears nearby enemies with a burst of fire
    if(p.relics.effect_fireEmbers){
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y) < 120) dealDamageToTarget(t, computeDamage(7), 'e');
      });
      addParticles(p.x,p.y,'#ff8a3d',12,150,0.3);
    }
  }
  if(keyPressed('KeyR')) doUltimate();
  if(keyPressed('ShiftLeft') || keyPressed('ShiftRight')) doShiftAbility();
  if(keyPressed('Digit1')) usePotion('hp');
  if(keyPressed('Digit2')) usePotion('def');
  if(keyPressed('Digit3')) usePotion('dmg');
  if(keyPressed('Digit4')) usePotion('spd');

  // --- interact ---
  if(keyPressed('Space')) doInteract();

  // --- enemies ---
  updateEnemies(dt);
  // --- boss ---
  if(game.boss) updateBoss(dt);
  // --- projectiles ---
  updateProjectiles(dt);
  // --- hazards ---
  updateHazards(dt);
  // --- mines (Mecha) ---
  updateMines(dt);
  // --- gold orbs ---
  updateGoldOrbs(dt);
  updateRelicPickups(dt);
  updateUtilityChests(dt);
  // --- particles ---
  updateParticles(dt);
  // --- slash / swing visuals ---
  updateSwings(dt);
  updateShockwaves(dt);
  updateAfterimages(dt);
  // --- pet (summoner) ---
  if(game.pet) updatePet(dt);
  updatePack(dt);
  updateGravityWell(dt);
  updateSlowZone(dt);
  updatePendingBursts(dt);
  updateVortex(dt);
  updatePullLines(dt);
  // --- chests bob/interact ---
  if(game.phase==='shopping') updateChests(dt);
  // --- altar prompt ---
  updateAltarPrompt();

  // shake decay
  game.shake = Math.max(0, game.shake - dt*18);

  // camera follows the player through the (now larger) world
  updateCamera();

  // hud
  syncHud();

  // death check
  if(p.hp<=0){
    if(p.relics.relic_phoenix && !p.phoenixUsed){
      p.phoenixUsed = true;
      p.hp = p.maxHp*0.5;
      p.invuln = 1.5;
      spawnToast('🔥 La Pluma de Fénix te trae de vuelta');
      addParticles(p.x,p.y,'#ff8a3d',34,220,0.6);
      shake(10);
    } else if(p.relics.relic_dawnFeather && !p.dawnFeatherUsed){
      p.dawnFeatherUsed = true;
      p.hp = p.maxHp*0.3;
      p.invuln = 1.5;
      spawnToast('🌅 La Pluma de Alba te trae de vuelta, débil pero viva');
      addParticles(p.x,p.y,'#ffd97a',30,210,0.55);
      shake(10);
    } else {
      onPlayerDeath();
    }
  }
}

function currentAtk(p){
  if(p.def.id==='dual') return p.stance==='ranged' ? p.def.atkRanged : p.def.atkMelee;
  return p.def.atk;
}

function doBasicAttack(){
  const p = game.player;
  // Reliquia del Eco: every 10th basic attack you throw out refunds Q's cooldown entirely
  if(p.relics.effect_echoRelic){
    p._echoRelicCount = (p._echoRelicCount||0)+1;
    if(p._echoRelicCount>=10){ p._echoRelicCount=0; p.qTimer=0; addParticles(p.x,p.y,'#8ec9ff',10,140,0.25); }
  }
  const atk = currentAtk(p);
  if(atk.kind==='melee'){
    // hit all enemies (and boss) within range+arc
    const targets = [...game.enemies, ...bossTargets()];
    let hitAny=false;
    targets.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<=atk.range+t.radius){
        const ang = Math.atan2(t.y-p.y,t.x-p.x);
        let diff = Math.abs(ang-p.facing);
        if(diff>Math.PI) diff=Math.PI*2-diff;
        if(diff <= (atk.arc*Math.PI/180)){
          dealDamageToTarget(t, computeDamage(atk.dmg), 'melee');
          triggerComboEffect('melee', t);
          hitAny=true;
        }
      }
    });
    game.swings.push({ x:p.x, y:p.y, angle:p.facing, arc:(atk.arc*Math.PI/180), range:atk.range*0.85,
      life:0.16, maxLife:0.16, color:p.def.accent });
    addParticles(p.x+p.facingX*40, p.y+p.facingY*40, p.def.accent, 8, 150, 0.25);
  } else {
    spawnProjectile({ x:p.x, y:p.y, vx:p.facingX*atk.projSpeed, vy:p.facingY*atk.projSpeed,
      dmg:computeDamage(atk.dmg), radius:atk.radius, owner:'player', color:p.def.accent, life:1.4 });
    addParticles(p.x+p.facingX*22, p.y+p.facingY*22, p.def.accent, 4, 110, 0.15);
  }
}

function updateCamera(){
  const w = arenaBounds();
  const viewW = canvas.width, viewH = canvas.height;
  let cx, cy;
  if(w.w <= viewW){ cx = w.x - (viewW-w.w)/2; }
  else { cx = clamp(game.player.x - viewW/2, w.x, w.x+w.w-viewW); }
  if(w.h <= viewH){ cy = w.y - (viewH-w.h)/2; }
  else { cy = clamp(game.player.y - viewH/2, w.y, w.y+w.h-viewH); }
  game.camera.x = cx; game.camera.y = cy;
}

function comboFactor(p){ return 1 + Math.min(p.combo,50)*(p.relics.effect_comboPact?0.008:0.004); }

function computeDamage(base){
  const p = game.player;
  if(devMode) return { value: 999999, crit:true, superCrit:false }; // dev mode: one-shots everything
  let dmg = base*p.dmgMult*comboFactor(p);
  if(p.weakenTimer>0) dmg *= p.weakenFactor;
  if(p.effects.warcry>0) dmg*=1.35;
  if(p.potionEffects.dmg>0) dmg*=1.25;
  if(p.def.id==='vidrio' && p.hp < p.maxHp*0.5) dmg*=1.4;
  let crit=false, superCrit=false;
  // Crit chance is only meaningful up to 100% for the normal roll — anything past that used to
  // just be wasted. Now the overflow becomes a separate "súper crítico" chance: once you're at
  // 100% normal crit (guaranteed), every extra point of crit chance is instead a chance for that
  // guaranteed crit to be upgraded into a much bigger one (double the usual crit bonus).
  const normalCritChance = Math.min(p.critChance, 1);
  const superCritChance = Math.max(0, p.critChance - 1);
  if(Math.random()<normalCritChance || p.effects.shadowCrit){
    crit=true;
    p.effects.shadowCrit=false;
    if(superCritChance>0 && Math.random()<superCritChance){
      superCrit = true;
      dmg *= 1+ (0.8*2); // súper crítico: el doble del bonus de daño de un crítico normal (+160% en vez de +80%)
    } else {
      dmg *= 1.8;
    }
  }
  return { value:dmg, crit, superCrit };
}

function bossTargets(){
  const arr=[];
  if(game.boss){
    arr.push(game.boss);
    if(game.boss.twin && game.boss.twin.alive) arr.push(game.boss.twin);
    if(game.boss.cores && game.boss.cores.length) arr.push(...game.boss.cores.filter(c=>c.alive));
    if(game.boss.movers && game.boss.movers.length) arr.push(...game.boss.movers.filter(m=>m.alive && m.breakable && !(m.spawnDelay>0)));
  }
  return arr;
}

// El Sol's Colapso Total (piso 100, Ascenso): unlike abyssLord's Autodestrucción Implacable, the
// Sun stays fully damageable during the channel — this is a "concentrate your damage" check, not
// a "break the cores" one. Deal enough damage to the exposed core within the window and the
// supernova fizzles; fail (and aren't invulnerable when it detonates) and it hits hard.
function startSunSupernova(boss){
  const bnds = arenaBounds();
  boss.x = clamp(bnds.x+bnds.w/2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
  boss.y = clamp(bnds.y+bnds.h/2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
  boss.supernovaActive = true;
  boss.supernovaTimer = 5.0;
  boss.supernovaMaxTimer = 5.0;
  boss.supernovaHpStart = boss.hp;
  boss.supernovaThreshold = Math.max(1, Math.round(boss.maxHp*0.09));
  spawnToast('¡El Sol colapsa sobre sí mismo! Concentrá el daño en el núcleo — 5 segundos antes de la Supernova');
  addParticles(boss.x,boss.y,'#ffffff',30,220,0.5);
  shake(10);
}

function finishSunSupernova(boss, success){
  boss.supernovaActive = false;
  boss.telegraph = null;
  if(success){
    boss.stunTimer = 2.5;
    boss.attackTimer = 2.8; // resumes acting right as the stun wears off
    spawnToast('¡El núcleo cede! El Sol queda expuesto — es tu oportunidad');
    addParticles(boss.x,boss.y,'#ffffff',36,250,0.55);
    shake(10);
  } else {
    spawnToast('¡La Supernova detona!');
    addParticles(boss.x,boss.y,'#ff2fd6',50,290,0.6);
    shake(20);
    if(game.player.invuln<=0){
      hitPlayer(game.player.maxHp*0.7);
    } else {
      spawnToast('¡Tu invulnerabilidad te salvó de la Supernova!');
    }
    boss.attackTimer = 1.4;
  }
}

function startAbyssEnrage(boss){
  const bnds = arenaBounds();
  boss.enrageTriggered = true;
  boss.telegraph = null;
  boss.x = clamp(bnds.x+bnds.w/2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
  boss.y = clamp(bnds.y+bnds.h/2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
  boss.invulnerable = true;
  boss.enrageActive = true;
  boss.enrageTimer = 16;
  boss.enrageMaxTimer = 16;
  boss.burnTick = 0.6;
  boss.sparkTimer = 0.5;
  const positions = [
    { x:bnds.x+70, y:bnds.y+70 },
    { x:bnds.x+bnds.w-70, y:bnds.y+70 },
    { x:bnds.x+bnds.w/2, y:bnds.y+70 },
  ];
  boss.cores = positions.map(pos=>({ x:pos.x, y:pos.y, hp:42, maxHp:42, radius:24, hitFlash:0, isCore:true, alive:true }));
  spawnToast('¡El Señor del Abismo canaliza una supernova! Destruí los núcleos de refrigeración antes de que detone.');
  shake(12);
}

function finishAbyssEnrage(boss, success){
  boss.enrageActive = false;
  boss.cores = [];
  if(success){
    boss.invulnerable = false;
    boss.stunTimer = 3.5;
    boss.hp = Math.max(1, Math.round(boss.maxHp*0.10));
    boss.attackTimer = 3.6; // resumes acting right as the stun wears off
    spawnToast('¡Los núcleos caen! El Señor del Abismo queda aturdido — es tu oportunidad.');
    addParticles(boss.x,boss.y,'#8ec9ff',34,230,0.5);
    shake(10);
  } else {
    spawnToast('¡La supernova detona!');
    addParticles(boss.x,boss.y,'#ff3d3d',44,270,0.6);
    shake(18);
    game.player.hp = Math.min(game.player.hp, 1);
    boss.invulnerable = false;
    boss.attackTimer = 1.2;
  }
}

function dealDamageToTarget(t, dmgObj, source){
  if(t===game.boss && t.invulnerable){
    // El Señor del Abismo is untouchable while channeling its supernova — only breaking the
    // cooling cores matters until that ends
    addParticles(t.x,t.y,'#ffffff',4,90,0.15);
    return;
  }
  let val = dmgObj.value;
  t.hitFlash = 0.12;
  if(t===game.boss && t.stunTimer>0) val *= 1.6; // stunned after a successful core break — a real punish window
  if(t.weakenMarkTimer>0) val *= 1.25; // Cazador (Racha x12): Salto de Sombra marks a target for bonus damage
  if(t.shieldTimer>0) val *= 0.55; // sisterCall: the twins guard each other for a few seconds
  if(t.armorHp>0){
    const absorbed = Math.min(t.armorHp, val);
    t.armorHp -= absorbed;
    val -= absorbed;
    addParticles(t.x,t.y,'#c9c9d4',6,110,0.2);
    if(t.armorHp<=0 && val<=0) return; // the armor held the whole hit
  }
  if(val<=0) return;
  // Marca de Caza: the first hit landed on any given target hits noticeably harder
  if(game.player.relics.effect_huntersMark && !t.huntersMarkUsed){
    t.huntersMarkUsed = true;
    val *= 1.3;
  }
  t.hp -= val;
  // Sello del Vacío / Núcleo Gélido: a chance to stun or slow whatever you just hit — kept off
  // the boss itself (same guard as Filo Ejecutor) so it can't trivialize a guardian fight
  const canAfflict = t!==game.boss && !(game.boss && game.boss.twin===t);
  if(canAfflict && game.player.relics.effect_voidSeal && Math.random()<0.20){
    t.stunTimer = Math.max(t.stunTimer||0, 0.6);
    addParticles(t.x,t.y,'#a070c0',8,120,0.25);
  }
  if(canAfflict && game.player.relics.effect_frostCore && Math.random()<0.15){
    t.slowTimer = Math.max(t.slowTimer||0, 1.4);
    addParticles(t.x,t.y,'#8ec9ff',8,120,0.25);
  }
  // El Señor del Abismo can't be burst past his supernova trigger — a big enough hit gets clamped
  // right at the threshold instead of skipping the enrage phase entirely
  if(t===game.boss && t.kind==='abyssLord' && !t.enrageTriggered){
    t.hp = Math.max(t.hp, t.maxHp*0.10);
  }
  // Filo Ejecutor: a critical hit finishes off anything already below 12% HP outright — kept off
  // the boss and its twin so it can't trivialize a guardian fight, only trash enemies
  if(dmgObj.crit && game.player.relics.effect_execute && t!==game.boss && !(game.boss && game.boss.twin===t) && t.maxHp && t.hp>0 && t.hp/t.maxHp<0.12){
    t.hp = 0;
    addParticles(t.x,t.y,'#ff3d3d',10,160,0.3);
  }
  addDamageText(t.x, t.y-t.radius-6, val, dmgObj.superCrit?'#ff4dd8':(dmgObj.crit?'#ffcb47':'#fff'), dmgObj.crit);
  addParticles(t.x, t.y, dmgObj.superCrit?'#ff4dd8':(dmgObj.crit?'#ffcb47':'#ffffff'), dmgObj.superCrit?14:(dmgObj.crit?9:4), dmgObj.superCrit?210:(dmgObj.crit?170:100), dmgObj.superCrit?0.34:(dmgObj.crit?0.28:0.18));
  if(dmgObj.superCrit) shake(3);
  // Núcleo Inestable: critical hits have a chance to detonate on top of their normal damage
  if(dmgObj.crit && game.player.relics.effect_unstableCore && Math.random()<0.15){
    explodeAt(t.x,t.y,95,computeDamage(12));
  }
  if(!game.pacts.noHeal && game.player.lifesteal>0){ game.player.hp = Math.min(game.player.maxHp, game.player.hp + val*Math.min((game.player.lifestealBurstTimer>0?0.20:0.10),game.player.lifesteal)*(game.player.witherTimer>0?0.5:1)); }
  if(source!=='chain'){
    game.player.combo++;
    game.player.comboTimer = 4 + (game.player.relics.effect_persistenceSeal ? 0.3 : 0);
    addComboPop(t.x, t.y-t.radius-24, game.player.combo);
  }
  if(source!=='chain' && game.player.relics.relic_storm && Math.random()<0.15){
    const others = [...game.enemies, ...bossTargets()].filter(o=>o!==t && dist(o.x,o.y,t.x,t.y)<150);
    if(others.length){
      const target2 = others[Math.floor(Math.random()*others.length)];
      addParticles(t.x,t.y,'#8ec9ff',6,140,0.2);
      dealDamageToTarget(target2, {value: val*0.5, crit:false}, 'chain');
    }
  }
  if(t.hp<=0){
    if(t===game.boss){
      if(game.boss.kind==='twinBoss' && game.boss.twin && game.boss.twin.alive){ onTwinComponentDeath(true); }
      else if(game.ascenso){ onAscensoBossDeath(); }
      else { onBossDeath(); }
    } else if(game.boss && game.boss.twin && t===game.boss.twin){
      onTwinComponentDeath(false);
    } else if(t.isCore){
      // a breakable boss "core" — a cooling valve, a weak wall segment, etc. Destroying it is a
      // sub-objective within a bigger attack rather than a normal kill, so it never touches the
      // usual enemy-death rewards/loot path
      t.alive = false;
      t.hp = 0;
      addParticles(t.x,t.y,'#8ec9ff',18,170,0.4);
      shake(4);
    } else {
      killEnemy(t);
    }
  }
}

function onTwinComponentDeath(deadIsPrimary){
  const boss = game.boss;
  if(deadIsPrimary){
    addParticles(boss.x, boss.y, boss.def.color, 22, 190, 0.45);
    spawnToast('Una gemela cae. La otra toma su lugar.');
    shake(6);
    game.boss = {
      kind: boss.kind, def: boss.def, x: boss.twin.x, y: boss.twin.y,
      hp: boss.twin.hp, maxHp: boss.twin.maxHp, dmg: boss.dmg, radius: boss.twin.radius,
      attackTimer: 0.6, phase: boss.phase, telegraph:null, contactTimer:0, hitFlash:0, spawnGrace:0,
      hover:false, petalTimer:0, twin:null,
    };
    $('boss-hp-wrap').classList.add('show');
  } else {
    boss.twin.alive = false;
    spawnToast('Una gemela cae. La otra sigue en pie.');
    addParticles(boss.twin.x, boss.twin.y, boss.def.color, 22, 190, 0.45);
    shake(6);
  }
}

// Espina de Escarcha: enemies that land a melee/contact hit on you get slowed for it
function applyContactSlowIfEquipped(en){
  if(game.player.relics.effect_frostSpine){
    en.slowTimer = Math.max(en.slowTimer||0, 1.0);
    addParticles(en.x,en.y,'#8ec9ff',6,110,0.2);
  }
}

function killEnemy(t){
  const idx = game.enemies.indexOf(t);
  if(idx>=0) game.enemies.splice(idx,1);
  game.kills++;
  addParticles(t.x,t.y,(t.def&&t.def.color)||'#ffffff',t.isElite?18:10,t.isElite?220:180,0.4);
  // Grito de Batalla: three kills within 2 seconds triggers a real damage buff (reuses the same
  // Grito de Guerra effect a couple of heroes already grant through their own abilities)
  if(game.player.relics.effect_warcryStreak){
    const p = game.player;
    p._recentKillTimes = (p._recentKillTimes||[]).filter(ts=>performance.now()-ts<2000);
    p._recentKillTimes.push(performance.now());
    if(p._recentKillTimes.length>=3){
      p.effects.warcry = Math.max(p.effects.warcry||0, 4);
      p._recentKillTimes = [];
      spawnToast('¡Grito de Batalla! +35% daño por unos segundos');
    }
  }
  // Núcleo Volátil: a chance for a defeated enemy to detonate, damaging whatever's nearby
  if(game.player.relics.effect_deathburst && Math.random()<0.25){
    explodeAt(t.x,t.y,90,computeDamage(10));
  }
  if(t.def && t.def.explodesOnDeath){
    addParticles(t.x,t.y,'#ff8a3d',22,220,0.45);
    shake(4);
    const p = game.player;
    if(dist(t.x,t.y,p.x,p.y) < t.def.explodeRadius+p.radius) hitPlayer(t.def.explodeDmg);
  }
  if(!t.isBossMinion){
    const g = Math.round(rand(t.goldMin!==undefined?t.goldMin:(t.def && t.def.gold ? t.def.gold[0] : 1), t.goldMax!==undefined?t.goldMax:(t.def && t.def.gold ? t.def.gold[1] : 2)));
    const GOLD_ORB_CAP = 40; // once the floor's this cluttered, fold new drops into the nearest orb instead of adding more
    if(game.goldOrbs.length >= GOLD_ORB_CAP){
      let nearest=null, nd=Infinity;
      game.goldOrbs.forEach(o=>{ const d=dist(o.x,o.y,t.x,t.y); if(d<nd){ nd=d; nearest=o; } });
      if(nearest) nearest.value += g;
    } else {
      game.goldOrbs.push({ x:t.x, y:t.y, value:g, vx:rand(-40,40), vy:rand(-40,40) });
    }
  }
  maybeDropRelic(t);
  maybeDropUtilityChest(t);
}

function onBossDeath(){
  const boss = game.boss;
  if(game.player.relics.effect_doubleHeart){ game.player.lifestealBurstTimer = 8; spawnToast('❤️‍🔥 Corazón Doble: robo de vida potenciado'); }
  addParticles(boss.x, boss.y, boss.def.color, 40, 260, 0.7);
  shake(14);
  const g = 20 + game.stageIndex*10;
  game.goldOrbs.push({ x:boss.x, y:boss.y, value:g, vx:0, vy:0 });
  spawnBossDrops(boss);
  game.portal = { x:boss.x, y:boss.y, radius:34, pulse:0 };
  game.boss=null;
  $('boss-hp-wrap').classList.remove('show');
  spawnToast(`¡${boss.def.name} derrotado! Un portal se abre.`);
  game.stats.bossesThisRun++;
  if(!game.stats.bossTookDamage) game.stats.noHitBoss = true;
  checkAchievements();
  game.phase='portal';
  updatePhaseNote();
}

function spawnBossDrops(boss){
  const p = game.player;
  const item = BOSS_ITEMS[boss.kind];
  if(item && Math.random()<0.10){
    const already = p.items.some(it=>it.id===item.id);
    if(already){
      const bonus = 18 + game.stageIndex*5;
      game.gold += bonus;
      spawnToast(`Ya tenías ${item.name}. +${bonus} oro en su lugar.`);
    } else {
      item.apply(p);
      p.items.push(item);
      registerItemDiscovery(item);
      checkSynergies(p);
      spawnToast(`👑 Objeto de jefe: ${item.name} — ${item.desc}`);
      addParticles(boss.x,boss.y,'#ffd54a',26,220,0.6);
    }
  }
  const lockedAbilities = ULTIMATE_ABILITIES.filter(a=>!progress.unlockedAbilities.includes(a.id));
  if(lockedAbilities.length && Math.random()<0.05){
    const ab = lockedAbilities[Math.floor(Math.random()*lockedAbilities.length)];
    progress.unlockedAbilities.push(ab.id);
    p.ultCooldowns[ab.id] = 0;
    saveProgress();
    spawnToast(`🔓 ¡HABILIDAD DESBLOQUEADA! ${ab.name} — tecla R`);
    addParticles(boss.x,boss.y,ab.color,36,260,0.7);
    shake(10);
  }
}

/* ---------- abilities ---------- */
function doAbilityQ(){
  const p = game.player;
  const id = p.def.id;
  p.qTimer = Math.max(MIN_ABILITY_CD, p.def.q.cd*effectiveCdMult(p));
  if(id==='guerrero'){
    // dash forward dealing damage along the whole path, with invulnerability plus a defensive window on landing
    const dashDist = 230;
    const steps=8;
    p.invuln = Math.max(p.invuln, 0.55);
    p.effects.wall = Math.max(p.effects.wall, 1.2);
    const alreadyHit = new Set();
    const b = arenaBounds();
    for(let i=1;i<=steps;i++){
      const nx = p.x + p.facingX*(dashDist/steps);
      const ny = p.y + p.facingY*(dashDist/steps);
      p.x = clamp(nx, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(ny, b.y+p.radius, b.y+b.h-p.radius);
      spawnAfterimage(p.x, p.y, p.radius, p.def.accent, p.def.icon);
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(!alreadyHit.has(t) && dist(p.x,p.y,t.x,t.y) < 70+t.radius){
          alreadyHit.add(t);
          dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.8), 'q');
          addParticles(t.x,t.y,p.def.accent,6,120,0.25);
        }
      });
    }
    addParticles(p.x,p.y,p.def.accent,14,200,0.35);
    shake(4);
  } else if(id==='maga'){
    spawnProjectile({ x:p.x,y:p.y, vx:p.facingX*260, vy:p.facingY*260, dmg:computeDamage(p.def.atk.dmg*1.5),
      radius:18, owner:'player', color:'#ff6a3d', life:2.4, explode:true, explodeRadius:95, shape:'ember' });
  } else if(id==='picaro'){
    for(let i=-1.5;i<=1.5;i++){
      const ang = p.facing + i*0.18;
      spawnProjectile({ x:p.x,y:p.y, vx:Math.cos(ang)*560, vy:Math.sin(ang)*560, dmg:computeDamage(p.def.atk.dmg*0.75),
        radius:5, owner:'player', color:'#d24aff', life:1, shape:'shard' });
    }
  } else if(id==='paladin'){
    p.shield = Math.max(p.shield, p.maxHp*0.35);
    p.parryWindow = 0.4; // Maestría de Posturas: block a hit in the first 0.4s for the full payoff
    addParticles(p.x,p.y,'#ffcb47',20,160,0.5);
  } else if(id==='nigromante'){
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y) < 130) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.6), 'q');
    });
    addParticles(p.x,p.y,'#8bff6b',24,200,0.45);
    spawnShockwave(p.x,p.y,'#8bff6b',130,0.35);
    shake(4);
  } else if(id==='vidrio'){
    const targets = [...game.enemies, ...bossTargets()];
    targets.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<=110+t.radius){
        const ang = Math.atan2(t.y-p.y,t.x-p.x);
        let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
        if(diff <= (80*Math.PI/180)){
          const dmgObj = computeDamage(p.def.atk.dmg*1.8);
          dmgObj.crit = true; dmgObj.value *= 1.3;
          dealDamageToTarget(t, dmgObj, 'q');
        }
      }
    });
    game.swings.push({ x:p.x, y:p.y, angle:p.facing, arc:(80*Math.PI/180), range:110, life:0.2, maxLife:0.2, color:'#e8e8f5' });
    addParticles(p.x,p.y,'#e8e8f5',16,220,0.3);
    shake(5);
  } else if(id==='coloso'){
    game.enemies.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<220 && d>1){
        const ang = Math.atan2(p.y-t.y,p.x-t.x);
        const ox=t.x, oy=t.y;
        t.x += Math.cos(ang)*90; t.y += Math.sin(ang)*90;
        t.stunTimer = Math.max(t.stunTimer||0, 1.1);
        spawnPullLine(p.x, p.y, ox, oy, '#9c8a6a');
      }
    });
    addParticles(p.x,p.y,'#9c8a6a',26,200,0.5);
    spawnShockwave(p.x,p.y,'#9c8a6a',220,0.4);
    shake(9);
  } else if(id==='silvano'){
    game.pet = { x:p.x-30, y:p.y, hp:1, maxHp:1, radius:14, speed:270, dmg:Math.round(p.def.atk.dmg*1.4),
      atkTimer:0, atkCd:0.6, color:'#5bbf7a', hitFlash:0, life:14 };
    addParticles(p.x,p.y,'#5bbf7a',18,160,0.4);
  } else if(id==='dual'){
    p.stance = p.stance==='melee' ? 'ranged' : 'melee';
    addParticles(p.x,p.y,'#5ac8d8',14,150,0.3);
  } else if(id==='monje'){
    const steps=4;
    const b = arenaBounds();
    // Targets already struck this flurry. Once a target is "engaged" it keeps taking hits every
    // remaining step even if the forward dash carries the player past it and it ends up technically
    // behind the frozen facing angle — this was the bug: a close target only fell inside the cone
    // for the steps *before* you passed it, so it only ever took ~2 of the 4 hits instead of all 4.
    const hitSet = new Set();
    for(let i=0;i<steps;i++){
      p.x = clamp(p.x+p.facingX*14, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+p.facingY*14, b.y+p.radius, b.y+b.h-p.radius);
      [...game.enemies, ...bossTargets()].forEach(t=>{
        const d = dist(p.x,p.y,t.x,t.y);
        if(d>76+t.radius) return;
        if(!hitSet.has(t)){
          const ang = Math.atan2(t.y-p.y,t.x-p.x);
          let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
          if(diff > (65*Math.PI/180)) return; // not engaged yet and outside the cone — skip for now
          hitSet.add(t);
        }
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.9), 'q');
      });
      addParticles(p.x,p.y,p.def.accent,6,120,0.15);
    }
    shake(3);
  } else if(id==='arquera'){
    spawnProjectile({ x:p.x,y:p.y, vx:p.facingX*820, vy:p.facingY*820, dmg:computeDamage(p.def.atk.dmg*1.3),
      radius:7, owner:'player', color:'#8bffb0', life:1.4, pierce:true, pierceCount:99, shape:'shard' });
    addParticles(p.x,p.y,'#8bffb0',10,140,0.2);
  } else if(id==='elementalista'){
    const targets = [...game.enemies, ...bossTargets()];
    let cur = {x:p.x,y:p.y};
    const hit = new Set();
    let chainsLeft = 4;
    while(chainsLeft>0){
      let nearest=null, nearestD=260;
      targets.forEach(t=>{
        if(hit.has(t)) return;
        const d = dist(cur.x,cur.y,t.x,t.y);
        if(d<nearestD){ nearest=t; nearestD=d; }
      });
      if(!nearest) break;
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*1.3), 'q');
      addParticles(nearest.x,nearest.y,'#6ad8ff',10,140,0.25);
      hit.add(nearest);
      cur = nearest;
      chainsLeft--;
    }
    addParticles(p.x,p.y,'#6ad8ff',10,140,0.2);
  } else if(id==='berserker'){
    // was a single instant hit — now a 3s channel that roots the player (see the movement lock
    // below) and ticks damage repeatedly, still scaling up the lower your own HP gets, recomputed
    // live each tick since your HP can change mid-spin
    p.spinTimer = 3;
    p.spinTick = 0; // fires the first tick immediately next frame
    addParticles(p.x,p.y,'#ff3d3d',18,180,0.4);
    shake(4);
  } else if(id==='ilusionista'){
    game.pet = { x:p.x-30, y:p.y, hp:1, maxHp:1, radius:13, speed:230, dmg:Math.round(p.def.atk.dmg*1.1),
      atkTimer:0, atkCd:0.7, color:'#c9a8ff', hitFlash:0, life:10 };
    addParticles(p.x,p.y,'#c9a8ff',16,150,0.35);
  } else if(id==='alquimista'){
    const b = arenaBounds();
    const tx = clamp(p.x+p.facingX*260, b.x+20,b.x+b.w-20);
    const ty = clamp(p.y+p.facingY*260, b.y+20,b.y+b.h-20);
    const ang = Math.atan2(ty-p.y,tx-p.x);
    const travelDist = Math.max(60,Math.hypot(tx-p.x,ty-p.y));
    spawnProjectile({ x:p.x,y:p.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300, dmg:computeDamage(p.def.atk.dmg*1.4),
      radius:10, owner:'player', color:'#c9e85a', life:travelDist/300+0.15, explode:true, explodeRadius:85, shape:'orb' });
  } else if(id==='druida'){
    const dashDist=150, steps=5;
    const b = arenaBounds();
    const hitSet = new Set();
    for(let i=1;i<=steps;i++){
      p.x = clamp(p.x+p.facingX*(dashDist/steps), b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+p.facingY*(dashDist/steps), b.y+p.radius, b.y+b.h-p.radius);
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(!hitSet.has(t) && dist(p.x,p.y,t.x,t.y) < 66+t.radius){
          hitSet.add(t);
          dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.6), 'q');
        }
      });
    }
    p.invuln = Math.max(p.invuln, 0.2);
    addParticles(p.x,p.y,'#9c7a4a',14,180,0.3);
  } else if(id==='sangre'){
    const cost = Math.min(p.hp-1, 8);
    p.hp -= Math.max(0,cost);
    const missingFrac = 1-clamp(p.hp/p.maxHp,0,1);
    const mult = 1.1 + missingFrac*1.4;
    spawnProjectile({ x:p.x,y:p.y, vx:p.facingX*400, vy:p.facingY*400, dmg:computeDamage(p.def.atk.dmg*mult),
      radius:8, owner:'player', color:'#b91d3a', life:1.6, shape:'orb' });
    addParticles(p.x,p.y,'#b91d3a',10,140,0.25);
  } else if(id==='centinela'){
    game.enemies.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<190){
        t.stunTimer = Math.max(t.stunTimer||0, 1.4);
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.1), 'q');
      }
    });
    addParticles(p.x,p.y,'#7a8a9c',24,190,0.45);
    spawnShockwave(p.x,p.y,'#7a8a9c',190,0.4);
    shake(7);
  } else if(id==='cazador'){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=320;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    if(nearest){
      const missingFrac = nearest.hp!==undefined && nearest.maxHp ? 1-clamp(nearest.hp/nearest.maxHp,0,1) : 0;
      const mult = 1.4 + missingFrac*1.6; // execute-style: hits much harder on a wounded target
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*mult), 'q');
      addParticles(nearest.x,nearest.y,'#8a6fd8',16,180,0.3);
    }
  } else if(id==='torque'){
    // hookshot: only the common-enemy wave gets pulled/stunned (bosses stay put, same convention
    // as coloso's/centinela's crowd control) — but it still needs to work in a boss fight where
    // there are no common enemies left, so it just does nothing if none are in the cone that turn
    let nearest=null, nearestD=460;
    game.enemies.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d>=nearestD) return;
      const ang = Math.atan2(t.y-p.y,t.x-p.x);
      let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
      if(diff > (35*Math.PI/180)) return;
      nearest = t; nearestD = d;
    });
    if(nearest){
      const b = arenaBounds();
      const ang = Math.atan2(nearest.y-p.y, nearest.x-p.x);
      const pullDist = Math.min(nearestD-50, 220);
      const ox = nearest.x, oy = nearest.y;
      if(pullDist>0){
        nearest.x = clamp(nearest.x - Math.cos(ang)*pullDist, b.x+nearest.radius, b.x+b.w-nearest.radius);
        nearest.y = clamp(nearest.y - Math.sin(ang)*pullDist, b.y+nearest.radius, b.y+b.h-nearest.radius);
      }
      nearest.stunTimer = Math.max(nearest.stunTimer||0, 1.0);
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*1.3), 'q');
      spawnPullLine(p.x, p.y, ox, oy, '#4fae9c');
      spawnPullTrail(ox, oy, nearest.x, nearest.y, '#4fae9c');
      addParticles(nearest.x,nearest.y,'#4fae9c',14,170,0.3);
      p.lastHookTarget = nearest;
    }
  } else if(id==='frey'){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=340;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    if(nearest){
      // bosses only get a brief chill (their stunTimer is fully respected by updateBoss, but a
      // full multi-second lock would trivialize a boss fight) — common enemies get the real freeze
      const isBoss = bossTargets().includes(nearest);
      nearest.stunTimer = Math.max(nearest.stunTimer||0, isBoss?0.9:2.2);
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*1.1), 'q');
      addParticles(nearest.x,nearest.y,'#8fd8ff',18,150,0.35);
    }
  } else if(id==='dorian'){
    p.parryWindow = 1.1;
    addParticles(p.x,p.y,'#e0455a',10,140,0.25);
  } else if(id==='ferro'){
    game.pet = { x:p.x+p.facingX*40, y:p.y+p.facingY*40, hp:1, maxHp:1, radius:16, speed:0, stationary:true,
      dmg:Math.round(p.def.atk.dmg*1.2), atkTimer:0, atkCd:0.5, atkRange:260, color:'#c9a24a', hitFlash:0, life:16 };
    addParticles(p.x,p.y,'#c9a24a',16,150,0.3);
  } else if(id==='mecha'){
    const b = arenaBounds();
    for(let i=0;i<2;i++){
      const dd = 40+i*46;
      const mx = clamp(p.x+p.facingX*dd + rand(-14,14), b.x+10, b.x+b.w-10);
      const my = clamp(p.y+p.facingY*dd + rand(-14,14), b.y+10, b.y+b.h-10);
      game.mines.push({ x:mx, y:my, armTimer:0.35, triggerRadius:55, blastRadius:95, dmgBase:p.def.atk.dmg*1.6, life:16 });
    }
    addParticles(p.x,p.y,'#c96a4a',10,140,0.25);
  } else if(id==='arakne'){
    game.enemies.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d>200) return;
      const ang = Math.atan2(t.y-p.y,t.x-p.x);
      let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
      if(diff > (50*Math.PI/180)) return;
      t.slowTimer = Math.max(t.slowTimer||0, 2.5);
      dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.9), 'q');
    });
    game.swings.push({ x:p.x, y:p.y, angle:p.facing, arc:(50*Math.PI/180), range:200, life:0.25, maxLife:0.25, color:'#b89cff' });
    addParticles(p.x,p.y,'#b89cff',14,160,0.3);
  } else if(id==='rasha'){
    if(game.pack.length < 4){
      game.pack.push({ x:p.x+rand(-20,20), y:p.y+rand(-20,20), hp:1, maxHp:1, radius:11, speed:290,
        dmg:Math.round(p.def.atk.dmg*0.55), atkTimer:0, atkCd:0.5, color:'#e0a24a', hitFlash:0, life:16 });
      addParticles(p.x,p.y,'#e0a24a',10,140,0.25);
    } else {
      game.pack.forEach(m=> m.life = Math.min(m.life+6, 16));
      addParticles(p.x,p.y,'#e0a24a',14,150,0.3);
    }
  } else if(id==='marlow'){
    game.pet = { x:p.x+p.facingX*70, y:p.y+p.facingY*70, hp:1, maxHp:1, radius:13, speed:0, stationary:true,
      dmg:0, atkTimer:9999, atkCd:9999, atkRange:0, color:'#c98fd8', hitFlash:0, life:14 };
    addParticles(p.x,p.y,'#c98fd8',12,140,0.25);
  } else if(id==='orbis'){
    game.gravityWell = { x:p.x+p.facingX*180, y:p.y+p.facingY*180, r:170, timer:2.2, dmgBase:p.def.atk.dmg*0.35, tick:0 };
    addParticles(game.gravityWell.x, game.gravityWell.y, '#8a5fd8', 14, 150, 0.3);
  } else if(id==='skald'){
    p.runeStacks = Math.min((p.runeStacks||0)+1, 5);
    p.potionEffects.dmg = Math.max(p.potionEffects.dmg, 4);
    addParticles(p.x,p.y,'#b08d57',10+p.runeStacks*2,150,0.3);
  } else if(id==='morbus'){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=360;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    if(nearest){
      if(game.enemies.includes(nearest)){
        nearest.plagueTimer = Math.max(nearest.plagueTimer||0, 5);
        nearest.plagueTick = 0;
        nearest.plagueDmgBase = p.def.atk.dmg*0.5;
        addParticles(nearest.x,nearest.y,'#7ad14a',12,140,0.3);
      } else {
        dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*1.6), 'q');
        addParticles(nearest.x,nearest.y,'#7ad14a',14,150,0.3);
      }
    }
  } else if(id==='tempus'){
    game.slowZone = { x:p.x+p.facingX*160, y:p.y+p.facingY*160, r:150, timer:4 };
    addParticles(game.slowZone.x, game.slowZone.y, '#5fc9e6', 14, 140, 0.3);
  } else if(id==='seren'){
    const dashDist=170, steps=5;
    const b = arenaBounds();
    let hitAny=false;
    for(let i=1;i<=steps;i++){
      p.x = clamp(p.x+p.facingX*(dashDist/steps), b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+p.facingY*(dashDist/steps), b.y+p.radius, b.y+b.h-p.radius);
    }
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<60+t.radius){
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.3), 'q');
        hitAny=true;
      }
    });
    p.chainCount = hitAny ? Math.min((p.chainCount||0)+1, 3) : 0;
    p.chainWindow = hitAny ? 1.2 : 0;
    p.invuln = Math.max(p.invuln, 0.15);
    addParticles(p.x,p.y,'#ff8fd0',14,180,0.3);
  } else if(id==='rowan'){
    if(!(p.mountTimer>0)) p.speedMult = (p.speedMult||1) * 1.6;
    p.mountTimer = 3.5;
    p.mountTrampleTick = 0;
    addParticles(p.x,p.y,'#d9c98f',14,150,0.3);
  } else if(id==='talus'){
    for(let i=1;i<=4;i++){
      game.pendingBursts.push({ x:p.x+p.facingX*i*68, y:p.y+p.facingY*i*68, timer:0.55, radius:55, dmgBase:p.def.atk.dmg*1.3 });
    }
    addParticles(p.x,p.y,'#c9a878',10,140,0.25);
  } else if(id==='lira'){
    p.songIndex = ((p.songIndex||0)+1)%3;
    if(p.songIndex===0){
      p.potionEffects.dmg = Math.max(p.potionEffects.dmg, 6);
      addParticles(p.x,p.y,'#ffcb6a',12,150,0.3);
    } else if(p.songIndex===1){
      p.potionEffects.spd = Math.max(p.potionEffects.spd, 6);
      addParticles(p.x,p.y,'#6affd0',12,150,0.3);
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.06);
      addParticles(p.x,p.y,'#ff9ad1',12,150,0.3);
    }
  } else if(id==='amara'){
    let nearest=null, nearestD=320;
    game.enemies.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    if(nearest){
      const idx = game.enemies.indexOf(nearest);
      if(idx>=0) game.enemies.splice(idx,1);
      game.pack.push({ x:nearest.x, y:nearest.y, hp:1, maxHp:1, radius:nearest.radius||14,
        speed:(nearest.def && nearest.def.speed)||220, dmg:Math.round(p.def.atk.dmg*0.7),
        atkTimer:0, atkCd:0.5, color:'#9c6fd8', hitFlash:0, life:8, possessed:true });
      p.invuln = Math.max(p.invuln, 0.25);
      addParticles(nearest.x,nearest.y,'#9c6fd8',18,180,0.35);
    } else {
      p.shield = Math.max(p.shield, 40);
      addParticles(p.x,p.y,'#9c6fd8',12,140,0.3);
    }
  } else if(id==='midas'){
    const cost = Math.min(game.gold, 40);
    if(cost>=20){
      game.gold -= cost;
      p.shield = Math.max(p.shield, cost*1.8);
      addParticles(p.x,p.y,'#ffd24a',14,160,0.3);
      spawnToast(`💰 -${cost} oro → escudo`);
    } else {
      addParticles(p.x,p.y,'#ffd24a',8,120,0.2);
      spawnToast('No tenés suficiente oro (mínimo 20)');
    }
  } else if(id==='borea'){
    game.vortex = { x:p.x, y:p.y, r:140, timer:4, storedDmg:0 };
    addParticles(p.x,p.y,'#a8e0ff',14,150,0.3);
  } else if(id==='anselm'){
    p.stoneTimer = 2.5;
    p.stoneElapsed = 0;
    addParticles(p.x,p.y,'#9c9c9c',14,140,0.25);
  }
  addParticles(p.x,p.y,'#fff',6,90,0.2);
  triggerComboEffect('q');
}

function doAbilityE(){
  const p = game.player;
  const id = p.def.id;
  p.eTimer = Math.max(MIN_ABILITY_CD, p.def.e.cd*effectiveCdMult(p));
  if(id==='guerrero'){
    p.effects.warcry = 5;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<160){
        const ang = Math.atan2(t.y-p.y,t.x-p.x);
        t.x += Math.cos(ang)*40; t.y += Math.sin(ang)*40;
      }
    });
    addParticles(p.x,p.y,'#ff6a3d',22,220,0.5);
    shake(8);
  } else if(id==='maga'){
    const b = arenaBounds();
    const nx = clamp(p.x+p.facingX*220, b.x+p.radius, b.x+b.w-p.radius);
    const ny = clamp(p.y+p.facingY*220, b.y+p.radius, b.y+b.h-p.radius);
    addParticles(p.x,p.y,'#6a8dff',16,160,0.4);
    p.x=nx; p.y=ny;
    p.invuln = 0.3;
    addParticles(p.x,p.y,'#6a8dff',16,160,0.4);
  } else if(id==='picaro'){
    p.effects.shadow = 1.3;
    p.effects.shadowCrit = true;
    p.invuln = 0.2;
    addParticles(p.x,p.y,'#d24aff',18,180,0.45);
  } else if(id==='paladin'){
    let healed = 0;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y) < 140){ dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.2), 'e'); healed+=8; }
    });
    p.hp = Math.min(p.maxHp, p.hp + Math.max(14,healed));
    addParticles(p.x,p.y,'#ffcb47',26,220,0.5);
    shake(6);
  } else if(id==='nigromante'){
    let drained = 0;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y) < 150){ const dmgObj=computeDamage(p.def.atk.dmg*0.9); dealDamageToTarget(t, dmgObj, 'e'); drained+=dmgObj.value*0.6; }
    });
    p.hp = Math.min(p.maxHp, p.hp + drained);
    addParticles(p.x,p.y,'#8bff6b',22,190,0.5);
  } else if(id==='vidrio'){
    p.shield = Math.max(p.shield, 46);
    addParticles(p.x,p.y,'#e8e8f5',20,170,0.4);
  } else if(id==='coloso'){
    p.shield = Math.max(p.shield, 90);
    p.effects.wall = 4;
    p.parryWindow = 0.35; // Maestría de Posturas: block a hit right as Muro de Voluntad goes up
    addParticles(p.x,p.y,'#9c8a6a',24,180,0.45);
    shake(4);
  } else if(id==='silvano'){
    if(game.pet){
      explodeAt(game.pet.x, game.pet.y, 130, computeDamage(p.def.atk.dmg*3), '#5bbf7a');
      addParticles(game.pet.x,game.pet.y,'#5bbf7a',30,220,0.5);
      game.pet = null;
      shake(6);
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.15);
      addParticles(p.x,p.y,'#5bbf7a',16,150,0.35);
    }
  } else if(id==='dual'){
    const dashDist=130, steps=6;
    const b = arenaBounds();
    for(let i=0;i<steps;i++){
      p.x = clamp(p.x+p.facingX*(dashDist/steps), b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+p.facingY*(dashDist/steps), b.y+p.radius, b.y+b.h-p.radius);
    }
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y) < 80+t.radius) dealDamageToTarget(t, computeDamage(currentAtk(p).dmg*1.5), 'e');
    });
    p.invuln = Math.max(p.invuln, 0.2);
    addParticles(p.x,p.y,'#5ac8d8',16,190,0.35);
    shake(3);
  } else if(id==='monje'){
    p.invuln = Math.max(p.invuln, 1.1);
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.22);
    p.slowTimer=0; p.chillTimer=0; p.witherTimer=0; p.weakenTimer=0; p.qLockTimer=0; p.eLockTimer=0;
    addParticles(p.x,p.y,'#ffb347',24,150,0.5);
  } else if(id==='arquera'){
    const b = arenaBounds();
    const cx = clamp(p.x+p.facingX*180, b.x+40,b.x+b.w-40);
    const cy = clamp(p.y+p.facingY*180, b.y+40,b.y+b.h-40);
    for(let i=0;i<9;i++){
      const ox = cx + rand(-90,90), oy = cy + rand(-70,70);
      spawnProjectile({ x:ox, y:oy-260, vx:0, vy:640, dmg:computeDamage(p.def.atk.dmg*0.85),
        radius:6, owner:'player', color:'#8bffb0', life:0.6, shape:'shard' });
    }
    addParticles(cx,cy,'#8bffb0',12,120,0.3);
  } else if(id==='elementalista'){
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y) < 150) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.1), 'e');
    });
    p.shield = Math.max(p.shield, 60);
    addParticles(p.x,p.y,'#6ad8ff',22,190,0.45);
    spawnShockwave(p.x,p.y,'#6ad8ff',150,0.35);
  } else if(id==='berserker'){
    const cost = Math.min(p.hp-1, p.maxHp*0.15);
    p.hp -= Math.max(0,cost);
    p.effects.warcry = Math.max(p.effects.warcry||0, 6);
    addParticles(p.x,p.y,'#ff3d3d',22,200,0.45);
    shake(5);
  } else if(id==='ilusionista'){
    if(game.pet){
      const tx=game.pet.x, ty=game.pet.y;
      addParticles(p.x,p.y,'#c9a8ff',14,150,0.3);
      p.x = tx; p.y = ty;
      p.invuln = Math.max(p.invuln, 0.25);
      explodeAt(tx,ty,110, computeDamage(p.def.atk.dmg*2), '#c9a8ff');
      game.pet = null;
      addParticles(tx,ty,'#c9a8ff',24,200,0.45);
      shake(4);
    } else {
      const b = arenaBounds();
      const nx = clamp(p.x+p.facingX*180, b.x+p.radius, b.x+b.w-p.radius);
      const ny = clamp(p.y+p.facingY*180, b.y+p.radius, b.y+b.h-p.radius);
      p.x=nx; p.y=ny; p.invuln=Math.max(p.invuln,0.25);
      addParticles(p.x,p.y,'#c9a8ff',16,160,0.4);
    }
  } else if(id==='alquimista'){
    game.enemies.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d<170 && d>1){
        const ang = Math.atan2(t.y-p.y,t.x-p.x);
        t.x += Math.cos(ang)*70; t.y += Math.sin(ang)*70;
      }
    });
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.18);
    p.invuln = Math.max(p.invuln, 0.3);
    addParticles(p.x,p.y,'#c9e85a',24,210,0.45);
    spawnShockwave(p.x,p.y,'#c9e85a',170,0.35);
    shake(6);
  } else if(id==='druida'){
    p.potionEffects.spd = Math.max(p.potionEffects.spd, 6);
    p.potionEffects.dmg = Math.max(p.potionEffects.dmg, 6);
    p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.1);
    addParticles(p.x,p.y,'#9c7a4a',22,190,0.45);
    shake(4);
  } else if(id==='sangre'){
    const cost = Math.min(p.hp-1, p.maxHp*0.2);
    p.hp -= Math.max(0,cost);
    p.shield = Math.max(p.shield, cost*1.8);
    addParticles(p.x,p.y,'#b91d3a',20,180,0.4);
  } else if(id==='centinela'){
    p.shield = Math.max(p.shield, 110);
    p.potionEffects.def = Math.max(p.potionEffects.def, 5);
    addParticles(p.x,p.y,'#7a8a9c',26,200,0.45);
    shake(4);
  } else if(id==='cazador'){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=420;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    if(nearest){
      const b = arenaBounds();
      const ang = Math.atan2(nearest.y-p.y, nearest.x-p.x);
      const behindDist = 55+nearest.radius;
      p.x = clamp(nearest.x-Math.cos(ang)*behindDist, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(nearest.y-Math.sin(ang)*behindDist, b.y+p.radius, b.y+b.h-p.radius);
      p.invuln = Math.max(p.invuln, 0.2);
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*2.1), 'e');
      addParticles(nearest.x,nearest.y,'#8a6fd8',20,190,0.4);
      shake(4);
    } else {
      p.effects.shadow = Math.max(p.effects.shadow||0, 1);
      addParticles(p.x,p.y,'#8a6fd8',16,160,0.35);
    }
  } else if(id==='torque'){
    const origin = (p.lastHookTarget && p.lastHookTarget.hp>0) ? p.lastHookTarget : p;
    const ox = origin.x, oy = origin.y;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(ox,oy,t.x,t.y) >= 170) return;
      dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.4), 'e');
      if(game.enemies.includes(t)) t.stunTimer = Math.max(t.stunTimer||0, 0.8);
    });
    addParticles(ox,oy,'#4fae9c',20,180,0.4);
    spawnShockwave(ox,oy,'#4fae9c',170,0.35);
    shake(4);
  } else if(id==='frey'){
    const targets = [...game.enemies, ...bossTargets()];
    targets.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d>120+t.radius) return;
      const ang = Math.atan2(t.y-p.y,t.x-p.x);
      let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
      if(diff > (75*Math.PI/180)) return;
      const frozen = t.stunTimer>0;
      const dmgObj = computeDamage(p.def.atk.dmg*(frozen?3.2:1.3));
      if(frozen) dmgObj.crit = true;
      dealDamageToTarget(t, dmgObj, 'e');
      if(frozen){ t.stunTimer = 0; addParticles(t.x,t.y,'#ffffff',16,190,0.35); }
    });
    game.swings.push({ x:p.x, y:p.y, angle:p.facing, arc:(75*Math.PI/180), range:120, life:0.2, maxLife:0.2, color:'#8fd8ff' });
    addParticles(p.x,p.y,'#8fd8ff',14,190,0.3);
    shake(4);
  } else if(id==='dorian'){
    const hasCharge = !!p.parryCharge;
    const mult = hasCharge ? 3.2 : 1.6;
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=110;
    targets.forEach(t=>{
      const d = dist(p.x,p.y,t.x,t.y);
      if(d>=nearestD) return;
      const ang = Math.atan2(t.y-p.y,t.x-p.x);
      let diff = Math.abs(ang-p.facing); if(diff>Math.PI) diff=Math.PI*2-diff;
      if(diff > (70*Math.PI/180)) return;
      nearest = t; nearestD = d;
    });
    if(nearest){
      const dmgObj = computeDamage(p.def.atk.dmg*mult);
      if(hasCharge) dmgObj.crit = true;
      dealDamageToTarget(nearest, dmgObj, 'e');
      addParticles(nearest.x,nearest.y,'#e0455a',hasCharge?24:14,200,0.4);
      if(hasCharge) shake(6);
    }
    p.parryCharge = false;
    p.invuln = Math.max(p.invuln, 0.15);
  } else if(id==='ferro'){
    if(game.pet){
      explodeAt(game.pet.x, game.pet.y, 130, computeDamage(p.def.atk.dmg*1.8), '#c9a24a');
      addParticles(game.pet.x,game.pet.y,'#c9a24a',24,200,0.4);
      game.pet.life = Math.min(game.pet.life+6, 20); // overcharge also tops the turret's timer back up
      shake(4);
    } else {
      p.shield = Math.max(p.shield, 55);
      addParticles(p.x,p.y,'#c9a24a',18,160,0.35);
    }
  } else if(id==='mecha'){
    if(game.mines.length){
      [...game.mines].forEach(m=>{ explodeAt(m.x, m.y, m.blastRadius, computeDamage(m.dmgBase), '#c96a4a'); });
      game.mines = [];
      shake(5);
    } else {
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<110) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.2), 'e');
      });
      addParticles(p.x,p.y,'#c96a4a',14,150,0.3);
    }
  } else if(id==='arakne'){
    const dashDist=200, steps=6;
    const b = arenaBounds();
    const hitSet = new Set();
    for(let i=1;i<=steps;i++){
      p.x = clamp(p.x+p.facingX*(dashDist/steps), b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+p.facingY*(dashDist/steps), b.y+p.radius, b.y+b.h-p.radius);
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(!hitSet.has(t) && dist(p.x,p.y,t.x,t.y) < 60+t.radius){
          hitSet.add(t);
          const webbed = t.slowTimer>0;
          dealDamageToTarget(t, computeDamage(p.def.atk.dmg*(webbed?2.4:1.4)), 'e');
        }
      });
    }
    p.invuln = Math.max(p.invuln, 0.2);
    addParticles(p.x,p.y,'#b89cff',16,190,0.35);
    shake(3);
  } else if(id==='rasha'){
    if(game.pack.length){
      [...game.pack].forEach(m=>{
        explodeAt(m.x, m.y, 80, computeDamage(p.def.atk.dmg*1.3), '#e0a24a');
        addParticles(m.x,m.y,'#e0a24a',14,170,0.3);
      });
      game.pack = [];
      shake(5);
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.1);
      addParticles(p.x,p.y,'#e0a24a',14,150,0.3);
    }
  } else if(id==='marlow'){
    if(game.pet){
      const tx=game.pet.x, ty=game.pet.y;
      [...game.enemies, ...bossTargets()].forEach(t=>{
        const d = dist(tx,ty,t.x,t.y);
        if(d>=150) return;
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.6), 'e');
        if(game.enemies.includes(t)){
          const ang = Math.atan2(p.y-t.y,p.x-t.x);
          const b = arenaBounds();
          const ox=t.x, oy=t.y;
          t.x = clamp(t.x+Math.cos(ang)*90, b.x+t.radius, b.x+b.w-t.radius);
          t.y = clamp(t.y+Math.sin(ang)*90, b.y+t.radius, b.y+b.h-t.radius);
          t.stunTimer = Math.max(t.stunTimer||0, 0.7);
          spawnPullLine(tx, ty, ox, oy, '#c98fd8');
          spawnPullTrail(ox, oy, t.x, t.y, '#c98fd8');
        }
      });
      addParticles(tx,ty,'#c98fd8',20,180,0.4);
      spawnShockwave(tx,ty,'#c98fd8',150,0.35);
      game.pet = null;
      shake(4);
    } else {
      p.shield = Math.max(p.shield, 50);
      addParticles(p.x,p.y,'#c98fd8',16,150,0.3);
    }
  } else if(id==='orbis'){
    const w = game.gravityWell;
    if(w){
      const b = arenaBounds();
      game.enemies.forEach(t=>{
        const d = dist(w.x,w.y,t.x,t.y);
        if(d>=w.r+40) return;
        const ang = Math.atan2(t.y-w.y,t.x-w.x);
        t.x = clamp(t.x+Math.cos(ang)*160, b.x+t.radius, b.x+b.w-t.radius);
        t.y = clamp(t.y+Math.sin(ang)*160, b.y+t.radius, b.y+b.h-t.radius);
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.8), 'e');
      });
      bossTargets().forEach(t=>{
        if(dist(w.x,w.y,t.x,t.y)<w.r+40) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.8), 'e');
      });
      addParticles(w.x,w.y,'#8a5fd8',26,220,0.45);
      spawnShockwave(w.x,w.y,'#8a5fd8',w.r+40,0.4);
      game.gravityWell = null;
      shake(6);
    } else {
      p.shield = Math.max(p.shield, 55);
      addParticles(p.x,p.y,'#8a5fd8',16,160,0.3);
    }
  } else if(id==='skald'){
    const stacks = p.runeStacks||0;
    if(stacks>0){
      const mult = 0.8 + stacks*0.5;
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<160) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult), 'e');
      });
      addParticles(p.x,p.y,'#b08d57',16+stacks*4,200,0.4);
      spawnShockwave(p.x,p.y,'#b08d57',160,0.35);
      p.runeStacks = 0;
      shake(3+stacks);
    } else {
      p.shield = Math.max(p.shield, 40);
      addParticles(p.x,p.y,'#b08d57',14,150,0.3);
    }
  } else if(id==='morbus'){
    let dealt = 0;
    game.enemies.forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<130){
        t.plagueTimer = Math.max(t.plagueTimer||0, 4);
        t.plagueTick = 0;
        t.plagueDmgBase = p.def.atk.dmg*0.45;
        dealt += p.def.atk.dmg*0.3; // credited toward the self-heal now, even though it actually lands over time
      }
    });
    bossTargets().forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<130){
        const dmgObj = computeDamage(p.def.atk.dmg*1.3);
        dealDamageToTarget(t, dmgObj, 'e');
        dealt += dmgObj.value;
      }
    });
    p.hp = Math.min(p.maxHp, p.hp + dealt*0.5);
    addParticles(p.x,p.y,'#7ad14a',20,180,0.4);
    shake(3);
  } else if(id==='tempus'){
    const hist = p.rewindHistory||[];
    const targetTime = performance.now()-2500;
    let best=null;
    for(let i=0;i<hist.length;i++){ if(hist[i].t<=targetTime) best=hist[i]; }
    if(best){
      const b = arenaBounds();
      p.x = clamp(best.x, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(best.y, b.y+p.radius, b.y+b.h-p.radius);
      if(best.hp>p.hp) p.hp = Math.min(p.maxHp, p.hp + (best.hp-p.hp)*0.5);
      p.invuln = Math.max(p.invuln, 0.35);
      addParticles(p.x,p.y,'#5fc9e6',22,190,0.4);
    } else {
      p.invuln = Math.max(p.invuln, 0.25); // not enough history yet — still a brief safety blink
      addParticles(p.x,p.y,'#5fc9e6',14,150,0.3);
    }
  } else if(id==='seren'){
    const stacks = p.chainCount||0;
    const mult = 1.2 + stacks*0.7;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<130) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult), 'e');
    });
    addParticles(p.x,p.y,'#ff8fd0',16+stacks*4,200,0.4);
    spawnShockwave(p.x,p.y,'#ff8fd0',130,0.3);
    p.chainCount = 0; p.chainWindow = 0;
    shake(3+stacks);
  } else if(id==='rowan'){
    const mounted = p.mountTimer>0;
    const mult = mounted ? 2.6 : 1.3;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<150) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult), 'e');
    });
    addParticles(p.x,p.y,'#d9c98f',mounted?24:14,200,0.4);
    spawnShockwave(p.x,p.y,'#d9c98f',150,0.35);
    if(mounted){ p.speedMult /= 1.6; p.mountTimer = 0; }
    shake(mounted?6:3);
  } else if(id==='talus'){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=420;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearest=t; nearestD=d; } });
    p.invuln = Math.max(p.invuln, 0.4);
    if(nearest){
      const b = arenaBounds();
      const ang = Math.atan2(nearest.y-p.y, nearest.x-p.x);
      const arriveDist = Math.max(nearestD-50, 0);
      p.x = clamp(p.x+Math.cos(ang)*arriveDist, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y+Math.sin(ang)*arriveDist, b.y+p.radius, b.y+b.h-p.radius);
      dealDamageToTarget(nearest, computeDamage(p.def.atk.dmg*2.2), 'e');
      if(game.enemies.includes(nearest)) nearest.stunTimer = Math.max(nearest.stunTimer||0, 0.6);
      addParticles(p.x,p.y,'#c9a878',22,190,0.4);
      spawnShockwave(p.x,p.y,'#c9a878',90,0.3);
      shake(5);
    } else {
      addParticles(p.x,p.y,'#c9a878',14,150,0.3);
    }
  } else if(id==='lira'){
    const idx = p.songIndex||0;
    if(idx===0){
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<150) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*2.2), 'e');
      });
      addParticles(p.x,p.y,'#ffcb6a',20,190,0.4);
    } else if(idx===1){
      p.speedBurstTimer = Math.max(p.speedBurstTimer||0, 3);
      p.invuln = Math.max(p.invuln, 0.2);
      addParticles(p.x,p.y,'#6affd0',18,180,0.35);
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp*0.22);
      addParticles(p.x,p.y,'#ff9ad1',20,190,0.4);
    }
    spawnShockwave(p.x,p.y,'#ffe08a',150,0.3);
    shake(3);
  } else if(id==='amara'){
    const possessed = game.pack.filter(m=>m.possessed);
    if(possessed.length){
      possessed.forEach(m=>{
        explodeAt(m.x, m.y, 110, computeDamage(p.def.atk.dmg*2.4), '#9c6fd8');
        addParticles(m.x,m.y,'#9c6fd8',22,200,0.4);
      });
      game.pack = game.pack.filter(m=>!m.possessed);
      shake(5);
    } else {
      [...game.enemies, ...bossTargets()].forEach(t=>{
        if(dist(p.x,p.y,t.x,t.y)<110) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.3), 'e');
      });
      addParticles(p.x,p.y,'#9c6fd8',14,150,0.3);
    }
  } else if(id==='midas'){
    let converted = 0;
    for(let i=game.projectiles.length-1;i>=0;i--){
      const pr = game.projectiles[i];
      if(pr.owner==='enemy' && dist(p.x,p.y,pr.x,pr.y)<160){
        game.goldOrbs.push({ x:pr.x, y:pr.y, value:Math.round(rand(2,5)), vx:rand(-40,40), vy:rand(-40,40) });
        game.projectiles.splice(i,1);
        converted++;
      }
    }
    if(converted>0){
      addParticles(p.x,p.y,'#ffd24a',10+converted*3,170,0.35);
      spawnShockwave(p.x,p.y,'#ffd24a',160,0.3);
    } else {
      game.gold += 8;
      addParticles(p.x,p.y,'#ffd24a',10,140,0.3);
    }
  } else if(id==='borea'){
    const v = game.vortex;
    const bonus = v ? v.storedDmg*0.8 : 0;
    const mult = 1.3 + (bonus/Math.max(1,p.def.atk.dmg));
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<170) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult), 'e');
    });
    addParticles(p.x,p.y,'#a8e0ff',20+(v?10:0),200,0.4);
    spawnShockwave(p.x,p.y,'#a8e0ff',170,0.35);
    if(v) game.vortex = null;
    shake(v?5:3);
  } else if(id==='anselm'){
    const heldTime = p.stoneElapsed||0;
    const mult = 1.2 + Math.min(heldTime,4)*0.6;
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<160) dealDamageToTarget(t, computeDamage(p.def.atk.dmg*mult), 'e');
    });
    addParticles(p.x,p.y,'#9c9c9c',18+Math.round(heldTime*4),200,0.4);
    spawnShockwave(p.x,p.y,'#9c9c9c',160,0.35);
    p.stoneTimer = 0; p.stoneElapsed = 0;
    shake(4+Math.round(Math.min(heldTime,4)));
  }
  triggerComboEffect('e');
}

function doUltimate(){
  const p = game.player;
  const id = p.activeUltimate;
  if(!id) return;
  const cd = p.ultCooldowns[id]||0;
  if(cd>0) return;
  const ability = ULTIMATE_ABILITIES.find(a=>a.id===id);
  ability.cast(p);
  // the R ultimate's cooldown ignores cdMult entirely — cooldown-reduction items/synergies
  // don't touch it, it always sits at its own base cd (floored at MIN_ULT_CD = 30s)
  p.ultCooldowns[ability.id] = Math.max(MIN_ULT_CD, ability.cd);
  // Ojo que Todo Ve: deliberately doesn't touch R's cooldown (see note above) — instead grants a
  // few seconds of invulnerability the instant you commit to using it
  if(p.relics.effect_allSeeingEye){ p.invuln = Math.max(p.invuln, 3); }
}
function doShiftAbility(){
  const p = game.player;
  const id = p.activeShiftAbility;
  if(!id) return;
  const cd = p.shiftCooldowns[id]||0;
  if(cd>0) return;
  const ability = SHIFT_ABILITIES.find(a=>a.id===id);
  ability.cast(p);
  p.shiftCooldowns[ability.id] = ability.cd; // Shift abilities aren't floored by MIN_ULT_CD — they're meant to be more frequent utility, not a second R
}

function doInteract(){
  const p = game.player;
  // chests
  if(game.phase==='shopping'){
    game.chests.forEach(c=>{
      if(!c.opened && dist(p.x,p.y,c.x,c.y)<60){
        if(game.gold>=c.cost){
          game.gold-=c.cost;
          c.opened=true;
          const tier = CHEST_TIERS[c.tier];
          const cursed = Math.random()<CURSED_CHEST_CHANCE;
          const item = cursed
            ? CURSED_ITEMS[Math.floor(Math.random()*CURSED_ITEMS.length)]
            : ITEM_POOL[c.tier][Math.floor(Math.random()*ITEM_POOL[c.tier].length)];
          item.apply(p);
          p.items.push(item);
          registerItemDiscovery(item);
          checkSynergies(p);
          if(cursed){
            spawnToast(`☠ [MALDITO] ${item.name} — ${item.desc}`);
            addParticles(c.x,c.y,'#e8434f',30,220,0.6);
            shake(8);
          } else {
            spawnToast(`${item.icon} [${tier.label}] ${item.name} — ${item.desc}`);
            addParticles(c.x,c.y,tier.color,c.tier==='epic'?32:(c.tier==='rare'?24:16),c.tier==='epic'?240:180,0.55);
            shake(c.tier==='epic'?7:(c.tier==='rare'?4:0));
          }
        } else {
          spawnToast(`Necesitas ${c.cost} de oro para este cofre.`);
        }
      }
    });
    if(game.altar && game.altar.active && dist(p.x,p.y,game.altar.x,game.altar.y)<70){
      startBossCountdown();
    }
    if(game.sacrificeAltar && !game.sacrificeAltar.used && dist(p.x,p.y,game.sacrificeAltar.x,game.sacrificeAltar.y)<60){
      game.sacrificeAltar.used = true;
      const cut = p.maxHp*0.15;
      p.maxHp -= cut; p.hp = Math.max(1, p.hp-cut);
      const bonus = 15 + game.stageIndex*6;
      game.gold += bonus;
      spawnToast(`Sacrificaste ${Math.round(cut)} HP máx por ${bonus} oro.`);
      addParticles(game.sacrificeAltar.x, game.sacrificeAltar.y, '#e8434f', 26, 200, 0.5);
      shake(5);
    }
    if(game.corruptionAltar && !game.corruptionAltar.used && dist(p.x,p.y,game.corruptionAltar.x,game.corruptionAltar.y)<60){
      game.corruptionAltar.used = true;
      const item = ITEM_POOL.epic[Math.floor(Math.random()*ITEM_POOL.epic.length)];
      item.apply(p);
      p.items.push(item);
      registerItemDiscovery(item);
      checkSynergies(p);
      p.corruptionCurse = true;
      game.roomsSinceCorruption = 0; // purges automatically after 3 clean floors — see btn-next-stage
      spawnToast(`👑 [LEGENDARIO] ${item.name} — ${item.desc}`);
      spawnToast('☠ El altar te maldice: visión reducida y lentitud, hasta limpiar 3 salas más');
      addParticles(game.corruptionAltar.x, game.corruptionAltar.y, '#7a2fbf', 34, 240, 0.6);
      shake(10);
    }
    if(game.merchant && dist(p.x,p.y,game.merchant.x,game.merchant.y)<70 && !merchantOpen){
      openMerchant();
    }
  } else if(game.phase==='portal'){
    if(game.portal && dist(p.x,p.y,game.portal.x,game.portal.y)<70){
      if(game.ascenso) onAscensoStageClear(); else onStageClear();
    }
  }
}

/* ---------- enemies ---------- */
function stepPetAI(pet, dt){
  // shared chase/attack AI — used by the single-slot game.pet (Silvano/Ferro/Ilusionista/Marlow)
  // and by game.pack, Rasha's array of several simultaneous critters
  const p = game.player;
  pet.spawnAge = (pet.spawnAge||0) + dt; // drives the materialize pop-in in drawPet
  pet.hitFlash = Math.max(0, pet.hitFlash-dt);
  pet.atkTimer = Math.max(0, pet.atkTimer-dt);
  const atkRange = pet.atkRange||34; // Ferro's turret passes a much bigger range than the default melee pets
  const targets = [...game.enemies, ...bossTargets()];
  let nearest=null, nearestD=Infinity;
  targets.forEach(t=>{ const d=dist(pet.x,pet.y,t.x,t.y); if(d<nearestD){ nearestD=d; nearest=t; } });
  if(nearest && nearestD<Math.max(420,atkRange)){
    if(nearestD>atkRange){
      if(!pet.stationary){
        const ang = Math.atan2(nearest.y-pet.y,nearest.x-pet.x);
        pet.x += Math.cos(ang)*pet.speed*dt;
        pet.y += Math.sin(ang)*pet.speed*dt;
      }
    } else if(pet.atkTimer<=0 && pet.dmg>0){
      pet.atkTimer = pet.atkCd;
      pet.hitFlash = 0.12;
      dealDamageToTarget(nearest, computeDamage(pet.dmg), 'pet');
      addParticles(nearest.x,nearest.y,pet.color||'#5bbf7a',5,110,0.18);
    }
  } else if(!pet.stationary){
    const d = dist(pet.x,pet.y,p.x,p.y);
    if(d>70){
      const ang = Math.atan2(p.y-pet.y,p.x-pet.x);
      pet.x += Math.cos(ang)*pet.speed*0.8*dt;
      pet.y += Math.sin(ang)*pet.speed*0.8*dt;
    }
  }
  const b = arenaBounds();
  pet.x = clamp(pet.x, b.x+pet.radius, b.x+b.w-pet.radius);
  pet.y = clamp(pet.y, b.y+pet.radius, b.y+b.h-pet.radius);
}
function updatePet(dt){
  const pet = game.pet;
  pet.life -= dt;
  if(pet.life<=0){ game.pet = null; return; }
  stepPetAI(pet, dt);
}
function updatePack(dt){
  for(let i=game.pack.length-1;i>=0;i--){
    const m = game.pack[i];
    m.life -= dt;
    if(m.life<=0){ game.pack.splice(i,1); continue; }
    stepPetAI(m, dt);
  }
}

// Orbis (Gravimante): a single persistent pull zone, only ever one active at a time
function updateGravityWell(dt){
  const w = game.gravityWell;
  if(!w) return;
  w.timer -= dt; w.tick -= dt;
  if(w.timer<=0){ game.gravityWell = null; return; }
  game.enemies.forEach(t=>{
    const d = dist(w.x,w.y,t.x,t.y);
    if(d<w.r && d>4){
      const ang = Math.atan2(w.y-t.y,w.x-t.x);
      const b = arenaBounds();
      t.x = clamp(t.x+Math.cos(ang)*140*dt, b.x+t.radius, b.x+b.w-t.radius);
      t.y = clamp(t.y+Math.sin(ang)*140*dt, b.y+t.radius, b.y+b.h-t.radius);
    }
  });
  if(w.tick<=0){
    w.tick = 0.4;
    game.enemies.forEach(t=>{ if(dist(w.x,w.y,t.x,t.y)<w.r) dealDamageToTarget(t, computeDamage(w.dmgBase), 'q'); });
  }
}
function drawGravityWell(){
  const w = game.gravityWell;
  if(!w) return;
  const t = performance.now()/1000;
  ctx.save();
  ctx.translate(w.x,w.y);
  ctx.globalAlpha = 0.32+Math.sin(performance.now()/200)*0.1;
  ctx.strokeStyle = '#8a5fd8'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0,0,w.r,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha *= 0.5;
  ctx.beginPath(); ctx.arc(0,0,w.r*0.55,0,Math.PI*2); ctx.stroke();
  // inward-spiraling arms — makes the pull itself visible, not just the boundary ring
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#c9a8ff'; ctx.lineWidth = 1.5;
  for(let arm=0;arm<3;arm++){
    ctx.beginPath();
    for(let i=0;i<=20;i++){
      const frac = i/20;
      const ang = t*1.5 + arm*(Math.PI*2/3) + frac*Math.PI*1.8;
      const rr = w.r*(1-frac*0.85);
      const x=Math.cos(ang)*rr, y=Math.sin(ang)*rr;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.fillStyle='#1a0f2a';
  ctx.beginPath(); ctx.arc(0,0,8,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// Tempus (Crononauta): a single persistent slow field, only one active at a time
function updateSlowZone(dt){
  const z = game.slowZone;
  if(!z) return;
  z.timer -= dt;
  if(z.timer<=0){ game.slowZone = null; return; }
  game.enemies.forEach(t=>{
    if(dist(z.x,z.y,t.x,t.y)<z.r) t.slowTimer = Math.max(t.slowTimer||0, 0.3);
  });
}
function drawSlowZone(){
  const z = game.slowZone;
  if(!z) return;
  const t = performance.now()/1000;
  ctx.save();
  ctx.translate(z.x,z.y);
  ctx.globalAlpha = 0.2+Math.sin(performance.now()/300)*0.05;
  ctx.fillStyle = '#5fc9e6';
  ctx.beginPath(); ctx.arc(0,0,z.r,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = '#5fc9e6'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0,0,z.r,0,Math.PI*2); ctx.stroke();
  // slow-drifting frost motes suspended inside the field
  ctx.fillStyle='#eafcff';
  for(let i=0;i<6;i++){
    const seed=i*137.5;
    const a = (seed%360)*Math.PI/180 + t*0.3;
    const rr = z.r*(0.2+((seed*7)%80)/100);
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(Math.cos(a)*rr, Math.sin(a)*rr, 2, 0, Math.PI*2); ctx.fill();
  }
  // a faint slow clock-hand sweep, hinting at "time crawling" inside the field
  ctx.globalAlpha=0.3;
  ctx.strokeStyle='#ffffff'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(t*0.4)*z.r*0.7, Math.sin(t*0.4)*z.r*0.7); ctx.stroke();
  ctx.restore();
}

// Talus (Terramante): telegraphed delayed bursts (his Q's ground-spike line)
function updatePendingBursts(dt){
  for(let i=game.pendingBursts.length-1;i>=0;i--){
    const b = game.pendingBursts[i];
    b.timer -= dt;
    if(b.timer<=0){
      explodeAt(b.x, b.y, b.radius, computeDamage(b.dmgBase), '#c96a4a');
      game.pendingBursts.splice(i,1);
    }
  }
}
function drawPendingBursts(){
  game.pendingBursts.forEach(b=>{
    ctx.save();
    ctx.translate(b.x,b.y);
    ctx.globalAlpha = 0.35+Math.sin(performance.now()/90)*0.15;
    ctx.strokeStyle = '#c9633a'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0,0,b.radius,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  });
}

// Borea (Domadora de Vientos): a single persistent vortex that eats enemy projectiles and banks
// their damage for E to release
// Shared "hook/pull" chain visual — a slightly jagged line from puller to whatever got yanked,
// fading fast. Used by any ability that drags an enemy toward (or away from) a point instead of
// dealing damage in place, so the pull actually reads as a pull instead of an instant teleport.
function spawnPullLine(x1,y1,x2,y2,color){
  game.pullLines.push({x1,y1,x2,y2,color,life:0.22,maxLife:0.22});
}
function updatePullLines(dt){
  for(let i=game.pullLines.length-1;i>=0;i--){
    const l = game.pullLines[i];
    l.life -= dt;
    if(l.life<=0) game.pullLines.splice(i,1);
  }
}
function drawPullLines(){
  game.pullLines.forEach(l=>{
    const fade = clamp(l.life/l.maxLife,0,1);
    ctx.save();
    ctx.globalAlpha = fade*0.85;
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = l.color; ctx.shadowBlur = 7;
    const segs = 5;
    const nx = -(l.y2-l.y1), ny = (l.x2-l.x1);
    const len = Math.hypot(nx,ny)||1;
    ctx.beginPath();
    for(let i=0;i<=segs;i++){
      const t = i/segs;
      const x = l.x1 + (l.x2-l.x1)*t;
      const y = l.y1 + (l.y2-l.y1)*t;
      const off = (i%2===0?0:1) * fade*4;
      if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x+nx/len*off, y+ny/len*off);
    }
    ctx.stroke();
    ctx.restore();
  });
}
// spawns a short trail of particles tracing the path an enemy just got dragged along, so the
// motion itself reads clearly instead of the target just appearing at its new spot
function spawnPullTrail(ox,oy,nx,ny,color){
  for(let i=1;i<=4;i++){
    const t=i/4;
    addParticles(ox+(nx-ox)*t, oy+(ny-oy)*t, color, 3, 80, 0.15);
  }
}

function updateVortex(dt){
  const v = game.vortex;
  if(!v) return;
  v.timer -= dt;
  if(v.timer<=0){ game.vortex = null; return; }
  for(let i=game.projectiles.length-1;i>=0;i--){
    const pr = game.projectiles[i];
    if(pr.owner==='enemy' && dist(v.x,v.y,pr.x,pr.y)<v.r){
      v.storedDmg += pr.dmg || 6;
      game.projectiles.splice(i,1);
      addParticles(pr.x,pr.y,'#a8e0ff',4,80,0.15);
    }
  }
}
function drawVortex(){
  const v = game.vortex;
  if(!v) return;
  const t = performance.now()/1000;
  ctx.save();
  ctx.translate(v.x,v.y);
  ctx.globalAlpha = 0.3+Math.sin(performance.now()/150)*0.1;
  ctx.strokeStyle = '#a8e0ff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(0,0,v.r,0,Math.PI*2); ctx.stroke();
  // spinning wind arcs — the suction pulling projectiles in now actually reads as wind
  ctx.globalAlpha=0.5;
  ctx.strokeStyle='#ffffff'; ctx.lineWidth=1.4;
  for(let i=0;i<3;i++){
    ctx.beginPath();
    ctx.arc(0,0,v.r*(0.4+i*0.2), t*3+i*2, t*3+i*2+Math.PI*1.1);
    ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.restore();
}

function drawPet(pet){
  // used to just pop into existence at full size as a flat circle — now scales in over its first
  // ~0.25s with a brief summoning ring, and has a soft rim-glow instead of a flat stroke
  ctx.save();
  ctx.globalAlpha = clamp(pet.life/2, 0.5, 1);
  ctx.translate(pet.x,pet.y);
  const pop = Math.min(1, (pet.spawnAge||1)/0.25);
  if(pop<1){
    ctx.save();
    ctx.globalAlpha *= (1-pop)*0.8;
    ctx.strokeStyle = pet.color; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(0,0,pet.radius+(1-pop)*16,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  ctx.scale(pop,pop);
  ctx.fillStyle = pet.hitFlash>0 ? '#ffffff' : pet.color;
  ctx.shadowColor=pet.color; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.arc(0,0,pet.radius,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2; ctx.stroke();
  ctx.globalAlpha *= 0.5;
  ctx.strokeStyle='#ffffff'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.arc(0,0,pet.radius*0.6,0,Math.PI*2); ctx.stroke();
  ctx.restore();
}


function updateEnemies(dt){
  const p = game.player;
  game.enemies.forEach(en=>{
    en.hitFlash = Math.max(0,en.hitFlash-dt);
    en.atkTimer = Math.max(0,en.atkTimer-dt);
    if(en.stunTimer>0){ en.stunTimer -= dt; return; }
    if(en.slowTimer>0){ en.slowTimer -= dt; en.speedMult = 0.5; } else { en.speedMult = 1; }
    if(en.poisonTimer>0){ en.poisonTimer-=dt; if(Math.floor(en.poisonTimer*10)%3===0){} }
    // Morbus (Médico de la Plaga): DOT that spreads to nearby uninfected enemies each tick, with a
    // shrinking timer on each jump so a single cast can't chain forever across a whole room
    if(en.plagueTimer>0){
      en.plagueTimer -= dt; en.plagueTick = (en.plagueTick||0) - dt;
      if(en.plagueTick<=0){
        en.plagueTick = 0.5;
        dealDamageToTarget(en, computeDamage(en.plagueDmgBase||3), 'plague');
        addParticles(en.x,en.y,'#7ad14a',4,80,0.15);
        if(en.plagueTimer>0.6){
          const spreadTarget = game.enemies.find(o=>o!==en && !(o.plagueTimer>0) && dist(en.x,en.y,o.x,o.y)<90);
          if(spreadTarget){
            spreadTarget.plagueTimer = en.plagueTimer*0.6;
            spreadTarget.plagueTick = 0;
            spreadTarget.plagueDmgBase = en.plagueDmgBase;
          }
        }
      }
    }
    // Bastión (Guerrero): Racha de Combo x10 — a simple non-spreading bleed DOT, refreshed by
    // each melee hit while combo stays above the threshold (see COMBO_EFFECTS above)
    if(en.bleedTimer>0){
      en.bleedTimer -= dt; en.bleedTick = (en.bleedTick||0) - dt;
      if(en.bleedTick<=0){
        en.bleedTick = 0.5;
        dealDamageToTarget(en, computeDamage(en.bleedDmgBase||3), 'bleed');
        addParticles(en.x,en.y,'#c9384a',4,90,0.15);
      }
    }
    if(en.weakenMarkTimer>0) en.weakenMarkTimer -= dt; // Cazador (Racha x12) — see dealDamageToTarget
    const d = dist(en.x,en.y,p.x,p.y);
    const def = en.def;
    const spd = def.speed*(en.speedMult||1);

    // ---- healer aura: works alongside whatever else this enemy is doing ----
    if(def.healer){
      en.healTimer = (en.healTimer===undefined ? Math.random()*def.healCd : en.healTimer) - dt;
      if(en.healTimer<=0){
        en.healTimer = def.healCd;
        let healedAny=false;
        game.enemies.forEach(other=>{
          if(other!==en && other.hp<other.maxHp && dist(en.x,en.y,other.x,other.y)<def.healRadius){
            other.hp = Math.min(other.maxHp, other.hp+def.healAmount);
            healedAny=true;
          }
        });
        if(healedAny) addParticles(en.x,en.y,'#5ad98a',10,90,0.4);
      }
    }

    if(def.charger){
      // ---- charge-dash melee: idle -> windup (telegraph) -> dash -> cooldown ----
      en.chargeState = en.chargeState || 'idle';
      if(en.chargeState==='dashing'){
        en.chargeTimer -= dt;
        en.x += en.chargeDirX*def.chargeSpeed*dt;
        en.y += en.chargeDirY*def.chargeSpeed*dt;
        if(en.atkTimer<=0 && d<en.radius+p.radius+6){
          en.atkTimer = 0.5;
          hitPlayer(en.dmg);
          applyContactSlowIfEquipped(en);
          addParticles(p.x,p.y,'#e8434f',8,140,0.3);
        }
        if(en.chargeTimer<=0){ en.chargeState='cooldown'; en.chargeTimer=def.chargeCd; }
      } else if(en.chargeState==='windup'){
        en.chargeTimer -= dt;
        if(en.chargeTimer<=0){
          en.chargeState='dashing'; en.chargeTimer=def.chargeDur;
          const ang = Math.atan2(p.y-en.y,p.x-en.x);
          en.chargeDirX = Math.cos(ang); en.chargeDirY = Math.sin(ang);
        }
      } else if(en.chargeState==='cooldown'){
        en.chargeTimer -= dt;
        if(d>def.range*0.7){
          const ang = Math.atan2(p.y-en.y,p.x-en.x);
          en.x += Math.cos(ang)*spd*dt; en.y += Math.sin(ang)*spd*dt;
        } else if(en.atkTimer<=0){
          en.atkTimer = def.atkCd;
          hitPlayer(en.dmg*0.6);
          applyContactSlowIfEquipped(en);
          addParticles(p.x,p.y,'#e8434f',6,120,0.25);
        }
        if(en.chargeTimer<=0) en.chargeState='idle';
      } else { // idle
        if(d>def.range*0.7){
          const ang = Math.atan2(p.y-en.y,p.x-en.x);
          en.x += Math.cos(ang)*spd*dt; en.y += Math.sin(ang)*spd*dt;
        } else {
          en.chargeState='windup'; en.chargeTimer=def.chargeWindup;
        }
      }
    } else if(def.kind==='melee'){
      if(d>def.range*0.7){
        const ang = Math.atan2(p.y-en.y,p.x-en.x);
        en.x += Math.cos(ang)*spd*dt;
        en.y += Math.sin(ang)*spd*dt;
      } else if(en.atkTimer<=0){
        en.atkTimer = def.atkCd;
        hitPlayer(en.dmg);
        applyContactSlowIfEquipped(en);
        addParticles(p.x,p.y,'#e8434f',8,140,0.3);
      }
    } else {
      // ---- ranged kinds (including chargeShot snipers, which pause & telegraph before firing) ----
      const aiming = def.chargeShot && en.aiming;
      if(!aiming){
        if(def.erratic){
          en.wanderAng += (Math.random()-0.5)*3.2*dt;
          const wx = Math.cos(en.wanderAng), wy = Math.sin(en.wanderAng);
          if(d>def.range*0.6){
            const ang = Math.atan2(p.y-en.y,p.x-en.x);
            en.x += (Math.cos(ang)*0.7 + wx*0.5)*spd*dt;
            en.y += (Math.sin(ang)*0.7 + wy*0.5)*spd*dt;
          } else {
            en.x += wx*spd*0.7*dt;
            en.y += wy*spd*0.7*dt;
          }
        } else if(d>def.range*0.75){
          const ang = Math.atan2(p.y-en.y,p.x-en.x);
          en.x += Math.cos(ang)*spd*dt;
          en.y += Math.sin(ang)*spd*dt;
        } else if(d<def.range*0.4){
          const ang = Math.atan2(en.y-p.y,en.x-p.x);
          en.x += Math.cos(ang)*spd*dt;
          en.y += Math.sin(ang)*spd*dt;
        }
      }
      if(def.chargeShot){
        if(en.aiming){
          en.aimTimer -= dt;
          if(en.aimTimer<=0){
            en.aiming=false;
            en.atkTimer = def.atkCd;
            const ang = Math.atan2(p.y-en.y,p.x-en.x);
            spawnProjectile({ x:en.x,y:en.y, vx:Math.cos(ang)*def.projSpeed, vy:Math.sin(ang)*def.projSpeed,
              dmg:en.dmg, radius:6, owner:'enemy', color:'#ffb3ec', life:2 });
          }
        } else if(en.atkTimer<=0 && d<def.range){
          en.aiming = true;
          en.aimTimer = def.chargeShotWindup;
        }
      } else if(en.atkTimer<=0 && d<def.range){
        en.atkTimer = def.atkCd;
        const ang = Math.atan2(p.y-en.y,p.x-en.x);
        spawnProjectile({ x:en.x,y:en.y, vx:Math.cos(ang)*def.projSpeed, vy:Math.sin(ang)*def.projSpeed,
          dmg:en.dmg, radius:6, owner:'enemy', color:def.poison?'#8bff6b':(def.slowOnHit?'#9fd8ff':'#e8434f'), life:2, poison:def.poison,
          slow: def.slowOnHit ? { factor:def.slowFactor, dur:def.slowDur } : null });
      }
    }
    const b = arenaBounds();
    en.x = clamp(en.x, b.x+en.radius, b.x+b.w-en.radius);
    en.y = clamp(en.y, b.y+en.radius, b.y+b.h-en.radius);
  });

  // separation pass: gently push overlapping enemies apart so a crowd doesn't collapse into a
  // single stacked pile — cheap O(n²) pass, fine for the enemy counts this game spawns
  const n = game.enemies.length;
  const eb = arenaBounds();
  for(let i=0;i<n;i++){
    const a = game.enemies[i];
    for(let j=i+1;j<n;j++){
      const c = game.enemies[j];
      const dx = c.x-a.x, dy = c.y-a.y;
      const dst = Math.hypot(dx,dy) || 0.01;
      const minDist = (a.radius+c.radius)*0.92;
      if(dst < minDist){
        const push = (minDist-dst)/dst*0.5;
        const ox = dx*push, oy = dy*push;
        a.x = clamp(a.x-ox, eb.x+a.radius, eb.x+eb.w-a.radius);
        a.y = clamp(a.y-oy, eb.y+a.radius, eb.y+eb.h-a.radius);
        c.x = clamp(c.x+ox, eb.x+c.radius, eb.x+eb.w-c.radius);
        c.y = clamp(c.y+oy, eb.y+c.radius, eb.y+eb.h-c.radius);
      }
    }
  }
}

// Maestría de Posturas: per-hero payoff for a perfectly-timed parry (see hitPlayer). Any hero not
// listed here still gets the mechanic — just falls back to a small shield — so this stays cheap
// to extend to future heroes without needing a bespoke entry for every single one.
const PARRY_REWARDS = {
  dorian: p=>{
    p.parryCharge = true; // spent by Contragolpe (E) for a guaranteed-crit follow-up
  },
  paladin: p=>{
    // a perfect block resets both Q and E outright — Aurelio's kit is built around a slow,
    // deliberate rhythm rather than a stacking resource, so getting the whole rotation back
    // immediately is the bigger payoff here
    p.qTimer = 0; p.eTimer = 0;
    spawnToast('✝ ¡Bloqueo perfecto! Habilidades reiniciadas');
  },
  coloso: p=>{
    // Muro de Voluntad already grants a flat shield — a perfect block on top of it blasts
    // everything around him, since the shield itself absorbs nothing when parried in time
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<180){
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.4), 'q');
        if(game.enemies.includes(t)) t.stunTimer = Math.max(t.stunTimer||0, 0.8);
      }
    });
    spawnShockwave(p.x,p.y,'#9c8a6a',180,0.35);
    shake(6);
  },
};
function applyParryReward(p){
  const fn = PARRY_REWARDS[p.def.id];
  if(fn){ fn(p); return; }
  p.shield = Math.max(p.shield, 30);
}

function hitPlayer(dmg){
  const p = game.player;
  if(devMode) return; // dev mode: infinite HP, take no damage at all
  if(p.invuln>0) return;
  if(game && game.phase==='boss') game.stats.bossTookDamage = true;
  p.timeSinceHit = 0;
  // Maestría de Posturas: a generic parry/perfect-block window, checked before the plain shield
  // absorb below so a well-timed hit gets the full payoff even on heroes whose Q/E also grants a
  // flat shield at the same moment (Paladín, Coloso) — miss the window and it just falls through
  // to that shield like normal. Every hero gets the shared baseline (full negate + punish-nova);
  // PARRY_REWARDS adds a bespoke bonus on top for the heroes built around this mechanic.
  if(p.parryWindow>0){
    p.parryWindow = 0;
    p.invuln = Math.max(p.invuln, 0.3);
    addParticles(p.x,p.y,p.def.accent||'#fff',20,190,0.4);
    spawnShockwave(p.x,p.y,p.def.accent||'#fff',130,0.3);
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<130){
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*1.5), 'q');
        if(game.enemies.includes(t)) t.stunTimer = Math.max(t.stunTimer||0, 0.8);
      }
    });
    applyParryReward(p);
    shake(5);
    return;
  }
  if(p.shield>0){
    p.shield -= dmg;
    addParticles(p.x,p.y,'#ffcb47',10,150,0.3);
    if(p.shield<0) p.hp += p.shield; // overflow spills onto HP
    p.shield = Math.max(0,p.shield);
    p.invuln = 0.15;
    shake(3);
    return;
  }
  // Escudo de Reacción: once per floor, dropping below 30% HP grants a shield that fully
  // absorbs the very next hit (checked here, before the hit even lands, so it can save you)
  if(p.relics.effect_reactiveShield && !p._reactiveShieldUsedThisFloor && p.hp/p.maxHp < 0.30){
    p._reactiveShieldUsedThisFloor = true;
    p.invuln = 0.4;
    spawnToast('¡Escudo de Reacción! Absorbiste el golpe entero');
    addParticles(p.x,p.y,'#8ec9ff',18,180,0.4);
    shake(5);
    return;
  }
  // Anselm (Peregrino de Piedra): fully immune while petrified, reflects to anything close and has
  // a chance to stun it — checked every hit during the window (not consumed after one, unlike Dorian's)
  if(p.stoneTimer>0){
    addParticles(p.x,p.y,'#9c9c9c',10,140,0.25);
    [...game.enemies, ...bossTargets()].forEach(t=>{
      if(dist(p.x,p.y,t.x,t.y)<90){
        dealDamageToTarget(t, computeDamage(p.def.atk.dmg*0.7), 'q');
        if(game.enemies.includes(t) && Math.random()<0.35) t.stunTimer = Math.max(t.stunTimer||0, 0.5);
      }
    });
    return;
  }
  const wallBonus = (p.effects.wall>0 ? 0.25 : 0) + (p.potionEffects.def>0 ? 0.30 : 0);
  const reduced = dmg*(1-Math.min(0.85,p.armor+wallBonus))*p.curseDmgTakenMult;
  // Reflejo Instantáneo: once per run, a hit that would have killed you instead leaves you at
  // 1 HP and grants a real window of invulnerability to recover
  if(p.relics.effect_instantReflex && !p._instantReflexUsed && (p.hp-reduced)<=0){
    p._instantReflexUsed = true;
    p.hp = 1;
    p.invuln = 1.5;
    spawnToast('¡Reflejo Instantáneo te salvó de la muerte!');
    addParticles(p.x,p.y,'#fff3c4',30,220,0.5);
    shake(10);
    return;
  }
  p.hp -= reduced;
  // Deuda de Sangre: each hit taken also permanently shaves a bit off your max HP
  if(p.relics.effect_bloodDebt){
    const shrink = p.maxHp*0.01;
    p.maxHp = Math.max(20, p.maxHp-shrink);
    p.hp = Math.min(p.hp, p.maxHp);
  }
  p.combo = 0;
  p.invuln = 0.35;
  shake(4);
  // Talismán de Represalia: a chance to hit back everything nearby the instant you get hit
  if(p.relics.effect_thorns && Math.random()<0.20){
    explodeAt(p.x,p.y,110, computeDamage(14), '#c9a878');
  }
  // Escudo Especular (ultimate): while active, every hit is reflected back at the nearest target
  if(p.effects.mirrorShield>0){
    const targets = [...game.enemies, ...bossTargets()];
    let nearest=null, nearestD=Infinity;
    targets.forEach(t=>{ const d=dist(p.x,p.y,t.x,t.y); if(d<nearestD){ nearestD=d; nearest=t; } });
    if(nearest) dealDamageToTarget(nearest, computeDamage(reduced*0.7), 'reflect');
    addParticles(p.x,p.y,'#6ad8ff',10,140,0.3);
  }
}

/* ---------- boss AI ---------- */
// ---- Boss delayed-action scheduler ---------------------------------------------------------
// Companion to the dash engine above, but for non-movement follow-ups: lets a single attack play
// out as "do this now, then a beat later do that" (a warning tremor before a collapse, a return
// volley after the first one, a second wave of spikes) instead of everything resolving in one
// instant call. This is what makes a move read as a real multi-stage sequence rather than one
// flat burst — the same kind of shape guardian attacks already had, now available to any move.
function scheduleBossAction(delay, fn){
  const boss = game.boss;
  if(!boss) return;
  if(!boss.scheduled) boss.scheduled = [];
  boss.scheduled.push({ t:delay, fn });
}
function updateScheduledBossActions(dt){
  const boss = game.boss;
  if(!boss || !boss.scheduled || !boss.scheduled.length) return;
  const remaining = [];
  boss.scheduled.forEach(s=>{
    s.t -= dt;
    if(s.t<=0){ if(game.boss===boss) s.fn(); }
    else remaining.push(s);
  });
  boss.scheduled = remaining;
}

function updateBoss(dt){
  const p = game.player;
  const boss = game.boss;
  const b = arenaBounds();
  boss.hitFlash = Math.max(0,boss.hitFlash-dt);
  boss.shieldTimer = Math.max(0,(boss.shieldTimer||0)-dt);
  if(boss.weakenMarkTimer>0) boss.weakenMarkTimer -= dt; // Cazador (Racha x12) — see dealDamageToTarget
  if(boss.regenTimer>0){
    boss.regenTimer -= dt;
    boss.hp = Math.min(boss.maxHp, boss.hp + (boss.regenPerSec||0)*dt);
  }

  // materializing: boss just appeared, does nothing yet (visual pop-in only)
  if(boss.spawnGrace>0){
    boss.spawnGrace -= dt;
    return;
  }

  if(boss.twin && boss.twin.alive){
    boss.twin.hitFlash = Math.max(0, boss.twin.hitFlash-dt);
    boss.twin.shieldTimer = Math.max(0,(boss.twin.shieldTimer||0)-dt);
    // flies independently in a slow orbit around the player instead of being locked to the main
    // boss's position — this used to snap back every frame, undoing anything twinSwap/attacks did
    const orbitAng = performance.now()/900;
    const tx = clamp(p.x+Math.cos(orbitAng)*170, b.x+40, b.x+b.w-40);
    const ty = clamp(p.y+Math.sin(orbitAng)*170, b.y+40, b.y+b.h-40);
    const twSpeed = 120;
    const dtx = tx-boss.twin.x, dty = ty-boss.twin.y;
    const dtLen = Math.hypot(dtx,dty)||1;
    boss.twin.x = clamp(boss.twin.x+(dtx/dtLen)*twSpeed*dt, b.x+30, b.x+b.w-30);
    boss.twin.y = clamp(boss.twin.y+(dty/dtLen)*twSpeed*dt, b.y+30, b.y+b.h-30);
  }

  boss.contactTimer = Math.max(0,boss.contactTimer-dt);
  boss.attackTimer -= dt;

  if(boss.hp < boss.maxHp*0.5 && boss.phase===1){
    boss.phase=2; boss.def={...boss.def, speed:boss.def.speed*1.15};
    // visual impact of the transition itself — the mechanical escalation (faster attack cadence,
    // bigger pool, shorter telegraphs) already existed below, but the moment it happens had no
    // punch of its own; .boss-hp.enraged (toggled in syncHud) intensifies the bar's fire/lightning
    shake(9);
    addParticles(boss.x, boss.y, '#ff2f2f', 30, 220, 0.55);
    spawnShockwave(boss.x, boss.y, '#ff2f2f', 140, 0.4);
    if(boss.kind==='twinBoss'){
      // at half HP the Twins open their signature mega laser immediately, rather than leaving it
      // to random chance — a clear, telegraphed "things just changed" moment
      boss.forceNextAttack = 'megaLaser';
      spawnToast('¡Las Hermanas Gemelas fusionan su mirada!');
    } else {
      spawnToast(`⚠ ${boss.def.name} entra en furia`);
    }
  }

  if(boss.supernovaActive){
    // El Sol's Colapso Total: a 5-second DPS-check channel. Unlike enrageActive he's NOT
    // invulnerable here — track how much damage lands by comparing hp against the value it
    // was when the channel started, since there's no separate core object to check instead.
    boss.supernovaTimer -= dt;
    const dmgSoFar = boss.supernovaHpStart - boss.hp;
    if(dmgSoFar >= boss.supernovaThreshold){
      finishSunSupernova(boss, true);
    } else if(boss.supernovaTimer<=0){
      finishSunSupernova(boss, false);
    }
    return; // the collapse channel completely overrides his normal movement/attack routine
  }
  if(boss.kind==='abyssLord' && !boss.enrageTriggered && boss.hp <= boss.maxHp*0.10){
    startAbyssEnrage(boss);
  }
  if(boss.enrageActive){
    // Autodestrucción Implacable: a DPS-check desperation phase. He's untouchable and the room
    // itself is burning you — the only way through is breaking the three cooling cores before
    // the timer runs out
    boss.enrageTimer -= dt;
    boss.burnTick = (boss.burnTick||0) - dt;
    const heatProg = clamp(1-boss.enrageTimer/boss.enrageMaxTimer, 0, 1);
    if(boss.burnTick<=0){
      boss.burnTick = 0.5;
      hitPlayer(3+heatProg*10);
      addParticles(p.x,p.y,'#ff6a3d',4,70,0.2);
    }
    boss.sparkTimer = (boss.sparkTimer||0) - dt;
    if(boss.sparkTimer<=0){
      boss.sparkTimer = 0.32;
      const ang = Math.random()*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#ff6a3d', life:2, shape:'ember' });
    }
    const coresAlive = boss.cores ? boss.cores.filter(c=>c.alive).length : 0;
    if(coresAlive===0){
      finishAbyssEnrage(boss, true);
    } else if(boss.enrageTimer<=0){
      finishAbyssEnrage(boss, false);
    }
    return; // the supernova channel completely overrides her normal movement/attack routine
  }
  if(boss.stunTimer>0){
    boss.stunTimer -= dt;
    return; // stunned and fully vulnerable — this is the punish window after breaking all cores
  }

  if(boss.cageActive){
    // crystalCage's aftermath: keep raining shards on the boxed-in player until either the
    // weak wall breaks (escape) or the cage's own clock runs out
    boss.cageTimer -= dt;
    boss.cageShardTimer -= dt;
    if(boss.cageShardTimer<=0){
      boss.cageShardTimer = 0.4;
      const ang = Math.atan2(p.y-boss.cageCY, p.x-boss.cageCX);
      const n=5;
      for(let i=0;i<n;i++){
        const a = ang + (i-(n-1)/2)*0.14;
        spawnProjectile({ x:boss.cageCX,y:boss.cageCY, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#e8e8f5', life:1.3, shape:'shard' });
      }
    }
    const wallBroken = boss.cageWallCore && !boss.cageWallCore.alive;
    if(wallBroken || boss.cageTimer<=0){
      boss.cageActive = false;
      spawnToast(wallBroken ? '¡Rompiste el cristal y escapaste a tiempo!' : 'Los cristales se disuelven');
    }
  }

  if(boss.iceSlideActive){
    // Pista de Escarcha Glacial: periodic gusts of ice shards sweep in from one edge while the
    // floor keeps the player sliding around (handled in the player movement code)
    boss.iceSlideTimer -= dt;
    boss.slideGustTimer -= dt;
    if(boss.slideGustTimer<=0){
      boss.slideGustTimer = 1.1;
      const vertical = Math.random()<0.5;
      const n=8;
      for(let i=0;i<n;i++){
        const frac = i/(n-1);
        let sx,sy,vx,vy;
        if(vertical){ sx=b.x-20; sy=b.y+frac*b.h; vx=340; vy=0; }
        else { sx=b.x+frac*b.w; sy=b.y-20; vx=0; vy=340; }
        spawnProjectile({ x:sx,y:sy, vx,vy, dmg:boss.dmg*0.3, radius:9, owner:'enemy', color:'#c8ecff', life:2.6, shape:'shard' });
      }
    }
    if(boss.iceSlideTimer<=0) boss.iceSlideActive = false;
  }

  if(boss.blizzardActive){
    // Cero Absoluto: standing still fills the freeze meter, moving drains it — hit 100% and
    // you're locked in ice for a few seconds, taking steady damage until it breaks
    boss.blizzardTimer -= dt;
    const pSpeedNow = Math.hypot(p.x-(boss.lastPX!==undefined?boss.lastPX:p.x), p.y-(boss.lastPY!==undefined?boss.lastPY:p.y))/Math.max(dt,0.0001);
    boss.lastPX = p.x; boss.lastPY = p.y;
    if(p.frozenTimer<=0){
      if(pSpeedNow < 40) p.freezeMeter = Math.min(100,(p.freezeMeter||0)+dt*30);
      else p.freezeMeter = Math.max(0,(p.freezeMeter||0)-dt*45);
      if(p.freezeMeter>=100){
        p.frozenTimer = 3;
        p.freezeMeter = 0;
        spawnToast('¡Quedaste atrapado en un bloque de hielo! Presioná WASD para romperlo');
        shake(6);
      }
    }
    boss.blizzardGustTimer -= dt;
    if(boss.blizzardGustTimer<=0){
      boss.blizzardGustTimer = 1.15;
      const vertical = Math.random()<0.5;
      const n=7;
      for(let i=0;i<n;i++){
        const frac = i/(n-1);
        let sx,sy,vx,vy;
        if(vertical){ sx=b.x-20; sy=b.y+frac*b.h; vx=300; vy=0; }
        else { sx=b.x+frac*b.w; sy=b.y-20; vx=0; vy=300; }
        spawnProjectile({ x:sx,y:sy, vx,vy, dmg:boss.dmg*0.26, radius:8, owner:'enemy', color:'#c8ecff', life:2.6, shape:'wisp' });
      }
    }
    if(boss.blizzardTimer<=0) boss.blizzardActive = false;
  }

  if(boss.dandelionActive){
    boss.dandelionTimer -= dt;
    boss.dandelionX += boss.dandelionVX*dt;
    boss.dandelionSeedTimer -= dt;
    if(boss.dandelionSeedTimer<=0){
      boss.dandelionSeedTimer = 0.55;
      const seedSpeed = 110, seedLife = 2.0;
      const travel = seedSpeed*seedLife; // exact distance the seed projectile actually covers before it expires
      const angs=[Math.PI/4, Math.PI-Math.PI/4];
      // each seed gets its OWN landing hazard at the end of ITS OWN path — previously both hazards
      // were placed using only the first angle, so the left-diagonal seed had nothing waiting for it
      angs.forEach(ang=>{
        spawnProjectile({ x:boss.dandelionX,y:boss.dandelionY, vx:Math.cos(ang)*seedSpeed, vy:Math.sin(ang)*seedSpeed,
          dmg:boss.dmg*0.32, radius:7, owner:'enemy', color:'#fff08a', life:seedLife, shape:'wisp' });
        const landX = clamp(boss.dandelionX + Math.cos(ang)*travel, b.x+30,b.x+b.w-30);
        const landY = clamp(boss.dandelionY + Math.sin(ang)*travel, b.y+30,b.y+b.h-30);
        game.hazards.push({ x:landX-16, y:landY, r:18, type:'light', telegraph:1.1, active:0.4, tick:0, dmg:boss.dmg*0.3 });
        game.hazards.push({ x:landX+16, y:landY, r:18, type:'light', telegraph:1.1, active:0.4, tick:0, dmg:boss.dmg*0.3 });
      });
    }
    if(boss.dandelionTimer<=0 || boss.dandelionX < b.x-60 || boss.dandelionX > b.x+b.w+60) boss.dandelionActive=false;
  }

  if(boss.canopyActive){
    boss.canopyTimer -= dt;
    boss.canopySwitchTimer -= dt;
    if(boss.canopySwitchTimer<=0){
      boss.canopySwitchTimer = 1.6;
      boss.canopyPhase = boss.canopyPhase===0 ? 1 : 0;
      const lanes=4;
      for(let i=0;i<lanes;i++){
        if(i%2 !== boss.canopyPhase) continue;
        const laneX = b.x + b.w*((i+0.5)/lanes);
        const rows=5;
        for(let r=0;r<rows;r++){
          const ly = b.y+30 + (b.h-60)*(r/(rows-1));
          game.hazards.push({ x:laneX, y:ly, r:34, type:'light', telegraph:0.4, active:1.3, tick:0, dmg:boss.dmg*0.32 });
        }
      }
    }
    if(boss.canopyTimer<=0) boss.canopyActive=false;
  }

  if(boss.circuitActive){
    boss.circuitTimer -= dt;
    if(boss.circuitTimer<=0){
      boss.circuitTimer = 1.3;
      const panels=5;
      const laneX = b.x + b.w*((boss.circuitIndex+0.5)/panels);
      const rows=6;
      for(let r=0;r<rows;r++){
        const ly = b.y+30 + (b.h-60)*(r/(rows-1));
        game.hazards.push({ x:laneX, y:ly, r:(b.w/panels)*0.48, type:'storm', telegraph:0.9, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      boss.circuitIndex = (boss.circuitIndex+1)%panels;
      boss.circuitCycles--;
      if(boss.circuitCycles<=0) boss.circuitActive=false;
    }
  }

  if(boss.polarityActive){
    boss.polarityTimer -= dt;
    boss.polarityPhaseTimer -= dt;
    if(boss.polarityPhaseTimer<=0){
      boss.polarityPhaseTimer = 2.2;
      boss.polarityPhase = boss.polarityPhase==='attract' ? 'repel' : 'attract';
      spawnToast(boss.polarityPhase==='attract' ? 'El campo te atrae hacia el jefe' : 'El campo te repele con fuerza');
    }
    const pullSpeed = 70;
    const angToBoss = Math.atan2(boss.y-p.y, boss.x-p.x);
    const dirP = boss.polarityPhase==='attract' ? 1 : -1;
    p.x = clamp(p.x + Math.cos(angToBoss)*pullSpeed*dirP*dt, b.x+p.radius, b.x+b.w-p.radius);
    p.y = clamp(p.y + Math.sin(angToBoss)*pullSpeed*dirP*dt, b.y+p.radius, b.y+b.h-p.radius);
    boss.polarityOrbTimer -= dt;
    if(boss.polarityOrbTimer<=0){
      boss.polarityOrbTimer = 0.6;
      const ang = Math.random()*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*95, vy:Math.sin(ang)*95,
        dmg:boss.dmg*0.4, radius:9, owner:'enemy', color:boss.def.color, life:3, shape:'orb' });
    }
    if(boss.polarityTimer<=0) boss.polarityActive=false;
  }

  if(boss.barrierActive){
    boss.barrierTimer -= dt;
    boss.barrierLeftX = Math.min(boss.barrierLeftX + boss.barrierCloseSpeed*dt, b.x+b.w/2-40);
    boss.barrierRightX = Math.max(boss.barrierRightX - boss.barrierCloseSpeed*dt, b.x+b.w/2+40);
    const coreAlive = boss.barrierCore && boss.barrierCore.alive;
    if(coreAlive){
      boss.barrierCore.x = boss.barrierWeakSide==='left' ? boss.barrierLeftX : boss.barrierRightX;
      boss.barrierCore.y = p.y;
    }
    const leftDisabled = boss.barrierWeakSide==='left' && !coreAlive;
    const rightDisabled = boss.barrierWeakSide==='right' && !coreAlive;
    boss.barrierTick = (boss.barrierTick||0)-dt;
    if(boss.barrierTick<=0){
      boss.barrierTick=0.3;
      if(!leftDisabled && Math.abs(p.x-boss.barrierLeftX)<26) hitPlayer(boss.dmg*0.55);
      if(!rightDisabled && Math.abs(p.x-boss.barrierRightX)<26) hitPlayer(boss.dmg*0.55);
    }
    if(boss.barrierTimer<=0 || boss.barrierRightX-boss.barrierLeftX < 90) boss.barrierActive=false;
  }

  if(boss.singularityActive){
    boss.singularityTimer -= dt;
    const cx=boss.singularityCX, cy=boss.singularityCY;
    const dxPrev = p.x-(boss.singLastPX!==undefined?boss.singLastPX:p.x);
    const dyPrev = p.y-(boss.singLastPY!==undefined?boss.singLastPY:p.y);
    boss.singLastPX=p.x; boss.singLastPY=p.y;
    const towardX = cx-p.x, towardY = cy-p.y;
    const movedTowards = (dxPrev*towardX + dyPrev*towardY) > 0;
    const moveLen = Math.hypot(dxPrev,dyPrev);
    if(moveLen>0.05){
      const boost = movedTowards ? 1.0 : -0.55;
      p.x = clamp(p.x + dxPrev*boost, b.x+p.radius, b.x+b.w-p.radius);
      p.y = clamp(p.y + dyPrev*boost, b.y+p.radius, b.y+b.h-p.radius);
    }
    boss.singularityWaveTimer -= dt;
    if(boss.singularityWaveTimer<=0){
      boss.singularityWaveTimer=0.9;
      const n=16;
      const rr = 70 + (boss.singularityWaveIndex||0)*55;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        game.hazards.push({ x:clamp(cx+Math.cos(ang)*rr,b.x+16,b.x+b.w-16), y:clamp(cy+Math.sin(ang)*rr,b.y+16,b.y+b.h-16),
          r:20, type:'void', telegraph:0.5, active:0.4, tick:0, dmg:boss.dmg*0.32 });
      }
      boss.singularityWaveIndex = ((boss.singularityWaveIndex||0)+1)%5;
    }
    if(boss.singularityTimer<=0) boss.singularityActive=false;
  }

  if(boss.gravityFlipActive){
    boss.gravityFlipTimer -= dt;
    boss.gravityFlipBeamX += boss.gravityFlipBeamVX*dt;
    if(Math.abs(p.x-boss.gravityFlipBeamX)<20){
      boss.gravityFlipTick=(boss.gravityFlipTick||0)-dt;
      if(boss.gravityFlipTick<=0){ boss.gravityFlipTick=0.3; hitPlayer(boss.dmg*0.4); }
    }
    if(boss.gravityFlipTimer<=0 || boss.gravityFlipBeamX<b.x-40 || boss.gravityFlipBeamX>b.x+b.w+40) boss.gravityFlipActive=false;
  }

  if(boss.crackActive){
    boss.crackTimer -= dt;
    if(boss.crackTimer<=0){
      boss.crackTimer=1.6;
      game.hazards.push({ x:p.x, y:p.y, r:44, type:'void', telegraph:1.5, active:3.2, tick:0, dmg:boss.dmg*0.85 });
      boss.crackRemaining--;
      if(boss.crackRemaining<=0) boss.crackActive=false;
    }
  }

  if(boss.pulseActive){
    boss.pulseTimer -= dt;
    if(boss.pulseTimer<=0){
      boss.pulseTimer=0.85;
      const n=14;
      const rr = 90 + (boss.pulseWave||0)*70;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        const diff = Math.abs(((ang-boss.pulseGapAngle+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI);
        if(diff < 0.45) continue;
        game.hazards.push({ x:clamp(boss.x+Math.cos(ang)*rr,b.x+16,b.x+b.w-16), y:clamp(boss.y+Math.sin(ang)*rr,b.y+16,b.y+b.h-16),
          r:22, type:'void', telegraph:0.35, active:0.4, tick:0, dmg:boss.dmg*0.36 });
      }
      boss.pulseGapAngle += 0.9;
      boss.pulseWave = (boss.pulseWave||0)+1;
      boss.pulseRemaining--;
      if(boss.pulseRemaining<=0) boss.pulseActive=false;
    }
  }

  if(boss.movers && boss.movers.length){
    // shared system for anything that physically travels across the arena: rolling boulders,
    // drifting ice walls — breakable ones (isCore) can be smashed early via normal attacks
    boss.movers.forEach(mv=>{
      if(!mv.alive) return;
      if(mv.spawnDelay>0){ mv.spawnDelay -= dt; return; }
      mv.x += mv.vx*dt; mv.y += mv.vy*dt;
      mv.hitFlash = Math.max(0,(mv.hitFlash||0)-dt);
      if(mv.x < b.x-70 || mv.x > b.x+b.w+70 || mv.y < b.y-70 || mv.y > b.y+b.h+70){ mv.alive=false; return; }
      mv.tick = (mv.tick||0)-dt;
      if(dist(mv.x,mv.y,p.x,p.y) < mv.radius+p.radius && mv.tick<=0){
        mv.tick = 0.5;
        hitPlayer(mv.dmg);
        addParticles(p.x,p.y,'#c8ecff',10,140,0.25);
        shake(4);
      }
    });
    boss.movers = boss.movers.filter(mv=>mv.alive);
  }

  // dash-type attacks (charge, echoDash, etc.) now travel over real time instead of teleporting —
  // see startBossDash/updateBossDashes above. While one is in flight it fully owns boss.x/boss.y,
  // so the normal chase movement below has to stand down or it would fight the dash every frame.
  updateBossDashes(dt);
  updateScheduledBossActions(dt);
  const isDashing = !!(boss.dashes && boss.dashes.length);

  // movement: approach player unless telegraphing
  if(!boss.telegraph && !isDashing){
    const d = dist(boss.x,boss.y,p.x,p.y);
    if(boss.hover){
      const desired = 300;
      if(d>desired+50){
        const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
        boss.x += Math.cos(ang)*boss.def.speed*dt;
        boss.y += Math.sin(ang)*boss.def.speed*dt;
      } else if(d<desired-50){
        const ang = Math.atan2(boss.y-p.y,boss.x-p.x);
        boss.x += Math.cos(ang)*boss.def.speed*dt;
        boss.y += Math.sin(ang)*boss.def.speed*dt;
      } else {
        const ang = Math.atan2(p.y-boss.y,p.x-boss.x) + Math.PI/2;
        boss.x += Math.cos(ang)*boss.def.speed*0.55*dt;
        boss.y += Math.sin(ang)*boss.def.speed*0.55*dt;
      }
      boss.petalTimer -= dt;
      if(boss.petalTimer<=0){
        boss.petalTimer = 0.1;
        const ang = Math.random()*Math.PI*2;
        game.particles.push({ x:boss.x+Math.cos(ang)*boss.radius, y:boss.y+Math.sin(ang)*boss.radius,
          vx:rand(-14,14), vy:22, life:1.1, maxLife:1.1, color:'#ffd6f0', r:rand(1.5,3), type:'circle' });
      }
    } else if(d>90){
      const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
      boss.x += Math.cos(ang)*boss.def.speed*dt;
      boss.y += Math.sin(ang)*boss.def.speed*dt;
    } else {
      // too close to approach further — back off a little or circle-strafe instead of standing
      // completely still, which made some kits (all close-range/self attacks, no repositioning
      // move) feel like the boss never moved at all
      if(d<50){
        const ang = Math.atan2(boss.y-p.y,boss.x-p.x);
        boss.x += Math.cos(ang)*boss.def.speed*0.6*dt;
        boss.y += Math.sin(ang)*boss.def.speed*0.6*dt;
      } else {
        const ang = Math.atan2(p.y-boss.y,p.x-boss.x) + Math.PI/2*(boss.strafeDir||1);
        boss.x += Math.cos(ang)*boss.def.speed*0.5*dt;
        boss.y += Math.sin(ang)*boss.def.speed*0.5*dt;
      }
      // contact damage only when actually touching (radius overlap + a small buffer, same as
      // every other boss attack's hitbox) — this used to fire off the flat d<=90 bucket above,
      // which is much bigger than most bosses' actual radius, so it could hit the player from a
      // visible gap and feel like getting hurt without touching the boss at all
      if(boss.contactTimer<=0 && d <= boss.radius+p.radius+14){
        boss.contactTimer = boss.def.contactCd;
        hitPlayer(boss.dmg*0.6);
      }
    }
  }
  boss.x = clamp(boss.x, b.x+boss.radius, b.x+b.w-boss.radius);
  boss.y = clamp(boss.y, b.y+boss.radius, b.y+b.h-boss.radius);

  // telegraph resolution
  if(boss.telegraph){
    if(boss.telegraph.type==='boneGrab'){
      // wind pulls the player toward the boss from anywhere in the room, growing stronger the
      // longer it goes on — this never ends on a clock. It only stops when you reach the safe
      // pocket (you're spared) or the wind drags you into the boss (you get hit)
      const tgG = boss.telegraph;
      tgG.elapsed = (tgG.elapsed||0)+dt;
      const inSafeZone = tgG.safeX!==undefined && dist(tgG.safeX,tgG.safeY,p.x,p.y) < tgG.safeR;
      const dGrab = dist(boss.x,boss.y,p.x,p.y);
      if(inSafeZone){
        tgG.t = -1; // reached the calm pocket — resolve now as a success, don't wait around
      } else if(dGrab<=boss.radius+p.radius+10){
        tgG.t = -1; // dragged all the way in — resolve now as a hit
      } else if(tgG.elapsed > 12){
        tgG.t = -1; // hard safety net, should never realistically be reached
      } else {
        const prog = clamp(tgG.elapsed/(tgG.rampDur||3.2), 0, 1); // 0 -> 1 as the pull intensifies, then holds
        const pullSpeed = 25 + prog*150;
        const ang = Math.atan2(boss.y-p.y, boss.x-p.x);
        p.x = clamp(p.x+Math.cos(ang)*pullSpeed*dt, b.x+p.radius, b.x+b.w-p.radius);
        p.y = clamp(p.y+Math.sin(ang)*pullSpeed*dt, b.y+p.radius, b.y+b.h-p.radius);
        if(Math.random()<0.4) addParticles(p.x,p.y,boss.def.color,2,60,0.25);
      }
    } else if(boss.telegraph.type==='gravityWell'){
      // unlike boneGrab, this pulls toward a FIXED point in space that stays put even if the boss moves
      const wx = boss.telegraph.tx, wy = boss.telegraph.ty;
      const dWell = dist(wx,wy,p.x,p.y);
      if(dWell>18){
        const prog = 1 - clamp(boss.telegraph.t/boss.telegraph.dur,0,1);
        const pullSpeed = 20 + prog*95;
        const ang = Math.atan2(wy-p.y, wx-p.x);
        p.x = clamp(p.x+Math.cos(ang)*pullSpeed*dt, b.x+p.radius, b.x+b.w-p.radius);
        p.y = clamp(p.y+Math.sin(ang)*pullSpeed*dt, b.y+p.radius, b.y+b.h-p.radius);
        if(Math.random()<0.4) addParticles(p.x,p.y,boss.def.color,2,50,0.25);
      }
    } else if(boss.telegraph.type==='megaLaser'){
      // the beam sweeps continuously across its arc — dodging means getting ahead of the sweep
      // and staying clear, not just sidestepping once. Two beams (main + twin) cross if she's
      // still alive, cutting the safe pockets down further
      const tgL = boss.telegraph;
      const elapsed = tgL.dur - tgL.t;
      const checkBeam = (originX, originY, startAngle)=>{
        if(elapsed <= tgL.hotAt) return; // still in the warning-preview window, not burning yet
        const sweepProg = clamp((elapsed-tgL.hotAt)/(tgL.dur-tgL.hotAt), 0, 1);
        const curAngle = startAngle + tgL.sweepDir*tgL.sweepArc*sweepProg;
        const angToPlayer = Math.atan2(p.y-originY, p.x-originX);
        const diff = Math.abs(((angToPlayer-curAngle+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI);
        const dToPlayer = dist(originX,originY,p.x,p.y);
        if(diff < 0.1 && dToPlayer < tgL.beamLen){
          tgL.tick = (tgL.tick||0) - dt;
          if(tgL.tick<=0){
            hitPlayer(boss.dmg*0.42);
            tgL.tick = 0.15;
            addParticles(p.x,p.y,'#ff3d3d',8,120,0.25);
            shake(2);
          }
        }
      };
      checkBeam(boss.x, boss.y, tgL.startAngle);
      if(boss.twin && boss.twin.alive && tgL.twinStartAngle!==undefined){
        checkBeam(boss.twin.x, boss.twin.y, tgL.twinStartAngle);
      }
    } else if(boss.telegraph.type==='plasmaBeam' || boss.telegraph.type==='dawnBeam' || boss.telegraph.type==='voidBeam'){
      // the beam translates straight across the arena from one edge toward the other — dodging
      // means getting to (and staying on) the side it's already passed, not a quick sidestep
      const tgB = boss.telegraph;
      const elapsed = tgB.dur - tgB.t;
      if(elapsed > tgB.hotAt){
        // the beam only travels 3/4 of the arena from the edge it charged on, always leaving a
        // safe strip on the far side — previously it swept edge-to-edge with nowhere safe to stand
        const sweepLimit = 0.75;
        const sweepProg = clamp((elapsed-tgB.hotAt)/(tgB.dur-tgB.hotAt), 0, 1)*sweepLimit;
        let beamPos;
        if(tgB.vertical){
          beamPos = tgB.fromStart ? b.x+sweepProg*b.w : b.x+b.w-sweepProg*b.w;
          tgB.curPos = beamPos;
          if(Math.abs(p.x-beamPos) < 32){
            tgB.tick = (tgB.tick||0)-dt;
            if(tgB.tick<=0){ hitPlayer(boss.dmg*0.5); tgB.tick=0.15; addParticles(p.x,p.y,'#ff6a3d',10,140,0.25); shake(3); }
          }
        } else {
          beamPos = tgB.fromStart ? b.y+sweepProg*b.h : b.y+b.h-sweepProg*b.h;
          tgB.curPos = beamPos;
          if(Math.abs(p.y-beamPos) < 32){
            tgB.tick = (tgB.tick||0)-dt;
            if(tgB.tick<=0){ hitPlayer(boss.dmg*0.5); tgB.tick=0.15; addParticles(p.x,p.y,'#ff6a3d',10,140,0.25); shake(3); }
          }
        }
      }
    } else if(boss.telegraph.type==='geoSweep'){
      // El Sol's Barrido de Plasma Geomagnético: two parallel vertical walls of magenta plasma
      // sweep across together with a gap between them — dodge by dashing through the gap in
      // time, or by staying ahead of the sweep on the safe far side (same 3/4 sweepLimit idea
      // as the single-wall beam above, just doubled).
      const tgG = boss.telegraph;
      const elapsedG = tgG.dur - tgG.t;
      if(elapsedG > tgG.hotAt){
        const sweepLimit = 0.75;
        const sweepProg = clamp((elapsedG-tgG.hotAt)/(tgG.dur-tgG.hotAt), 0, 1)*sweepLimit;
        const centerPos = tgG.fromStart ? b.x+sweepProg*b.w : b.x+b.w-sweepProg*b.w;
        const gapHalf = tgG.gap/2;
        tgG.curPos = centerPos;
        const leftWall = centerPos - gapHalf, rightWall = centerPos + gapHalf;
        if(Math.abs(p.x-leftWall) < 26 || Math.abs(p.x-rightWall) < 26){
          tgG.tick = (tgG.tick||0)-dt;
          if(tgG.tick<=0){ hitPlayer(boss.dmg*0.55); tgG.tick=0.15; addParticles(p.x,p.y,'#ff2fd6',12,150,0.25); shake(3); }
        }
      }
    } else if(boss.telegraph.type==='stormSpiral'){
      // Espiral de Tormenta Estelar: a channeled spiral of magenta/cyan bolts, spinning faster
      // and firing denser the lower El Sol's HP gets — the fight visibly escalates as it goes on
      const tgS2 = boss.telegraph;
      const elapsedS2 = tgS2.dur - tgS2.t;
      if(elapsedS2 > tgS2.hotAt){
        const hpFrac = clamp(boss.hp/boss.maxHp, 0, 1);
        const intensity = 1 + (1-hpFrac)*0.9; // up to ~1.9x faster/denser at low HP
        tgS2.spiralAngle += dt*2.6*intensity;
        tgS2.spiralTick -= dt;
        if(tgS2.spiralTick<=0){
          tgS2.spiralTick = 0.13/intensity;
          const arms=5;
          const speedS2=110*intensity;
          for(let i=0;i<arms;i++){
            const ang = tgS2.spiralAngle + (i/arms)*Math.PI*2;
            const travelS2 = rayToBounds(boss.x,boss.y,ang,b);
            const col = i%2===0 ? '#ff2fd6' : '#33e5ff';
            spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speedS2, vy:Math.sin(ang)*speedS2,
              dmg:boss.dmg*0.26, radius:6, owner:'enemy', color:col, life:travelS2/speedS2+0.5, shape:'wisp' });
          }
        }
      }
    } else if(boss.telegraph.type==='eruptionConvergence'){
      // just a bright channel visual while he "canaliza energía, poniéndose blanco brillante" —
      // the actual 6-point convergence fires all at once in resolveBossAttack when this ends
    } else if(boss.telegraph.type==='solarSporeSpiral'){
      const tgS = boss.telegraph;
      const elapsedS = tgS.dur - tgS.t;
      if(elapsedS > tgS.hotAt){
        tgS.spiralAngle += dt*2.0;
        tgS.spiralTick -= dt;
        if(tgS.spiralTick<=0){
          tgS.spiralTick = 0.14;
          const arms=4;
          const speedS=95;
          for(let i=0;i<arms;i++){
            const ang = tgS.spiralAngle + (i/arms)*Math.PI*2;
            // life used to be a flat 3.4s, which fizzled out well short of the wall on most arena
            // sizes — now it's however long it actually takes to travel to the wall (plus a small
            // buffer so it visibly crosses it) so the spiral always fills the whole room
            const travelS = rayToBounds(boss.x,boss.y,ang,b);
            spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speedS, vy:Math.sin(ang)*speedS,
              dmg:boss.dmg*0.3, radius:7, owner:'enemy', color:'#ffe08a', life:travelS/speedS+0.5, shape:'wisp' });
          }
        }
      }
    } else if(boss.telegraph.type==='lightDeluge'){
      // a rotating "flower" that blooms outward — a dense, classic bullet-hell radial pattern
      const tgLD = boss.telegraph;
      const elapsedLD = tgLD.dur - tgLD.t;
      if(elapsedLD > tgLD.hotAt){
        tgLD.delugeAngle += dt*1.1;
        tgLD.delugeTick -= dt;
        if(tgLD.delugeTick<=0){
          tgLD.delugeTick = 0.22;
          const arms=10, speedLD=130;
          for(let i=0;i<arms;i++){
            const ang = tgLD.delugeAngle + (i/arms)*Math.PI*2;
            const travelLD = rayToBounds(boss.x,boss.y,ang,b);
            spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speedLD, vy:Math.sin(ang)*speedLD,
              dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#ffb0d9', life:travelLD/speedLD+0.5, shape:'wisp' });
          }
        }
      }
    } else if(boss.telegraph.type==='prismaticCascade'){
      // horizontal rows of light falling from the top, each with one safe gap that shifts wave
      // to wave — a straightforward "curtain fall" bullet-hell pattern
      const tgPC = boss.telegraph;
      const elapsedPC = tgPC.dur - tgPC.t;
      if(elapsedPC > tgPC.hotAt){
        tgPC.cascadeTick -= dt;
        if(tgPC.cascadeTick<=0){
          tgPC.cascadeTick = 0.7;
          tgPC.gapX = b.x + 70 + Math.random()*(b.w-140);
          const speedPC=150, n=13;
          for(let i=0;i<n;i++){
            const x = b.x + b.w*((i+0.5)/n);
            if(Math.abs(x-tgPC.gapX) < 55) continue; // the one column you can stand in this wave
            spawnProjectile({ x, y:b.y+8, vx:0, vy:speedPC, dmg:boss.dmg*0.3, radius:7, owner:'enemy',
              color:'#ffe6a0', life:(b.h/speedPC)+0.5, shape:'ember' });
          }
        }
      }
    } else if(boss.telegraph.type==='radiantMandala'){
      // two concentric rings turning opposite ways — classic mandala bullet-hell pattern
      const tgM = boss.telegraph;
      const elapsedM = tgM.dur - tgM.t;
      if(elapsedM > tgM.hotAt){
        tgM.mandalaAngleA += dt*1.4;
        tgM.mandalaAngleB -= dt*1.0;
        tgM.mandalaTick -= dt;
        if(tgM.mandalaTick<=0){
          tgM.mandalaTick = 0.42;
          const speedA=115, speedB=85, ringsA=8, ringsB=10;
          for(let i=0;i<ringsA;i++){
            const ang = tgM.mandalaAngleA + (i/ringsA)*Math.PI*2;
            const travelA = rayToBounds(boss.x,boss.y,ang,b);
            spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speedA, vy:Math.sin(ang)*speedA,
              dmg:boss.dmg*0.26, radius:5, owner:'enemy', color:'#ffd6f0', life:travelA/speedA+0.5, shape:'shard' });
          }
          for(let i=0;i<ringsB;i++){
            const ang = tgM.mandalaAngleB + (i/ringsB)*Math.PI*2;
            const travelB = rayToBounds(boss.x,boss.y,ang,b);
            spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speedB, vy:Math.sin(ang)*speedB,
              dmg:boss.dmg*0.26, radius:5, owner:'enemy', color:'#c9a8ff', life:travelB/speedB+0.5, shape:'shard' });
          }
        }
      }
    } else if(boss.telegraph.type==='pincerScan'){
      const tgP = boss.telegraph;
      boss.x = b.x+60; boss.y = b.y+100;
      if(boss.twin && boss.twin.alive){ boss.twin.x = b.x+b.w-60; boss.twin.y = b.y+100; }
      const elapsedP = tgP.dur - tgP.t;
      if(elapsedP > tgP.hotAt){
        const prog2 = clamp((elapsedP-tgP.hotAt)/(tgP.dur-tgP.hotAt),0,1);
        tgP.laserY = b.y+40 + prog2*(b.h-80);
        if(Math.abs(p.y-tgP.laserY)<24){
          tgP.tick=(tgP.tick||0)-dt;
          if(tgP.tick<=0){ tgP.tick=0.15; hitPlayer(boss.dmg*0.4); }
        }
        tgP.waveTimer -= dt;
        if(tgP.waveTimer<=0 && boss.twin && boss.twin.alive){
          tgP.waveTimer=0.85;
          spawnProjectile({ x:boss.twin.x,y:boss.twin.y+90, vx:-140, vy:0, dmg:boss.dmg*0.4, radius:9, owner:'enemy', color:boss.def.color, life:3.5, shape:'orb' });
        }
      }
    } else if(boss.telegraph.type==='orbitalCross'){
      const tgO = boss.telegraph;
      tgO.orbitAngle += dt*1.6;
      const orbBX = clamp(tgO.orbitCX + Math.cos(tgO.orbitAngle)*tgO.orbitR, b.x+boss.radius, b.x+b.w-boss.radius);
      const orbBY = clamp(tgO.orbitCY + Math.sin(tgO.orbitAngle)*tgO.orbitR, b.y+boss.radius, b.y+b.h-boss.radius);
      const orbTX = clamp(tgO.orbitCX + Math.cos(tgO.orbitAngle+Math.PI)*tgO.orbitR, b.x+(boss.twin?boss.twin.radius:boss.radius), b.x+b.w-(boss.twin?boss.twin.radius:boss.radius));
      const orbTY = clamp(tgO.orbitCY + Math.sin(tgO.orbitAngle+Math.PI)*tgO.orbitR, b.y+(boss.twin?boss.twin.radius:boss.radius), b.y+b.h-(boss.twin?boss.twin.radius:boss.radius));
      const elapsedO = tgO.dur - tgO.t;
      // ease onto the orbit path over hotAt seconds instead of snapping there instantly
      const easeIn = clamp(elapsedO/tgO.hotAt, 0, 1);
      boss.x = tgO.orbitStartBX + (orbBX-tgO.orbitStartBX)*easeIn;
      boss.y = tgO.orbitStartBY + (orbBY-tgO.orbitStartBY)*easeIn;
      if(boss.twin && boss.twin.alive){
        boss.twin.x = tgO.orbitStartTX + (orbTX-tgO.orbitStartTX)*easeIn;
        boss.twin.y = tgO.orbitStartTY + (orbTY-tgO.orbitStartTY)*easeIn;
      }
      if(elapsedO > tgO.hotAt){
        tgO.orbitFireTimer -= dt;
        if(tgO.orbitFireTimer<=0){
          tgO.orbitFireTimer=0.85;
          const mainBottom = Math.sin(tgO.orbitAngle) > 0;
          if(mainBottom){
            spawnProjectile({ x:boss.x,y:boss.y, vx:0, vy:220, dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
          } else if(boss.twin && boss.twin.alive){
            [-0.35,0,0.35].forEach(off=>{
              spawnProjectile({ x:boss.twin.x,y:boss.twin.y, vx:Math.cos(Math.PI/2+off)*180, vy:Math.sin(Math.PI/2+off)*180,
                dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:'#ff9ad1', life:2, shape:'wisp' });
            });
          }
        }
      }
    } else if(boss.telegraph.type==='desperateRush'){
      const tgD = boss.telegraph;
      const elapsedD = tgD.dur - tgD.t;
      if(elapsedD < tgD.hotAt){ tgD.lockX = p.x; tgD.lockY = p.y; }
    } else if(boss.telegraph.type==='energyBond'){
      const tgE = boss.telegraph;
      const elapsedE = tgE.dur - tgE.t;
      if(elapsedE > tgE.hotAt){
        const advSpeed = 55;
        // move as a pair around a shared center so the gap between the two eyes never collapses
        // at the walls (previously each eye clamped independently, which could squash them together)
        tgE.bondCenterX = clamp(tgE.bondCenterX + tgE.bondDir*advSpeed*dt, b.x+tgE.bondGap/2+20, b.x+b.w-tgE.bondGap/2-20);
        boss.x = tgE.bondCenterX - tgE.bondGap/2;
        if(boss.twin && boss.twin.alive){
          boss.twin.x = tgE.bondCenterX + tgE.bondGap/2;
          boss.twin.y = boss.y;
        }
        tgE.bondGapY = clamp(tgE.bondGapY + Math.sin(elapsedE*2.1)*90*dt, b.y+70, b.y+b.h-70);
        const hasTwinE = boss.twin && boss.twin.alive;
        const withinCable = hasTwinE ? (p.x > boss.x-26 && p.x < boss.twin.x+26) : Math.abs(p.x-boss.x)<26;
        if(withinCable && Math.abs(p.y-tgE.bondGapY)>75){
          tgE.tick=(tgE.tick||0)-dt;
          if(tgE.tick<=0){ tgE.tick=0.2; hitPlayer(boss.dmg*0.45); }
        }
      } else if(boss.twin && boss.twin.alive){
        boss.twin.y = boss.y;
      }
    } else if(boss.telegraph.type==='predictiveLightning'){
      const tgL2 = boss.telegraph;
      const elapsedL2 = tgL2.dur - tgL2.t;
      if(elapsedL2 < tgL2.hotAt){ tgL2.lockX += (p.x-tgL2.lockX)*Math.min(1,dt*4); }
    }
    boss.telegraph.t -= dt;
    if(boss.telegraph.t<=0){
      game._echoProjectiles = true; // boss attacks fire roughly double the projectiles — see spawnProjectile
      game._guardianAttack = !!boss.isGuardian; // guardians' projectiles fly faster — see spawnProjectile
      const hazardsBefore = game.hazards.length;
      resolveBossAttack(boss.telegraph.type, boss.telegraph);
      if(boss.isGuardian){
        // same idea as the projectile speed boost, but for ground hazards: less warning before
        // the ground actually hurts you
        for(let hi=hazardsBefore; hi<game.hazards.length; hi++){
          if(game.hazards[hi].telegraph) game.hazards[hi].telegraph *= 0.8;
        }
      }
      game._echoProjectiles = false;
      game._guardianAttack = false;
      boss.telegraph=null;
      // the cooldown to the NEXT attack starts now, after this one has fully resolved — previously
      // it ran concurrently with the wind-up itself, so the boss barely got any time to actually
      // move between attacks (worse the deeper the run, since wind-up stayed fixed while the
      // cooldown window shrank)
      const freq = clamp(1 - game.stageIndex*0.035, 0.38, 1);
      const baseRange = boss.phase===2 ? [0.6,1.0] : [0.95,1.5];
      let attackTimer = rand(baseRange[0], baseRange[1]) * freq;
      // guardians (floors 10, 20, 30...) get noticeably more room between attacks than regular
      // floor bosses — the fight is built around a few hard-hitting, deliberate attacks rather
      // than a continuous stream of smaller ones
      if(boss.isGuardian) attackTimer *= 1.6;
      // the lower a boss's remaining HP, the less it waits between attacks — a smooth ramp on top
      // of (not instead of) the existing phase-2 jump at 50% HP, so the fight keeps tightening all
      // the way to the kill instead of just stepping once at the halfway mark
      const hpFrac = boss.maxHp>0 ? clamp(boss.hp/boss.maxHp, 0, 1) : 1;
      const hpSpeedMult = 0.55 + hpFrac*0.45; // 1x at full HP, down to 0.55x (~1.8x faster) near death
      attackTimer *= hpSpeedMult;
      boss.attackTimer = Math.max(0.25, attackTimer); // safety floor: never lets attacks chain instantly
    }
  } else if(boss.attackTimer<=0 && !isDashing){
    pickBossAttack(boss);
  }
}

const ATTACK_NAMES = {
  charge: 'Embestida Ósea',
  boneSlam: 'Golpe Sísmico',
  boneShards: 'Lluvia de Fragmentos',
  boneCage: 'Jaula de Huesos',
  boneWall: 'Muralla de Huesos',
  boneGrab: 'Garra Ósea',
  radialBurst: 'Estallido Pútrido',
  blinkStrike: 'Golpe Fantasma',
  poisonPool: 'Aliento del Pantano',
  curseMark: 'Marca Maldita',
  wither: 'Marchitar',
  slam: 'Puño del Abismo',
  fireRain: 'Lluvia Ígnea',
  meteor: 'Caída Estelar',
  lavaGeyser: 'Géiseres de Lava',
  magmaCross: 'Cruz de Magma',
  blazingFissure: 'Fisura Ardiente',
  growingMagma: 'Magma Creciente',
  frostNova: 'Nova de Escarcha',
  iceCage: 'Jaula de Hielo',
  stormBolt: 'Rayo Certero',
  stormField: 'Campo de Tormenta',
  voidLance: 'Lanza del Vacío',
  voidRift: 'Grieta del Vacío',
  witchCauldron: 'Caldero de Bruja',
  gracefulVeil: 'Velo de Luz',
  glassRain: 'Lluvia de Cristal',
  blizzardWall: 'Muralla de Escarcha',
  frozenGround: 'Suelo Congelado',
  chainLightning: 'Rayo Encadenado',
  thunderdome: 'Cúpula de Tormenta',
  gravityWell: 'Pozo de Gravedad',
  starCollapse: 'Colapso Estelar',
  sisterCall: 'Llamado de las Hermanas',
  eyeLaser: 'Rayo del Ojo',
  megaLaser: 'Mega Rayo Láser',
  acidDeluge: 'El Gran Colapso',
  venomousWeb: 'Brote de la Red Venenosa',
  infiniteReflections: 'Laberinto de Reflejos Infinitos',
  boundlessBeam: 'Brazos de Luz Infrecuente',
  crystalCage: 'Prisión de Cristal Fragmentado',
  plasmaBeam: 'Haz de Plasma Metálico',
  abyssSupernova: 'Autodestrucción Implacable',
  iceSlide: 'Pista de Escarcha Glacial',
  growingSpikes: 'Estalagmitas Espinosas',
  absoluteZero: 'Cero Absoluto',
  movingIceWalls: 'Muros Glaciales Desplazables',
  iceAvalanche: 'Avalancha en Cadena',
  cursedFlameBreath: 'Aliento Maldito',
  twinCharge: 'Embestida Doble',
  mirrorDecoy: 'Señuelo Especular',
  glassField: 'Campo de Cristal',
  illusionSwap: 'Intercambio Ilusorio',
  mirrorGaze: 'Mirada del Espejo',
  fracturedBurst: 'Ráfaga Fracturada',
  boundStrike: 'Golpe Vinculado',
  bondPulse: 'Pulso Compartido',
  twinStrike: 'Golpe Doble',
  bondedShield: 'Escudo Espiritual',
  spiritLink: 'Vínculo Espiritual',
  iceLance: 'Lanza de Hielo',
  crystalPrison: 'Prisión de Cristal',
  avalanche: 'Avalancha',
  frostBreath: 'Aliento Helado',
  numbingChill: 'Frío Entumecedor',
  thunderStrike: 'Golpe de Trueno',
  stormVortex: 'Vórtice de Tormenta',
  staticField: 'Campo Estático',
  skySiege: 'Asedio Celestial',
  boltRunner: 'Rayo Corredor',
  voidTendrils: 'Tentáculos del Vacío',
  darkPulse: 'Pulso Oscuro',
  starlightDrain: 'Drenaje Estelar',
  umbraStep: 'Paso de Sombra',
  collapsingStar: 'Estrella Colapsante',
  royalDecree: 'Decreto Real',
  throneSlam: 'Golpe del Trono',
  crownfire: 'Fuego de Corona',
  finalJudgment: 'Juicio Final',
  soulBarrage: 'Ráfaga de Almas',
  boneCross: 'Cruz de Huesos',
  boneSpiral: 'Espiral Ósea',
  skullBarrage: 'Ráfaga de Cráneos',
  graveSpikes: 'Espinas de Tumba',
  boneWhip: 'Látigo de Hueso',
  deathRattle: 'Estertor Mortal',
  hauntingWail: 'Lamento Errante',
  cryptCollapse: 'Colapso de Cripta',
  boneShrapnel: 'Metralla Ósea',
  graveyardShift: 'Salto de Cementerio',
  deathMark: 'Marca Mortal',
  skeletalSwarm: 'Enjambre Esquelético',
  tombstoneSlam: 'Golpe de Lápida',
  ribcage: 'Jaula de Costillas',
  deathToll: 'Toque Funesto',
  skullStorm: 'Tormenta de Cráneos',
  gravebind: 'Atadura de Tumba',
  boneChain: 'Cadena Ósea',
  cryptWhisper: 'Susurro de Cripta',
  deathsDoor: 'Puerta de la Muerte',
  rattlingBones: 'Huesos Traqueteantes',
  deathKnell: 'Tañido Fúnebre',
  bogBurst: 'Estallido de Ciénaga',
  leechSwarm: 'Enjambre de Sanguijuelas',
  witchesCurse: 'Maldición de Bruja',
  numbTonic: 'Tónico Entumecedor',
  rootSnare: 'Trampa de Raíces',
  quicksand: 'Arena Movediza',
  poisonBrew: 'Brebaje Venenoso',
  witchsEye: 'Ojo de Bruja',
  cauldronBubble: 'Burbujeo del Caldero',
  swampSurge: 'Oleada del Pantano',
  willOWisp: 'Fuego Fatuo',
  vineLine: 'Sendero de Enredaderas',
  venomLash: 'Latigazo Venenoso',
  shadowBrew: 'Brebaje de Sombras',
  batSwarm: 'Enjambre de Murciélagos',
  mireField: 'Campo de Lodo',
  curseBind: 'Atadura Maldita',
  witchsMark: 'Marca de Bruja',
  spectralHex: 'Hechizo Espectral',
  gooBurst: 'Estallido Viscoso',
  plagueCloud: 'Nube de Plaga',
  witchesRing: 'Círculo de Brujas',
  lavaSpurt: 'Chorro de Lava',
  infernoRing: 'Anillo Infernal',
  brimstoneRain: 'Lluvia de Azufre',
  demonRoar: 'Rugido Demoníaco',
  ashCloud: 'Nube de Ceniza',
  moltenTrap: 'Trampa de Magma',
  cinderSwarm: 'Enjambre de Cenizas',
  flameSurge: 'Oleada de Llamas',
  infernalBond: 'Pacto Infernal',
  sulfurBreath: 'Aliento de Azufre',
  pyreCollapse: 'Colapso de la Pira',
  scorchedEarth: 'Tierra Quemada',
  demonEye: 'Ojo Demoníaco',
  infernalChains: 'Cadenas Infernales',
  brimstoneSpiral: 'Espiral de Azufre',
  flameWreath: 'Corona de Fuego',
  hellgate: 'Puerta Infernal',
  cinderVolley: 'Ráfaga de Cenizas',
  moltenWave: 'Ola de Magma',
  demonicHowl: 'Aullido Demoníaco',
  infernalCrown: 'Corona Infernal',
  demonicBlast: 'Estallido Demoníaco',
  abyssalCollapse: 'Colapso del Abismo',
  summon: 'Refuerzos',
  boneVolley: 'Ráfaga Ósea',
  risingSpikes: 'Espinas Crecientes',
  boneArmor: 'Armadura de Hueso',
  boneTrap: 'Trampa Oculta',
  toxicSpores: 'Esporas Tóxicas',
  swampGrasp: 'Garra del Pantano',
  witchesBlessing: 'Bendición del Pantano',
  hexTrail: 'Rastro Maldito',
  mudSlow: 'Lodo Aferrado',
  cinderBurst: 'Estallido de Cenizas',
  flameWhip: 'Latigazo de Fuego',
  emberField: 'Campo de Ascuas',
  moltenCore: 'Núcleo Fundido',
  cinderRain: 'Lluvia de Cenizas',
  thornVolley: 'Ráfaga de Espinas',
  bloomTrap: 'Trampa Floreciente',
  healingBloom: 'Florecer',
  lightTwins: 'Luces Gemelas',
  radiantPath: 'Sendero Radiante',
  fireWave: 'Oleada de Fuego',
  butterflyBurst: 'Danza de Alas',
  prismDash: 'Corte Prismático',
  radiantNova: 'Nova Radiante',
  rainbowLine: 'Cortina de Luz',
  spiralBloom: 'Floración Espiral',
  petalRing: 'Anillo de Pétalos',
  mirrorSplit: 'Fractura Especular',
  phantomBarrage: 'Ráfaga Fantasma',
  echoDash: 'Eco Cortante',
  twinPulse: 'Pulso Gemelo',
  twinSwap: 'Intercambio Espectral',
  crossFire: 'Fuego Cruzado',
  petalStorm: 'Tormenta de Pétalos',
  vineWhip: 'Latigazo de Enredadera',
  prismShard: 'Esquirla Prismática',
  nectarSwarm: 'Enjambre de Néctar',
  gildedThorns: 'Espinas Doradas',
  dewTrap: 'Trampa de Rocío',
  crystalBloom: 'Floración de Cristal',
  thornCage: 'Jaula de Espinas',
  sunbeamLine: 'Rayo de Sol',
  bloomRing: 'Anillo Floreciente',
  sunfireCross: 'Cruz de Sol',
  radianceField: 'Campo de Resplandor',
  lightCascade: 'Cascada de Luz',
  tangleRoots: 'Raíces Enredadas',
  mirrorBloom: 'Pulso de Luz',
  verdantSurge: 'Oleada Verdiente',
  glowWisp: 'Chispa Radiante',
  sunfireLance: 'Lanza de Sol',
  lightPollen: 'Polen Cegador',
  witheringPetals: 'Pétalos Marchitos',
  petalVeil: 'Velo de Pétalos',
  gardenGuardians: 'Guardianes del Jardín',
  shatterVolley: 'Ráfaga Quebrada',
  reflectedBarrage: 'Ráfaga Reflejada',
  prismaticShards: 'Esquirlas Prismáticas',
  mirageSwarm: 'Enjambre de Espejismos',
  silverStrike: 'Golpe de Plata',
  mirrorMaze: 'Laberinto de Espejos',
  shatterZone: 'Zona Quebradiza',
  reflectivePool: 'Estanque Reflectante',
  glassSpikes: 'Espinas de Cristal',
  doubleVision: 'Visión Doble',
  distortionField: 'Campo de Distorsión',
  echoChamber: 'Cámara del Eco',
  hallOfMirrors: 'Salón de los Espejos',
  mirrorShatter: 'Espejo Roto',
  reflectivePulse: 'Pulso Reflejado',
  phantomChaser: 'Fantasma Acechante',
  reflectedLance: 'Lanza Reflejada',
  hauntingReflection: 'Reflejo Persecutor',
  disorientingGaze: 'Mirada Desorientadora',
  shatteredFocus: 'Concentración Rota',
  silveredSkin: 'Piel Plateada',
  mirroredEcho: 'Eco Espectral',
  twinVolley: 'Ráfaga Gemela',
  soulShards: 'Esquirlas del Alma',
  pairedBolts: 'Rayos Emparejados',
  spiritBurst: 'Estallido Espiritual',
  boundArrows: 'Flechas Vinculadas',
  soulTether: 'Lazo del Alma',
  kinshipRing: 'Anillo de Parentesco',
  dualBloom: 'Floración Doble',
  sharedPain: 'Dolor Compartido',
  weaveTrap: 'Trampa Entrelazada',
  pactCircle: 'Círculo del Pacto',
  tetherLine: 'Línea del Vínculo',
  soulPulse: 'Pulso del Alma',
  boundSurge: 'Oleada Vinculada',
  spiritChaser: 'Espíritu Acechante',
  soulLance: 'Lanza del Alma',
  kinseeker: 'Buscador de Sangre',
  sharedWound: 'Herida Compartida',
  soulSap: 'Drenaje del Alma',
  boundCurse: 'Maldición Vinculante',
  sharedBlessing: 'Bendición Compartida',
  twinSpirits: 'Espíritus Gemelos',
  frostShards: 'Esquirlas Heladas',
  glacialVolley: 'Descarga Glacial',
  iceShrapnel: 'Metralla de Hielo',
  crystalBarrage: 'Cortina de Cristal',
  polarWind: 'Viento Polar',
  snowSquall: 'Chubasco de Nieve',
  glacialSpike: 'Pico Glacial',
  frostRing: 'Anillo de Escarcha',
  iceFissure: 'Fisura Helada',
  frozenTrail: 'Sendero Congelado',
  hailfall: 'Granizada',
  permafrost: 'Permahielo',
  crystalRain: 'Lluvia de Cristal',
  blizzardGust: 'Ráfaga de Ventisca',
  frostSlam: 'Golpe de Escarcha',
  frostWisp: 'Espíritu Helado',
  iceStalker: 'Acechador de Hielo',
  frostbite: 'Congelación',
  brittleChill: 'Frío Quebradizo',
  glacialGrip: 'Garra Glacial',
  glacialWard: 'Guardia de Hielo',
  boltSpray: 'Lluvia de Rayos',
  thunderClap: 'Estruendo',
  chargedBurst: 'Descarga Cargada',
  windSlash: 'Corte de Viento',
  stormShards: 'Esquirlas de Tormenta',
  arcVolley: 'Descarga en Arco',
  thunderPatch: 'Punto de Trueno',
  stormCell: 'Célula de Tormenta',
  lightningField: 'Campo de Relámpagos',
  galeZone: 'Zona de Vendaval',
  thunderColumn: 'Columna de Truenos',
  stormPocket: 'Bolsillo de Tormenta',
  chainStrike: 'Golpe en Cadena',
  squallLine: 'Línea de Chubasco',
  thunderSlam: 'Trueno Sísmico',
  stormChaser: 'Perseguidor Tormentoso',
  thunderEye: 'Ojo del Trueno',
  staticShock: 'Descarga Estática',
  galeForce: 'Fuerza del Vendaval',
  overcharge: 'Sobrecarga',
  stormShield: 'Escudo de Tormenta',
  shadowShards: 'Esquirlas Sombrías',
  voidBurst: 'Estallido de Vacío',
  darkVolley: 'Descarga Oscura',
  eclipseSpray: 'Rociada de Eclipse',
  starfallShards: 'Fragmentos Estelares',
  umbralArc: 'Arco Umbrío',
  voidPool: 'Pozo de Vacío',
  shadowPatch: 'Mancha de Sombra',
  darkRift: 'Fisura Oscura',
  eclipseZone: 'Zona de Eclipse',
  starfallField: 'Campo de Estrellas Caídas',
  umbralCage: 'Jaula Umbría',
  voidColumn: 'Columna de Vacío',
  nullGround: 'Suelo Nulo',
  shadowSlam: 'Golpe de Sombra',
  voidWisp: 'Espíritu del Vacío',
  shadowStalker: 'Acechador Sombrío',
  voidGrasp: 'Garra del Vacío',
  starDrain: 'Drenaje Estelar',
  nullTouch: 'Toque Nulo',
  voidShroud: 'Manto de Vacío',
  crownShards: 'Esquirlas de Corona',
  royalVolley: 'Descarga Real',
  soulBurst: 'Estallido de Almas',
  radiantBlast: 'Ráfaga Radiante',
  scepterShards: 'Esquirlas de Cetro',
  dominionSpray: 'Rociada de Dominio',
  thronePatch: 'Punto del Trono',
  judgmentZone: 'Zona de Juicio',
  soulField: 'Campo de Almas',
  dominionCircle: 'Círculo de Dominio',
  regalSpikes: 'Picos Reales',
  sovereignGround: 'Suelo Soberano',
  crownfireField: 'Campo de Fuego Real',
  royalGround: 'Suelo Real',
  royalSlam: 'Golpe Soberano',
  soulChaser: 'Perseguidor de Almas',
  wraithMark: 'Marca Espectral',
  royalCurse: 'Maldición Real',
  soulDrain: 'Drenaje del Alma',
  crownBind: 'Cadena Dorada',
  royalAegis: 'Égida Real',
  lightDeluge: 'Diluvio de Luz',
  prismaticCascade: 'Cascada Prismática',
  radiantMandala: 'Mandala Radiante',
  solarSporeSpiral: 'Esporas Solares',
  lightSeeds: 'Semillas de Luz',
  dandelionWave: 'Diente de León Prismático',
  canopyBeams: 'Sinfonía del Bosque Sagrado',
  pincerScan: 'El Escáner de Tenaza',
  orbitalCross: 'Órbita Cruzada',
  desperateRush: 'Fase Desesperada',
  energyBond: 'Vínculo de Energía',
  circuitPanels: 'El Circuito Secuencial',
  polarityPull: 'Carga de Polaridad',
  closingBarrier: 'La Barrera que se Cierra',
  predictiveLightning: 'Relámpago Telegrafiado',
  massSingularity: 'Singularidad Terrestre',
  gravityFlip: 'Giro de Masa',
  voidCrackCollapse: 'Grieta del Vacío',
  eventHorizonPulse: 'Onda de Evento de Horizonte',
  // Ascenso — Piso 1 (Larva de Sombra) y Piso 100 (El Sol)
  voidClaw: 'Zarpazo de Vacío',
  voidPuddles: 'Charcos de Sombra',
  shadowBurst: 'Estallido de Sombra',
  dawnBeam: 'Haz del Alba',
  solarFlare: 'Llamarada Solar',
  radiantCollapse: 'Colapso Radiante',
  zenith: 'Cenit',
  echoSlam: 'Golpe con Eco',
  hollowVolley: 'Ráfaga Hueca',
  duplicantPulse: 'Pulso Duplicante',
  crackLine: 'Línea de Grietas',
  tendrilBloom: 'Florecer de Zarcillos',
  weaverBurst: 'Estallido del Tejedor',
  silentSlam: 'Golpe Silencioso',
  mutePulse: 'Pulso Mudo',
  whisperVolley: 'Ráfaga de Susurros',
  devourLunge: 'Embestida Devoradora',
  echoSwarmBurst: 'Enjambre de Ecos',
  voidMawPuddles: 'Fauces del Vacío',
  ashSlam: 'Golpe de Ceniza',
  cinderRing: 'Anillo de Brasas',
  ashStorm: 'Tormenta de Ceniza',
  whisperDodge: 'Esquiva Susurrante',
  crackVolley: 'Ráfaga de Grieta',
  whisperCrawl: 'Arrastre Susurrante',
  thornLash: 'Latigazo de Espinas',
  thornField: 'Campo de Espinas',
  thornBurst: 'Estallido de Espinas',
  wardenCrush: 'Aplastón del Custodio',
  wardenBarrier: 'Barrera del Custodio',
  wardenVolley: 'Ráfaga del Custodio',
  swarmDash: 'Embestida del Enjambre',
  swarmPepper: 'Metralla del Enjambre',
  swarmField: 'Campo del Enjambre',
  heraldSlam: 'Golpe del Heraldo',
  heraldLine: 'Línea del Heraldo',
  heraldBurst: 'Estallido del Heraldo',
  heraldCollapse: 'Colapso del Heraldo',
  screamSlam: 'Golpe del Grito',
  drownedVolley: 'Ráfaga Ahogada',
  echoTrap: 'Trampa de Eco',
  duskLash: 'Latigazo del Ocaso',
  duskWeb: 'Red del Ocaso',
  twilightBurst: 'Estallido Crepuscular',
  facelessCrush: 'Aplastón sin Rostro',
  facelessWard: 'Guarda sin Rostro',
  facelessGaze: 'Mirada sin Rostro',
  vineLash: 'Latigazo de Enredadera',
  vineField: 'Campo de Enredaderas',
  vineBurst: 'Estallido de Enredadera',
  whisperTwinDash: 'Embestida Doble',
  doubleVolley: 'Ráfaga Doble',
  twinCrawl: 'Arrastre Doble',
  shardSlam: 'Golpe de Fragmento',
  shardRain: 'Lluvia de Fragmentos',
  shardBurst: 'Estallido de Fragmentos',
  custodianSlam: 'Golpe de la Custodia',
  custodianRing: 'Anillo de la Custodia',
  custodianVolley: 'Ráfaga de la Custodia',
  lamentDodge: 'Esquiva del Lamento',
  lamentCrawl: 'Arrastre del Lamento',
  lamentWail: 'Gemido del Lamento',
  heartSlam: 'Golpe del Corazón',
  heartLine: 'Línea del Corazón',
  heartBurst: 'Estallido del Corazón',
  heartCollapse: 'Colapso del Corazón',
  thresholdSlam: 'Golpe del Umbral',
  thresholdField: 'Campo del Umbral',
  voidBeam: 'Haz de Vacío',
  choirSlam: 'Golpe del Coro',
  choirWave: 'Oleada del Coro',
  choirEcho: 'Eco del Coro',
  marauderPounce: 'Salto del Merodeador',
  marauderRake: 'Zarpazo del Merodeador',
  marauderHail: 'Granizo del Merodeador',
  graniteCrush: 'Aplastón de Granito',
  graniteWall: 'Muro de Granito',
  graniteVolley: 'Ráfaga de Granito',
  bloomLash: 'Latigazo del Florecer',
  bloomField: 'Campo del Florecer',
  bloomBurst: 'Estallido del Florecer',
  emberSlam: 'Golpe de Brasas',
  crownAshfall: 'Ceniza de la Corona',
  emberBurst: 'Estallido de Brasas',
  ashDash: 'Embestida de Ceniza',
  emberWake: 'Estela de Brasas',
  cinderScatter: 'Dispersión de Rescoldos',
  emberCrush: 'Aplastón Ardiente',
  achingRing: 'Anillo Doliente',
  emberVolley: 'Ráfaga de Brasas',
  paleFlicker: 'Parpadeo Pálido',
  paleWake: 'Estela Pálida',
  paleBurst: 'Estallido Pálido',
  wardenEmberSlam: 'Golpe del Custodio Ardiente',
  emberWardenRing: 'Anillo del Custodio Ardiente',
  emberWardenVolley: 'Ráfaga del Custodio Ardiente',
  swarmEmberDash: 'Embestida del Enjambre Ardiente',
  emberSwarmField: 'Campo del Enjambre Ardiente',
  emberSwarmBurst: 'Estallido del Enjambre Ardiente',
  mistSlam: 'Golpe de Bruma',
  mistField: 'Campo de Bruma',
  mistBurst: 'Estallido de Bruma',
  dimmedCrush: 'Aplastón Apagado',
  dimmedRing: 'Anillo Apagado',
  dimmedVolley: 'Ráfaga Apagada',
  greyThornLash: 'Latigazo Gris',
  greyThornField: 'Campo Gris',
  greyThornBurst: 'Estallido Gris',
  dimWhisperDodge: 'Esquiva del Susurro Apagado',
  dimmedCrawl: 'Reptar Apagado',
  dimmedWhisperVolley: 'Ráfaga del Susurro Apagado',
  heartDimSlam: 'Golpe del Corazón Apagado',
  dimmedHeartLine: 'Línea del Corazón Apagado',
  dimmedHeartBurst: 'Estallido del Corazón Apagado',
  dustDash: 'Embestida de Polvo',
  dustTrail: 'Estela de Polvo',
  dustScatter: 'Dispersión de Polvo',
  fissureLash: 'Latigazo de Fisura',
  fissureField: 'Campo de Fisura',
  fissureBurst: 'Estallido de Fisura',
  hollowSlam: 'Golpe Hueco',
  hollowField: 'Campo Hueco',
  hollowBurst: 'Estallido Hueco',
  stoneWhisperDodge: 'Esquiva del Susurro de Piedra',
  stoneCrawl: 'Reptar de Piedra',
  stoneVolley: 'Ráfaga de Piedra',
  dustHeartSlam: 'Golpe del Corazón de Polvo',
  dustHeartLine: 'Línea del Corazón de Polvo',
  dustHeartBurst: 'Estallido del Corazón de Polvo',
  dustHeartCollapse: 'Colapso del Corazón de Polvo',
  gleamSlam: 'Golpe de Brillo',
  gleamField: 'Campo de Brillo',
  gleamBurst: 'Estallido de Brillo',
  stoneWardenCrush: 'Aplastón del Custodio de Piedra',
  stoneWardenRing: 'Anillo del Custodio de Piedra',
  stoneWardenVolley: 'Ráfaga del Custodio de Piedra',
  lightThornLash: 'Latigazo de Luz',
  lightThornField: 'Campo de Luz',
  lightThornBurst: 'Estallido de Luz',
  greyEchoDash: 'Embestida de Ecos Grises',
  greyEchoField: 'Campo de Ecos Grises',
  greyEchoBurst: 'Estallido de Ecos Grises',
  ashLightSlam: 'Golpe de Ceniza y Luz',
  ashLightField: 'Campo de Ceniza y Luz',
  ashLightBurst: 'Estallido de Ceniza y Luz',
  veilSlam: 'Golpe del Velo',
  veilField: 'Campo del Velo',
  veilBurst: 'Estallido del Velo',
  edgeGuardCrush: 'Aplastón de la Guardiana del Límite',
  edgeGuardRing: 'Anillo de la Guardiana del Límite',
  edgeGuardVolley: 'Ráfaga de la Guardiana del Límite',
  dawnThornLash: 'Latigazo del Alba',
  dawnThornField: 'Campo del Alba',
  dawnThornBurst: 'Estallido del Alba',
  edgeHeartSlam: 'Golpe del Corazón del Límite',
  edgeHeartLine: 'Línea del Corazón del Límite',
  edgeHeartBurst: 'Estallido del Corazón del Límite',
  edgeHeartCollapse: 'Colapso del Corazón del Límite',
  dawnDash: 'Embestida del Alba',
  dawnTrail: 'Estela del Alba',
  dawnScatter: 'Dispersión del Alba',
  dawnGuardCrush: 'Aplastón de la Guardiana del Alba',
  dawnGuardRing: 'Anillo de la Guardiana del Alba',
  dawnGuardVolley: 'Ráfaga de la Guardiana del Alba',
  goldenEchoDash: 'Embestida del Eco Dorado',
  goldenEchoField: 'Campo del Eco Dorado',
  goldenEchoBurst: 'Estallido del Eco Dorado',
  goldenThornLash: 'Latigazo Dorado',
  goldenThornField: 'Campo Dorado',
  goldenThornBurst: 'Estallido Dorado',
  dawnWhisperDodge: 'Esquiva del Susurro del Alba',
  dawnWhisperCrawl: 'Reptar del Susurro del Alba',
  dawnWhisperVolley: 'Ráfaga del Susurro del Alba',
  brightSlam: 'Golpe Brillante',
  brightField: 'Campo Brillante',
  brightBurst: 'Estallido Brillante',
  swarmGoldenDash: 'Embestida del Enjambre Dorado',
  goldenSwarmField: 'Campo del Enjambre Dorado',
  goldenSwarmBurst: 'Estallido del Enjambre Dorado',
  radiantCrush: 'Aplastón Radiante',
  radiantRing: 'Anillo Radiante',
  radiantVolley: 'Ráfaga Radiante',
  radiantThornLash: 'Latigazo Radiante',
  radiantThornField: 'Campo Radiante',
  radiantThornBurst: 'Estallido Radiante',
  sunHeraldSlam: 'Golpe del Heraldo del Sol',
  sunHeraldLine: 'Línea del Heraldo del Sol',
  sunHeraldBurst: 'Estallido del Heraldo del Sol',
  sunHeraldCollapse: 'Colapso del Heraldo del Sol',
  sentinelDash: 'Embestida del Centinela Dorado',
  sentinelTrail: 'Estela del Centinela Dorado',
  sentinelScatter: 'Dispersión del Centinela Dorado',
  solarWardenCrush: 'Aplastón del Custodio Solar',
  solarWardenRing: 'Anillo del Custodio Solar',
  solarWardenVolley: 'Ráfaga del Custodio Solar',
  solarWhisperDodge: 'Esquiva del Susurro Solar',
  solarWhisperCrawl: 'Reptar del Susurro Solar',
  solarWhisperVolley: 'Ráfaga del Susurro Solar',
  solarEchoDash: 'Embestida del Eco Solar',
  solarEchoField: 'Campo del Eco Solar',
  solarEchoBurst: 'Estallido del Eco Solar',
  swarmBlazeDash: 'Embestida del Enjambre de Llamas',
  blazeSwarmField: 'Campo del Enjambre de Llamas',
  blazeSwarmBurst: 'Estallido del Enjambre de Llamas',
  solarGuardSlam: 'Golpe de la Guardiana Solar',
  solarGuardField: 'Campo de la Guardiana Solar',
  solarGuardBurst: 'Estallido de la Guardiana Solar',
  flareWardenCrush: 'Aplastón del Custodio de Flare',
  flareWardenRing: 'Anillo del Custodio de Flare',
  flareWardenVolley: 'Ráfaga del Custodio de Flare',
  flareThornLash: 'Latigazo de Flare',
  flareThornField: 'Campo de Flare',
  flareThornBurst: 'Estallido de Flare',
  coronaWhisperDodge: 'Esquiva del Susurro de Corona',
  coronaWhisperCrawl: 'Reptar del Susurro de Corona',
  coronaWhisperVolley: 'Ráfaga del Susurro de Corona',
  coronaHeartSlam: 'Golpe del Corazón de Corona',
  coronaHeartLine: 'Línea del Corazón de Corona',
  coronaHeartBurst: 'Estallido del Corazón de Corona',
  coronaHeartCollapse: 'Colapso del Corazón de Corona',
  swarmFlareDash: 'Embestida del Enjambre de Flare',
  flareSwarmField: 'Campo del Enjambre de Flare',
  flareSwarmBurst: 'Estallido del Enjambre de Flare',
  zenithWardenCrush: 'Aplastón del Custodio del Cenit',
  zenithWardenRing: 'Anillo del Custodio del Cenit',
  zenithWardenVolley: 'Ráfaga del Custodio del Cenit',
  zenithThornLash: 'Latigazo del Cenit',
  zenithThornField: 'Campo del Cenit',
  zenithThornBurst: 'Estallido del Cenit',
  zenithWhisperDodge: 'Esquiva del Susurro del Cenit',
  zenithWhisperCrawl: 'Reptar del Susurro del Cenit',
  zenithWhisperVolley: 'Ráfaga del Susurro del Cenit',
  zenithEchoDash: 'Embestida del Eco del Cenit',
  zenithEchoField: 'Campo del Eco del Cenit',
  zenithEchoBurst: 'Estallido del Eco del Cenit',
  zenithGuardSlam: 'Golpe de la Guardiana del Cenit',
  zenithGuardField: 'Campo de la Guardiana del Cenit',
  zenithGuardBurst: 'Estallido de la Guardiana del Cenit',
  blindWardenCrush: 'Aplastón del Custodio Cegador',
  blindWardenRing: 'Anillo del Custodio Cegador',
  blindWardenVolley: 'Ráfaga del Custodio Cegador',
  blindThornLash: 'Latigazo Cegador',
  blindThornField: 'Campo Cegador',
  blindThornBurst: 'Estallido Cegador',
  blindWhisperDodge: 'Esquiva del Susurro Cegador',
  blindWhisperCrawl: 'Reptar del Susurro Cegador',
  blindWhisperVolley: 'Ráfaga del Susurro Cegador',
  blindHeartSlam: 'Golpe del Corazón Cegador',
  blindHeartLine: 'Línea del Corazón Cegador',
  blindHeartBurst: 'Estallido del Corazón Cegador',
  blindHeartCollapse: 'Colapso del Corazón Cegador',
  swarmBlindDash: 'Embestida del Enjambre Cegador',
  blindSwarmField: 'Campo del Enjambre Cegador',
  blindSwarmBurst: 'Estallido del Enjambre Cegador',
  ascWardenCrush: 'Aplastón del Custodio Ascendente',
  ascWardenRing: 'Anillo del Custodio Ascendente',
  ascWardenVolley: 'Ráfaga del Custodio Ascendente',
  ascThornLash: 'Latigazo Ascendente',
  ascThornField: 'Campo Ascendente',
  ascThornBurst: 'Estallido Ascendente',
  ascWhisperDodge: 'Esquiva del Susurro Ascendente',
  ascWhisperCrawl: 'Reptar del Susurro Ascendente',
  ascWhisperVolley: 'Ráfaga del Susurro Ascendente',
  ascEchoDash: 'Embestida del Eco Ascendente',
  ascEchoField: 'Campo del Eco Ascendente',
  ascEchoBurst: 'Estallido del Eco Ascendente',
  ascGuardSlam: 'Golpe de la Guardiana Ascendente',
  ascGuardField: 'Campo de la Guardiana Ascendente',
  ascGuardBurst: 'Estallido de la Guardiana Ascendente',
  summitWardenCrush: 'Aplastón del Custodio de la Cumbre',
  summitWardenRing: 'Anillo del Custodio de la Cumbre',
  summitWardenVolley: 'Ráfaga del Custodio de la Cumbre',
  summitThornLash: 'Latigazo de la Cumbre',
  summitThornField: 'Campo de la Cumbre',
  summitThornBurst: 'Estallido de la Cumbre',
  summitWhisperDodge: 'Esquiva del Susurro de la Cumbre',
  summitWhisperCrawl: 'Reptar del Susurro de la Cumbre',
  summitWhisperVolley: 'Ráfaga del Susurro de la Cumbre',
  summitHeartSlam: 'Golpe del Corazón de la Cumbre',
  summitHeartLine: 'Línea del Corazón de la Cumbre',
  summitHeartBurst: 'Estallido del Corazón de la Cumbre',
  summitHeartCollapse: 'Colapso del Corazón de la Cumbre',
  swarmSummitDash: 'Embestida del Enjambre de la Cumbre',
  summitSwarmField: 'Campo del Enjambre de la Cumbre',
  summitSwarmBurst: 'Estallido del Enjambre de la Cumbre',
  portalWardenCrush: 'Aplastón del Custodio del Portal',
  portalWardenRing: 'Anillo del Custodio del Portal',
  portalWardenVolley: 'Ráfaga del Custodio del Portal',
  portalThornLash: 'Latigazo del Portal',
  portalThornField: 'Campo del Portal',
  portalThornBurst: 'Estallido del Portal',
  portalWhisperDodge: 'Esquiva del Susurro del Portal',
  portalWhisperCrawl: 'Reptar del Susurro del Portal',
  portalWhisperVolley: 'Ráfaga del Susurro del Portal',
  portalEchoDash: 'Embestida del Eco del Portal',
  portalEchoField: 'Campo del Eco del Portal',
  portalEchoBurst: 'Estallido del Eco del Portal',
  portalGuardSlam: 'Golpe de la Guardiana del Portal',
  portalGuardField: 'Campo de la Guardiana del Portal',
  portalGuardBurst: 'Estallido de la Guardiana del Portal',
  lastWardenCrush: 'Aplastón del Último Custodio',
  lastWardenRing: 'Anillo del Último Custodio',
  lastWardenVolley: 'Ráfaga del Último Custodio',
  lastThornLash: 'Latigazo de la Última Espina',
  lastThornField: 'Campo de la Última Espina',
  lastThornBurst: 'Estallido de la Última Espina',
  precursorSlam: 'Golpe del Precursor del Sol',
  precursorRing: 'Anillo del Precursor del Sol',
  precursorLine: 'Línea del Precursor del Sol',
  precursorBurst: 'Estallido del Precursor del Sol',
  precursorCollapse: 'Colapso del Precursor del Sol',
};
const GROUND_SELF_ATTACKS = ['boneSlam','slam','fireWave','mirrorBloom','verdantSurge','mirrorShatter','reflectivePulse','soulPulse','boundSurge','frostSlam','thunderSlam','shadowSlam','royalSlam','voidClaw','echoSlam','silentSlam','ashSlam','thornLash','wardenCrush','heraldSlam','screamSlam','duskLash','facelessCrush','vineLash','shardSlam','custodianSlam','heartSlam','thresholdSlam','choirSlam','marauderRake','graniteCrush','bloomLash','emberSlam','emberCrush','paleFlicker','wardenEmberSlam','mistSlam','dimmedCrush','heartDimSlam','greyThornLash','hollowSlam','dustHeartSlam','fissureLash','gleamSlam','ashLightSlam','stoneWardenCrush','lightThornLash','veilSlam','edgeGuardCrush','edgeHeartSlam','dawnThornLash','dawnGuardCrush','goldenThornLash','brightSlam','radiantCrush','radiantThornLash','sunHeraldSlam','solarWardenCrush','solarGuardSlam','flareWardenCrush','flareThornLash','coronaHeartSlam','zenithWardenCrush','zenithThornLash','zenithGuardSlam','blindWardenCrush','blindThornLash','blindHeartSlam','ascWardenCrush','ascThornLash','ascGuardSlam','summitWardenCrush','summitThornLash','summitHeartSlam','portalWardenCrush','portalThornLash','portalGuardSlam','lastWardenCrush','lastThornLash','precursorSlam'];
const GROUND_TARGET_ATTACKS = ['fireRain','poisonPool','meteor','boneCage','boneWall','lavaGeyser','growingMagma','iceCage','stormField','voidRift','risingSpikes','boneTrap','swampGrasp','hexTrail','emberField','moltenCore','cinderRain','bloomTrap','radiantPath','glassField','bondPulse','spiritLink','crystalPrison','avalanche','stormVortex','skySiege','voidTendrils','collapsingStar','finalJudgment','thunderStrike','boneCross','boneSpiral','graveSpikes','cryptCollapse','ribcage','deathToll','deathsDoor','deathKnell','rootSnare','quicksand','poisonBrew','swampSurge','vineLine','mireField','plagueCloud','witchesRing','infernoRing','brimstoneRain','moltenTrap','flameSurge','pyreCollapse','scorchedEarth','brimstoneSpiral','moltenWave','dewTrap','crystalBloom','thornCage','sunbeamLine','bloomRing','sunfireCross','radianceField','lightCascade','tangleRoots','mirrorMaze','shatterZone','reflectivePool','glassSpikes','doubleVision','distortionField','echoChamber','hallOfMirrors','soulTether','kinshipRing','dualBloom','sharedPain','weaveTrap','pactCircle','tetherLine','acidDeluge','venomousWeb','boundlessBeam','crystalCage','growingSpikes','glacialSpike','frostRing','iceFissure','frozenTrail','hailfall','permafrost','crystalRain','blizzardGust','thunderPatch','stormCell','lightningField','galeZone','thunderColumn','stormPocket','chainStrike','squallLine','voidPool','shadowPatch','darkRift','eclipseZone','starfallField','umbralCage','voidColumn','nullGround','thronePatch','judgmentZone','soulField','dominionCircle','regalSpikes','sovereignGround','crownfireField','royalGround','voidPuddles','radiantCollapse','zenith','duplicantPulse','crackLine','tendrilBloom','mutePulse','voidMawPuddles','cinderRing','ashStorm','whisperCrawl','thornField','wardenBarrier','swarmField','heraldLine','heraldCollapse','echoTrap','duskWeb','facelessWard','vineField','twinCrawl','shardRain','custodianRing','lamentCrawl','heartLine','heartCollapse','thresholdField','choirEcho','graniteWall','bloomField','crownAshfall','emberWake','achingRing','paleWake','emberWardenRing','emberSwarmField','mistField','dimmedRing','greyThornField','dimmedCrawl','dimmedHeartLine','dustTrail','fissureField','hollowField','stoneCrawl','dustHeartLine','dustHeartCollapse','gleamField','stoneWardenRing','lightThornField','greyEchoField','ashLightField','veilField','edgeGuardRing','dawnThornField','edgeHeartLine','edgeHeartCollapse','dawnTrail','dawnGuardRing','goldenEchoField','goldenThornField','dawnWhisperCrawl','brightField','goldenSwarmField','radiantRing','radiantThornField','sunHeraldLine','sunHeraldCollapse','sentinelTrail','solarWardenRing','solarWhisperCrawl','solarEchoField','blazeSwarmField','solarGuardField','flareWardenRing','flareThornField','coronaWhisperCrawl','coronaHeartLine','coronaHeartCollapse','flareSwarmField','zenithWardenRing','zenithThornField','zenithWhisperCrawl','zenithEchoField','zenithGuardField','blindWardenRing','blindThornField','blindWhisperCrawl','blindHeartLine','blindHeartCollapse','blindSwarmField','ascWardenRing','ascThornField','ascWhisperCrawl','ascEchoField','ascGuardField','summitWardenRing','summitThornField','summitWhisperCrawl','summitHeartLine','summitHeartCollapse','summitSwarmField','portalWardenRing','portalThornField','portalWhisperCrawl','portalEchoField','portalGuardField','lastWardenRing','lastThornField','precursorRing','precursorLine','precursorCollapse'];
const DASH_ATTACKS = ['charge','blinkStrike','prismDash','echoDash','devourLunge','swarmDash','whisperTwinDash','marauderPounce','ashDash','swarmEmberDash','dustDash','greyEchoDash','dawnDash','goldenEchoDash','swarmGoldenDash','sentinelDash','solarEchoDash','swarmBlazeDash','swarmFlareDash','zenithEchoDash','swarmBlindDash','ascEchoDash','swarmSummitDash','portalEchoDash'];
const BURST_ATTACKS = ['radialBurst','radiantNova','butterflyBurst','rainbowLine','spiralBloom','petalRing','mirrorSplit','phantomBarrage','twinPulse','crossFire','boneShards','frostNova','stormBolt','boneVolley','toxicSpores','boneArmor','witchesBlessing','summon','mudSlow','cinderBurst','thornVolley','healingBloom','lightTwins','flameWhip','eyeLaser','cursedFlameBreath','mirrorDecoy','fracturedBurst','boundStrike','illusionSwap','twinStrike','mirrorGaze','bondedShield','iceLance','boltRunner','soulBarrage','frostBreath','darkPulse','crownfire','numbingChill','staticField','starlightDrain','royalDecree','umbraStep','throneSlam','skullBarrage','boneShrapnel','skeletalSwarm','skullStorm','boneWhip','deathRattle','hauntingWail','graveyardShift','deathMark','tombstoneSlam','gravebind','boneChain','cryptWhisper','rattlingBones','bogBurst','leechSwarm','witchesCurse','numbTonic','witchsEye','cauldronBubble','willOWisp','venomLash','shadowBrew','batSwarm','curseBind','witchsMark','spectralHex','gooBurst','lavaSpurt','cinderSwarm','demonRoar','ashCloud','infernalBond','sulfurBreath','demonEye','infernalChains','flameWreath','hellgate','cinderVolley','demonicHowl','infernalCrown','petalStorm','vineWhip','prismShard','nectarSwarm','gildedThorns','glowWisp','sunfireLance','lightPollen','witheringPetals','petalVeil','gardenGuardians','shatterVolley','reflectedBarrage','prismaticShards','mirageSwarm','silverStrike','phantomChaser','reflectedLance','hauntingReflection','disorientingGaze','shatteredFocus','silveredSkin','mirroredEcho','twinVolley','soulShards','pairedBolts','spiritBurst','boundArrows','spiritChaser','soulLance','kinseeker','sharedWound','soulSap','boundCurse','sharedBlessing','twinSpirits','frostShards','glacialVolley','iceShrapnel','crystalBarrage','polarWind','snowSquall','frostWisp','iceStalker','frostbite','brittleChill','glacialGrip','glacialWard','boltSpray','thunderClap','chargedBurst','windSlash','stormShards','arcVolley','stormChaser','thunderEye','staticShock','galeForce','overcharge','stormShield','shadowShards','voidBurst','darkVolley','eclipseSpray','starfallShards','umbralArc','voidWisp','shadowStalker','voidGrasp','starDrain','nullTouch','voidShroud','crownShards','royalVolley','soulBurst','radiantBlast','scepterShards','dominionSpray','soulChaser','wraithMark','royalCurse','soulDrain','crownBind','royalAegis','shadowBurst','solarFlare','hollowVolley','weaverBurst','whisperVolley','echoSwarmBurst','crackVolley','thornBurst','wardenVolley','swarmPepper','heraldBurst','whisperDodge','drownedVolley','twilightBurst','facelessGaze','vineBurst','doubleVolley','shardBurst','custodianVolley','lamentDodge','lamentWail','heartBurst','choirWave','marauderHail','graniteVolley','bloomBurst','emberBurst','cinderScatter','emberVolley','paleBurst','emberWardenVolley','emberSwarmBurst','mistBurst','dimmedVolley','greyThornBurst','dimWhisperDodge','dimmedWhisperVolley','dimmedHeartBurst','dustScatter','fissureBurst','hollowBurst','stoneWhisperDodge','stoneVolley','dustHeartBurst','gleamBurst','stoneWardenVolley','lightThornBurst','greyEchoBurst','ashLightBurst','veilBurst','edgeGuardVolley','dawnThornBurst','edgeHeartBurst','dawnScatter','dawnGuardVolley','goldenEchoBurst','goldenThornBurst','dawnWhisperDodge','dawnWhisperVolley','brightBurst','goldenSwarmBurst','radiantVolley','radiantThornBurst','sunHeraldBurst','sentinelScatter','solarWardenVolley','solarWhisperDodge','solarWhisperVolley','solarEchoBurst','blazeSwarmBurst','solarGuardBurst','flareWardenVolley','flareThornBurst','coronaWhisperDodge','coronaWhisperVolley','coronaHeartBurst','flareSwarmBurst','zenithWardenVolley','zenithThornBurst','zenithWhisperDodge','zenithWhisperVolley','zenithEchoBurst','zenithGuardBurst','blindWardenVolley','blindThornBurst','blindWhisperDodge','blindWhisperVolley','blindHeartBurst','blindSwarmBurst','ascWardenVolley','ascThornBurst','ascWhisperDodge','ascWhisperVolley','ascEchoBurst','ascGuardBurst','summitWardenVolley','summitThornBurst','summitWhisperDodge','summitWhisperVolley','summitHeartBurst','summitSwarmBurst','portalWardenVolley','portalThornBurst','portalWhisperDodge','portalWhisperVolley','portalEchoBurst','portalGuardBurst','lastWardenVolley','lastThornBurst','precursorBurst'];
const DASH_ATTACKS_EXTRA_TELEGRAPH = ['twinCharge']; // uses the simple line telegraph like real dash attacks, without counting toward the dash budget

function showAttackBanner(boss, type){
  const el = $('boss-attack-name');
  if(!el) return;
  const name = ATTACK_NAMES[type];
  if(!name) return;
  el.textContent = name;
  el.style.color = boss.def.color;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

// Picks the next attack from the pool, but blocks a type that's already been used the last
// two times in a row (so no boss can do the same attack 3+ times back to back). The Empress of
// Light is exempt — her kit is built around repeatable light-weaving patterns.
function pickAttackAvoidingTripleRepeat(boss, pool){
  boss.recentAttacks = boss.recentAttacks || [];
  let candidates = pool;
  if(boss.kind!=='empressOfLight' && boss.recentAttacks.length>=2 &&
     boss.recentAttacks[boss.recentAttacks.length-1] === boss.recentAttacks[boss.recentAttacks.length-2]){
    const banned = boss.recentAttacks[boss.recentAttacks.length-1];
    const filtered = pool.filter(t=>t!==banned);
    candidates = filtered.length ? filtered : pool;
  }
  const type = candidates[Math.floor(Math.random()*candidates.length)];
  boss.recentAttacks.push(type);
  if(boss.recentAttacks.length>2) boss.recentAttacks.shift();
  return type;
}

function pickBossAttack(boss){
  const basePool = BOSS_ATTACKS[boss.kind] || ['charge','summon','radialBurst'];
  let pool = boss.phase===2 ? [...basePool, basePool[basePool.length-1], basePool[basePool.length-2]] : basePool;
  if(boss.phase!==2) pool = pool.filter(t=>t!=='megaLaser'&&t!=='desperateRush'); // signature enrage moves, can't roll before half HP
  boss.attackCount = (boss.attackCount||0)+1;
  if(boss.lastSummonAttack===undefined) boss.lastSummonAttack = -10;
  const canSummon = (boss.attackCount - boss.lastSummonAttack) >= 10;
  if(!canSummon && pool.includes('summon')){
    const filtered = pool.filter(t=>t!=='summon');
    pool = filtered.length ? filtered : pool;
  }
  // Heal nerf: a boss can only land a heal-type attack (direct heal, regen, or life-drain) once
  // every 10 attacks it executes, tracked the same way as the summon cooldown above.
  if(boss.lastHealAttack===undefined) boss.lastHealAttack = -10;
  const canHeal = (boss.attackCount - boss.lastHealAttack) >= 10;
  if(!canHeal && pool.some(t=>HEAL_ATTACK_TYPES.has(t))){
    const filtered = pool.filter(t=>!HEAL_ATTACK_TYPES.has(t));
    pool = filtered.length ? filtered : pool; // if heal was literally the only move, allow it rather than stall the boss
  }
  let type;
  if(boss.forceNextAttack){
    type = boss.forceNextAttack;
    boss.forceNextAttack = null;
    boss.recentAttacks = boss.recentAttacks||[];
    boss.recentAttacks.push(type);
    if(boss.recentAttacks.length>2) boss.recentAttacks.shift();
  } else {
    type = pickAttackAvoidingTripleRepeat(boss, pool);
  }
  if(type==='summon') boss.lastSummonAttack = boss.attackCount;
  if(HEAL_ATTACK_TYPES.has(type)) boss.lastHealAttack = boss.attackCount;
  const p = game.player;
  boss.telegraph = { type, t: 0.55, dur: 0.55, tx:p.x, ty:p.y };
  if(type==='blinkStrike'){
    const ang = Math.random()*Math.PI*2;
    const bnds = arenaBounds();
    const oldX = boss.x, oldY = boss.y;
    boss.x = clamp(p.x+Math.cos(ang)*110, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*110, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    boss.telegraph.t = 0.85; boss.telegraph.dur = 0.85; // boss teleports in immediately but the strike lands later, so it's dodgeable
    spawnShockwave(oldX, oldY, boss.def.color, boss.radius*1.4, 0.3);
    spawnShockwave(boss.x, boss.y, boss.def.color, boss.radius*1.4, 0.3);
    addParticles(oldX,oldY,boss.def.color,14,160,0.3);
    addParticles(boss.x,boss.y,boss.def.color,20,200,0.4);
  }
  if(type==='boneGrab'){
    // the wind now pulls from anywhere in the arena — there's no cone to sidestep, and no clock
    // either. It only ends when you reach the one safe pocket or get dragged all the way in
    // (see the per-frame handling in updateBoss). t/dur stay effectively infinite here; rampDur
    // just controls how fast the pull intensifies.
    boss.telegraph.t = 999; boss.telegraph.dur = 999;
    boss.telegraph.rampDur = 3.4;
    boss.telegraph.elapsed = 0;
    const bnds = arenaBounds();
    let sx, sy, tries=0;
    do {
      sx = rand(bnds.x+90, bnds.x+bnds.w-90);
      sy = rand(bnds.y+90, bnds.y+bnds.h-90);
      tries++;
    } while(dist(sx,sy,boss.x,boss.y)<220 && tries<12);
    boss.telegraph.safeX = sx; boss.telegraph.safeY = sy; boss.telegraph.safeR = 78;
    spawnToast('¡El viento arrasa la sala entera — hay una calma en algún lugar!');
  }
  if(type==='gravityWell'){
    boss.telegraph.t = 1.1; boss.telegraph.dur = 1.1; // slower than boneGrab, but escapable by running early since the well doesn't chase
  }
  if(type==='megaLaser'){
    // a wide sweeping beam (or two, if the twin sister is still alive) that rotates across a big
    // arc — you can't just juke sideways once, you have to get ahead of the sweep and stay there
    const dur = 2.6;
    boss.telegraph.t = dur; boss.telegraph.dur = dur;
    boss.telegraph.hotAt = 0.55; // brief full-arc preview before the beam actually starts burning
    const toPlayerAngle = Math.atan2(p.y-boss.y, p.x-boss.x);
    const sweepDir = Math.random()<0.5 ? 1 : -1;
    const sweepArc = Math.PI*0.8;
    boss.telegraph.sweepDir = sweepDir;
    boss.telegraph.sweepArc = sweepArc;
    boss.telegraph.startAngle = toPlayerAngle - sweepDir*sweepArc/2;
    boss.telegraph.beamLen = Math.max(arenaBounds().w, arenaBounds().h);
    if(boss.twin && boss.twin.alive){
      // the twin's beam sweeps the opposite direction, crossing over the main beam — much less
      // room to hide than a single sweep alone
      const twinToPlayerAngle = Math.atan2(p.y-boss.twin.y, p.x-boss.twin.x);
      boss.telegraph.twinStartAngle = twinToPlayerAngle - (-sweepDir)*sweepArc/2;
    }
    spawnToast('Un rayo gemelo comienza a barrer la sala — anticipate al giro');
  }
  if(type==='acidDeluge'){
    // she retreats to the back of the room and channels — the actual rain is staggered across
    // the whole floor via many individually-timed hazards spawned in resolveBossAttack, so there's
    // no single safe corner to camp in for long
    const bnds = arenaBounds();
    boss.x = clamp(bnds.x+bnds.w/2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(bnds.y+bnds.h*0.14, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    boss.telegraph.t = 0.8; boss.telegraph.dur = 0.8;
    addParticles(boss.x,boss.y,boss.def.color,20,160,0.4);
    spawnToast('La Bruja Madre se retira al fondo y comienza a canalizar');
  }
  if(type==='venomousWeb'){
    boss.telegraph.t = 0.7; boss.telegraph.dur = 0.7; // brief roar before the floor cracks open
  }
  if(type==='infiniteReflections'){
    // a lineup of reflections across the room — only one is real. The real one glows visibly
    // stronger during the wind-up; that's the only tell before they all attack identically
    boss.telegraph.t = 1.8; boss.telegraph.dur = 1.8;
    const bnds = arenaBounds();
    const n = 4;
    const rowY = clamp(p.y + rand(-50,50), bnds.y+90, bnds.y+bnds.h-90);
    const positions = [];
    for(let i=0;i<n;i++){
      positions.push({ x: bnds.x + bnds.w*((i+0.5)/n), y: rowY, real:false });
    }
    positions[Math.floor(Math.random()*n)].real = true;
    boss.telegraph.reflectPositions = positions;
    spawnToast('Reflejos idénticos llenan la sala — fijate cuál brilla de verdad');
  }
  if(type==='boundlessBeam'){
    boss.telegraph.t = 0.7; boss.telegraph.dur = 0.7; // brief wind-up, then the beam starts bouncing
    spawnToast('Un haz de luz va a rebotar entre los espejos de los bordes');
  }
  if(type==='crystalCage'){
    boss.telegraph.t = 0.7; boss.telegraph.dur = 0.7; // brief slam wind-up before the crystals erupt
  }
  if(type==='plasmaBeam' || type==='dawnBeam' || type==='voidBeam'){
    // he anchors to one edge of the arena and charges a beam that travels straight across to
    // the opposite edge — a wall of pressure that forces you to relocate, not just sidestep.
    // dawnBeam (El Sol) reuses this exact mechanic with its own color/toast — a beam of light
    // instead of plasma, but mechanically the same fair 3/4-arena sweep.
    const dur = 2.4;
    boss.telegraph.t = dur; boss.telegraph.dur = dur;
    boss.telegraph.hotAt = 0.6;
    const bnds = arenaBounds();
    const vertical = Math.random()<0.5; // vertical=true: beam is a vertical line sweeping left<->right
    boss.telegraph.vertical = vertical;
    const fromStart = Math.random()<0.5;
    boss.telegraph.fromStart = fromStart;
    if(vertical){
      boss.x = fromStart ? bnds.x+boss.radius : bnds.x+bnds.w-boss.radius;
      boss.y = clamp(p.y, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    } else {
      boss.y = fromStart ? bnds.y+boss.radius : bnds.y+bnds.h-boss.radius;
      boss.x = clamp(p.x, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    }
    spawnToast(type==='dawnBeam' ? '¡Un haz de luz va a atravesar la sala de lado a lado!' : type==='voidBeam' ? '¡Un haz de vacío va a atravesar la sala de lado a lado!' : '¡Un haz de plasma va a atravesar la sala de lado a lado!');
  }
  if(type==='geoSweep'){
    // El Sol anchors to one edge and charges twin parallel walls of magenta plasma that sweep
    // across together — always vertical per the reference ("perfectamente verticales")
    const dur = 2.6;
    boss.telegraph.t = dur; boss.telegraph.dur = dur;
    boss.telegraph.hotAt = 0.7;
    boss.telegraph.gap = 170;
    const bnds = arenaBounds();
    const fromStart = Math.random()<0.5;
    boss.telegraph.fromStart = fromStart;
    boss.x = fromStart ? bnds.x+boss.radius : bnds.x+bnds.w-boss.radius;
    boss.y = clamp(p.y, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    spawnToast('¡Dos paredes de plasma geomagnético barren la sala — buscá el hueco entre ellas!');
  }
  if(type==='stormSpiral'){
    const dur=4.4;
    boss.telegraph.t=dur; boss.telegraph.dur=dur;
    boss.telegraph.hotAt=0.5;
    boss.telegraph.spiralAngle=0;
    boss.telegraph.spiralTick=0;
    spawnToast('¡El Sol gira sobre sí mismo — una tormenta estelar en espiral comienza!');
  }
  if(type==='eruptionConvergence'){
    boss.telegraph.t = 1.0; boss.telegraph.dur = 1.0;
    spawnToast('El Sol se pone blanco brillante — algo enorme se está gestando');
  }
  if(type==='zeroGravityRings'){
    boss.telegraph.t = 0.6; boss.telegraph.dur = 0.6;
    spawnToast('¡La gravedad se altera! Prepará el cuerpo para moverte más lento');
  }
  if(type==='totalCollapse'){
    startSunSupernova(boss);
    boss.telegraph.t = 999; boss.telegraph.dur = 999; // ended explicitly by finishSunSupernova, not by t reaching 0
  }
  if(type==='iceSlide'){
    boss.telegraph.t = 0.6; boss.telegraph.dur = 0.6;
    boss.iceSlideActive = true;
    boss.iceSlideTimer = 5;
    boss.slideGustTimer = 1.0;
    p.iceSlideTimer = Math.max(p.iceSlideTimer||0, 5);
    spawnToast('¡El suelo se congela — perdés tracción! Cuidado con las ráfagas');
    addParticles(p.x,p.y,'#c8ecff',18,120,0.35);
  }
  if(type==='growingSpikes'){
    boss.telegraph.t = 0.6; boss.telegraph.dur = 0.6;
  }
  if(type==='absoluteZero'){
    boss.telegraph.t = 0.7; boss.telegraph.dur = 0.7;
    boss.blizzardActive = true;
    boss.blizzardTimer = 7.5;
    boss.blizzardGustTimer = 1.2;
    boss.lastPX = p.x; boss.lastPY = p.y;
    spawnToast('¡Una ventisca masiva cubre la sala — mantenete en movimiento!');
    shake(6);
  }
  if(type==='movingIceWalls'){
    boss.telegraph.t = 0.65; boss.telegraph.dur = 0.65;
  }
  if(type==='iceAvalanche'){
    const bnds = arenaBounds();
    boss.x = clamp(bnds.x+bnds.w/2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(bnds.y+bnds.h*0.14, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    boss.telegraph.t = 0.9; boss.telegraph.dur = 0.9;
  }
  if(type==='solarSporeSpiral'){
    const dur=3.6;
    boss.telegraph.t=dur; boss.telegraph.dur=dur;
    boss.telegraph.hotAt=0.5;
    boss.telegraph.spiralAngle=0;
    boss.telegraph.spiralTick=0;
    spawnToast('Espirales de polen solar comienzan a girar');
  }
  if(type==='lightSeeds'){
    boss.telegraph.t=0.6; boss.telegraph.dur=0.6;
  }
  if(type==='dandelionWave'){
    const bndsD=arenaBounds();
    boss.y = clamp(bndsD.y+bndsD.h*0.18, bndsD.y+boss.radius, bndsD.y+bndsD.h-boss.radius);
    boss.telegraph.t=0.6; boss.telegraph.dur=0.6;
  }
  if(type==='lightDeluge'){
    const durLD=3.4;
    boss.telegraph.t=durLD; boss.telegraph.dur=durLD;
    boss.telegraph.hotAt=0.45;
    boss.telegraph.delugeAngle=0;
    boss.telegraph.delugeTick=0;
    spawnToast('Una flor de luz florece hacia afuera');
  }
  if(type==='prismaticCascade'){
    const durPC=3.8;
    boss.telegraph.t=durPC; boss.telegraph.dur=durPC;
    boss.telegraph.hotAt=0.4;
    boss.telegraph.cascadeTick=0;
    boss.telegraph.gapX=arenaBounds().x+arenaBounds().w/2;
    spawnToast('Filas de luz empiezan a caer del techo');
  }
  if(type==='radiantMandala'){
    const durM=3.6;
    boss.telegraph.t=durM; boss.telegraph.dur=durM;
    boss.telegraph.hotAt=0.45;
    boss.telegraph.mandalaAngleA=0;
    boss.telegraph.mandalaAngleB=0;
    boss.telegraph.mandalaTick=0;
    spawnToast('Dos mandalas de luz giran en direcciones opuestas');
  }
  if(type==='pincerScan'){
    const bndsP=arenaBounds();
    boss.x = bndsP.x+60; boss.y = bndsP.y+100;
    if(boss.twin && boss.twin.alive){ boss.twin.x = bndsP.x+bndsP.w-60; boss.twin.y = bndsP.y+100; }
    const durP=2.6;
    boss.telegraph.t=durP; boss.telegraph.dur=durP;
    boss.telegraph.hotAt=0.5;
    boss.telegraph.laserY = bndsP.y+40;
    boss.telegraph.waveTimer=0.7;
    spawnToast('Los ojos se posicionan en los extremos — buscá el hueco en el medio');
  }
  if(type==='orbitalCross'){
    const durO=4.2;
    boss.telegraph.t=durO; boss.telegraph.dur=durO;
    boss.telegraph.hotAt=0.7;
    const bndsO=arenaBounds();
    boss.telegraph.orbitCX = bndsO.x+bndsO.w/2;
    boss.telegraph.orbitCY = bndsO.y+bndsO.h*0.38;
    boss.telegraph.orbitR = 130;
    boss.telegraph.orbitAngle = 0;
    boss.telegraph.orbitFireTimer = 0.9;
    // used to snap straight onto the orbit circle the instant this was picked, which looked like
    // a teleport if the boss was elsewhere in the room — now it remembers where it actually was
    // and eases onto the orbit over hotAt seconds instead of jumping
    boss.telegraph.orbitStartBX = boss.x; boss.telegraph.orbitStartBY = boss.y;
    boss.telegraph.orbitStartTX = boss.twin ? boss.twin.x : boss.x;
    boss.telegraph.orbitStartTY = boss.twin ? boss.twin.y : boss.y;
    spawnToast('Las gemelas giran una alrededor de la otra');
  }
  if(type==='desperateRush'){
    const hasTwin = boss.twin && boss.twin.alive;
    boss.telegraph.beaconIsMain = hasTwin ? Math.random()<0.5 : true;
    const durR=2.5;
    boss.telegraph.t=durR; boss.telegraph.dur=durR;
    boss.telegraph.hotAt=1.5;
    boss.telegraph.lockX=p.x; boss.telegraph.lockY=p.y;
    spawnToast('Un ojo te fija con la mira mientras el otro se prepara a embestir');
  }
  if(type==='energyBond'){
    const bndsE=arenaBounds();
    // used to spawn both eyes on the exact same tile (twin.x/y = boss.x/y), so the "cable between
    // them" was a zero-length line and the danger zone collapsed to a single point instead of a
    // wall — now they properly flank the player with a fixed gap, and advance together as a pair
    const gapE = 260;
    const dirE = Math.random()<0.5 ? 1 : -1;
    const centerX = clamp(p.x, bndsE.x+gapE/2+40, bndsE.x+bndsE.w-gapE/2-40);
    const yE = clamp(p.y, bndsE.y+70, bndsE.y+bndsE.h-70);
    boss.x = centerX - gapE/2; boss.y = yE;
    if(boss.twin && boss.twin.alive){ boss.twin.x = centerX + gapE/2; boss.twin.y = yE; }
    const durE=4.2;
    boss.telegraph.t=durE; boss.telegraph.dur=durE;
    boss.telegraph.hotAt=0.4;
    boss.telegraph.bondDir = dirE;
    boss.telegraph.bondGap = gapE;
    boss.telegraph.bondCenterX = centerX;
    boss.telegraph.bondGapY = yE;
    spawnToast('Las gemelas se colocan a cada lado tuyo y tienden un cable de energía');
  }
  if(type==='circuitPanels'){
    boss.telegraph.t=0.5; boss.telegraph.dur=0.5;
  }
  if(type==='polarityPull'){
    boss.telegraph.t=0.5; boss.telegraph.dur=0.5;
  }
  if(type==='closingBarrier'){
    boss.telegraph.t=0.5; boss.telegraph.dur=0.5;
  }
  if(type==='predictiveLightning'){
    const durL=3.0;
    boss.telegraph.t=durL; boss.telegraph.dur=durL;
    boss.telegraph.hotAt=2.0;
    boss.telegraph.lockX=p.x;
    spawnToast('Una mira de rayo empieza a seguir tus pasos');
  }
  if(type==='massSingularity'){
    boss.telegraph.t=0.6; boss.telegraph.dur=0.6;
  }
  if(type==='gravityFlip'){
    boss.telegraph.t=0.6; boss.telegraph.dur=0.6;
  }
  if(type==='voidCrackCollapse'){
    boss.telegraph.t=0.5; boss.telegraph.dur=0.5;
  }
  if(type==='eventHorizonPulse'){
    boss.telegraph.t=0.6; boss.telegraph.dur=0.6;
  }
  addParticles(boss.x,boss.y, boss.def.color, 10, 100, 0.6);
  if(boss.isGuardian){
    // guardians give you noticeably less warning before an attack lands than the same attack
    // from a regular floor boss — the read-and-react window itself shrinks, which is what
    // actually makes an attack harder to dodge
    boss.telegraph.t *= 0.8;
    boss.telegraph.dur *= 0.8;
  }
  showAttackBanner(boss, type);
}

// ---- Boss dash engine --------------------------------------------------------------------
// Dash-type boss attacks used to move the boss the *entire* distance inside a single instant —
// the whole for-loop of position updates ran within one frame, right when the telegraph ended —
// which reads as a teleport (blink to the destination) rather than a dash, and gives you zero
// real time to react to the movement itself (only to the telegraph beforehand). They now travel
// over real time via game.boss.dashes (an array, since more than one mover — e.g. Twin Eyes — can
// dash at once), and the hit check runs continuously along the path instead of once at the very
// end, so stepping aside *during* the dash can actually save you. See updateBossDashes(dt),
// called every frame from updateBoss(dt), and the movement-AI gate right below it.
function startBossDash(mover, ang, dashDist, opts){
  const boss = game.boss;
  if(!boss) return null;
  opts = opts || {};
  if(!boss.dashes) boss.dashes = [];
  const radius = opts.radius!==undefined ? opts.radius : (mover.radius||boss.radius);
  const rec = {
    mover, ang, sx:mover.x, sy:mover.y, dist:dashDist, radius,
    dur: opts.dur!==undefined ? opts.dur : Math.max(0.14, dashDist/(opts.speed||900)),
    t:0, dmg: opts.dmg!==undefined ? opts.dmg : boss.dmg,
    hitPad: opts.hitPad!==undefined ? opts.hitPad : 12,
    hit:false, steps: opts.steps||0, stepsFired:0,
    onStep: opts.onStep||null, onComplete: opts.onComplete||null
  };
  boss.dashes.push(rec);
  return rec;
}

function updateBossDashes(dt){
  const boss = game.boss;
  if(!boss || !boss.dashes || !boss.dashes.length) return;
  const p = game.player;
  const b = arenaBounds();
  const done = [];
  boss.dashes.forEach(d=>{
    d.t += dt;
    const prog = clamp(d.t/d.dur, 0, 1);
    d.mover.x = clamp(d.sx + Math.cos(d.ang)*d.dist*prog, b.x+d.radius, b.x+b.w-d.radius);
    d.mover.y = clamp(d.sy + Math.sin(d.ang)*d.dist*prog, b.y+d.radius, b.y+b.h-d.radius);
    if(d.steps>0 && d.onStep){
      const targetStep = Math.min(d.steps, Math.floor(prog*d.steps+1e-6)+1);
      while(d.stepsFired < targetStep){ d.onStep(d.stepsFired, d.mover); d.stepsFired++; }
    }
    if(!d.hit && dist(d.mover.x,d.mover.y,p.x,p.y) < d.radius+p.radius+d.hitPad){
      d.hit = true;
      hitPlayer(d.dmg);
    }
    if(prog>=1){ if(d.onComplete) d.onComplete(d.mover); done.push(d); }
  });
  if(done.length) boss.dashes = boss.dashes.filter(d=>done.indexOf(d)===-1);
}

function resolveBossAttack(type, tg){
  const p = game.player;
  const boss = game.boss;
  const b = arenaBounds();
  const targetX = tg ? tg.tx : p.x;
  const targetY = tg ? tg.ty : p.y;
  if(type==='charge'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=220;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg, hitPad: 14,
      onComplete: ()=>{ shake(8); addParticles(boss.x,boss.y,boss.def.color,16,220,0.4); }
    });
  } else if(type==='boneShards'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=7;
    for(let i=0;i<n;i++){
      const a = ang + (i-(n-1)/2)*0.13;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.6, radius:7, owner:'enemy', color:boss.def.color, life:2.4, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,14,150,0.4);
    shake(5);
  } else if(type==='summon'){
    addParticles(boss.x,boss.y,boss.def.color,14,90,0.3);
    spawnShockwave(boss.x,boss.y,boss.def.color,60,0.3);
    for(let i=0;i<2;i++){
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
    }
    spawnToast('El jefe invoca refuerzos');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
      addParticles(boss.x,boss.y,boss.def.color,10,80,0.25);
      spawnToast('Un refuerzo más se levanta');
    });
  } else if(type==='radialBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
        dmg:boss.dmg*0.7, radius:8, owner:'enemy', color:boss.def.color, life:2.2 });
    }
    shake(6);
  } else if(type==='boneSlam'){
    const r=150;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#d9cdb3',28,260,0.5);
    spawnShockwave(boss.x,boss.y,'#d9cdb3',r,0.4);
    shake(9);
  } else if(type==='blinkStrike'){
    if(dist(boss.x,boss.y,p.x,p.y)<boss.radius+p.radius+30) hitPlayer(boss.dmg*0.7);
    addParticles(boss.x,boss.y,boss.def.color,10,150,0.3);
    shake(4);
  } else if(type==='slam'){
    const r=170;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    addParticles(boss.x,boss.y,'#ff5a3d',32,280,0.55);
    spawnShockwave(boss.x,boss.y,'#ff5a3d',r,0.45);
    shake(11);
  } else if(type==='magmaCross'){
    // fire erupts from the boss's own position in a fixed cross, unlike the scattered rings other bosses use
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    dirs.forEach(([dx,dy])=>{
      for(let k=1;k<=3;k++){
        const hx = clamp(boss.x+dx*k*58, b.x+22, b.x+b.w-22);
        const hy = clamp(boss.y+dy*k*58, b.y+22, b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:30, type:'fire', telegraph:0.6, active:1.3, tick:0, dmg:boss.dmg*0.5 });
      }
    });
    addParticles(boss.x, boss.y, '#ff5a3d', 24, 180, 0.4);
    spawnToast('El magma se abre en cruz');
  } else if(type==='blazingFissure'){
    // a solid crack of fire splits the arena in a straight line through where you were standing,
    // leaving exactly one gap open — find it and get through
    const vertical = Math.random()<0.5;
    const gapFrac = rand(0.22,0.78);
    const segments = 9;
    for(let i=0;i<segments;i++){
      const frac = i/(segments-1);
      if(Math.abs(frac-gapFrac) < 0.09) continue; // the escape gap
      let hx,hy;
      if(vertical){ hx = clamp(targetX, b.x+30,b.x+b.w-30); hy = clamp(b.y+30+frac*(b.h-60), b.y+30, b.y+b.h-30); }
      else { hy = clamp(targetY, b.y+30,b.y+b.h-30); hx = clamp(b.x+30+frac*(b.w-60), b.x+30, b.x+b.w-30); }
      game.hazards.push({ x:hx, y:hy, r:34, type:'fire', telegraph:0.7, active:1.4, tick:0, dmg:boss.dmg*0.55 });
    }
    addParticles(boss.x,boss.y,'#ff5a3d',20,180,0.4);
    spawnToast('Una fisura de fuego parte la arena en dos');
  } else if(type==='growingMagma'){
    // erupts small at your feet but keeps spreading for its whole duration — standing still is fatal
    game.hazards.push({ x:targetX, y:targetY, r:18, type:'fire', telegraph:0.5, active:2.2, tick:0, dmg:boss.dmg*0.45,
      expanding:true, expandRate:58 });
    addParticles(targetX,targetY,'#ff5a3d',18,160,0.4);
    spawnToast('El magma no deja de crecer');
  } else if(type==='fireRain'){
    for(let i=0;i<4;i++){
      const hx = clamp(targetX+rand(-140,140), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-140,140), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'fire', telegraph:0.7, active:1.8, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('El suelo arde bajo tus pies');
  } else if(type==='butterflyBurst'){
    const n=16;
    for(let i=0;i<n;i++){
      const ang = (i/n)*Math.PI*4;
      const speed = 160+(i%2)*40;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color: i%2?'#ffd6f0':'#ffcb47', life:2.4, shape:'feather' });
    }
    addParticles(boss.x,boss.y,'#ffb3ec',22,180,0.5);
  } else if(type==='prismDash'){
    const doPrismBlink = (n)=>{
      if(n>=3){ shake(7); return; }
      const ang = Math.atan2(p.y-boss.y, p.x-boss.x) + rand(-0.5,0.5);
      startBossDash(boss, ang, 140, {
        dmg: boss.dmg*0.6, hitPad: 10, dur: 0.1, steps: 6,
        onStep: ()=>{ spawnAfterimage(boss.x, boss.y, boss.radius, boss.def.color); addParticles(boss.x,boss.y,boss.def.color,3,80,0.3); },
        onComplete: ()=>doPrismBlink(n+1)
      });
    };
    doPrismBlink(0);
  } else if(type==='radiantNova'){
    const n=14;
    for(let ring=0; ring<2; ring++){
      for(let i=0;i<n;i++){
        const ang = (i/n)*Math.PI*2 + (ring?Math.PI/n:0);
        const speed = 180+ring*70;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.6, radius:8, owner:'enemy', color: ring?'#ffcb47':'#ffb3ec', life:2.4, shape:'orb' });
      }
    }
    shake(8);
  } else if(type==='boneCage'){
    const n=6;
    for(let k=0;k<n;k++){
      const ang=(k/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+22, b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+22, b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:28, type:'spike', telegraph:0.55, active:0.9, tick:0, dmg:boss.dmg*0.6 });
    }
    addParticles(targetX, targetY, '#d9cdb3', 20, 160, 0.4);
    spawnToast('Huesos brotan a tu alrededor');
  } else if(type==='poisonPool'){
    for(let i=0;i<3;i++){
      const hx = clamp(targetX+rand(-160,160), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-160,160), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:52, type:'poison', telegraph:0.6, active:3.2, tick:0, dmg:boss.dmg*0.28 });
    }
    addParticles(targetX, targetY, '#8bff6b', 22, 130, 0.45);
    spawnToast('El pantano exhala veneno');
  } else if(type==='meteor'){
    game.hazards.push({ x:targetX, y:targetY, r:95, type:'fire', telegraph:1.1, active:0.5, tick:0, dmg:boss.dmg*1.6 });
    addParticles(targetX, targetY, '#ff5a3d', 34, 260, 0.6);
    spawnToast('Algo cae del cielo');
    shake(4);
  } else if(type==='rainbowLine'){
    const dir = Math.random()<0.5 ? 1 : -1;
    const rows=3;
    for(let r=0;r<rows;r++){
      const y = clamp(b.y + b.h*(0.2+r*0.3), b.y+20, b.y+b.h-20);
      for(let k=0;k<6;k++){
        spawnProjectile({ x: dir>0? b.x-20-k*26 : b.x+b.w+20+k*26, y,
          vx: dir*260, vy:0, dmg:boss.dmg*0.45, radius:8, owner:'enemy',
          color: ['#ffb3ec','#ffcb47','#6a8dff'][k%3], life:3, shape:'orb' });
      }
    }
    shake(5);
  } else if(type==='spiralBloom'){
    const arms=5, perArm=6;
    const baseAng = Math.random()*Math.PI*2;
    for(let a=0;a<arms;a++){
      for(let k=0;k<perArm;k++){
        const ang = baseAng + (a/arms)*Math.PI*2 + k*0.11;
        const speed = 120+k*14;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color: k%2?'#ffd6f0':'#ffcb47', life:2.6, shape:'feather' });
      }
    }
    addParticles(boss.x,boss.y,'#ffb3ec',18,150,0.4);
  } else if(type==='petalRing'){
    const n=20;
    const gapIndex = Math.floor(Math.random()*n);
    for(let ring=0; ring<2; ring++){
      for(let i=0;i<n;i++){
        if(i===gapIndex || i===(gapIndex+1)%n) continue; // dodge window
        const ang = (i/n)*Math.PI*2 + (ring?(Math.PI/n):0);
        const speed = 140+ring*50;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.4, radius:7, owner:'enemy', color: ring?'#6a8dff':'#ffb3ec', life:2.8, shape:'feather' });
      }
    }
    addParticles(boss.x,boss.y,'#ffcb47',20,170,0.45);
  } else if(type==='boneWall'){
    const dir = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let k=0;k<6;k++){
      const dd = 60+k*55;
      const hx = clamp(boss.x+Math.cos(dir)*dd, b.x+20, b.x+b.w-20);
      const hy = clamp(boss.y+Math.sin(dir)*dd, b.y+20, b.y+b.h-20);
      game.hazards.push({ x:hx, y:hy, r:34, type:'spike', telegraph:0.5, active:1.0, tick:0, dmg:boss.dmg*0.7 });
    }
    spawnToast('Una muralla de huesos avanza');
  } else if(type==='curseMark'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x, y:boss.y, vx:Math.cos(ang)*95, vy:Math.sin(ang)*95,
      dmg:boss.dmg*0.9, radius:14, owner:'enemy', color:'#a44fd9', life:5.5, homing:true, poison:true, shape:'wisp' });
    spawnToast('Una marca maldita te persigue');
  } else if(type==='lavaGeyser'){
    for(let k=0;k<5;k++){
      const hx = rand(b.x+40, b.x+b.w-40);
      const hy = rand(b.y+40, b.y+b.h-40);
      game.hazards.push({ x:hx, y:hy, r:55, type:'fire', telegraph:0.9, active:1.2, tick:0, dmg:boss.dmg*0.6 });
    }
    spawnToast('El suelo entero burbujea');
  } else if(type==='mirrorSplit'){
    const b2x = clamp(boss.x + (boss.x-p.x)*0.4, b.x+20, b.x+b.w-20);
    const b2y = clamp(boss.y + (boss.y-p.y)*0.4, b.y+20, b.y+b.h-20);
    [{x:boss.x,y:boss.y},{x:b2x,y:b2y}].forEach(origin=>{
      const n=8;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:origin.x,y:origin.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
          dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#e8e8f5', life:2.2, shape:'shard' });
      }
    });
    shake(6);
  } else if(type==='phantomBarrage'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=9;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.13;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
        dmg:boss.dmg*0.45, radius:6, owner:'enemy', color:'#c9c9d4', life:2, shape:'wisp' });
    }
  } else if(type==='echoDash'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const dashDist=260;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.7, hitPad: 12, steps: 6,
      onStep: (i)=>{
        spawnAfterimage(boss.x, boss.y, boss.radius, boss.def.color);
        if(i%2===0) game.hazards.push({ x:boss.x, y:boss.y, r:34, type:'spike', telegraph:0.15, active:0.5, tick:0, dmg:boss.dmg*0.5 });
      },
      onComplete: ()=>{ shake(6); }
    });
  } else if(type==='twinPulse'){
    const origins = [{x:boss.x,y:boss.y}];
    if(boss.twin && boss.twin.alive) origins.push({x:boss.twin.x,y:boss.twin.y});
    origins.forEach(o=>{
      const n=10;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:o.x,y:o.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
          dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#ff9ad1', life:2.2, shape:'orb' });
      }
    });
    shake(6);
  } else if(type==='crossFire'){
    const origins = [{x:boss.x,y:boss.y}];
    if(boss.twin && boss.twin.alive) origins.push({x:boss.twin.x,y:boss.twin.y});
    origins.forEach(o=>{
      const ang = Math.atan2(p.y-o.y, p.x-o.x);
      for(let k=-1;k<=1;k++){
        const a = ang + k*0.22;
        spawnProjectile({ x:o.x,y:o.y, vx:Math.cos(a)*280, vy:Math.sin(a)*280,
          dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:'#ff9ad1', life:2.4, shape:'orb' });
      }
    });
  } else if(type==='boneGrab'){
    const inSafeZone = tg && tg.safeX!==undefined && dist(tg.safeX,tg.safeY,p.x,p.y) < tg.safeR;
    if(!inSafeZone){
      hitPlayer(boss.dmg*0.8);
      addParticles(p.x,p.y,boss.def.color,18,150,0.35);
      shake(7);
    } else {
      spawnToast('Encontraste el ojo de calma y el viento pasó de largo');
      addParticles(p.x,p.y,'#8bff6b',16,100,0.3);
    }
  } else if(type==='wither'){
    p.witherTimer = Math.max(p.witherTimer||0, 5);
    spawnToast('Sentís que tu fuerza se marchita');
    addParticles(p.x,p.y,'#a44fd9',22,140,0.4);
  } else if(type==='acidDeluge'){
    // El Gran Colapso: massive toxic stalactites and acid drops rain down across nearly the
    // entire arena, staggered so no one spot stays safe for long — keep moving, don't camp
    const n=22;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+34, b.x+b.w-34);
      const hy = rand(b.y+34, b.y+b.h-34);
      game.hazards.push({ x:hx, y:hy, r:34+Math.random()*22, type:'poison',
        telegraph:0.4+Math.random()*2.6, active:0.5, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('¡Un diluvio ácido cae del techo sobre toda la sala!');
    shake(5);
  } else if(type==='venomousWeb'){
    // Brote de la Red Venenosa: the floor cracks open across almost the whole arena and thorned,
    // poisoned vines erupt everywhere except a carved-out path — a temporary maze you have to
    // actually navigate, not just an area to step out of once
    const cols=7, rows=5;
    const cellW = b.w/cols, cellH = b.h/rows;
    const safeCells = new Set();
    let row = Math.floor(Math.random()*rows);
    for(let col=0; col<cols; col++){
      safeCells.add(col+','+row);
      const r2 = Math.random();
      if(r2<0.35 && row>0){ row--; safeCells.add(col+','+row); }
      else if(r2>0.65 && row<rows-1){ row++; safeCells.add(col+','+row); }
    }
    for(let col=0; col<cols; col++){
      for(let r2=0; r2<rows; r2++){
        if(safeCells.has(col+','+r2)) continue;
        const hx = b.x + cellW*(col+0.5);
        const hy = b.y + cellH*(r2+0.5);
        game.hazards.push({ x:hx, y:hy, r:Math.min(cellW,cellH)*0.42, type:'poison',
          telegraph:0.6+Math.random()*0.4, active:5.5, tick:0, dmg:boss.dmg*0.32 });
      }
    }
    spawnToast('¡El suelo se agrieta — lianas venenosas brotan por toda la arena!');
    shake(6);
  } else if(type==='infiniteReflections'){
    // only the real reflection's burst actually deals damage — the decoys fire the same shape
    // but are pure light, harmless if you'd bet on the wrong one and lived
    (tg.reflectPositions||[]).forEach(pos=>{
      const n=8;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        if(pos.real){
          spawnProjectile({ x:pos.x,y:pos.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
            dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:'#e8e8f5', life:2, shape:'shard' });
        }
      }
      addParticles(pos.x,pos.y, pos.real?'#e8e8f5':'#5a5a6a', pos.real?18:8, pos.real?170:70, 0.35);
    });
    spawnToast('El reflejo verdadero ataca — los demás eran solo luz');
    shake(5);
  } else if(type==='boundlessBeam'){
    // a beam bouncing between mirrors at the left and right edges, dropping to a new row each
    // bounce — each row leaves exactly one gap, and the gap moves every time
    const bounces = 6;
    const gapW = 130;
    let curY = b.y + 80;
    const stepY = (b.h-160)/(bounces-1);
    for(let i=0;i<bounces;i++){
      const gapX = rand(b.x+gapW, b.x+b.w-gapW);
      const segCount = 11;
      for(let s=0;s<segCount;s++){
        const hx = b.x + (s+0.5)*(b.w/segCount);
        if(Math.abs(hx-gapX) < gapW/2) continue; // the gap stays open — this is where you walk through
        game.hazards.push({ x:hx, y:curY, r:24, type:'light', telegraph:0.5+i*0.55, active:0.4, tick:0, dmg:boss.dmg*0.4 });
      }
      curY += stepY;
    }
  } else if(type==='crystalCage'){
    // crystal walls box you into a small area around where you were standing — one wall is a
    // breakable weak point (a core with HP), the rest just hurt if you push through them. From
    // inside, a frontal rain of shards keeps coming until you break out or it runs its course
    const cx = tg.tx, cy = tg.ty;
    const boxR = 105;
    const weakSide = Math.floor(Math.random()*4); // 0=left,1=right,2=top,3=bottom
    const sides = [ {dx:-1,dy:0}, {dx:1,dy:0}, {dx:0,dy:-1}, {dx:0,dy:1} ];
    boss.cores = (boss.cores||[]).filter(c=>c.alive); // keep any still-alive cores from elsewhere
    let weakCore = null;
    sides.forEach((side, idx)=>{
      const wallX = clamp(cx+side.dx*boxR, b.x+20, b.x+b.w-20);
      const wallY = clamp(cy+side.dy*boxR, b.y+20, b.y+b.h-20);
      if(idx===weakSide){
        weakCore = { x:wallX, y:wallY, hp:34, maxHp:34, radius:26, hitFlash:0, isCore:true, alive:true };
        boss.cores.push(weakCore);
      } else {
        const perpX = side.dy, perpY = -side.dx;
        for(let s=-1;s<=1;s++){
          const hx = clamp(wallX + perpX*s*36, b.x+16, b.x+b.w-16);
          const hy = clamp(wallY + perpY*s*36, b.y+16, b.y+b.h-16);
          game.hazards.push({ x:hx, y:hy, r:22, type:'spike', telegraph:0.25, active:2.7, tick:0, dmg:boss.dmg*0.35 });
        }
      }
    });
    boss.cageActive = true;
    boss.cageTimer = 2.8;
    boss.cageShardTimer = 0.15;
    boss.cageCX = cx; boss.cageCY = cy;
    boss.cageWallCore = weakCore;
    boss.attackTimer = Math.max(boss.attackTimer||0, 3.2); // hold off her normal rotation until the cage plays out
    spawnToast('¡Cristales te encierran! Rompé el punto débil brillante para escapar');
    shake(7);
  } else if(type==='plasmaBeam'){
    // all the damage already happened during the sweep itself (see the per-frame update)
    spawnToast('El haz de plasma se disipa');
    addParticles(boss.x,boss.y,'#ff6a3d',18,160,0.35);
    shake(4);
  } else if(type==='dawnBeam'){
    spawnToast('El haz de luz se disipa');
    addParticles(boss.x,boss.y,'#fff3c4',18,160,0.35);
    shake(4);
  } else if(type==='voidBeam'){
    spawnToast('El haz de vacío se disipa');
    addParticles(boss.x,boss.y,'#a070c0',18,160,0.35);
    shake(4);
  } else if(type==='solarSporeSpiral'){
    spawnToast('El polen solar se disipa');
    addParticles(boss.x,boss.y,'#ffe08a',18,140,0.35);
  } else if(type==='lightSeeds'){
    const n=5;
    for(let i=0;i<n;i++){
      const sx = b.x+b.w*((i+0.5)/n);
      const sy = rand(b.y+80,b.y+b.h-80);
      game.hazards.push({ x:sx, y:sy, r:26, type:'light', telegraph:2.0, active:1.1, tick:0, dmg:boss.dmg*0.85 });
    }
    spawnToast('Semillas de luz caen y echan raíces — buscá el hueco antes de que broten');
  } else if(type==='dandelionWave'){
    const fromLeftD = Math.random()<0.5;
    boss.dandelionActive = true;
    boss.dandelionTimer = 4.5;
    boss.dandelionX = fromLeftD ? b.x-40 : b.x+b.w+40;
    boss.dandelionY = boss.y;
    boss.dandelionVX = fromLeftD ? 70 : -70;
    boss.dandelionSeedTimer = 0.4;
    spawnToast('Un diente de león gigante avanza soltando semillas');
  } else if(type==='lightDeluge'){
    spawnToast('El diluvio de luz se disipa');
    addParticles(boss.x,boss.y,'#ffb0d9',18,150,0.35);
  } else if(type==='prismaticCascade'){
    spawnToast('La cascada prismática se detiene');
    addParticles(boss.x,boss.y,'#ffe6a0',16,140,0.3);
  } else if(type==='radiantMandala'){
    spawnToast('El mandala radiante se apaga');
    addParticles(boss.x,boss.y,'#c9a8ff',20,160,0.35);
  } else if(type==='pincerScan'){
    spawnToast('¡Los ojos escanean la sala desde los extremos!');
  } else if(type==='orbitalCross'){
    spawnToast('Las gemelas comienzan su baile orbital');
  } else if(type==='desperateRush'){
    const rammer = tg.beaconIsMain ? (boss.twin&&boss.twin.alive?boss.twin:boss) : boss;
    const angR = Math.atan2(tg.lockY-rammer.y, tg.lockX-rammer.x);
    const dashDistR = Math.max(b.w,b.h)*1.3;
    startBossDash(rammer, angR, dashDistR, {
      dmg: boss.dmg*1.1, hitPad: 12, speed: 1900, radius: rammer.radius||boss.radius,
      onComplete: ()=>{ shake(9); addParticles(rammer.x,rammer.y,boss.def.color,20,220,0.4); }
    });
    spawnToast('¡El ojo embestidor cruza la sala a toda velocidad!');
  } else if(type==='energyBond'){
    spawnToast('El cable de energía se disuelve');
    addParticles(boss.x,boss.y,boss.def.color,16,140,0.3);
  } else if(type==='circuitPanels'){
    boss.circuitActive = true;
    boss.circuitTimer = 0.05;
    boss.circuitIndex = 0;
    boss.circuitCycles = 8;
    spawnToast('El suelo se electrifica en paneles secuenciales');
  } else if(type==='polarityPull'){
    boss.polarityActive = true;
    boss.polarityTimer = 6;
    boss.polarityPhase = 'attract';
    boss.polarityPhaseTimer = 2.2;
    boss.polarityOrbTimer = 0.5;
    spawnToast('Un campo magnético envuelve la sala');
  } else if(type==='closingBarrier'){
    const weakSide = Math.random()<0.5 ? 'left' : 'right';
    boss.barrierActive = true;
    boss.barrierTimer = 7;
    boss.barrierLeftX = b.x;
    boss.barrierRightX = b.x+b.w;
    boss.barrierCloseSpeed = 32;
    boss.barrierWeakSide = weakSide;
    boss.cores = (boss.cores||[]).filter(c=>c.alive);
    boss.barrierCore = { x: weakSide==='left'?b.x:b.x+b.w, y:p.y, hp:38, maxHp:38, radius:26, hitFlash:0, isCore:true, alive:true };
    boss.cores.push(boss.barrierCore);
    spawnToast('Columnas de voltaje avanzan desde los bordes — una tiene una falla');
  } else if(type==='predictiveLightning'){
    // was one giant circle (radius = whole arena!) — now a real narrow column stacked along
    // the locked X, so the danger zone is actually just that vertical strip, not the whole room
    const colR = 34;
    const rows = Math.ceil(b.h/(colR*1.3));
    for(let i=0;i<rows;i++){
      const ly = b.y + colR + i*(colR*1.3);
      game.hazards.push({ x: tg.lockX, y: ly, r: colR, type:'storm', telegraph:0.05, active:0.35, tick:0, dmg:boss.dmg*1.0 });
    }
    spawnToast('¡El rayo cae sobre el punto fijado!');
    shake(8);
  } else if(type==='massSingularity'){
    boss.singularityActive = true;
    boss.singularityTimer = 7;
    boss.singularityCX = b.x+b.w/2;
    boss.singularityCY = b.y+b.h/2;
    boss.singularityWaveTimer = 0.7;
    boss.singularityWaveIndex = 0;
    spawnToast('Una singularidad altera tu peso según hacia dónde camines');
  } else if(type==='gravityFlip'){
    const heavy = Math.random()<0.5;
    p.slowTimer = Math.max(p.slowTimer||0, 5);
    p.slowFactor = heavy ? 0.5 : 1.7;
    boss.gravityFlipActive = true;
    boss.gravityFlipTimer = 4;
    const fromLeftG = Math.random()<0.5;
    boss.gravityFlipBeamX = fromLeftG ? b.x : b.x+b.w;
    boss.gravityFlipBeamVX = (fromLeftG?1:-1)*90;
    addParticles(p.x,p.y,heavy?'#8a5ad9':'#c9a8ff',18,130,0.35);
    spawnToast(heavy ? 'Te volviste pesado: caminás lento' : 'Te volviste liviano: caminás rapidísimo');
  } else if(type==='voidCrackCollapse'){
    boss.crackActive = true;
    boss.crackTimer = 0.05;
    boss.crackRemaining = 3;
    spawnToast('El vacío se abre bajo tus pasos, tres veces seguidas');
  } else if(type==='eventHorizonPulse'){
    boss.pulseActive = true;
    boss.pulseTimer = 0.05;
    boss.pulseRemaining = 4;
    boss.pulseGapAngle = Math.random()*Math.PI*2;
    boss.pulseWave = 0;
    spawnToast('Anillos de vacío pulsan hacia afuera desde el jefe');
  } else if(type==='iceSlide' || type==='absoluteZero'){
    // both are pure channel attacks — everything they do happens in the per-frame handling in
    // updateBoss (slide momentum + gusts, or the freeze meter + gusts); nothing left to resolve
  } else if(type==='growingSpikes'){
    // a single-file line of stalagmites advances from one edge to the other, each segment
    // arriving a beat after the last — one persistent gap moves along as it goes
    const vertical = Math.random()<0.5;
    const n = 9;
    const gapFrac0 = Math.random();
    for(let i=0;i<n;i++){
      const frac = i/(n-1);
      const gapFrac = clamp(gapFrac0 + (Math.random()-0.5)*0.5, 0.08, 0.92);
      const segCount = 8;
      for(let s=0;s<segCount;s++){
        const perp = (s+0.5)/segCount;
        if(Math.abs(perp-gapFrac) < 0.09) continue; // the gap for this row
        let hx,hy;
        if(vertical){ hx = b.x+30+frac*(b.w-60); hy = b.y+perp*b.h; }
        else { hy = b.y+30+frac*(b.h-60); hx = b.x+perp*b.w; }
        game.hazards.push({ x:hx, y:hy, r:24, type:'ice', telegraph:0.35+frac*1.5, active:1.8, tick:0, dmg:boss.dmg*0.42 });
      }
    }
    spawnToast('Estalagmitas avanzan en fila desde el borde de la sala');
  } else if(type==='movingIceWalls'){
    // two or three large ice blocks drift across the room, pushed by wind — smash them early or
    // dodge around them as they cross
    const bnds = { x:b.x, y:b.y, w:b.w, h:b.h };
    const count = Math.random()<0.5 ? 2 : 3;
    const fromLeft = Math.random()<0.5;
    boss.movers = boss.movers || [];
    for(let i=0;i<count;i++){
      const y = bnds.y + bnds.h*((i+1)/(count+1));
      boss.movers.push({
        x: fromLeft ? bnds.x-40 : bnds.x+bnds.w+40, y,
        vx: fromLeft ? 95 : -95, vy:0,
        radius:46, dmg:boss.dmg*0.6, hp:50, maxHp:50, hitFlash:0, isCore:true, breakable:true, alive:true, tick:0,
      });
    }
    spawnToast('Bloques de hielo avanzan empujados por el viento — rompelos o esquivalos');
  } else if(type==='iceAvalanche'){
    // she retreats to the back and rolling boulders come in from one side, lane by lane, each
    // with a brief warning crack before it actually arrives
    const bnds = { x:b.x, y:b.y, w:b.w, h:b.h };
    const lanes = 4;
    const fromLeft = Math.random()<0.5;
    boss.movers = boss.movers || [];
    for(let i=0;i<lanes;i++){
      const y = bnds.y + bnds.h*((i+0.5)/lanes);
      boss.movers.push({
        x: fromLeft ? bnds.x-50 : bnds.x+bnds.w+50, y,
        vx: (fromLeft?1:-1)*(250+Math.random()*50), vy:0,
        radius:28, dmg:boss.dmg*0.5, alive:true, tick:0, isCore:false, breakable:false,
        spawnDelay: 0.5+i*0.4, warnY:y, warnFromLeft:fromLeft,
      });
    }
    spawnToast('¡Una avalancha ruge desde el borde de la sala!');
    shake(8);
  } else if(type==='frostNova'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*210, vy:Math.sin(ang)*210,
        dmg:boss.dmg*0.55, radius:8, owner:'enemy', color:boss.def.color, life:2.4, shape:'orb',
        slow:{factor:0.55,dur:1.1} });
    }
    addParticles(boss.x,boss.y,boss.def.color,20,170,0.4);
    shake(6);
  } else if(type==='iceCage'){
    const n=6;
    for(let k=0;k<n;k++){
      const ang=(k/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+22, b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+22, b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:28, type:'ice', telegraph:0.55, active:0.9, tick:0, dmg:boss.dmg*0.55 });
    }
    addParticles(targetX, targetY, boss.def.color, 20, 160, 0.4);
    spawnToast('El hielo se cierra a tu alrededor');
  } else if(type==='stormBolt'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*620, vy:Math.sin(ang)*620,
      dmg:boss.dmg*0.95, radius:9, owner:'enemy', color:boss.def.color, life:1.2, shape:'orb' });
    addParticles(boss.x,boss.y,boss.def.color,12,140,0.3);
    shake(4);
  } else if(type==='stormField'){
    for(let i=0;i<4;i++){
      const hx = clamp(targetX+rand(-140,140), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-140,140), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:40, type:'storm', telegraph:0.55, active:1.2, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('Rayos golpean el suelo a tu alrededor');
  } else if(type==='voidLance'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x, y:boss.y, vx:Math.cos(ang)*105, vy:Math.sin(ang)*105,
      dmg:boss.dmg*0.85, radius:13, owner:'enemy', color:boss.def.color, life:5, homing:true, shape:'wisp' });
    spawnToast('Una lanza del vacío te persigue');
  } else if(type==='voidRift'){
    for(let i=0;i<3;i++){
      const hx = clamp(targetX+rand(-160,160), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-160,160), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:48, type:'void', telegraph:0.6, active:2.6, tick:0, dmg:boss.dmg*0.32 });
    }
    addParticles(targetX, targetY, boss.def.color, 22, 130, 0.45);
    spawnToast('El vacío se abre bajo tus pies');
  } else if(type==='witchCauldron'){
    // summons a cauldron away from her own body that fires its own spread of poison bolts —
    // the danger comes from a second point in space, not from the witch herself
    const cx = clamp(targetX, b.x+40, b.x+b.w-40), cy = clamp(targetY, b.y+40, b.y+b.h-40);
    const n=4;
    for(let i=0;i<n;i++){
      const ang = Math.atan2(p.y-cy, p.x-cx) + (i-(n-1)/2)*0.22;
      spawnProjectile({ x:cx,y:cy, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:'#8bff6b', life:2.6, poison:true, shape:'wisp' });
    }
    addParticles(cx,cy,'#8bff6b',16,120,0.4);
    spawnToast('La bruja invoca un caldero venenoso');
  } else if(type==='gracefulVeil'){
    // three concentric rings of light close in step by step around where you stood, instead of a
    // single ring or a line — you have to keep moving inward as each one lands
    const cx = clamp(p.x, b.x+60, b.x+b.w-60), cy = clamp(p.y, b.y+60, b.y+b.h-60);
    [220,150,90].forEach((rad, idx)=>{
      const n = 10;
      for(let i=0;i<n;i++){
        const ang = (i/n)*Math.PI*2;
        game.hazards.push({ x:cx+Math.cos(ang)*rad, y:cy+Math.sin(ang)*rad, r:22, type:'light',
          telegraph:0.5+idx*0.55, active:0.5, tick:0, dmg:boss.dmg*0.4 });
      }
    });
    addParticles(cx,cy,boss.def.color,20,140,0.4);
    spawnToast('Un velo de luz se cierra a tu alrededor');
  } else if(type==='glassRain'){
    // a grid of shards covers the floor, leaving one clear row and one clear column as the only
    // safe path — a 2D pattern instead of a line or a ring
    const cols=5, rows=4;
    const safeCol = Math.floor(Math.random()*cols);
    const safeRow = Math.floor(Math.random()*rows);
    for(let cx=0; cx<cols; cx++){
      for(let ry=0; ry<rows; ry++){
        if(cx===safeCol || ry===safeRow) continue;
        const hx = b.x + (cx+0.5)*(b.w/cols);
        const hy = b.y + (ry+0.5)*(b.h/rows);
        game.hazards.push({ x:hx, y:hy, r:34, type:'spike', telegraph:0.75, active:0.6, tick:0, dmg:boss.dmg*0.5 });
      }
    }
    addParticles(boss.x,boss.y,boss.def.color,18,150,0.35);
    spawnToast('El suelo se llena de fragmentos de espejo');
  } else if(type==='blizzardWall'){
    // a wall of ice sweeps across the whole arena from one side to the other, via staggered
    // telegraph timing along a line — you have to outrun it, not just dodge a fixed spot
    const vertical = Math.random()<0.5;
    const n = 10;
    const reverse = Math.random()<0.5;
    for(let i=0;i<n;i++){
      const frac = i/(n-1);
      const delay = reverse ? (1-frac)*1.3 : frac*1.3;
      let hx,hy;
      if(vertical){ hx = b.x+30+frac*(b.w-60); hy = clamp(p.y+rand(-40,40), b.y+30,b.y+b.h-30); }
      else { hy = b.y+30+frac*(b.h-60); hx = clamp(p.x+rand(-40,40), b.x+30,b.x+b.w-30); }
      game.hazards.push({ x:hx, y:hy, r:38, type:'ice', telegraph:0.4+delay, active:0.5, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('Una pared de escarcha barre la arena');
  } else if(type==='frozenGround'){
    // slows you directly (no projectile needed to trigger it) while ice erupts at random points
    // around the arena over the next few seconds
    p.slowTimer = Math.max(p.slowTimer||0, 3.5);
    p.slowFactor = 0.6;
    for(let i=0;i<5;i++){
      const hx = rand(b.x+40,b.x+b.w-40), hy = rand(b.y+40,b.y+b.h-40);
      game.hazards.push({ x:hx, y:hy, r:26, type:'ice', telegraph:0.4+rand(0,1.4), active:0.6, tick:0, dmg:boss.dmg*0.4 });
    }
    addParticles(p.x,p.y,boss.def.color,14,100,0.35);
    spawnToast('El suelo se congela bajo tus pies');
  } else if(type==='chainLightning'){
    // three sharp, deliberate strikes in sequence that jump around your position — a punchy triple
    // hit rather than a wide simultaneous barrage
    const points = [ {x:p.x,y:p.y}, {x:p.x+rand(-160,160),y:p.y+rand(-160,160)}, {x:p.x+rand(-160,160),y:p.y+rand(-160,160)} ];
    points.forEach((pt,idx)=>{
      const hx = clamp(pt.x, b.x+30,b.x+b.w-30), hy = clamp(pt.y, b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:36, type:'storm', telegraph:0.35+idx*0.5, active:0.35, tick:0, dmg:boss.dmg*0.65 });
    });
    spawnToast('El rayo salta de un punto a otro');
  } else if(type==='thunderdome'){
    // a long, chaotic barrage of many random strikes across the whole arena, rather than a
    // deliberate few — pure sustained chaos as the storm's ultimate move
    const n=9;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:30, type:'storm', telegraph:0.3+Math.random()*1.8, active:0.35, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El cielo entero se descarga sobre la arena');
    shake(3);
  } else if(type==='gravityWell'){
    if(dist(tg.tx,tg.ty,p.x,p.y) < 40){
      hitPlayer(boss.dmg*0.9);
      addParticles(p.x,p.y,boss.def.color,20,160,0.4);
      shake(6);
    } else {
      spawnToast('Escapaste del pozo de gravedad a tiempo');
    }
  } else if(type==='megaLaser'){
    // all the damage already happened during the sweep itself (see the per-frame update) — this
    // is just the beam winding down
    spawnToast('El rayo gemelo se apaga');
    addParticles(boss.x,boss.y,'#ff3d3d',18,160,0.35);
    if(boss.twin && boss.twin.alive) addParticles(boss.twin.x,boss.twin.y,'#ff3d3d',18,160,0.35);
    shake(4);
  } else if(type==='starCollapse'){
    // one massive, long-telegraphed detonation centered on the boss itself, instead of many small
    // hazards — a single slow, unmistakable threat
    game.hazards.push({ x:boss.x, y:boss.y, r:150, type:'void', telegraph:1.5, active:0.4, tick:0, dmg:boss.dmg*1.5 });
    spawnToast('Algo colapsa en el centro del vacío...');
  } else if(type==='sisterCall'){
    // a defensive move: the twins heal and briefly shield each other, instead of another attack —
    // the only non-damaging move in the game
    const healAmt = boss.maxHp*0.08;
    boss.hp = Math.min(boss.maxHp, boss.hp+healAmt);
    boss.shieldTimer = Math.max(boss.shieldTimer||0, 3);
    addParticles(boss.x,boss.y,'#ff9ad1',20,150,0.4);
    if(boss.twin && boss.twin.alive){
      boss.twin.hp = Math.min(boss.twin.maxHp, boss.twin.hp+healAmt);
      boss.twin.shieldTimer = Math.max(boss.twin.shieldTimer||0, 3);
      addParticles(boss.twin.x,boss.twin.y,'#ff9ad1',20,150,0.4);
    }
    spawnToast('Las hermanas se protegen mutuamente');
  } else if(type==='eyeLaser'){
    // one eye locks on and fires a fast, precise shot — the "laser eye" half of the pair
    const origins = [{x:boss.x,y:boss.y}];
    if(boss.twin && boss.twin.alive) origins.push({x:boss.twin.x,y:boss.twin.y});
    const src = origins[Math.floor(Math.random()*origins.length)];
    const ang = Math.atan2(p.y-src.y, p.x-src.x);
    spawnProjectile({ x:src.x,y:src.y, vx:Math.cos(ang)*640, vy:Math.sin(ang)*640,
      dmg:boss.dmg*0.9, radius:6, owner:'enemy', color:'#ff4d4d', life:1.1, shape:'orb' });
    addParticles(src.x,src.y,'#ff4d4d',10,120,0.25);
    spawnToast('Un ojo dispara un rayo certero');
  } else if(type==='cursedFlameBreath'){
    // the other eye breathes a cone of cursed flame instead — always from whichever body is
    // currently furthest from the laser eye, so the two feel like distinct roles
    const src = (boss.twin && boss.twin.alive) ? boss.twin : boss;
    const ang0 = Math.atan2(p.y-src.y, p.x-src.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.14;
      spawnProjectile({ x:src.x,y:src.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.45, radius:8, owner:'enemy', color:'#39d97a', life:1.8, shape:'ember' });
    }
    spawnToast('Fuego maldito brota del otro ojo');
  } else if(type==='twinCharge'){
    // both eyes charge you at once from wherever they currently are — the pair's signature
    // "stop circling and come straight at you" beat
    const chargers = [boss];
    if(boss.twin && boss.twin.alive) chargers.push(boss.twin);
    chargers.forEach(t=>{
      const ang = Math.atan2(p.y-t.y, p.x-t.x);
      const rad = t.radius||boss.radius*0.85;
      startBossDash(t, ang, 170, {
        dmg: boss.dmg*0.7, hitPad: 10, radius: rad,
        onComplete: ()=>{ addParticles(t.x,t.y,'#ff9ad1',10,140,0.3); }
      });
    });
    shake(6);
    spawnToast('Ambos ojos embisten a la vez');
  } else if(type==='abyssalCollapse'){
    // the arena's edges become unsafe instead of the center — the opposite of every other ground
    // attack in the game, which threatens outward from a point
    const margin = 70;
    const edges = [
      {x:b.x+margin, y:b.y+b.h/2}, {x:b.x+b.w-margin, y:b.y+b.h/2},
      {x:b.x+b.w/2, y:b.y+margin}, {x:b.x+b.w/2, y:b.y+b.h-margin},
    ];
    edges.forEach(e=>{
      for(let i=0;i<3;i++){
        game.hazards.push({ x:e.x+rand(-50,50), y:e.y+rand(-50,50), r:70, type:'void', telegraph:0.6+i*0.5, active:1.6, tick:0, dmg:boss.dmg*0.4 });
      }
    });
    spawnToast('El abismo se traga los bordes de la arena');
    shake(6);
  } else if(type==='boneCross'){
    const dirs=[[1,0],[-1,0],[0,1],[0,-1]];
    dirs.forEach(([dx,dy])=>{
      for(let k=1;k<=2;k++){
        const hx = clamp(targetX+dx*k*50, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+dy*k*50, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:26, type:'spike', telegraph:0.55, active:0.4, tick:0, dmg:boss.dmg*0.42 });
      }
    });
    spawnToast('Huesos brotan en cruz bajo tus pies');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const diag=[[1,1],[1,-1],[-1,1],[-1,-1]];
      diag.forEach(([dx,dy])=>{
        const hx = clamp(targetX+dx*45, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+dy*45, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:24, type:'spike', telegraph:0.4, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      });
      spawnToast('La cruz se completa en diagonal');
    });
  } else if(type==='boneSpiral'){
    // hazard points trace a bone spiral outward, then a small burst fires from its outer end
    const n=7;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2.6;
      const rad=18+i*15;
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:20, type:'spike', telegraph:0.3+i*0.09, active:0.4, tick:0, dmg:boss.dmg*0.38 });
    }
    spawnToast('Huesos giran en espiral hacia afuera');
    scheduleBossAction(0.3+n*0.09+0.25, ()=>{
      if(!game.boss) return;
      const ang=(n/7)*Math.PI*2.6, rad=18+n*15;
      const ex = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const ey = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:ex,y:ey, vx:Math.cos(a2)*180, vy:Math.sin(a2)*180,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
      addParticles(ex,ey,boss.def.color,10,100,0.25);
    });
  } else if(type==='skullBarrage'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.12;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
    }
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.12;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
          dmg:boss.dmg*0.42, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
      shake(3);
    });
  } else if(type==='graveSpikes'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'spike', telegraph:0.5+Math.random()*1.0, active:0.4, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Huesos brotan al azar por toda la arena');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:70, type:'spike', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.55 });
      spawnToast('Un último hueso enorme cae junto al jefe');
    });
  } else if(type==='boneWhip'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const reach=250;
    const proj = (p.x-boss.x)*Math.cos(ang) + (p.y-boss.y)*Math.sin(ang);
    const perpDist = Math.hypot((p.x-boss.x)-Math.cos(ang)*proj, (p.y-boss.y)-Math.sin(ang)*proj);
    if(proj>0 && proj<reach && perpDist<38) hitPlayer(boss.dmg*0.85);
    addParticles(boss.x+Math.cos(ang)*reach, boss.y+Math.sin(ang)*reach, boss.def.color,10,110,0.22);
    shake(4);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      const proj2 = (p.x-boss.x)*Math.cos(ang2) + (p.y-boss.y)*Math.sin(ang2);
      const perp2 = Math.hypot((p.x-boss.x)-Math.cos(ang2)*proj2, (p.y-boss.y)-Math.sin(ang2)*proj2);
      if(proj2>0 && proj2<reach*0.85 && perp2<38) hitPlayer(boss.dmg*0.7);
      addParticles(boss.x+Math.cos(ang2)*reach*0.85, boss.y+Math.sin(ang2)*reach*0.85, boss.def.color,10,100,0.2);
      shake(3);
      spawnToast('El látigo de huesos vuelve en un revés');
    });
  } else if(type==='deathRattle'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un traqueteo mortal debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:60, type:'spike', telegraph:0.35, active:0.3, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('El traqueteo termina en un golpe seco');
    });
  } else if(type==='hauntingWail'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un lamento entumece tus reflejos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.2);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('El lamento hace eco una vez más');
    });
  } else if(type==='cryptCollapse'){
    // a handful of harmless pre-tremor cracks flicker before the real collapse lands
    const cracks=3;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,90);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:16, type:'spike', telegraph:0.6+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:120, type:'spike', telegraph:1.3, active:0.4, tick:0, dmg:boss.dmg*1.15 });
    spawnToast('La cripta empieza a agrietarse antes de colapsar');
  } else if(type==='boneShrapnel'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.45;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
        dmg:boss.dmg*0.48, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
    }
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const perp = ang0+Math.PI/2;
      [perp, perp+Math.PI].forEach(a=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
      });
      shake(2);
    });
  } else if(type==='graveyardShift'){
    boss.x = clamp(targetX+rand(-40,40), b.x+boss.radius, b.x+b.w-boss.radius);
    boss.y = clamp(targetY+rand(-40,40), b.y+boss.radius, b.y+b.h-boss.radius);
    if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+20) hitPlayer(boss.dmg*0.8);
    spawnShockwave(boss.x,boss.y,boss.def.color,50,0.3);
    spawnToast('Aparece de repente junto a vos');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      spawnShockwave(boss.x,boss.y,boss.def.color,80,0.3);
      if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+34) hitPlayer(boss.dmg*0.4);
    });
  } else if(type==='deathMark'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*100, vy:Math.sin(ang)*100,
      dmg:boss.dmg*0.75, radius:12, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
    spawnToast('Una marca mortal te persigue');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*120, vy:Math.sin(ang2)*120,
        dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
      spawnToast('Una segunda marca se suelta');
    });
  } else if(type==='skeletalSwarm'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.34, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
    }
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
          dmg:boss.dmg*0.3, radius:5, owner:'enemy', color:boss.def.color, life:1.4, shape:'shard' });
      }
    });
  } else if(type==='tombstoneSlam'){
    // a wind-up beat before the ground actually slams
    const r=150;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
      addParticles(boss.x,boss.y,boss.def.color,22,200,0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.35);
      shake(7);
    });
  } else if(type==='ribcage'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*95, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*95, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'spike', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Una jaula de costillas se cierra a tu alrededor');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*55, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*55, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'spike', telegraph:0.35, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('La jaula se cierra más');
    });
  } else if(type==='deathToll'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'spike', telegraph:0.25+frac*0.85, active:0.4, tick:0, dmg:boss.dmg*0.38 });
    }
    spawnToast('Un eco funesto avanza hacia vos');
    scheduleBossAction(1.15, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='skullStorm'){
    // three genuinely staggered rings instead of all firing on the same frame
    const ring = (idx)=>{
      if(!game.boss) return;
      const nR=7, speed=170+idx*60;
      for(let i=0;i<nR;i++){
        const ang=(i/nR)*Math.PI*2 + idx*0.25;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.34, radius:6, owner:'enemy', color:boss.def.color, life:1.9, shape:'shard' });
      }
      shake(3);
    };
    ring(0);
    scheduleBossAction(0.3, ()=>ring(1));
    scheduleBossAction(0.6, ()=>ring(2));
  } else if(type==='gravebind'){
    p.slowTimer = Math.max(p.slowTimer||0, 3);
    p.slowFactor = 0.6;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Manos huesudas se aferran a tus tobillos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.6);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('Otras manos se suman al agarre');
    });
  } else if(type==='boneChain'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    [-0.3,0.3].forEach(off=>{
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang+off)*105, vy:Math.sin(ang+off)*105,
        dmg:boss.dmg*0.5, radius:9, owner:'enemy', color:boss.def.color, life:4.2, homing:true, shape:'shard' });
    });
    spawnToast('Dos marcas óseas te acechan');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      [-0.55,0.55].forEach(off=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2+off)*95, vy:Math.sin(ang2+off)*95,
          dmg:boss.dmg*0.4, radius:8, owner:'enemy', color:boss.def.color, life:3.6, homing:true, shape:'shard' });
      });
      spawnToast('Dos marcas más se suman a la cadena');
    });
  } else if(type==='cryptWhisper'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.08);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Un susurro antiguo restaura sus fuerzas');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=110;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.5);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El susurro se vuelve hostil');
    });
  } else if(type==='deathsDoor'){
    game.hazards.push({ x:targetX, y:targetY, r:20, type:'spike', telegraph:0.5, active:2.0, tick:0, dmg:boss.dmg*0.45, expanding:true, expandRate:52 });
    spawnToast('Una puerta hacia la muerte se abre bajo tus pies');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+24,b.x+b.w-24);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:16, type:'spike', telegraph:0.4, active:1.6, tick:0, dmg:boss.dmg*0.35, expanding:true, expandRate:44 });
      spawnToast('Una segunda puerta se abre cerca');
    });
  } else if(type==='rattlingBones'){
    for(let k=0;k<3;k++){
      game.hazards.push({ x:boss.x, y:boss.y, r:14+k*11, type:'spike', telegraph:0.32*(k+1), active:0.3, tick:0, dmg:boss.dmg*0.42 });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,140,0.3);
    spawnToast('Sus huesos traquetean con fuerza creciente');
    scheduleBossAction(1.05, ()=>{
      if(!game.boss) return;
      const m=8;
      for(let i=0;i<m;i++){
        const ang=(i/m)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*210, vy:Math.sin(ang)*210,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
      shake(5);
    });
  } else if(type==='deathKnell'){
    game.hazards.push({ x:targetX, y:targetY, r:32, type:'spike', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*1.05 });
    spawnToast('Un tañido fúnebre marca el lugar');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:targetX, y:targetY, r:44, type:'spike', telegraph:0.2, active:0.3, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('El tañido resuena una vez más');
    });
  } else if(type==='boneVolley'){
    // a full ring of bone shards, then a second offset ring a beat later — the volley doubles up
    const n=12;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
    }
    shake(5);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
          dmg:boss.dmg*0.42, radius:6, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
      }
      addParticles(boss.x,boss.y,boss.def.color,10,140,0.3);
    });
  } else if(type==='risingSpikes'){
    // an expanding ring starts small at your feet, then a second ring closes in from further out
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*30, y:targetY+Math.sin(ang)*30, r:20, type:'spike',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.5, expanding:true, expandRate:70 });
    }
    addParticles(targetX,targetY,boss.def.color,14,120,0.3);
    spawnToast('Espinas brotan y avanzan hacia afuera');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*70, y:targetY+Math.sin(ang)*70, r:18, type:'spike',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.45, expanding:true, expandRate:-60 });
      }
      spawnToast('Un segundo anillo se cierra hacia adentro');
    });
  } else if(type==='boneArmor'){
    // a self-buff paired with a delayed retaliation burst — hardening isn't just idle
    boss.armorHp = Math.max(boss.armorHp||0, boss.maxHp*0.08);
    addParticles(boss.x,boss.y,boss.def.color,20,130,0.4);
    spawnToast('Sus huesos se endurecen');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      const n=8;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
          dmg:boss.dmg*0.35, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
      }
      spawnToast('La armadura libera una descarga ósea');
    });
  } else if(type==='boneTrap'){
    // two inert decoy telegraphs plus the one real trap — only one of the three actually detonates
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:40, type:'spike', telegraph:0.9, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:46, type:'spike', telegraph:0.9, active:0.3, tick:0, dmg:boss.dmg*1.3 });
    spawnToast('Algo se oculta bajo el polvo... ¿pero dónde?');
  } else if(type==='toxicSpores'){
    // a slow drifting cloud, then a second smaller puff drifts out toward wherever you moved
    const n=6;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.16;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*70, vy:Math.sin(ang)*70,
        dmg:boss.dmg*0.35, radius:11, owner:'enemy', color:'#8bff6b', life:3.4, poison:true, shape:'wisp' });
    }
    spawnToast('Esporas tóxicas flotan hacia vos');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<4;i++){
        const ang = ang1 + (i-1.5)*0.2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*85, vy:Math.sin(ang)*85,
          dmg:boss.dmg*0.3, radius:9, owner:'enemy', color:'#8bff6b', life:2.8, poison:true, shape:'wisp' });
      }
    });
  } else if(type==='swampGrasp'){
    // vines erupt in a tight cluster right under you, then a wider ring catches anyone who dodged out
    const n=5;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*36, y:targetY+Math.sin(ang)*36, r:24, type:'spike',
        telegraph:0.35, active:0.4, tick:0, dmg:boss.dmg*0.55 });
    }
    spawnToast('Enredaderas brotan bajo tus pies');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      const n2=7;
      for(let i=0;i<n2;i++){
        const ang=(i/n2)*Math.PI*2;
        game.hazards.push({ x:targetX+Math.cos(ang)*80, y:targetY+Math.sin(ang)*80, r:20, type:'spike',
          telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('Más enredaderas brotan más lejos');
    });
  } else if(type==='witchesBlessing'){
    // a big self-heal, punished a beat later by a retaliation burst if you stay close
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.12);
    addParticles(boss.x,boss.y,'#7fd98f',22,140,0.4);
    spawnToast('El pantano restaura sus fuerzas');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      const r=110;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.5);
      spawnShockwave(boss.x,boss.y,'#7fd98f',r,0.3);
      spawnToast('La bendición se descarga violentamente');
    });
  } else if(type==='hexTrail'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac = i/(steps-1);
      const hx = clamp(boss.x + (targetX-boss.x)*frac, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y + (targetY-boss.y)*frac, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:26, type:'poison', telegraph:0.25+frac*0.9, active:0.8, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Algo repta hacia vos entre el lodo');
    scheduleBossAction(1.25, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*160, vy:Math.sin(a2)*160,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:boss.def.color, life:1.6, poison:true, shape:'wisp' });
      }
    });
  } else if(type==='mudSlow'){
    p.slowTimer = Math.max(p.slowTimer||0, 3);
    p.slowFactor = 0.62;
    addParticles(p.x,p.y,'#7fd98f',14,90,0.35);
    spawnToast('El barro se aferra a tus piernas');
    scheduleBossAction(0.85, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:55, type:'poison', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('El lodo bajo tus pies estalla');
    });
  } else if(type==='bogBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
        dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:3.0, poison:true, shape:'wisp' });
    }
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*160, vy:Math.sin(ang)*160,
          dmg:boss.dmg*0.32, radius:7, owner:'enemy', color:boss.def.color, life:2.6, poison:true, shape:'wisp' });
      }
    });
  } else if(type==='leechSwarm'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    [-0.3,0.3].forEach(off=>{
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang+off)*95, vy:Math.sin(ang+off)*95,
        dmg:boss.dmg*0.45, radius:8, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
    });
    spawnToast('Sanguijuelas te acechan desde el lodo');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      [-0.5,0.5].forEach(off=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2+off)*85, vy:Math.sin(ang2+off)*85,
          dmg:boss.dmg*0.35, radius:7, owner:'enemy', color:boss.def.color, life:3.5, homing:true, shape:'wisp' });
      });
      spawnToast('Más sanguijuelas emergen');
    });
  } else if(type==='witchesCurse'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una maldición debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:58, type:'poison', telegraph:0.35, active:0.3, tick:0, dmg:boss.dmg*0.38 });
      spawnToast('La maldición se descarga');
    });
  } else if(type==='numbTonic'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un tónico entumece tus reflejos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('El tónico hace efecto una vez más');
    });
  } else if(type==='rootSnare'){
    // two inert decoy roots plus the one real snare — only one of the three actually detonates
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:38, type:'poison', telegraph:0.85, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:42, type:'poison', telegraph:0.85, active:0.3, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('Raíces se ocultan bajo el lodo');
  } else if(type==='quicksand'){
    game.hazards.push({ x:targetX, y:targetY, r:60, type:'poison', telegraph:0.6, active:1.4, tick:0, dmg:boss.dmg*0.35 });
    p.slowTimer = Math.max(p.slowTimer||0, 1.4);
    spawnToast('El suelo se vuelve arena movediza');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*80, b.x+24,b.x+b.w-24);
      const hy = clamp(targetY+Math.sin(ang)*80, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:40, type:'poison', telegraph:0.4, active:1.0, tick:0, dmg:boss.dmg*0.28 });
      spawnToast('Una segunda zona de arena se abre cerca');
    });
  } else if(type==='poisonBrew'){
    const n=6;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:26, type:'poison', telegraph:0.5+Math.random()*1.0, active:0.5, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Frascos de veneno caen por toda la arena');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:65, type:'poison', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último frasco enorme cae junto al jefe');
    });
  } else if(type==='witchsEye'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*100, vy:Math.sin(ang)*100,
      dmg:boss.dmg*0.75, radius:12, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
    spawnToast('Un ojo maldito te vigila y te persigue');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*115, vy:Math.sin(ang2)*115,
        dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
      spawnToast('Un segundo ojo se abre y te sigue');
    });
  } else if(type==='cauldronBubble'){
    for(let k=0;k<3;k++){
      game.hazards.push({ x:boss.x, y:boss.y, r:15+k*11, type:'poison', telegraph:0.33*(k+1), active:0.3, tick:0, dmg:boss.dmg*0.4 });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,130,0.3);
    spawnToast('Su caldero burbujea con fuerza creciente');
    scheduleBossAction(1.05, ()=>{
      if(!game.boss) return;
      const m=8;
      for(let i=0;i<m;i++){
        const ang=(i/m)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:boss.def.color, life:1.6, poison:true, shape:'wisp' });
      }
      shake(4);
    });
  } else if(type==='swampSurge'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*28, y:targetY+Math.sin(ang)*28, r:18, type:'poison',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.42, expanding:true, expandRate:62 });
    }
    spawnToast('El pantano se hincha y avanza hacia afuera');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*70, y:targetY+Math.sin(ang)*70, r:16, type:'poison',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:-50 });
      }
      spawnToast('Una segunda oleada se cierra hacia adentro');
    });
  } else if(type==='willOWisp'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.42;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*180, vy:Math.sin(ang)*180,
        dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:3.2, shape:'wisp' });
    }
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.42;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*210, vy:Math.sin(ang)*210,
          dmg:boss.dmg*0.34, radius:7, owner:'enemy', color:boss.def.color, life:2.8, shape:'wisp' });
      }
    });
  } else if(type==='vineLine'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:22, type:'poison', telegraph:0.22+frac*0.8, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Una enredadera repta hacia vos');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*150, vy:Math.sin(a2)*150,
          dmg:boss.dmg*0.26, radius:6, owner:'enemy', color:boss.def.color, life:1.4, poison:true, shape:'wisp' });
      }
    });
  } else if(type==='venomLash'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const reach=250;
    const proj = (p.x-boss.x)*Math.cos(ang) + (p.y-boss.y)*Math.sin(ang);
    const perpDist = Math.hypot((p.x-boss.x)-Math.cos(ang)*proj, (p.y-boss.y)-Math.sin(ang)*proj);
    if(proj>0 && proj<reach && perpDist<38) hitPlayer(boss.dmg*0.85);
    addParticles(boss.x+Math.cos(ang)*reach, boss.y+Math.sin(ang)*reach, boss.def.color,10,110,0.22);
    shake(4);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      const proj2 = (p.x-boss.x)*Math.cos(ang2) + (p.y-boss.y)*Math.sin(ang2);
      const perp2 = Math.hypot((p.x-boss.x)-Math.cos(ang2)*proj2, (p.y-boss.y)-Math.sin(ang2)*proj2);
      if(proj2>0 && proj2<reach*0.85 && perp2<38) hitPlayer(boss.dmg*0.65);
      addParticles(boss.x+Math.cos(ang2)*reach*0.85, boss.y+Math.sin(ang2)*reach*0.85, boss.def.color,10,100,0.2);
      shake(3);
      spawnToast('El látigo venenoso vuelve en un revés');
    });
  } else if(type==='shadowBrew'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.08);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Bebe un brebaje que restaura sus fuerzas');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=100;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El brebaje se vuelve tóxico al exhalar');
    });
  } else if(type==='batSwarm'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
        dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'wisp' });
    }
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
          dmg:boss.dmg*0.28, radius:5, owner:'enemy', color:boss.def.color, life:1.4, shape:'wisp' });
      }
    });
  } else if(type==='mireField'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'poison', telegraph:0.5+Math.random()*0.9, active:0.4, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El lodo brota al azar por toda la arena');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:68, type:'poison', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último pozo de lodo se abre junto al jefe');
    });
  } else if(type==='curseBind'){
    p.slowTimer = Math.max(p.slowTimer||0, 3);
    p.slowFactor = 0.6;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una maldición se aferra a tus pasos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.5);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('La maldición se aprieta más');
    });
  } else if(type==='witchsMark'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*105, vy:Math.sin(ang)*105,
      dmg:boss.dmg*0.72, radius:11, owner:'enemy', color:boss.def.color, life:4.2, homing:true, shape:'wisp' });
    spawnToast('Una marca de bruja te persigue');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*95, vy:Math.sin(ang2)*95,
        dmg:boss.dmg*0.5, radius:9, owner:'enemy', color:boss.def.color, life:3.6, homing:true, shape:'wisp' });
      spawnToast('Una segunda marca se suma');
    });
  } else if(type==='spectralHex'){
    boss.x = clamp(targetX+rand(-40,40), b.x+boss.radius, b.x+b.w-boss.radius);
    boss.y = clamp(targetY+rand(-40,40), b.y+boss.radius, b.y+b.h-boss.radius);
    if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+20) hitPlayer(boss.dmg*0.8);
    spawnShockwave(boss.x,boss.y,boss.def.color,50,0.3);
    spawnToast('Se desvanece y aparece junto a vos');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      spawnShockwave(boss.x,boss.y,boss.def.color,80,0.3);
      if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+34) hitPlayer(boss.dmg*0.4);
    });
  } else if(type==='gooBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.16;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:boss.def.color, life:2.6, poison:true, shape:'wisp' });
    }
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const perp = ang0+Math.PI/2;
      [perp, perp+Math.PI].forEach(a=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*210, vy:Math.sin(a)*210,
          dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:boss.def.color, life:2.2, poison:true, shape:'wisp' });
      });
    });
  } else if(type==='plagueCloud'){
    // a few harmless pre-tremor puffs flicker before the real plague cloud settles
    const puffs=3;
    for(let i=0;i<puffs;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,90);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:16, type:'poison', telegraph:0.6+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:110, type:'poison', telegraph:1.3, active:0.5, tick:0, dmg:boss.dmg*1.1 });
    spawnToast('Una nube de plaga se cierne sobre el lugar');
  } else if(type==='witchesRing'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*95, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*95, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'poison', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Un aquelarre invisible se cierra a tu alrededor');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*55, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*55, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'poison', telegraph:0.35, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('El aquelarre se cierra más');
    });
  } else if(type==='flameWhip'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const reach = 260;
    const proj = (p.x-boss.x)*Math.cos(ang) + (p.y-boss.y)*Math.sin(ang);
    const perpDist = Math.hypot((p.x-boss.x)-Math.cos(ang)*proj, (p.y-boss.y)-Math.sin(ang)*proj);
    if(proj>0 && proj<reach && perpDist<40) hitPlayer(boss.dmg*0.9);
    const ex = boss.x+Math.cos(ang)*reach, ey = boss.y+Math.sin(ang)*reach;
    addParticles(boss.x,boss.y,boss.def.color,10,120,0.25);
    addParticles(ex,ey,boss.def.color,10,120,0.25);
    shake(5);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      const proj2 = (p.x-boss.x)*Math.cos(ang2) + (p.y-boss.y)*Math.sin(ang2);
      const perp2 = Math.hypot((p.x-boss.x)-Math.cos(ang2)*proj2, (p.y-boss.y)-Math.sin(ang2)*proj2);
      if(proj2>0 && proj2<reach*0.85 && perp2<40) hitPlayer(boss.dmg*0.7);
      const ex2 = boss.x+Math.cos(ang2)*reach*0.85, ey2 = boss.y+Math.sin(ang2)*reach*0.85;
      addParticles(ex2,ey2,boss.def.color,10,110,0.22);
      shake(3);
      spawnToast('El látigo de fuego vuelve en un revés');
    });
  } else if(type==='lavaSpurt'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:1.7, shape:'ember' });
    }
    scheduleBossAction(0.32, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
          dmg:boss.dmg*0.34, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'ember' });
      }
    });
  } else if(type==='infernoRing'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:26, type:'fire', telegraph:0.55, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Un anillo de fuego se cierra a tu alrededor');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*55, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*55, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:22, type:'fire', telegraph:0.35, active:0.35, tick:0, dmg:boss.dmg*0.42 });
      }
      spawnToast('El anillo se cierra más');
    });
  } else if(type==='brimstoneRain'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'fire', telegraph:0.5+Math.random()*1.0, active:0.4, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Azufre ardiente cae por toda la arena');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:70, type:'fire', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.55 });
      spawnToast('Un último bloque de azufre cae junto al jefe');
    });
  } else if(type==='demonRoar'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un rugido demoníaco debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:58, type:'fire', telegraph:0.35, active:0.3, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('El rugido termina en una llamarada');
    });
  } else if(type==='ashCloud'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una nube de ceniza entumece tus reflejos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('La ceniza vuelve a asentarse sobre vos');
    });
  } else if(type==='moltenTrap'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:40, type:'fire', telegraph:0.85, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:44, type:'fire', telegraph:0.85, active:0.3, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('Magma se oculta bajo la superficie');
  } else if(type==='cinderSwarm'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'ember' });
    }
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
          dmg:boss.dmg*0.28, radius:5, owner:'enemy', color:boss.def.color, life:1.4, shape:'ember' });
      }
    });
  } else if(type==='flameSurge'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*26, y:targetY+Math.sin(ang)*26, r:18, type:'fire',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.42, expanding:true, expandRate:64 });
    }
    spawnToast('El fuego se hincha y avanza hacia afuera');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*70, y:targetY+Math.sin(ang)*70, r:16, type:'fire',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.38, expanding:true, expandRate:-52 });
      }
      spawnToast('Una segunda oleada se cierra hacia adentro');
    });
  } else if(type==='infernalBond'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.08);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Un pacto infernal restaura sus fuerzas');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=105;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.5);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El pacto exige un pago');
    });
  } else if(type==='sulfurBreath'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=3;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.24;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*140, vy:Math.sin(ang)*140,
        dmg:boss.dmg*0.7, radius:13, owner:'enemy', color:boss.def.color, life:2.6, shape:'ember' });
    }
    spawnToast('Un aliento de azufre se extiende lento');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*160, vy:Math.sin(ang1)*160,
        dmg:boss.dmg*0.55, radius:14, owner:'enemy', color:boss.def.color, life:2.2, shape:'ember' });
    });
  } else if(type==='pyreCollapse'){
    const cracks=3;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,90);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:16, type:'fire', telegraph:0.6+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:120, type:'fire', telegraph:1.3, active:0.4, tick:0, dmg:boss.dmg*1.15 });
    spawnToast('Una pira colapsa sobre el lugar');
  } else if(type==='scorchedEarth'){
    const steps=8;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+Math.cos(ang0)*frac*b.w*0.5, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang0)*frac*b.h*0.5, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:26, type:'fire', telegraph:0.25+frac*0.9, active:0.45, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('El suelo se quema en línea recta');
    scheduleBossAction(1.25, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x) + Math.PI/2;
      for(let i=0;i<5;i++){
        const frac = i/4;
        const hx = clamp(boss.x+Math.cos(ang1)*frac*b.w*0.3, b.x+24,b.x+b.w-24);
        const hy = clamp(boss.y+Math.sin(ang1)*frac*b.h*0.3, b.y+24,b.y+b.h-24);
        game.hazards.push({ x:hx, y:hy, r:22, type:'fire', telegraph:0.25+frac*0.5, active:0.4, tick:0, dmg:boss.dmg*0.3 });
      }
      spawnToast('Una segunda línea se quema en perpendicular');
    });
  } else if(type==='demonEye'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*102, vy:Math.sin(ang)*102,
      dmg:boss.dmg*0.75, radius:12, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'ember' });
    spawnToast('Un ojo demoníaco te vigila y te persigue');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*118, vy:Math.sin(ang2)*118,
        dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'ember' });
      spawnToast('Un segundo ojo se abre y te sigue');
    });
  } else if(type==='infernalChains'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    [-0.3,0.3].forEach(off=>{
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang+off)*108, vy:Math.sin(ang+off)*108,
        dmg:boss.dmg*0.5, radius:9, owner:'enemy', color:boss.def.color, life:4.2, homing:true, shape:'ember' });
    });
    spawnToast('Dos cadenas ardientes te acechan');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      [-0.55,0.55].forEach(off=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2+off)*98, vy:Math.sin(ang2+off)*98,
          dmg:boss.dmg*0.4, radius:8, owner:'enemy', color:boss.def.color, life:3.6, homing:true, shape:'ember' });
      });
      spawnToast('Dos cadenas más se suman');
    });
  } else if(type==='brimstoneSpiral'){
    const n=7;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2.6;
      const rad=18+i*15;
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:20, type:'fire', telegraph:0.3+i*0.09, active:0.4, tick:0, dmg:boss.dmg*0.38 });
    }
    spawnToast('Fuego gira en espiral hacia afuera');
    scheduleBossAction(0.3+n*0.09+0.25, ()=>{
      if(!game.boss) return;
      const ang=(n/7)*Math.PI*2.6, rad=18+n*15;
      const ex = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const ey = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:ex,y:ey, vx:Math.cos(a2)*180, vy:Math.sin(a2)*180,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'ember' });
      }
      addParticles(ex,ey,boss.def.color,10,100,0.25);
    });
  } else if(type==='flameWreath'){
    for(let k=0;k<3;k++){
      game.hazards.push({ x:boss.x, y:boss.y, r:15+k*11, type:'fire', telegraph:0.33*(k+1), active:0.3, tick:0, dmg:boss.dmg*0.42 });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,130,0.3);
    spawnToast('Una corona de fuego pulsa con fuerza creciente');
    scheduleBossAction(1.05, ()=>{
      if(!game.boss) return;
      const m=8;
      for(let i=0;i<m;i++){
        const ang=(i/m)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*205, vy:Math.sin(ang)*205,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'ember' });
      }
      shake(5);
    });
  } else if(type==='hellgate'){
    boss.x = clamp(targetX+rand(-40,40), b.x+boss.radius, b.x+b.w-boss.radius);
    boss.y = clamp(targetY+rand(-40,40), b.y+boss.radius, b.y+b.h-boss.radius);
    if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+20) hitPlayer(boss.dmg*0.8);
    spawnShockwave(boss.x,boss.y,boss.def.color,50,0.3);
    spawnToast('Un portal infernal lo trae junto a vos');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      spawnShockwave(boss.x,boss.y,boss.def.color,80,0.3);
      if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+34) hitPlayer(boss.dmg*0.4);
    });
  } else if(type==='cinderVolley'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.5;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*205, vy:Math.sin(ang)*205,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'ember' });
    }
    scheduleBossAction(0.42, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.5;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*240, vy:Math.sin(ang)*240,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'ember' });
      }
    });
  } else if(type==='moltenWave'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'fire', telegraph:0.22+frac*0.85, active:0.4, tick:0, dmg:boss.dmg*0.38 });
    }
    spawnToast('Una ola de magma avanza hacia vos');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'ember' });
      }
    });
  } else if(type==='demonicHowl'){
    p.slowTimer = Math.max(p.slowTimer||0, 3);
    p.slowFactor = 0.6;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un aullido demoníaco entorpece tus pasos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.5);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('Un segundo aullido se suma');
    });
  } else if(type==='infernalCrown'){
    const ring = (idx)=>{
      if(!game.boss) return;
      const n=7, speed=170+idx*60;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + idx*0.25;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.34, radius:6, owner:'enemy', color:boss.def.color, life:1.9, shape:'ember' });
      }
      shake(4);
    };
    ring(0);
    scheduleBossAction(0.3, ()=>ring(1));
    scheduleBossAction(0.6, ()=>ring(2));
  } else if(type==='demonicBlast'){
    const r=155;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
      addParticles(boss.x,boss.y,boss.def.color,22,200,0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.35);
      shake(7);
    });
  } else if(type==='cinderBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.16;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:1.6, shape:'ember' });
    }
    for(let k=0;k<2;k++){
      const hx = clamp(boss.x+rand(-90,90), b.x+24,b.x+b.w-24), hy = clamp(boss.y+rand(-90,90), b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:26, type:'fire', telegraph:0.5, active:1.0, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Cenizas ardientes caen a su alrededor');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<4;i++){
        const ang = ang1 + (i-1.5)*0.2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
          dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:boss.def.color, life:1.4, shape:'ember' });
      }
    });
  } else if(type==='emberField'){
    const n=6;
    for(let i=0;i<n;i++){
      const ang = (i/n)*Math.PI*2 + rand(-0.2,0.2);
      const rad = rand(50,150);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+24,b.x+b.w-24);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:30, type:'fire', telegraph:0.3+i*0.22, active:0.5, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('El fuego se enciende en cadena a tu alrededor');
    scheduleBossAction(1.75, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:targetX, y:targetY, r:44, type:'fire', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('El fuego converge en el centro');
    });
  } else if(type==='moltenCore'){
    for(let k=0;k<3;k++){
      game.hazards.push({ x:boss.x, y:boss.y, r:16+k*10, type:'fire', telegraph:0.35*(k+1), active:0.35, tick:0, dmg:boss.dmg*0.5 });
    }
    addParticles(boss.x,boss.y,boss.def.color,18,150,0.35);
    spawnToast('Su núcleo pulsa con calor creciente');
    scheduleBossAction(1.15, ()=>{
      if(!game.boss) return;
      const m=8;
      for(let i=0;i<m;i++){
        const ang=(i/m)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'ember' });
      }
      shake(5);
    });
  } else if(type==='cinderRain'){
    const n=8;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:22, type:'fire', telegraph:0.5+Math.random()*1.1, active:0.4, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Ceniza ardiente llueve por toda la arena');
    scheduleBossAction(1.8, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:66, type:'fire', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Una última brasa enorme cae junto al jefe');
    });
  } else if(type==='thornVolley'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=7;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.15;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
    }
    shake(4);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1 + (i-2)*0.15;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*280, vy:Math.sin(ang)*280,
          dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
    });
  } else if(type==='bloomTrap'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.75, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:44, type:'light', telegraph:0.75, active:0.35, tick:0, dmg:boss.dmg*0.9 });
    spawnToast('Algo hermoso está por florecer bajo tus pies');
  } else if(type==='healingBloom'){
    boss.regenTimer = 4;
    boss.regenPerSec = boss.maxHp*0.025;
    addParticles(boss.x,boss.y,boss.def.color,18,120,0.35);
    spawnToast('Florece con nueva energía');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const r=100;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El brote libera polen cortante');
    });
  } else if(type==='lightTwins'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    [-0.35,0.35].forEach(off=>{
      spawnProjectile({ x:boss.x, y:boss.y, vx:Math.cos(ang+off)*100, vy:Math.sin(ang+off)*100,
        dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'feather' });
    });
    spawnToast('Dos luces gemelas te acechan');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      [-0.6,0.6].forEach(off=>{
        spawnProjectile({ x:boss.x, y:boss.y, vx:Math.cos(ang2+off)*90, vy:Math.sin(ang2+off)*90,
          dmg:boss.dmg*0.42, radius:9, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'feather' });
      });
      spawnToast('Dos luces más se suman');
    });
  } else if(type==='radiantPath'){
    // a winding, curved trail of light toward you, instead of a straight line or ring
    const steps=8;
    const ang = Math.atan2(targetY-boss.y, targetX-boss.x);
    const perp = ang+Math.PI/2;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const wob = Math.sin(frac*Math.PI*2.4)*46;
      const bx = boss.x+(targetX-boss.x)*frac + Math.cos(perp)*wob;
      const by = boss.y+(targetY-boss.y)*frac + Math.sin(perp)*wob;
      const hx = clamp(bx,b.x+24,b.x+b.w-24), hy=clamp(by,b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'light', telegraph:0.3+frac*0.9, active:0.6, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Un sendero serpenteante de luz se traza hacia vos');
  } else if(type==='petalStorm'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:boss.def.color, life:2.3, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,150,0.35);
    shake(5);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
          dmg:boss.dmg*0.36, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
      }
    });
  } else if(type==='vineWhip'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.09;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*310, vy:Math.sin(ang)*310,
        dmg:boss.dmg*0.55, radius:6, owner:'enemy', color:'#5ad98a', life:1.5, shape:'shard' });
    }
    shake(4);
    scheduleBossAction(0.28, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1 + (i-2)*0.09;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*330, vy:Math.sin(ang)*330,
          dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:'#5ad98a', life:1.3, shape:'shard' });
      }
    });
  } else if(type==='prismShard'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=-1;i<=1;i++){
      const a = ang + i*0.05;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*400, vy:Math.sin(a)*400,
        dmg:boss.dmg*0.7, radius:6, owner:'enemy', color:'#6a8dff', life:1.4, shape:'orb' });
    }
    addParticles(boss.x,boss.y,'#6a8dff',10,140,0.25);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*420, vy:Math.sin(ang2)*420,
        dmg:boss.dmg*0.55, radius:6, owner:'enemy', color:'#6a8dff', life:1.3, shape:'orb' });
    });
  } else if(type==='nectarSwarm'){
    const n=13;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*105, vy:Math.sin(ang)*105,
        dmg:boss.dmg*0.3, radius:9, owner:'enemy', color:'#ffcb47', life:3.4, shape:'wisp' });
    }
    spawnToast('Un enjambre de néctar se dispersa por el aire');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      for(let i=0;i<7;i++){
        const ang=(i/7)*Math.PI*2 + Math.PI/7;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*90, vy:Math.sin(ang)*90,
          dmg:boss.dmg*0.24, radius:8, owner:'enemy', color:'#ffcb47', life:2.8, shape:'wisp' });
      }
    });
  } else if(type==='gildedThorns'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
        dmg:boss.dmg*0.65, radius:8, owner:'enemy', color:'#ffcb47', life:2.2, shape:'shard' });
    }
    addParticles(boss.x,boss.y,'#ffcb47',18,160,0.35);
    shake(6);
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*195, vy:Math.sin(ang)*195,
          dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#ffcb47', life:1.9, shape:'shard' });
      }
    });
  } else if(type==='dewTrap'){
    const n=3;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*34, y:targetY+Math.sin(ang)*34, r:22,
        type:'light', telegraph:0.5, active:0.5, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Gotas de rocío brillante se condensan en el aire');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<3;i++){
        const ang=(i/3)*Math.PI*2 + Math.PI/3;
        game.hazards.push({ x:targetX+Math.cos(ang)*60, y:targetY+Math.sin(ang)*60, r:18,
          type:'light', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.3 });
      }
      spawnToast('Más rocío se condensa alrededor');
    });
  } else if(type==='crystalBloom'){
    game.hazards.push({ x:targetX, y:targetY, r:50, type:'light', telegraph:0.85, active:0.3, tick:0, dmg:boss.dmg*1.0 });
    addParticles(targetX,targetY,'#cfd6e8',14,120,0.3);
    spawnToast('Un cristal se forma bajo tus pies');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#cfd6e8', life:1.5, shape:'shard' });
      }
    });
  } else if(type==='thornCage'){
    const n=6;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*80, y:targetY+Math.sin(ang)*80, r:26,
        type:'spike', telegraph:0.55, active:0.8, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('Espinas se alzan formando una jaula a tu alrededor');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*48, y:targetY+Math.sin(ang)*48, r:22,
          type:'spike', telegraph:0.3, active:0.5, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('La jaula se cierra más');
    });
  } else if(type==='sunbeamLine'){
    // a beam of light sweeps across the arena from one edge to the other
    const vertical = Math.random()<0.5;
    const n=9;
    const reverse = Math.random()<0.5;
    for(let i=0;i<n;i++){
      const frac = i/(n-1);
      const delay = reverse ? (1-frac)*1.1 : frac*1.1;
      let hx,hy;
      if(vertical){ hx = b.x+30+frac*(b.w-60); hy = clamp(p.y+rand(-40,40), b.y+30,b.y+b.h-30); }
      else { hy = b.y+30+frac*(b.h-60); hx = clamp(p.x+rand(-40,40), b.x+30,b.x+b.w-30); }
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.35+delay, active:0.4, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('Un rayo de sol barre la arena');
  } else if(type==='bloomRing'){
    // two concentric rings of light close in around where you stood, one step behind gracefulVeil's three
    const cx = clamp(p.x, b.x+60, b.x+b.w-60), cy = clamp(p.y, b.y+60, b.y+b.h-60);
    [180,100].forEach((rad, idx)=>{
      const n=9;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        game.hazards.push({ x:cx+Math.cos(ang)*rad, y:cy+Math.sin(ang)*rad, r:24, type:'light',
          telegraph:0.5+idx*0.5, active:0.5, tick:0, dmg:boss.dmg*0.42 });
      }
    });
    spawnToast('Anillos de luz se cierran a tu alrededor');
  } else if(type==='sunfireCross'){
    // four arms of light extend from the boss's own position along the cardinal directions
    const arms=[[1,0],[-1,0],[0,1],[0,-1]];
    arms.forEach(([dx,dy])=>{
      for(let k=1;k<=3;k++){
        const hx = clamp(boss.x+dx*k*46, b.x+22, b.x+b.w-22);
        const hy = clamp(boss.y+dy*k*46, b.y+22, b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:24, type:'light', telegraph:0.45+k*0.12, active:0.4, tick:0, dmg:boss.dmg*0.45 });
      }
    });
    addParticles(boss.x,boss.y,'#ffcb47',16,140,0.3);
    spawnToast('Rayos de luz se extienden en cruz');
  } else if(type==='radianceField'){
    for(let i=0;i<4;i++){
      const hx = clamp(targetX+rand(-140,140), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-140,140), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.55, active:1.0, tick:0, dmg:boss.dmg*0.48 });
    }
    spawnToast('Parches de resplandor florecen a tu alrededor');
    scheduleBossAction(1.3, ()=>{
      if(!game.boss) return;
      const hx = clamp(targetX+rand(-100,100), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-100,100), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:44, type:'light', telegraph:0.3, active:0.6, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('Un último parche florece cerca');
    });
  } else if(type==='lightCascade'){
    // a wide staggered wall of light sweeps in from one side, like blizzardWall but in warm light
    const vertical = Math.random()<0.5;
    const n=10;
    const reverse = Math.random()<0.5;
    for(let i=0;i<n;i++){
      const frac = i/(n-1);
      const delay = reverse ? (1-frac)*1.3 : frac*1.3;
      let hx,hy;
      if(vertical){ hx = b.x+30+frac*(b.w-60); hy = clamp(p.y+rand(-40,40), b.y+30,b.y+b.h-30); }
      else { hy = b.y+30+frac*(b.h-60); hx = clamp(p.x+rand(-40,40), b.x+30,b.x+b.w-30); }
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.4+delay, active:0.5, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('Una cascada de luz avanza por la arena');
  } else if(type==='tangleRoots'){
    p.slowTimer = Math.max(p.slowTimer||0, 3);
    p.slowFactor = 0.65;
    for(let i=0;i<5;i++){
      const hx = rand(b.x+40,b.x+b.w-40), hy = rand(b.y+40,b.y+b.h-40);
      game.hazards.push({ x:hx, y:hy, r:26, type:'spike', telegraph:0.4+rand(0,1.2), active:0.55, tick:0, dmg:boss.dmg*0.4 });
    }
    addParticles(p.x,p.y,'#5ad98a',14,100,0.35);
    spawnToast('Raíces se enredan en tus piernas');
    scheduleBossAction(1.7, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.4);
      game.hazards.push({ x:p.x, y:p.y, r:40, type:'spike', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.32 });
      spawnToast('Más raíces se aferran a vos');
    });
  } else if(type==='mirrorBloom'){
    const r=130;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.8);
      addParticles(boss.x,boss.y,boss.def.color,20,190,0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      shake(6);
    });
  } else if(type==='verdantSurge'){
    const r=170;
    addParticles(boss.x,boss.y,'#5ad98a',12,100,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
      addParticles(boss.x,boss.y,'#5ad98a',28,240,0.5);
      spawnShockwave(boss.x,boss.y,'#5ad98a',r,0.4);
      shake(8);
    });
  } else if(type==='glowWisp'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*95, vy:Math.sin(ang)*95,
      dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:5, homing:true, shape:'wisp' });
    spawnToast('Una luz errante empieza a perseguirte');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*80, vy:Math.sin(ang2)*80,
        dmg:boss.dmg*0.4, radius:9, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
      spawnToast('Una segunda luz se une a la persecución');
    });
  } else if(type==='sunfireLance'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
      dmg:boss.dmg*0.85, radius:9, owner:'enemy', color:'#ffcb47', life:2.6, homing:true, shape:'orb' });
    addParticles(boss.x,boss.y,'#ffcb47',10,130,0.25);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*250, vy:Math.sin(ang2)*250,
        dmg:boss.dmg*0.6, radius:8, owner:'enemy', color:'#ffcb47', life:2.2, homing:true, shape:'orb' });
    });
  } else if(type==='lightPollen'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,'#ffd6f0',16,100,0.35);
    spawnToast('Polen cegador se posa sobre vos');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:56, type:'light', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('El polen estalla');
    });
  } else if(type==='witheringPetals'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,'#a89a8c',14,90,0.3);
    spawnToast('Pétalos marchitos entorpecen tus movimientos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,'#a89a8c',12,80,0.25);
      spawnToast('Más pétalos marchitos caen sobre vos');
    });
  } else if(type==='petalVeil'){
    boss.shieldTimer = Math.max(boss.shieldTimer||0, 3.5);
    addParticles(boss.x,boss.y,boss.def.color,20,140,0.4);
    spawnToast('Un velo de pétalos la protege');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const n=6;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*160, vy:Math.sin(ang)*160,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
      spawnToast('El velo libera una ráfaga de pétalos');
    });
  } else if(type==='gardenGuardians'){
    for(let i=0;i<2;i++){
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
    }
    spawnToast('El jardín despierta a sus guardianes');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
      addParticles(boss.x,boss.y,boss.def.color,10,80,0.25);
      spawnToast('Un guardián más despierta');
    });
  } else if(type==='mirrorDecoy'){
    // a decoy fires from the point exactly opposite the boss through the arena's center, instead
    // of from the boss's own body — the danger comes from somewhere else in the room entirely
    const cx = b.x+b.w/2, cy = b.y+b.h/2;
    const mx = clamp(2*cx-boss.x, b.x+40, b.x+b.w-40), my = clamp(2*cy-boss.y, b.y+40, b.y+b.h-40);
    const ang = Math.atan2(p.y-my, p.x-mx);
    const n=5;
    for(let i=0;i<n;i++){
      const a = ang + (i-(n-1)/2)*0.18;
      spawnProjectile({ x:mx,y:my, vx:Math.cos(a)*220, vy:Math.sin(a)*220,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
    }
    addParticles(mx,my,boss.def.color,16,120,0.35);
    spawnToast('Un reflejo aparece del otro lado de la sala');
  } else if(type==='glassField'){
    // each shard cracks twice at the same spot, on a delay — a double-hit trap instead of a
    // single-resolution zone
    const n=5;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+40,b.x+b.w-40), hy = rand(b.y+40,b.y+b.h-40);
      game.hazards.push({ x:hx, y:hy, r:26, type:'spike', telegraph:0.5, active:0.3, tick:0, dmg:boss.dmg*0.4 });
      game.hazards.push({ x:hx, y:hy, r:26, type:'spike', telegraph:1.1, active:0.3, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El cristal se rompe dos veces en el mismo lugar');
  } else if(type==='illusionSwap'){
    // an instant position swap with you, rather than a pull or a dash — the boss simply trades
    // places with you
    const oldBossX=boss.x, oldBossY=boss.y;
    boss.x = clamp(p.x, b.x+boss.radius, b.x+b.w-boss.radius);
    boss.y = clamp(p.y, b.y+boss.radius, b.y+b.h-boss.radius);
    p.x = clamp(oldBossX, b.x+p.radius, b.x+b.w-p.radius);
    p.y = clamp(oldBossY, b.y+p.radius, b.y+b.h-p.radius);
    addParticles(boss.x,boss.y,boss.def.color,16,140,0.3);
    addParticles(p.x,p.y,boss.def.color,16,140,0.3);
    spawnShockwave(boss.x,boss.y,boss.def.color,60,0.3);
    spawnShockwave(p.x,p.y,boss.def.color,60,0.3);
    shake(6);
    spawnToast('Intercambia lugares con vos');
  } else if(type==='mirrorGaze'){
    p.invertTimer = Math.max(p.invertTimer||0, 2.5);
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Tu propio reflejo confunde tus movimientos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:52, type:'spike', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.32 });
      spawnToast('El cristal bajo tus pies se quiebra');
    });
  } else if(type==='fracturedBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.5;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
    }
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1 + (i-2)*0.5;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
          dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:boss.def.color, life:1.9, shape:'shard' });
      }
    });
  } else if(type==='shatterVolley'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,150,0.35);
    shake(5);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*235, vy:Math.sin(ang)*235,
          dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
      }
    });
  } else if(type==='reflectedBarrage'){
    // fires simultaneously from the boss AND from her mirrored point across the arena's center —
    // two burst origins instead of mirrorDecoy's single decoy point
    const cx = b.x+b.w/2, cy = b.y+b.h/2;
    const mx = clamp(2*cx-boss.x, b.x+40, b.x+b.w-40), my = clamp(2*cy-boss.y, b.y+40, b.y+b.h-40);
    [{x:boss.x,y:boss.y},{x:mx,y:my}].forEach(o=>{
      const ang = Math.atan2(p.y-o.y, p.x-o.x);
      const n=4;
      for(let i=0;i<n;i++){
        const a = ang + (i-(n-1)/2)*0.2;
        spawnProjectile({ x:o.x,y:o.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
          dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
      }
    });
    addParticles(mx,my,boss.def.color,14,120,0.3);
    spawnToast('Su reflejo dispara desde el otro lado');
  } else if(type==='prismaticShards'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*350, vy:Math.sin(ang)*350,
        dmg:boss.dmg*0.5, radius:5, owner:'enemy', color:'#e8e8f5', life:1.3, shape:'shard' });
    }
    shake(4);
    scheduleBossAction(0.25, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<6;i++){
        const ang = ang1 + (i-2.5)*0.11;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*380, vy:Math.sin(ang)*380,
          dmg:boss.dmg*0.38, radius:5, owner:'enemy', color:'#e8e8f5', life:1.2, shape:'shard' });
      }
    });
  } else if(type==='mirageSwarm'){
    const n=14;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2 + i*0.05;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*115, vy:Math.sin(ang)*115,
        dmg:boss.dmg*0.3, radius:8, owner:'enemy', color:'#cfd6e8', life:3.0, shape:'wisp' });
    }
    spawnToast('Un enjambre de espejismos se dispersa');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      for(let i=0;i<8;i++){
        const ang=(i/8)*Math.PI*2 - i*0.05 + Math.PI/8;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*100, vy:Math.sin(ang)*100,
          dmg:boss.dmg*0.24, radius:7, owner:'enemy', color:'#cfd6e8', life:2.6, shape:'wisp' });
      }
    });
  } else if(type==='silverStrike'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*480, vy:Math.sin(ang)*480,
      dmg:boss.dmg*0.6, radius:6, owner:'enemy', color:'#e8e8f5', life:1.1, shape:'orb' });
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
      dmg:boss.dmg*0.5, radius:6, owner:'enemy', color:'#e8e8f5', life:1.4, shape:'orb' });
    addParticles(boss.x,boss.y,'#e8e8f5',10,120,0.25);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*420, vy:Math.sin(ang2)*420,
        dmg:boss.dmg*0.45, radius:6, owner:'enemy', color:'#e8e8f5', life:1.2, shape:'orb' });
    });
  } else if(type==='mirrorMaze'){
    // a 3x3 grid of glass panels around your position, all but one cell filled — a small, precise
    // maze rather than glassRain's arena-wide grid
    const cellSize=54;
    const safeCell = Math.floor(Math.random()*9);
    for(let row=0; row<3; row++){
      for(let col=0; col<3; col++){
        if(row*3+col===safeCell) continue;
        const hx = clamp(targetX+(col-1)*cellSize, b.x+24, b.x+b.w-24);
        const hy = clamp(targetY+(row-1)*cellSize, b.y+24, b.y+b.h-24);
        game.hazards.push({ x:hx, y:hy, r:24, type:'spike', telegraph:0.7, active:0.5, tick:0, dmg:boss.dmg*0.45 });
      }
    }
    spawnToast('Paneles de cristal se alzan a tu alrededor');
  } else if(type==='shatterZone'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:40, type:'spike', telegraph:0.8, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:48, type:'spike', telegraph:0.8, active:0.3, tick:0, dmg:boss.dmg*1.0 });
    addParticles(targetX,targetY,'#e8e8f5',16,130,0.3);
    spawnToast('El suelo de cristal está por quebrarse');
  } else if(type==='reflectivePool'){
    const cx = b.x+b.w/2, cy = b.y+b.h/2;
    const mx = clamp(2*cx-targetX, b.x+30, b.x+b.w-30), my = clamp(2*cy-targetY, b.y+30, b.y+b.h-30);
    game.hazards.push({ x:targetX, y:targetY, r:36, type:'light', telegraph:0.6, active:0.5, tick:0, dmg:boss.dmg*0.55 });
    game.hazards.push({ x:mx, y:my, r:36, type:'light', telegraph:0.6, active:0.5, tick:0, dmg:boss.dmg*0.55 });
    spawnToast('Un estanque reflectante aparece en dos lugares a la vez');
    scheduleBossAction(0.85, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:targetX, y:targetY, r:26, type:'light', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.3 });
      game.hazards.push({ x:mx, y:my, r:26, type:'light', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.3 });
    });
  } else if(type==='glassSpikes'){
    const n=6;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*76, y:targetY+Math.sin(ang)*76, r:24,
        type:'spike', telegraph:0.45, active:0.6, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('Esquirlas de cristal se alzan en anillo');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*48, y:targetY+Math.sin(ang)*48, r:20,
          type:'spike', telegraph:0.25, active:0.5, tick:0, dmg:boss.dmg*0.38 });
      }
      spawnToast('Más esquirlas se alzan más cerca');
    });
  } else if(type==='doubleVision'){
    // two overlapping clusters offset by a short random vector — everything looks doubled and
    // slightly misaligned, forcing you to account for both
    const offAng = Math.random()*Math.PI*2, offDist=60;
    const ox = Math.cos(offAng)*offDist, oy = Math.sin(offAng)*offDist;
    [[0,0],[ox,oy]].forEach(([dx,dy])=>{
      const n=3;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        game.hazards.push({ x:targetX+dx+Math.cos(ang)*30, y:targetY+dy+Math.sin(ang)*30, r:22,
          type:'spike', telegraph:0.55, active:0.4, tick:0, dmg:boss.dmg*0.4 });
      }
    });
    spawnToast('Tu visión se duplica de golpe');
  } else if(type==='distortionField'){
    for(let i=0;i<4;i++){
      const hx = clamp(targetX+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:36, type:'spike', telegraph:0.55, active:0.9, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('El espacio se distorsiona a tu alrededor');
    scheduleBossAction(1.3, ()=>{
      if(!game.boss) return;
      const hx = clamp(targetX+rand(-100,100), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-100,100), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'spike', telegraph:0.3, active:0.6, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('Una última distorsión se abre cerca');
    });
  } else if(type==='echoChamber'){
    // the same ring of danger pulses three times in place, like an echo repeating — you have to
    // stay clear of the same spot again and again instead of just once
    const cx = clamp(p.x, b.x+50, b.x+b.w-50), cy = clamp(p.y, b.y+50, b.y+b.h-50);
    for(let echo=0; echo<3; echo++){
      const n=7;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        game.hazards.push({ x:cx+Math.cos(ang)*100, y:cy+Math.sin(ang)*100, r:22, type:'light',
          telegraph:0.5+echo*0.55, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
    }
    spawnToast('Un eco de peligro resuena tres veces');
  } else if(type==='hallOfMirrors'){
    // two walls sweep in from opposite edges of the arena at once, closing toward the middle —
    // unlike lightCascade's single-direction sweep, you're pinched from both sides
    const vertical = Math.random()<0.5;
    const n=7;
    for(let i=0;i<n;i++){
      const frac = i/(n-1);
      let hx1,hy1,hx2,hy2;
      if(vertical){
        hy1 = clamp(p.y+rand(-30,30), b.y+30,b.y+b.h-30); hy2=hy1;
        hx1 = b.x+30+frac*(b.w-60)*0.5;
        hx2 = b.x+b.w-30-frac*(b.w-60)*0.5;
      } else {
        hx1 = clamp(p.x+rand(-30,30), b.x+30,b.x+b.w-30); hx2=hx1;
        hy1 = b.y+30+frac*(b.h-60)*0.5;
        hy2 = b.y+b.h-30-frac*(b.h-60)*0.5;
      }
      game.hazards.push({ x:hx1, y:hy1, r:32, type:'spike', telegraph:0.4+frac*0.9, active:0.4, tick:0, dmg:boss.dmg*0.45 });
      game.hazards.push({ x:hx2, y:hy2, r:32, type:'spike', telegraph:0.4+frac*0.9, active:0.4, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('Dos muros de cristal se cierran desde los bordes');
  } else if(type==='mirrorShatter'){
    // a self-centered pulse that also flings a small ring of shards outward as it breaks —
    // combines a melee hit with a light burst, unlike reflectivePulse's pure pulse
    const r=120;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.75);
    const n=6;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*170, vy:Math.sin(ang)*170,
        dmg:boss.dmg*0.35, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,20,180,0.4);
    spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
    shake(6);
  } else if(type==='reflectivePulse'){
    const r=165;
    addParticles(boss.x,boss.y,'#e8e8f5',10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
      addParticles(boss.x,boss.y,'#e8e8f5',26,220,0.45);
      spawnShockwave(boss.x,boss.y,'#e8e8f5',r,0.4);
      shake(8);
    });
  } else if(type==='phantomChaser'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*90, vy:Math.sin(ang)*90,
      dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:'#cfd6e8', life:5, homing:true, shape:'wisp' });
    spawnToast('Un fantasma comienza a perseguirte');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*75, vy:Math.sin(ang2)*75,
        dmg:boss.dmg*0.4, radius:9, owner:'enemy', color:'#cfd6e8', life:4.5, homing:true, shape:'wisp' });
      spawnToast('Un segundo fantasma se une');
    });
  } else if(type==='reflectedLance'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*230, vy:Math.sin(ang)*230,
      dmg:boss.dmg*0.85, radius:9, owner:'enemy', color:'#e8e8f5', life:2.4, homing:true, shape:'orb' });
    addParticles(boss.x,boss.y,'#e8e8f5',10,130,0.25);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*260, vy:Math.sin(ang2)*260,
        dmg:boss.dmg*0.6, radius:8, owner:'enemy', color:'#e8e8f5', life:2.1, homing:true, shape:'orb' });
    });
  } else if(type==='hauntingReflection'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*150, vy:Math.sin(ang)*150,
      dmg:boss.dmg*0.65, radius:9, owner:'enemy', color:boss.def.color, life:3.6, homing:true, shape:'wisp' });
    spawnToast('Tu propio reflejo te persigue');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*130, vy:Math.sin(ang2)*130,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:boss.def.color, life:3.2, homing:true, shape:'wisp' });
      spawnToast('Un segundo reflejo se suma a la persecución');
    });
  } else if(type==='disorientingGaze'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Su mirada te desorienta por completo');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('La desorientación vuelve a golpearte');
    });
  } else if(type==='shatteredFocus'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,'#e8e8f5',16,100,0.35);
    spawnToast('Tu concentración se hace añicos');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:56, type:'spike', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('Los fragmentos caen sobre vos');
    });
  } else if(type==='silveredSkin'){
    boss.armorHp = Math.max(boss.armorHp||0, boss.maxHp*0.08);
    addParticles(boss.x,boss.y,'#e8e8f5',20,130,0.4);
    spawnToast('Su piel se cubre de plata pulida');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      const n=8;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*185, vy:Math.sin(ang)*185,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:'#e8e8f5', life:1.7, shape:'shard' });
      }
      spawnToast('La plata libera una descarga reflejada');
    });
  } else if(type==='mirroredEcho'){
    for(let i=0;i<2;i++){
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
    }
    spawnToast('Ecos espectrales emergen de los espejos');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
      addParticles(boss.x,boss.y,boss.def.color,10,80,0.25);
      spawnToast('Un eco más emerge del cristal');
    });
  } else if(type==='boundStrike'){
    // fires from two points at once, offset to either side of the boss, as if two allies were
    // shooting in sync — a paired burst instead of a single-origin spread
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const perp = ang+Math.PI/2;
    [70,-70].forEach(off=>{
      const sx = boss.x+Math.cos(perp)*off, sy = boss.y+Math.sin(perp)*off;
      const a = Math.atan2(p.y-sy, p.x-sx);
      spawnProjectile({ x:sx,y:sy, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
        dmg:boss.dmg*0.55, radius:8, owner:'enemy', color:boss.def.color, life:2, shape:'orb' });
    });
    addParticles(boss.x,boss.y,boss.def.color,10,100,0.3);
    spawnToast('Dos proyectiles convergen desde ángulos distintos');
  } else if(type==='bondPulse'){
    [-70,70].forEach(off=>{
      game.hazards.push({ x:boss.x+off, y:boss.y, r:55, type:'light', telegraph:0.55, active:0.4, tick:0, dmg:boss.dmg*0.5 });
    });
    spawnToast('Dos pulsos laten al mismo tiempo');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      [-40,40].forEach(off=>{
        game.hazards.push({ x:boss.x+off, y:boss.y, r:40, type:'light', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.35 });
      });
      spawnToast('Un segundo par de pulsos late más cerca');
    });
  } else if(type==='twinStrike'){
    // two instant line-checks at once from slightly different angles — a doubled version of
    // flameWhip's single instant lash
    const angBase = Math.atan2(p.y-boss.y, p.x-boss.x);
    [angBase-0.25, angBase+0.25].forEach(ang=>{
      const reach=230;
      const proj = (p.x-boss.x)*Math.cos(ang) + (p.y-boss.y)*Math.sin(ang);
      const perpDist = Math.hypot((p.x-boss.x)-Math.cos(ang)*proj, (p.y-boss.y)-Math.sin(ang)*proj);
      if(proj>0 && proj<reach && perpDist<36) hitPlayer(boss.dmg*0.6);
      const ex=boss.x+Math.cos(ang)*reach, ey=boss.y+Math.sin(ang)*reach;
      addParticles(ex,ey,boss.def.color,8,100,0.2);
    });
    shake(5);
    spawnToast('Un golpe doble te alcanza desde dos ángulos');
  } else if(type==='bondedShield'){
    boss.shieldTimer = Math.max(boss.shieldTimer||0, 3.5);
    addParticles(boss.x,boss.y,boss.def.color,16,120,0.3);
    spawnToast('Se protege con un vínculo espiritual');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const n=6;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*170, vy:Math.sin(ang)*170,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:boss.def.color, life:1.6, shape:'orb' });
      }
      spawnToast('El vínculo libera una descarga protectora');
    });
  } else if(type==='spiritLink'){
    // a tether of hazard points strung between two random locations, unrelated to the boss's or
    // your own position — a danger line drawn across the room rather than radiating from a point
    const p1 = { x: rand(b.x+60,b.x+b.w-60), y: rand(b.y+60,b.y+b.h-60) };
    const p2 = { x: rand(b.x+60,b.x+b.w-60), y: rand(b.y+60,b.y+b.h-60) };
    const steps=6;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = p1.x+(p2.x-p1.x)*frac, hy = p1.y+(p2.y-p1.y)*frac;
      game.hazards.push({ x:hx, y:hy, r:22, type:'light', telegraph:0.5, active:0.5, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Un vínculo de energía cruza la arena');
  } else if(type==='twinVolley'){
    // two full rings fired at once from two offset points — a doubled version of soulShards'
    // single-origin ring
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    const perp = ang+Math.PI/2;
    [70,-70].forEach(off=>{
      const sx = boss.x+Math.cos(perp)*off, sy = boss.y+Math.sin(perp)*off;
      const n=6;
      for(let i=0;i<n;i++){
        const a=(i/n)*Math.PI*2;
        spawnProjectile({ x:sx,y:sy, vx:Math.cos(a)*180, vy:Math.sin(a)*180,
          dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:boss.def.color, life:2.1, shape:'shard' });
      }
    });
    addParticles(boss.x,boss.y,boss.def.color,14,120,0.3);
    shake(5);
  } else if(type==='soulShards'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*190, vy:Math.sin(ang)*190,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#ffb0d9', life:2.2, shape:'shard' });
    }
    addParticles(boss.x,boss.y,'#ffb0d9',14,140,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*225, vy:Math.sin(ang)*225,
          dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:'#ffb0d9', life:2, shape:'shard' });
      }
    });
  } else if(type==='pairedBolts'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
      dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:1.6, shape:'orb' });
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang+0.15)*260, vy:Math.sin(ang+0.15)*260,
      dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:1.6, shape:'orb' });
    addParticles(boss.x,boss.y,boss.def.color,8,100,0.2);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2-0.15)*280, vy:Math.sin(ang2-0.15)*280,
        dmg:boss.dmg*0.45, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'orb' });
    });
  } else if(type==='spiritBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*100, vy:Math.sin(ang)*100,
        dmg:boss.dmg*0.3, radius:9, owner:'enemy', color:'#ffb0d9', life:3.2, shape:'wisp' });
    }
    spawnToast('Espíritus se dispersan por el santuario');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      for(let i=0;i<7;i++){
        const ang=(i/7)*Math.PI*2 + Math.PI/7;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*85, vy:Math.sin(ang)*85,
          dmg:boss.dmg*0.24, radius:8, owner:'enemy', color:'#ffb0d9', life:2.8, shape:'wisp' });
      }
    });
  } else if(type==='boundArrows'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.09;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*330, vy:Math.sin(ang)*330,
        dmg:boss.dmg*0.55, radius:6, owner:'enemy', color:boss.def.color, life:1.4, shape:'shard' });
    }
    shake(4);
    scheduleBossAction(0.26, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1 + (i-2)*0.09;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*350, vy:Math.sin(ang)*350,
          dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:boss.def.color, life:1.3, shape:'shard' });
      }
    });
  } else if(type==='soulTether'){
    // a tether strung between the boss and your frozen position at the moment of the attack —
    // anchored to both of you, unlike spiritLink's two random points
    const steps=6;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = boss.x+(targetX-boss.x)*frac, hy = boss.y+(targetY-boss.y)*frac;
      game.hazards.push({ x:hx, y:hy, r:22, type:'light', telegraph:0.35+frac*0.5, active:0.5, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Un lazo espiritual se tiende entre ustedes');
  } else if(type==='kinshipRing'){
    const n=6;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*78, y:targetY+Math.sin(ang)*78, r:24,
        type:'light', telegraph:0.5, active:0.6, tick:0, dmg:boss.dmg*0.48 });
    }
    spawnToast('Un anillo de vínculo se cierra a tu alrededor');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*48, y:targetY+Math.sin(ang)*48, r:20,
          type:'light', telegraph:0.28, active:0.5, tick:0, dmg:boss.dmg*0.36 });
      }
      spawnToast('El anillo se cierra una vez más');
    });
  } else if(type==='dualBloom'){
    for(let i=0;i<2;i++){
      const hx = rand(b.x+70,b.x+b.w-70), hy = rand(b.y+70,b.y+b.h-70);
      game.hazards.push({ x:hx, y:hy, r:50, type:'light', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.55 });
    }
    spawnToast('Dos florecimientos de luz brotan en el santuario');
    scheduleBossAction(0.85, ()=>{
      if(!game.boss) return;
      const hx = rand(b.x+70,b.x+b.w-70), hy = rand(b.y+70,b.y+b.h-70);
      game.hazards.push({ x:hx, y:hy, r:44, type:'light', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('Un tercer florecimiento brota');
    });
  } else if(type==='sharedPain'){
    game.hazards.push({ x:targetX, y:targetY, r:38, type:'light', telegraph:0.55, active:0.5, tick:0, dmg:boss.dmg*0.5 });
    game.hazards.push({ x:boss.x, y:boss.y, r:38, type:'light', telegraph:0.55, active:0.5, tick:0, dmg:boss.dmg*0.5 });
    spawnToast('El dolor se comparte entre ambas');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:targetX, y:targetY, r:26, type:'light', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.32 });
      game.hazards.push({ x:boss.x, y:boss.y, r:26, type:'light', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.32 });
    });
  } else if(type==='weaveTrap'){
    // a zigzagging line of small hazards woven across the arena, alternating side to side
    const n=8;
    const startX = rand(b.x+60,b.x+b.w-60);
    for(let i=0;i<n;i++){
      const frac=i/(n-1);
      const hy = b.y+40+frac*(b.h-80);
      const hx = clamp(startX + Math.sin(frac*Math.PI*3)*90, b.x+30, b.x+b.w-30);
      game.hazards.push({ x:hx, y:hy, r:22, type:'light', telegraph:0.35+frac*0.9, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Un patrón entrelazado se teje por la arena');
  } else if(type==='pactCircle'){
    // one large circle of hazards around the center of the arena, forcing you to choose between
    // the middle or the edges instead of chasing your own position
    const cx = b.x+b.w/2, cy = b.y+b.h/2;
    const n=12;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const rad = Math.min(b.w,b.h)*0.32;
      game.hazards.push({ x:cx+Math.cos(ang)*rad, y:cy+Math.sin(ang)*rad, r:26, type:'light',
        telegraph:0.65, active:0.6, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('Un pacto circular se traza en el santuario');
  } else if(type==='tetherLine'){
    // a straight sweeping line from the boss toward a fixed point on the wall, sequential and
    // dodgeable along its length — unlike soulTether's anchor to your own position
    const wallAng = Math.random()*Math.PI*2;
    const wx = clamp(boss.x+Math.cos(wallAng)*400, b.x+20,b.x+b.w-20);
    const wy = clamp(boss.y+Math.sin(wallAng)*400, b.y+20,b.y+b.h-20);
    const steps=8;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = boss.x+(wx-boss.x)*frac, hy = boss.y+(wy-boss.y)*frac;
      game.hazards.push({ x:hx, y:hy, r:26, type:'light', telegraph:0.3+frac*0.8, active:0.4, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('Una línea de energía se extiende hacia el muro');
  } else if(type==='soulPulse'){
    const r=125;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.3, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.8);
      addParticles(boss.x,boss.y,boss.def.color,20,180,0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      shake(6);
    });
  } else if(type==='boundSurge'){
    const r=165;
    addParticles(boss.x,boss.y,'#ffb0d9',12,90,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
      addParticles(boss.x,boss.y,'#ffb0d9',26,220,0.45);
      spawnShockwave(boss.x,boss.y,'#ffb0d9',r,0.4);
      shake(8);
    });
  } else if(type==='spiritChaser'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*90, vy:Math.sin(ang)*90,
      dmg:boss.dmg*0.55, radius:10, owner:'enemy', color:boss.def.color, life:5, homing:true, shape:'wisp' });
    spawnToast('Un espíritu comienza a perseguirte');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*78, vy:Math.sin(ang2)*78,
        dmg:boss.dmg*0.4, radius:9, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
      spawnToast('Un segundo espíritu se une');
    });
  } else if(type==='soulLance'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*225, vy:Math.sin(ang)*225,
      dmg:boss.dmg*0.85, radius:9, owner:'enemy', color:'#ffb0d9', life:2.5, homing:true, shape:'orb' });
    addParticles(boss.x,boss.y,'#ffb0d9',10,130,0.25);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*250, vy:Math.sin(ang2)*250,
        dmg:boss.dmg*0.6, radius:8, owner:'enemy', color:'#ffb0d9', life:2.2, homing:true, shape:'orb' });
    });
  } else if(type==='kinseeker'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*150, vy:Math.sin(ang)*150,
      dmg:boss.dmg*0.65, radius:9, owner:'enemy', color:boss.def.color, life:3.6, homing:true, shape:'wisp' });
    spawnToast('Un lazo espiritual te busca');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*135, vy:Math.sin(ang2)*135,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:boss.def.color, life:3.2, homing:true, shape:'wisp' });
      spawnToast('Un segundo lazo se suma a la búsqueda');
    });
  } else if(type==='sharedWound'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,'#ffb0d9',16,100,0.35);
    spawnToast('Una herida compartida debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:54, type:'light', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('La herida se abre de nuevo');
    });
  } else if(type==='soulSap'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,'#a89a8c',14,90,0.3);
    spawnToast('Tu energía es drenada lentamente');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,'#a89a8c',12,80,0.25);
      spawnToast('El drenaje continúa una vez más');
    });
  } else if(type==='boundCurse'){
    p.invertTimer = Math.max(p.invertTimer||0, 2.5);
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una maldición vincula tus movimientos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:52, type:'light', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.32 });
      spawnToast('El vínculo se cierra con fuerza');
    });
  } else if(type==='sharedBlessing'){
    boss.regenTimer = 4;
    boss.regenPerSec = boss.maxHp*0.025;
    addParticles(boss.x,boss.y,boss.def.color,18,120,0.35);
    spawnToast('Una bendición compartida la restaura');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const r=100;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('La bendición se descarga');
    });
  } else if(type==='twinSpirits'){
    for(let i=0;i<2;i++){
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
    }
    spawnToast('Espíritus gemelos acuden a su llamado');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      spawnEnemyAt(boss.def.minion, boss.x+Math.cos(ang)*70, boss.y+Math.sin(ang)*70, true);
      addParticles(boss.x,boss.y,boss.def.color,10,80,0.25);
      spawnToast('Un tercer espíritu acude');
    });
  } else if(type==='iceLance'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*95, vy:Math.sin(ang)*95,
      dmg:boss.dmg*0.7, radius:12, owner:'enemy', color:boss.def.color, life:5, homing:true, shape:'shard',
      slow:{factor:0.6,dur:1} });
    spawnToast('Una lanza de hielo te persigue lentamente');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*115, vy:Math.sin(ang2)*115,
        dmg:boss.dmg*0.5, radius:10, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'shard', slow:{factor:0.6,dur:0.8} });
      spawnToast('Una segunda lanza se suma');
    });
  } else if(type==='crystalPrison'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:38, type:'ice', telegraph:0.7, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:50, type:'ice', telegraph:0.7, active:0.35, tick:0, dmg:boss.dmg*0.7 });
    p.slowTimer = Math.max(p.slowTimer||0, 1.6);
    spawnToast('El hielo intenta encerrarte');
  } else if(type==='avalanche'){
    const n=4;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+50,b.x+b.w-50), hy = rand(b.y+50,b.y+b.h-50);
      game.hazards.push({ x:hx, y:hy, r:70, type:'ice', telegraph:1.3, active:0.5, tick:0, dmg:boss.dmg*0.75 });
    }
    spawnToast('Bloques de hielo caen desde arriba');
    shake(5);
    scheduleBossAction(1.75, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:80, type:'ice', telegraph:0.35, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último bloque enorme cae junto al jefe');
    });
  } else if(type==='frostBreath'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=3;
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.22;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*130, vy:Math.sin(ang)*130,
        dmg:boss.dmg*0.7, radius:13, owner:'enemy', color:boss.def.color, life:2.6, shape:'orb', slow:{factor:0.6,dur:1} });
    }
    spawnToast('Un aliento helado se extiende lento');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*150, vy:Math.sin(ang1)*150,
        dmg:boss.dmg*0.55, radius:14, owner:'enemy', color:boss.def.color, life:2.3, shape:'orb', slow:{factor:0.55,dur:0.8} });
    });
  } else if(type==='numbingChill'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un frío entumecedor debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:56, type:'ice', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('El frío se cristaliza de golpe');
    });
  } else if(type==='frostShards'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*210, vy:Math.sin(ang)*210,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:boss.def.color, life:2.4, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,14,150,0.35);
    spawnToast('Esquirlas de hielo estallan en todas direcciones');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*180, vy:Math.sin(ang)*180,
          dmg:boss.dmg*0.36, radius:7, owner:'enemy', color:boss.def.color, life:2.1, shape:'shard' });
      }
    });
  } else if(type==='glacialVolley'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.18;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
    }
    spawnToast('Una descarga de hielo vuela directo hacia vos');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.18;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*290, vy:Math.sin(ang)*290,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:1.9, shape:'shard' });
      }
    });
  } else if(type==='iceShrapnel'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=8;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
        dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
    }
    shake(4);
    scheduleBossAction(0.28, ()=>{
      if(!game.boss) return;
      const perp = ang0+Math.PI/2;
      [perp, perp+Math.PI].forEach(a=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
          dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      });
    });
  } else if(type==='crystalBarrage'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.35;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*115, vy:Math.sin(ang)*115,
        dmg:boss.dmg*0.8, radius:15, owner:'enemy', color:boss.def.color, life:3.4, shape:'orb' });
    }
    spawnToast('Cristales pesados avanzan lentamente');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*130, vy:Math.sin(ang1)*130,
        dmg:boss.dmg*0.6, radius:14, owner:'enemy', color:boss.def.color, life:3, shape:'orb' });
    });
  } else if(type==='polarWind'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=7;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.5;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*175, vy:Math.sin(ang)*175,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:2.6, shape:'wisp', slow:{factor:0.7,dur:0.8} });
    }
    spawnToast('Un viento polar barre el área');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1+(i-2)*0.5;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*195, vy:Math.sin(ang)*195,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:2.2, shape:'wisp', slow:{factor:0.6,dur:0.6} });
      }
    });
  } else if(type==='snowSquall'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang = Math.random()*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*150, vy:Math.sin(ang)*150,
        dmg:boss.dmg*0.35, radius:6, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,18,130,0.3);
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      for(let i=0;i<6;i++){
        const ang = Math.random()*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*175, vy:Math.sin(ang)*175,
          dmg:boss.dmg*0.28, radius:5, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
      }
    });
  } else if(type==='glacialSpike'){
    const decoys = [ [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:36, type:'ice', telegraph:0.6, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:46, type:'ice', telegraph:0.75, active:0.4, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('Un pico de hielo emerge del suelo');
  } else if(type==='frostRing'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'ice', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Un anillo de escarcha se cierra a tu alrededor');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*55, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*55, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'ice', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('El anillo se cierra más');
    });
  } else if(type==='iceFissure'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'ice', telegraph:0.22+frac*0.85, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una grieta helada avanza hacia vos');
    scheduleBossAction(1.15, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*160, vy:Math.sin(a2)*160,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='frozenTrail'){
    const steps=6;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:26, type:'ice', telegraph:0.3+frac*1.0, active:0.7, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Un sendero de hielo se extiende bajo tus pasos');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:targetX, y:targetY, r:40, type:'ice', telegraph:0.25, active:0.4, tick:0, dmg:boss.dmg*0.4 });
      spawnToast('El sendero termina en un golpe helado');
    });
  } else if(type==='hailfall'){
    const n=6;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:26, type:'ice', telegraph:0.5+Math.random()*1.0, active:0.5, tick:0, dmg:boss.dmg*0.34 });
    }
    spawnToast('Granizo cae por toda la arena');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:64, type:'ice', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último granizo enorme cae junto al jefe');
    });
  } else if(type==='permafrost'){
    game.hazards.push({ x:targetX, y:targetY, r:30, type:'ice', telegraph:0.5, active:1.6, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:55 });
    spawnToast('El suelo se congela y se expande');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      const ang = Math.random()*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*90, b.x+24,b.x+b.w-24);
      const hy = clamp(targetY+Math.sin(ang)*90, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:22, type:'ice', telegraph:0.35, active:1.2, tick:0, dmg:boss.dmg*0.3, expanding:true, expandRate:44 });
      spawnToast('Una segunda zona helada se expande cerca');
    });
  } else if(type==='crystalRain'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'ice', telegraph:0.45+Math.random()*0.9, active:0.4, tick:0, dmg:boss.dmg*0.34 });
    }
    spawnToast('Cristales afilados caen del techo');
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:60, type:'ice', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último cristal enorme cae');
    });
  } else if(type==='blizzardGust'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*28, y:targetY+Math.sin(ang)*28, r:18, type:'ice',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:60 });
    }
    spawnToast('Una ráfaga helada se expande hacia afuera');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*70, y:targetY+Math.sin(ang)*70, r:16, type:'ice',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.36, expanding:true, expandRate:-50 });
      }
      spawnToast('Una segunda ráfaga se cierra hacia adentro');
    });
  } else if(type==='frostSlam'){
    const r=160;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r){ hitPlayer(boss.dmg*1.0); p.slowTimer=Math.max(p.slowTimer||0,1.6); p.slowFactor=0.6; }
      addParticles(boss.x,boss.y,boss.def.color,26,230,0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.35);
      shake(7);
      spawnToast('El suelo estalla en una onda helada');
    });
  } else if(type==='frostWisp'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*110, vy:Math.sin(ang)*110,
      dmg:boss.dmg*0.65, radius:10, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
    spawnToast('Un espíritu helado te persigue');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*95, vy:Math.sin(ang2)*95,
        dmg:boss.dmg*0.45, radius:9, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
      spawnToast('Un segundo espíritu se une');
    });
  } else if(type==='iceStalker'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*240, vy:Math.sin(ang)*240,
      dmg:boss.dmg*0.55, radius:9, owner:'enemy', color:boss.def.color, life:2.8, homing:true, shape:'orb' });
    spawnToast('Algo veloz te acecha entre el hielo');
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*260, vy:Math.sin(ang2)*260,
        dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:2.4, homing:true, shape:'orb' });
    });
  } else if(type==='frostbite'){
    p.witherTimer = Math.max(p.witherTimer||0, 4.5);
    addParticles(p.x,p.y,boss.def.color,14,100,0.3);
    spawnToast('El frío muerde: tu curación se reduce');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:54, type:'ice', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.32 });
      spawnToast('El frío se asienta con fuerza');
    });
  } else if(type==='brittleChill'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un frío quebradizo entorpece tus golpes');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('El frío se hace más profundo');
    });
  } else if(type==='glacialGrip'){
    p.slowTimer = Math.max(p.slowTimer||0, 2.6);
    p.slowFactor = 0.55;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('El hielo se aferra a tus piernas');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.3);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('El hielo se aprieta más');
    });
  } else if(type==='glacialWard'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.07);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Una armadura de hielo lo restaura');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=105;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('La armadura se rompe con fuerza');
    });
  } else if(type==='thunderStrike'){
    const decoys = [ [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:30, type:'storm', telegraph:0.28, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:34, type:'storm', telegraph:0.28, active:0.3, tick:0, dmg:boss.dmg*1.1 });
    spawnToast('Un rayo cae casi sin aviso');
  } else if(type==='stormVortex'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang = (i/n)*Math.PI*3;
      const rad = 20+i*16;
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+24,b.x+b.w-24);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:22, type:'storm', telegraph:0.35+i*0.08, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Un vórtice de rayos gira hacia afuera');
    scheduleBossAction(0.35+8*0.08+0.25, ()=>{
      if(!game.boss) return;
      const ang=(8/8)*Math.PI*3, rad=20+8*16;
      const ex = clamp(targetX+Math.cos(ang)*rad, b.x+24,b.x+b.w-24);
      const ey = clamp(targetY+Math.sin(ang)*rad, b.y+24,b.y+b.h-24);
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:ex,y:ey, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='staticField'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.5);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('La estática entumece tus reflejos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('La estática vuelve a descargarse');
    });
  } else if(type==='skySiege'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:32, type:'storm', telegraph:1.0, active:0.4, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('El cielo entero se abre de una sola vez');
    shake(4);
    scheduleBossAction(1.4, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:70, type:'storm', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último rayo cae junto al jefe');
    });
  } else if(type==='boltRunner'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
      dmg:boss.dmg*0.6, radius:9, owner:'enemy', color:boss.def.color, life:2.6, homing:true, shape:'orb' });
    spawnToast('Un rayo veloz te persigue');
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*280, vy:Math.sin(ang2)*280,
        dmg:boss.dmg*0.45, radius:8, owner:'enemy', color:boss.def.color, life:2.3, homing:true, shape:'orb' });
    });
  } else if(type==='boltSpray'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*240, vy:Math.sin(ang)*240,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'shard' });
    }
    shake(5);
    spawnToast('Rayos estallan en todas direcciones');
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*270, vy:Math.sin(ang)*270,
          dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:boss.def.color, life:1.9, shape:'shard' });
      }
    });
  } else if(type==='thunderClap'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.22;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*280, vy:Math.sin(ang)*280,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
    }
    spawnToast('Un trueno restalla hacia vos');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.22;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
      }
    });
  } else if(type==='chargedBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=8;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*310, vy:Math.sin(ang)*310,
        dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
    }
    scheduleBossAction(0.25, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<8;i++){
        const ang = ang1+(i-3.5)*0.1;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*330, vy:Math.sin(ang)*330,
          dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.4, shape:'shard' });
      }
    });
  } else if(type==='windSlash'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=5;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.4;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*195, vy:Math.sin(ang)*195,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:2.4, shape:'wisp' });
    }
    spawnToast('El viento corta el aire a tu alrededor');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1+(i-2)*0.4;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:2.1, shape:'wisp' });
      }
    });
  } else if(type==='stormShards'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang = Math.random()*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*220, vy:Math.sin(ang)*220,
        dmg:boss.dmg*0.35, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,150,0.3);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      for(let i=0;i<6;i++){
        const ang = Math.random()*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
          dmg:boss.dmg*0.3, radius:5, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
      }
    });
  } else if(type==='arcVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.3;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
        dmg:boss.dmg*0.7, radius:10, owner:'enemy', color:boss.def.color, life:1.8, shape:'orb' });
    }
    spawnToast('Un arco de energía se dispara con fuerza');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*330, vy:Math.sin(ang1)*330,
        dmg:boss.dmg*0.55, radius:9, owner:'enemy', color:boss.def.color, life:1.6, shape:'orb' });
    });
  } else if(type==='thunderPatch'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:34, type:'storm', telegraph:0.5, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:38, type:'storm', telegraph:0.5, active:0.35, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('Un rayo se prepara para caer');
  } else if(type==='stormCell'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*95, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*95, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'storm', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Una celda de tormenta se cierra alrededor tuyo');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*58, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*58, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'storm', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('La celda se cierra más');
    });
  } else if(type==='lightningField'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:26, type:'storm', telegraph:0.5+Math.random()*0.9, active:0.4, tick:0, dmg:boss.dmg*0.34 });
    }
    spawnToast('Rayos caen al azar por toda la arena');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:64, type:'storm', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último rayo cae junto al jefe');
    });
  } else if(type==='galeZone'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*28, y:targetY+Math.sin(ang)*28, r:18, type:'storm',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:65 });
    }
    spawnToast('Un vendaval se expande desde el centro');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*72, y:targetY+Math.sin(ang)*72, r:16, type:'storm',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.36, expanding:true, expandRate:-52 });
      }
      spawnToast('Un segundo vendaval se cierra hacia adentro');
    });
  } else if(type==='thunderColumn'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'storm', telegraph:0.22+frac*0.8, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una columna de rayos avanza hacia vos');
    scheduleBossAction(1.1, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='stormPocket'){
    const n=4;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+50,b.x+b.w-50), hy = rand(b.y+50,b.y+b.h-50);
      game.hazards.push({ x:hx, y:hy, r:55, type:'storm', telegraph:1.1, active:0.45, tick:0, dmg:boss.dmg*0.7 });
    }
    spawnToast('Bolsillos de tormenta se forman por la arena');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:65, type:'storm', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último bolsillo estalla junto al jefe');
    });
  } else if(type==='chainStrike'){
    const n=6;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:28, type:'storm', telegraph:0.3+i*0.15, active:0.35, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('Una cadena de rayos se enciende en secuencia');
    scheduleBossAction(0.3+6*0.15+0.3, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:56, type:'storm', telegraph:0.25, active:0.35, tick:0, dmg:boss.dmg*0.45 });
      spawnToast('La cadena termina junto al jefe');
    });
  } else if(type==='squallLine'){
    const vertical = Math.random()<0.5;
    const n=9;
    for(let i=0;i<n;i++){
      const frac=i/(n-1);
      const hx = vertical ? targetX : (b.x+24+frac*(b.w-48));
      const hy = vertical ? (b.y+24+frac*(b.h-48)) : targetY;
      game.hazards.push({ x:hx, y:hy, r:24, type:'storm', telegraph:0.5, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una línea de tormenta cruza la arena');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      const hx2 = vertical ? clamp(targetX+70, b.x+24,b.x+b.w-24) : targetX;
      const hy2 = vertical ? targetY : clamp(targetY+70, b.y+24,b.y+b.h-24);
      for(let i=0;i<9;i++){
        const frac=i/8;
        const hx = vertical ? hx2 : (b.x+24+frac*(b.w-48));
        const hy = vertical ? (b.y+24+frac*(b.h-48)) : hy2;
        game.hazards.push({ x:hx, y:hy, r:20, type:'storm', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.3 });
      }
      spawnToast('Una segunda línea cruza cerca');
    });
  } else if(type==='thunderSlam'){
    const r=165;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
      addParticles(boss.x,boss.y,boss.def.color,28,250,0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.35);
      shake(8);
      spawnToast('Truena con toda su fuerza contra el suelo');
    });
  } else if(type==='stormChaser'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
      dmg:boss.dmg*0.55, radius:9, owner:'enemy', color:boss.def.color, life:2.6, homing:true, shape:'orb' });
    spawnToast('Un rayo veloz cambia de rumbo para alcanzarte');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*270, vy:Math.sin(ang2)*270,
        dmg:boss.dmg*0.4, radius:8, owner:'enemy', color:boss.def.color, life:2.3, homing:true, shape:'orb' });
    });
  } else if(type==='thunderEye'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*115, vy:Math.sin(ang)*115,
      dmg:boss.dmg*0.68, radius:11, owner:'enemy', color:boss.def.color, life:4.4, homing:true, shape:'wisp' });
    spawnToast('Un ojo eléctrico te sigue de cerca');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*130, vy:Math.sin(ang2)*130,
        dmg:boss.dmg*0.5, radius:10, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
      spawnToast('Un segundo ojo se abre');
    });
  } else if(type==='staticShock'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.2);
    p.chillFactor = 1.55;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una descarga estática entorpece tus reflejos');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:56, type:'storm', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('La descarga estalla');
    });
  } else if(type==='galeForce'){
    p.slowTimer = Math.max(p.slowTimer||0, 2.8);
    p.slowFactor = 0.58;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una ráfaga te empuja y frena tus pasos');
    scheduleBossAction(0.85, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.4);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('Una segunda ráfaga te golpea');
    });
  } else if(type==='overcharge'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una sobrecarga debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:55, type:'storm', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('La sobrecarga estalla');
    });
  } else if(type==='stormShield'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.07);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Un manto de tormenta lo restaura');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=105;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El manto se descarga violentamente');
    });
  } else if(type==='voidTendrils'){
    const arms=6;
    for(let a=0;a<arms;a++){
      const ang=(a/arms)*Math.PI*2;
      for(let k=1;k<=2;k++){
        const hx = clamp(targetX+Math.cos(ang)*k*46, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*k*46, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:24, type:'void', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.4 });
      }
    }
    spawnToast('Tentáculos de vacío brotan bajo tus pies');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      for(let a=0;a<arms;a++){
        const ang=(a/arms)*Math.PI*2 + Math.PI/arms;
        const hx = clamp(targetX+Math.cos(ang)*70, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*70, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'void', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.32 });
      }
      spawnToast('Más tentáculos brotan más lejos');
    });
  } else if(type==='darkPulse'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0 + (i-(n-1)/2)*0.3;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*110, vy:Math.sin(ang)*110,
        dmg:boss.dmg*0.75, radius:14, owner:'enemy', color:boss.def.color, life:3.2, shape:'wisp' });
    }
    spawnToast('Orbes de oscuridad avanzan lentos');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*125, vy:Math.sin(ang1)*125,
        dmg:boss.dmg*0.55, radius:13, owner:'enemy', color:boss.def.color, life:2.8, shape:'wisp' });
    });
  } else if(type==='starlightDrain'){
    const drain = p.maxHp*0.07;
    p.maxHp = Math.max(20, p.maxHp-drain);
    p.hp = Math.min(p.hp, p.maxHp);
    boss.hp = Math.min(boss.maxHp, boss.hp+drain*0.6);
    addParticles(p.x,p.y,boss.def.color,16,120,0.35);
    spawnToast('Algo drena tu propia esencia vital');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      const r=100;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.4);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
    });
  } else if(type==='umbraStep'){
    boss.x = clamp(targetX+rand(-40,40), b.x+boss.radius, b.x+b.w-boss.radius);
    boss.y = clamp(targetY+rand(-40,40), b.y+boss.radius, b.y+b.h-boss.radius);
    if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+20) hitPlayer(boss.dmg*0.85);
    addParticles(boss.x,boss.y,boss.def.color,18,150,0.3);
    spawnShockwave(boss.x,boss.y,boss.def.color,50,0.3);
    spawnToast('Aparece de golpe a tu lado');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      spawnShockwave(boss.x,boss.y,boss.def.color,80,0.3);
      if(dist(boss.x,boss.y,p.x,p.y) < boss.radius+p.radius+34) hitPlayer(boss.dmg*0.4);
    });
  } else if(type==='collapsingStar'){
    const cracks=3;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,90);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:16, type:'void', telegraph:0.6+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:110, type:'void', telegraph:1.3, active:0.4, tick:0, dmg:boss.dmg*1.2 });
    spawnToast('Una estrella colapsa donde estabas parado');
  } else if(type==='shadowShards'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*215, vy:Math.sin(ang)*215,
        dmg:boss.dmg*0.5, radius:8, owner:'enemy', color:boss.def.color, life:2.4, shape:'shard' });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,150,0.35);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*185, vy:Math.sin(ang)*185,
          dmg:boss.dmg*0.36, radius:7, owner:'enemy', color:boss.def.color, life:2.1, shape:'shard' });
      }
    });
  } else if(type==='voidBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.24;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'shard' });
    }
    spawnToast('El vacío escupe esquirlas hacia vos');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.24;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*280, vy:Math.sin(ang)*280,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'shard' });
      }
    });
  } else if(type==='darkVolley'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=8;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*290, vy:Math.sin(ang)*290,
        dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:boss.def.color, life:1.6, shape:'shard' });
    }
    scheduleBossAction(0.25, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<8;i++){
        const ang = ang1+(i-3.5)*0.1;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*310, vy:Math.sin(ang)*310,
          dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='eclipseSpray'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang = Math.random()*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*175, vy:Math.sin(ang)*175,
        dmg:boss.dmg*0.36, radius:6, owner:'enemy', color:boss.def.color, life:2.2, shape:'wisp' });
    }
    spawnToast('Una sombra estalla en todas direcciones');
    scheduleBossAction(0.45, ()=>{
      if(!game.boss) return;
      for(let i=0;i<6;i++){
        const ang = Math.random()*Math.PI*2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*195, vy:Math.sin(ang)*195,
          dmg:boss.dmg*0.3, radius:5, owner:'enemy', color:boss.def.color, life:2, shape:'wisp' });
      }
    });
  } else if(type==='starfallShards'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.32;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*120, vy:Math.sin(ang)*120,
        dmg:boss.dmg*0.78, radius:14, owner:'enemy', color:boss.def.color, life:3.4, shape:'orb' });
    }
    spawnToast('Fragmentos de estrella caen pesadamente');
    scheduleBossAction(0.55, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*135, vy:Math.sin(ang1)*135,
        dmg:boss.dmg*0.58, radius:13, owner:'enemy', color:boss.def.color, life:3, shape:'orb' });
    });
  } else if(type==='umbralArc'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=7;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.48;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*185, vy:Math.sin(ang)*185,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:2.5, shape:'wisp' });
    }
    spawnToast('Un arco de sombra se extiende hacia vos');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1+(i-2)*0.48;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*205, vy:Math.sin(ang)*205,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:2.2, shape:'wisp' });
      }
    });
  } else if(type==='voidPool'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:40, type:'void', telegraph:0.8, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:48, type:'void', telegraph:0.8, active:0.4, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('Un pozo de vacío se abre en el suelo');
  } else if(type==='shadowPatch'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*92, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*92, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'void', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Sombras cierran un anillo a tu alrededor');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*55, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*55, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'void', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('Las sombras se cierran más');
    });
  } else if(type==='darkRift'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'void', telegraph:0.22+frac*0.85, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una fisura de vacío avanza hacia vos');
    scheduleBossAction(1.15, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*165, vy:Math.sin(a2)*165,
          dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'shard' });
      }
    });
  } else if(type==='eclipseZone'){
    const cracks=3;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,80);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:15, type:'void', telegraph:0.55+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:100, type:'void', telegraph:1.25, active:0.5, tick:0, dmg:boss.dmg*1.05 });
    spawnToast('Una zona de eclipse se cierne sobre el lugar');
  } else if(type==='starfallField'){
    const n=6;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:30, type:'void', telegraph:0.5+Math.random()*1.0, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Restos estelares caen al azar');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:66, type:'void', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último resto enorme cae junto al jefe');
    });
  } else if(type==='umbralCage'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*28, y:targetY+Math.sin(ang)*28, r:18, type:'void',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:60 });
    }
    spawnToast('Una jaula de sombras se expande a tu alrededor');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*68, y:targetY+Math.sin(ang)*68, r:16, type:'void',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.36, expanding:true, expandRate:-50 });
      }
      spawnToast('Una segunda jaula se cierra hacia adentro');
    });
  } else if(type==='voidColumn'){
    const n=4;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+50,b.x+b.w-50), hy = rand(b.y+50,b.y+b.h-50);
      game.hazards.push({ x:hx, y:hy, r:60, type:'void', telegraph:1.2, active:0.5, tick:0, dmg:boss.dmg*0.75 });
    }
    spawnToast('Columnas de vacío se abren por la arena');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:70, type:'void', telegraph:0.35, active:0.45, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Una última columna se abre junto al jefe');
    });
  } else if(type==='nullGround'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'void', telegraph:0.5+Math.random()*0.9, active:0.4, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('El suelo se anula al azar por toda la sala');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:62, type:'void', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último anulamiento cae junto al jefe');
    });
  } else if(type==='shadowSlam'){
    const r=170;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
      addParticles(boss.x,boss.y,boss.def.color,28,260,0.5);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.4);
      shake(9);
      spawnToast('Golpea el suelo con una onda de vacío');
    });
  } else if(type==='voidWisp'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*100, vy:Math.sin(ang)*100,
      dmg:boss.dmg*0.68, radius:11, owner:'enemy', color:boss.def.color, life:4.6, homing:true, shape:'wisp' });
    spawnToast('Un espíritu de vacío te persigue');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*85, vy:Math.sin(ang2)*85,
        dmg:boss.dmg*0.48, radius:10, owner:'enemy', color:boss.def.color, life:4.2, homing:true, shape:'wisp' });
      spawnToast('Un segundo espíritu se une');
    });
  } else if(type==='shadowStalker'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*245, vy:Math.sin(ang)*245,
      dmg:boss.dmg*0.56, radius:9, owner:'enemy', color:boss.def.color, life:2.7, homing:true, shape:'orb' });
    spawnToast('Una sombra veloz te acecha');
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*265, vy:Math.sin(ang2)*265,
        dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:2.4, homing:true, shape:'orb' });
    });
  } else if(type==='voidGrasp'){
    p.slowTimer = Math.max(p.slowTimer||0, 2.8);
    p.slowFactor = 0.55;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('El vacío se aferra a tus pasos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.3);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('El vacío se aferra más fuerte');
    });
  } else if(type==='starDrain'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Algo drena la fuerza de tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:55, type:'void', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('El drenaje termina en un golpe');
    });
  } else if(type==='nullTouch'){
    p.chillTimer = Math.max(p.chillTimer||0, 3.3);
    p.chillFactor = 1.5;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Un toque nulo entorpece tus reflejos');
    scheduleBossAction(0.8, ()=>{
      if(!game.boss) return;
      p.chillTimer = Math.max(p.chillTimer||0, 2.0);
      addParticles(p.x,p.y,boss.def.color,12,80,0.25);
      spawnToast('El toque nulo vuelve a alcanzarte');
    });
  } else if(type==='voidShroud'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.07);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Un manto de vacío lo restaura');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=105;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('El manto se descarga con fuerza');
    });
  } else if(type==='royalDecree'){
    p.qLockTimer = Math.max(p.qLockTimer||0, 2.5);
    p.eLockTimer = Math.max(p.eLockTimer||0, 2.5);
    addParticles(p.x,p.y,boss.def.color,18,120,0.35);
    spawnToast('Un decreto silencia tus habilidades');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:58, type:'spike', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('El decreto se hace cumplir por la fuerza');
    });
  } else if(type==='throneSlam'){
    // a heavier double-ringed version of a self slam, with two shockwaves instead of one
    const r=180;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,boss.def.color,30,260,0.5);
    spawnShockwave(boss.x,boss.y,boss.def.color,r,0.4);
    spawnShockwave(boss.x,boss.y,boss.def.color,r*0.6,0.3);
    shake(10);
    spawnToast('El trono golpea con todo su peso');
  } else if(type==='crownfire'){
    // three full rings fired in sequence, each faster than the last
    [0,1,2].forEach(ring=>{
      const n=8, speed=180+ring*70;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + ring*0.2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed,
          dmg:boss.dmg*0.4, radius:6, owner:'enemy', color:boss.def.color, life:2, shape:'ember' });
      }
    });
    shake(5);
    spawnToast('Anillos de fuego se expanden en cadena');
  } else if(type==='finalJudgment'){
    const cracks=4;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,120);
      const hx = clamp(b.x+b.w/2+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(b.y+b.h/2+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:16, type:'void', telegraph:0.8+Math.random()*0.4, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:b.x+b.w/2, y:b.y+b.h/2, r:170, type:'void', telegraph:1.4, active:0.5, tick:0, dmg:boss.dmg*1.1 });
    spawnToast('El centro de la sala se vuelve letal');
  } else if(type==='soulBarrage'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    [-0.4,0,0.4].forEach(off=>{
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang0+off)*130, vy:Math.sin(ang0+off)*130,
        dmg:boss.dmg*0.5, radius:9, owner:'enemy', color:boss.def.color, life:3.2, homing:true, shape:'wisp' });
    });
    spawnToast('Tres almas te persiguen desde ángulos distintos');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      [-0.6,0.6].forEach(off=>{
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1+off)*115, vy:Math.sin(ang1+off)*115,
          dmg:boss.dmg*0.4, radius:8, owner:'enemy', color:boss.def.color, life:2.8, homing:true, shape:'wisp' });
      });
      spawnToast('Dos almas más se suman a la persecución');
    });
  } else if(type==='crownShards'){
    const n=9;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*225, vy:Math.sin(ang)*225,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:boss.def.color, life:2.2, shape:'ember' });
    }
    shake(5);
    spawnToast('Fragmentos de corona estallan en anillo');
    scheduleBossAction(0.38, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*255, vy:Math.sin(ang)*255,
          dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:boss.def.color, life:2, shape:'ember' });
      }
    });
  } else if(type==='royalVolley'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=6;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*260, vy:Math.sin(ang)*260,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:boss.def.color, life:2, shape:'ember' });
    }
    spawnToast('Una descarga real se dispara hacia vos');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<n;i++){
        const ang = ang1+(i-(n-1)/2)*0.2;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*290, vy:Math.sin(ang)*290,
          dmg:boss.dmg*0.42, radius:6, owner:'enemy', color:boss.def.color, life:1.8, shape:'ember' });
      }
    });
  } else if(type==='soulBurst'){
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    const n=8;
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.12;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
        dmg:boss.dmg*0.4, radius:5, owner:'enemy', color:boss.def.color, life:1.6, shape:'wisp' });
    }
    scheduleBossAction(0.25, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<8;i++){
        const ang = ang1+(i-3.5)*0.12;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*320, vy:Math.sin(ang)*320,
          dmg:boss.dmg*0.32, radius:5, owner:'enemy', color:boss.def.color, life:1.5, shape:'wisp' });
      }
    });
  } else if(type==='radiantBlast'){
    const n=10;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*195, vy:Math.sin(ang)*195,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:2.4, shape:'ember' });
    }
    addParticles(boss.x,boss.y,boss.def.color,16,150,0.35);
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*225, vy:Math.sin(ang)*225,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:2.1, shape:'ember' });
      }
    });
  } else if(type==='scepterShards'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.3;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*300, vy:Math.sin(ang)*300,
        dmg:boss.dmg*0.72, radius:10, owner:'enemy', color:boss.def.color, life:1.8, shape:'orb' });
    }
    spawnToast('El cetro dispara con fuerza real');
    scheduleBossAction(0.4, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang1)*320, vy:Math.sin(ang1)*320,
        dmg:boss.dmg*0.55, radius:9, owner:'enemy', color:boss.def.color, life:1.6, shape:'orb' });
    });
  } else if(type==='dominionSpray'){
    const n=7;
    const ang0 = Math.atan2(p.y-boss.y, p.x-boss.x);
    for(let i=0;i<n;i++){
      const ang = ang0+(i-(n-1)/2)*0.5;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*180, vy:Math.sin(ang)*180,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:boss.def.color, life:2.5, shape:'wisp' });
    }
    spawnToast('Su dominio se extiende hacia vos en abanico');
    scheduleBossAction(0.5, ()=>{
      if(!game.boss) return;
      const ang1 = Math.atan2(p.y-boss.y, p.x-boss.x);
      for(let i=0;i<5;i++){
        const ang = ang1+(i-2)*0.5;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
          dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:boss.def.color, life:2.2, shape:'wisp' });
      }
    });
  } else if(type==='thronePatch'){
    const decoys = [ [rand(-90,90), rand(-90,90)], [rand(-90,90), rand(-90,90)] ];
    decoys.forEach(([dx,dy])=>{
      const hx = clamp(targetX+dx, b.x+22,b.x+b.w-22), hy = clamp(targetY+dy, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:36, type:'spike', telegraph:0.75, active:0.001, tick:0, dmg:0 });
    });
    game.hazards.push({ x:targetX, y:targetY, r:44, type:'spike', telegraph:0.75, active:0.4, tick:0, dmg:boss.dmg*1.0 });
    spawnToast('El trono señala un punto de castigo');
  } else if(type==='judgmentZone'){
    const cracks=3;
    for(let i=0;i<cracks;i++){
      const ang = Math.random()*Math.PI*2, rad = rand(30,80);
      const hx = clamp(targetX+Math.cos(ang)*rad, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*rad, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:15, type:'fire', telegraph:0.5+Math.random()*0.3, active:0.001, tick:0, dmg:0 });
    }
    game.hazards.push({ x:targetX, y:targetY, r:100, type:'fire', telegraph:1.2, active:0.5, tick:0, dmg:boss.dmg*1.05 });
    spawnToast('Una zona de juicio se enciende bajo tus pies');
  } else if(type==='soulField'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      const hx = clamp(targetX+Math.cos(ang)*92, b.x+22,b.x+b.w-22);
      const hy = clamp(targetY+Math.sin(ang)*92, b.y+22,b.y+b.h-22);
      game.hazards.push({ x:hx, y:hy, r:22, type:'spike', telegraph:0.6, active:0.4, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Almas errantes cierran un anillo a tu alrededor');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        const hx = clamp(targetX+Math.cos(ang)*56, b.x+22,b.x+b.w-22);
        const hy = clamp(targetY+Math.sin(ang)*56, b.y+22,b.y+b.h-22);
        game.hazards.push({ x:hx, y:hy, r:20, type:'spike', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.4 });
      }
      spawnToast('Más almas se suman al anillo');
    });
  } else if(type==='dominionCircle'){
    const n=8;
    for(let i=0;i<n;i++){
      const ang=(i/n)*Math.PI*2;
      game.hazards.push({ x:targetX+Math.cos(ang)*28, y:targetY+Math.sin(ang)*28, r:18, type:'fire',
        telegraph:0.4, active:0.5, tick:0, dmg:boss.dmg*0.4, expanding:true, expandRate:60 });
    }
    spawnToast('Un círculo de dominio se expande hacia afuera');
    scheduleBossAction(0.65, ()=>{
      if(!game.boss) return;
      for(let i=0;i<n;i++){
        const ang=(i/n)*Math.PI*2 + Math.PI/n;
        game.hazards.push({ x:targetX+Math.cos(ang)*70, y:targetY+Math.sin(ang)*70, r:16, type:'fire',
          telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.36, expanding:true, expandRate:-52 });
      }
      spawnToast('Un segundo círculo se cierra hacia adentro');
    });
  } else if(type==='regalSpikes'){
    const steps=7;
    for(let i=0;i<steps;i++){
      const frac=i/(steps-1);
      const hx = clamp(boss.x+(targetX-boss.x)*frac, b.x+24,b.x+b.w-24);
      const hy = clamp(boss.y+(targetY-boss.y)*frac, b.y+24,b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:24, type:'spike', telegraph:0.22+frac*0.85, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Picos reales emergen en fila hacia vos');
    scheduleBossAction(1.15, ()=>{
      if(!game.boss) return;
      const m=6;
      for(let k=0;k<m;k++){
        const a2=(k/m)*Math.PI*2;
        spawnProjectile({ x:targetX,y:targetY, vx:Math.cos(a2)*170, vy:Math.sin(a2)*170,
          dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:boss.def.color, life:1.5, shape:'ember' });
      }
    });
  } else if(type==='sovereignGround'){
    const n=6;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:28, type:'spike', telegraph:0.5+Math.random()*1.0, active:0.45, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('El suelo se alza al azar por orden del trono');
    scheduleBossAction(1.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:66, type:'spike', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.55 });
      spawnToast('Un último pico enorme se alza junto al jefe');
    });
  } else if(type==='crownfireField'){
    const n=4;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+50,b.x+b.w-50), hy = rand(b.y+50,b.y+b.h-50);
      game.hazards.push({ x:hx, y:hy, r:56, type:'fire', telegraph:1.1, active:0.45, tick:0, dmg:boss.dmg*0.7 });
    }
    spawnToast('Fuego de corona se enciende por la arena');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:64, type:'fire', telegraph:0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último fuego enorme se enciende junto al jefe');
    });
  } else if(type==='royalGround'){
    const n=7;
    for(let i=0;i<n;i++){
      const hx = rand(b.x+30,b.x+b.w-30), hy = rand(b.y+30,b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:24, type:'fire', telegraph:0.5+Math.random()*0.9, active:0.4, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('El suelo arde al azar por toda la sala');
    scheduleBossAction(1.5, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:boss.x, y:boss.y, r:60, type:'fire', telegraph:0.3, active:0.35, tick:0, dmg:boss.dmg*0.5 });
      spawnToast('Un último fuego arde junto al jefe');
    });
  } else if(type==='royalSlam'){
    const r=165;
    addParticles(boss.x,boss.y,boss.def.color,10,80,0.3);
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
      addParticles(boss.x,boss.y,boss.def.color,28,250,0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.35);
      shake(8);
      spawnToast('Golpea el suelo con autoridad real');
    });
  } else if(type==='soulChaser'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*105, vy:Math.sin(ang)*105,
      dmg:boss.dmg*0.68, radius:11, owner:'enemy', color:boss.def.color, life:4.5, homing:true, shape:'wisp' });
    spawnToast('Un alma condenada te persigue');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*90, vy:Math.sin(ang2)*90,
        dmg:boss.dmg*0.48, radius:10, owner:'enemy', color:boss.def.color, life:4, homing:true, shape:'wisp' });
      spawnToast('Otra alma condenada se une');
    });
  } else if(type==='wraithMark'){
    const ang = Math.atan2(p.y-boss.y, p.x-boss.x);
    spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*250, vy:Math.sin(ang)*250,
      dmg:boss.dmg*0.56, radius:9, owner:'enemy', color:boss.def.color, life:2.7, homing:true, shape:'orb' });
    spawnToast('Una marca espectral te sigue veloz');
    scheduleBossAction(0.35, ()=>{
      if(!game.boss) return;
      const ang2 = Math.atan2(p.y-boss.y, p.x-boss.x);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang2)*270, vy:Math.sin(ang2)*270,
        dmg:boss.dmg*0.42, radius:8, owner:'enemy', color:boss.def.color, life:2.4, homing:true, shape:'orb' });
    });
  } else if(type==='royalCurse'){
    p.weakenTimer = Math.max(p.weakenTimer||0, 4);
    p.weakenFactor = 0.75;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Una maldición real debilita tus golpes');
    scheduleBossAction(0.6, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:56, type:'spike', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.35 });
      spawnToast('La maldición se cierra sobre vos');
    });
  } else if(type==='soulDrain'){
    p.witherTimer = Math.max(p.witherTimer||0, 4.5);
    addParticles(p.x,p.y,boss.def.color,14,100,0.3);
    spawnToast('Algo drena tu voluntad de sanar');
    scheduleBossAction(0.7, ()=>{
      if(!game.boss) return;
      game.hazards.push({ x:p.x, y:p.y, r:52, type:'void', telegraph:0.3, active:0.3, tick:0, dmg:boss.dmg*0.3 });
      spawnToast('El drenaje se completa');
    });
  } else if(type==='crownBind'){
    p.slowTimer = Math.max(p.slowTimer||0, 2.8);
    p.slowFactor = 0.55;
    addParticles(p.x,p.y,boss.def.color,14,90,0.3);
    spawnToast('Cadenas doradas atan tus pasos');
    scheduleBossAction(0.9, ()=>{
      if(!game.boss) return;
      p.slowTimer = Math.max(p.slowTimer||0, 1.4);
      addParticles(p.x,p.y,boss.def.color,10,70,0.25);
      spawnToast('Las cadenas se aprietan más');
    });
  } else if(type==='royalAegis'){
    boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.07);
    addParticles(boss.x,boss.y,boss.def.color,16,110,0.3);
    spawnToast('Una égida real lo restaura');
    scheduleBossAction(0.75, ()=>{
      if(!game.boss) return;
      const r=105;
      if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.45);
      spawnShockwave(boss.x,boss.y,boss.def.color,r,0.3);
      spawnToast('La égida se descarga con fuerza real');
    });
  } else if(type==='fireWave'){
    game.hazards.push({ x:boss.x, y:boss.y, r:24, type:'fire', telegraph:0, active:2.4, tick:0, dmg:boss.dmg*0.5, expanding:true, expandRate:145 });
    spawnToast('Una oleada de fuego se expande');
    shake(4);
  } else if(type==='twinSwap'){
    if(boss.twin && boss.twin.alive){
      const tx=boss.x, ty=boss.y;
      const twx=boss.twin.x, twy=boss.twin.y;
      spawnShockwave(tx,ty,'#ff9ad1',boss.radius*1.3,0.32);
      spawnShockwave(twx,twy,'#ff9ad1',boss.radius*1.1,0.32);
      addParticles(boss.x,boss.y,'#ff9ad1',16,180,0.35);
      addParticles(boss.twin.x,boss.twin.y,'#ff9ad1',16,180,0.35);
      // a brief streak connecting the two swapped points, tracing the swap itself
      for(let k=1;k<6;k++){
        const fr=k/6;
        game.particles.push({ x:tx+(twx-tx)*fr, y:ty+(twy-ty)*fr, vx:0, vy:0, life:0.22, maxLife:0.22, color:'#ff9ad1', r:2.4, type:'circle' });
      }
      boss.x = boss.twin.x; boss.y = boss.twin.y;
      boss.twin.x = tx; boss.twin.y = ty;
      if(dist(boss.x,boss.y,p.x,p.y)<boss.radius+p.radius+40) hitPlayer(boss.dmg*0.6);
      if(dist(boss.twin.x,boss.twin.y,p.x,p.y)<boss.radius+p.radius+40) hitPlayer(boss.dmg*0.6);
    } else {
      const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
      boss.x = clamp(boss.x+Math.cos(ang)*80, b.x+boss.radius, b.x+b.w-boss.radius);
      boss.y = clamp(boss.y+Math.sin(ang)*80, b.y+boss.radius, b.y+b.h-boss.radius);
      if(dist(boss.x,boss.y,p.x,p.y)<boss.radius+p.radius+30) hitPlayer(boss.dmg*0.6);
    }
    shake(5);
  }

  // ============================================================
  // ASCENSO — attacks exclusive to the tower-above-100 bosses.
  // Piso 1 (Larva de Sombra): voidClaw, voidPuddles, shadowBurst
  // Piso 100 (El Sol): solarFlare, radiantCollapse, zenith (dawnBeam is wired above,
  // sharing the plasmaBeam mechanic — see the generalized blocks earlier in this file)
  // ============================================================
  else if(type==='voidClaw'){
    // a heavier, slower cousin of 'slam' — Larva de Sombra's only melee-range punish
    const r = 135;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.15);
    addParticles(boss.x,boss.y,'#8a5ad9',24,220,0.5);
    spawnShockwave(boss.x,boss.y,'#3a2f52',r,0.4);
    shake(7);
  }
  else if(type==='voidPuddles'){
    // 3 pools of pure dark bloom near the player — stand in one and it also slows you, since
    // shadow doesn't just hurt, it clings
    for(let i=0;i<3;i++){
      const hx = clamp(targetX+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'void', telegraph:0.65, active:2.6, tick:0, dmg:boss.dmg*0.32, slow:{factor:0.55,dur:0.6} });
    }
    addParticles(targetX,targetY,'#8a5ad9',18,140,0.4);
    spawnToast('La oscuridad se derrama a tu alrededor');
  }
  else if(type==='shadowBurst'){
    // a modest 6-shard radial burst — Larva de Sombra is floor 1, this is meant to be learnable,
    // not overwhelming (compare to El Sol's 14-shard solarFlare at the top of the tower)
    const n=6;
    for(let i=0;i<n;i++){
      const ang = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(ang)*200, vy:Math.sin(ang)*200,
        dmg:boss.dmg*0.6, radius:7, owner:'enemy', color:'#8a5ad9', life:2.4 });
    }
    shake(5);
  }
  else if(type==='geoSweep'){
    // all the damage already happened during the twin-wall sweep itself (see per-frame update)
    spawnToast('Las paredes de plasma geomagnético se disipan');
    addParticles(boss.x,boss.y,'#ff2fd6',20,170,0.35);
    shake(4);
  }
  else if(type==='stormSpiral'){
    spawnToast('La tormenta estelar en espiral se disipa');
    addParticles(boss.x,boss.y,'#33e5ff',20,170,0.35);
  }
  else if(type==='eruptionConvergence'){
    // 6 fixed danger zones scattered across the arena (rejecting picks that land too close
    // together), each set to detonate ~1s later — plus 6 giant projectiles launched straight
    // at those exact points, timed to arrive right as the zones go off
    const bnds = arenaBounds();
    const points = [];
    for(let i=0;i<6;i++){
      let x,y,tries=0,ok;
      do {
        x = clamp(bnds.x+70+Math.random()*(bnds.w-140), bnds.x+70, bnds.x+bnds.w-70);
        y = clamp(bnds.y+70+Math.random()*(bnds.h-140), bnds.y+70, bnds.y+bnds.h-70);
        ok = points.every(pt=>dist(pt.x,pt.y,x,y) > 140);
        tries++;
      } while(!ok && tries<12);
      points.push({x,y});
      game.hazards.push({ x, y, r:72, type:'solar', telegraph:1.0, active:0.5, tick:0, dmg:boss.dmg*1.3 });
    }
    const travelTime = 1.0;
    points.forEach(pt=>{
      const dx = pt.x-boss.x, dy = pt.y-boss.y;
      const d = Math.hypot(dx,dy)||1;
      const speed = d/travelTime;
      spawnProjectile({ x:boss.x, y:boss.y, vx:(dx/d)*speed, vy:(dy/d)*speed,
        dmg:boss.dmg*0.9, radius:20, owner:'enemy', color:'#c020ff', life:travelTime+0.15, shape:'orb' });
    });
    addParticles(boss.x,boss.y,'#c020ff',26,210,0.5);
    spawnToast('¡Convergencia de erupciones! 6 puntos van a detonar — no te quedes parado');
    shake(8);
  }
  else if(type==='zeroGravityRings'){
    // gravity itself gets heavy: player speed halved for the duration, while concentric rings
    // of cyan radiation pulse outward from El Sol's position, staggered so they read as
    // genuinely expanding rather than one flat blast
    game.player.slowTimer = Math.max(game.player.slowTimer||0, 5.5);
    game.player.slowFactor = 0.5;
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*62, type:'solar', telegraph:0.5+ring*0.5, active:0.5, tick:0, dmg:boss.dmg*0.55 });
    }
    spawnToast('¡Gravedad alterada! Te movés más lento — esquivá los anillos de radiación');
    addParticles(boss.x,boss.y,'#33e5ff',28,210,0.45);
    shake(7);
  }

  // ---- Piso 2: Eco Hueco ----
  else if(type==='echoSlam'){
    // a melee slam that leaves a lingering echo of itself behind — the ground it hit stays
    // dangerous a moment longer, punishing players who circle back to the same spot
    const r = 120;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.7, type:'void', telegraph:0.3, active:1.1, tick:0, dmg:boss.dmg*0.35 });
    addParticles(boss.x,boss.y,'#4a3d68',20,190,0.4);
    shake(6);
  }
  else if(type==='hollowVolley'){
    const n=7;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.16;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
        dmg:boss.dmg*0.55, radius:7, owner:'enemy', color:'#4a3d68', life:2.4 });
    }
    shake(4);
  }
  else if(type==='duplicantPulse'){
    // teleports to a spot near the player, warns briefly, then pulses — a positioning threat
    // rather than a reflex-test, since the pulse itself is slow and telegraphed
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const oldX=boss.x, oldY=boss.y;
    boss.x = clamp(p.x+Math.cos(ang)*90, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*90, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    addParticles(oldX,oldY,'#4a3d68',14,150,0.3);
    game.hazards.push({ x:boss.x, y:boss.y, r:110, type:'void', telegraph:0.7, active:0.4, tick:0, dmg:boss.dmg*0.8 });
    spawnToast('Eco Hueco se reubica en silencio');
  }

  // ---- Piso 3: Tejedor de Grietas ----
  else if(type==='crackLine'){
    // a line of small fissures across the arena with one gap to slip through — same "find the
    // gap" language as blazingFissure/growingMagma but oriented toward the player's position
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 60;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 65) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'void', telegraph:0.9, active:1.6, tick:0, dmg:boss.dmg*0.5 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 65) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'void', telegraph:0.9, active:1.6, tick:0, dmg:boss.dmg*0.5 });
      }
    }
    spawnToast('El suelo se agrieta — buscá el hueco');
  }
  else if(type==='tendrilBloom'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-160,160), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-160,160), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:50, type:'void', telegraph:0.6, active:2.2, tick:0, dmg:boss.dmg*0.3, slow:{factor:0.6,dur:0.5} });
    }
    addParticles(p.x,p.y,'#5a4a7a',16,140,0.4);
  }
  else if(type==='weaverBurst'){
    // spiral burst — each shot offset a bit further than the last, distinct from Eco Hueco's flat volley
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + performance.now()/900;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*210, vy:Math.sin(a)*210,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#5a4a7a', life:2.6 });
    }
    shake(5);
  }

  // ---- Piso 4: Guardiana Muda (más tanque, ataques más lentos y pesados) ----
  else if(type==='silentSlam'){
    const r = 155;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.3);
    spawnShockwave(boss.x,boss.y,'#6a5a8c',r,0.45);
    addParticles(boss.x,boss.y,'#6a5a8c',26,220,0.5);
    shake(9);
  }
  else if(type==='mutePulse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:60+ring*65, type:'void', telegraph:0.4+ring*0.4, active:0.4, tick:0, dmg:boss.dmg*0.45 });
    }
    spawnToast('La Guardiana colapsa hacia adentro');
    shake(5);
  }
  else if(type==='whisperVolley'){
    // fewer, heavier shots than the other early bosses' volleys — fits her slow/tanky identity
    const n=5;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.22;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*190, vy:Math.sin(a)*190,
        dmg:boss.dmg*0.85, radius:9, owner:'enemy', color:'#6a5a8c', life:2.8 });
    }
    shake(6);
  }

  // ---- Piso 5: Devorador de Ecos ----
  else if(type==='devourLunge'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=200;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*1.1, hitPad: 14,
      onComplete: ()=>{ shake(8); addParticles(boss.x,boss.y,'#7a6a9e',18,220,0.4); }
    });
  }
  else if(type==='echoSwarmBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#7a6a9e', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#7a6a9e',18,180,0.4);
    shake(6);
  }
  else if(type==='voidMawPuddles'){
    for(let i=0;i<5;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:44, type:'void', telegraph:0.55, active:2.4, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('El Devorador de Ecos abre fauces en el piso');
  }

  // ---- Piso 6: Centinela de Ceniza ----
  else if(type==='ashSlam'){
    const r = 130;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#8a7ab0',22,200,0.45);
    spawnShockwave(boss.x,boss.y,'#8a7ab0',r,0.4);
    shake(7);
  }
  else if(type==='cinderRing'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:50+ring*55, type:'solar', telegraph:0.3+ring*0.3, active:0.4, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Ceniza incandescente se expande desde el Centinela');
    shake(5);
  }
  else if(type==='ashStorm'){
    const n=9;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.05;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*220, vy:Math.sin(a)*220,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#8a7ab0', life:2.4 });
    }
    game.hazards.push({ x:p.x, y:p.y, r:60, type:'solar', telegraph:0.8, active:1.0, tick:0, dmg:boss.dmg*0.4 });
    addParticles(boss.x,boss.y,'#8a7ab0',20,180,0.4);
    shake(6);
  }

  // ---- Piso 7: Susurro de Grieta (ágil, se reubica antes de rematar) ----
  else if(type==='whisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 220+Math.random()*140;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<5;i++){
      const a = shootAng + (i-2)*0.13;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#9a5ac0', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#9a5ac0',16,160,0.3);
    spawnToast('Susurro de Grieta se desvanece y reaparece');
  }
  else if(type==='crackVolley'){
    const n=9;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*270, vy:Math.sin(a)*270,
        dmg:boss.dmg*0.45, radius:6, owner:'enemy', color:'#9a5ac0', life:2.1 });
    }
    shake(4);
  }
  else if(type==='whisperCrawl'){
    // a short line of hazards crawling from the boss toward the player, not a static line —
    // reads as a "reaching" attack rather than a wall to sidestep
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=5;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'void', telegraph:0.35+i*0.12, active:1.0, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una grieta serpentea hacia vos');
  }

  // ---- Piso 8: Espina de Sombra (deja daño persistente, tema "veneno de sombra") ----
  else if(type==='thornLash'){
    const r = 110;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'poison', telegraph:0.25, active:1.6, tick:0, dmg:boss.dmg*0.28 });
    addParticles(boss.x,boss.y,'#5c2f7a',18,180,0.4);
    shake(6);
  }
  else if(type==='thornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'poison', telegraph:0.6, active:2.6, tick:0, dmg:boss.dmg*0.3 });
    }
    addParticles(p.x,p.y,'#5c2f7a',16,140,0.35);
  }
  else if(type==='thornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*200, vy:Math.sin(a)*200,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#5c2f7a', life:2.5, poison:true });
    }
    shake(5);
  }

  // ---- Piso 9: Custodio Callado (segundo tanque, más lento y pesado que Guardiana Muda) ----
  else if(type==='wardenCrush'){
    const r = 165;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.35);
    spawnShockwave(boss.x,boss.y,'#7a6a9e',r,0.5);
    addParticles(boss.x,boss.y,'#7a6a9e',28,230,0.55);
    shake(10);
  }
  else if(type==='wardenBarrier'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*60, type:'void', telegraph:0.35+ring*0.35, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El Custodio levanta una barrera de sombra');
    shake(5);
  }
  else if(type==='wardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.28;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*175, vy:Math.sin(a)*175,
        dmg:boss.dmg*0.95, radius:10, owner:'enemy', color:'#7a6a9e', life:3.0 });
    }
    shake(6);
  }

  // ---- Piso 10: Enjambre de Cenizas (rápido, muchos golpes débiles en vez de pocos fuertes) ----
  else if(type==='swarmDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=180;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#9a8ab8',16,200,0.35); }
    });
  }
  else if(type==='swarmPepper'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
        dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:'#9a8ab8', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#9a8ab8',20,170,0.35);
    shake(5);
  }
  else if(type==='swarmField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'void', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.24 });
    }
    spawnToast('El Enjambre se dispersa por el suelo');
  }

  // ---- Piso 11: Heraldo de la Grieta (primer piso de dos dígitos — 4 ataques, más peligroso) ----
  else if(type==='heraldSlam'){
    const r = 140;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.15);
    addParticles(boss.x,boss.y,'#aa7ad0',24,210,0.45);
    spawnShockwave(boss.x,boss.y,'#aa7ad0',r,0.4);
    shake(8);
  }
  else if(type==='heraldLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 58;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 70) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 70) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    }
    spawnToast('La Grieta se abre de punta a punta');
  }
  else if(type==='heraldBurst'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*245, vy:Math.sin(a)*245,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#aa7ad0', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#aa7ad0',20,190,0.4);
    shake(6);
  }
  else if(type==='heraldCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:65+ring*65, type:'void', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.55 });
    }
    addParticles(boss.x,boss.y,'#aa7ad0',26,220,0.5);
    spawnToast('El Heraldo colapsa la grieta sobre sí mismo');
    shake(7);
  }

  // ---- Piso 12: Grito Ahogado (una sola onda pesada + minas de eco retardadas) ----
  else if(type==='screamSlam'){
    const r = 145;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    spawnShockwave(boss.x,boss.y,'#4a2f6a',r,0.45);
    addParticles(boss.x,boss.y,'#4a2f6a',24,210,0.5);
    shake(8);
  }
  else if(type==='drownedVolley'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*225, vy:Math.sin(a)*225,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#4a2f6a', life:2.4 });
    }
    shake(5);
  }
  else if(type==='echoTrap'){
    // 2 heavy "landmines" with a long telegraph — the delay is the whole point: it forces you to
    // remember where they are and route around them well before they actually go off
    for(let i=0;i<2;i++){
      const hx = clamp(p.x+rand(-200,200), b.x+30, b.x+b.w-30);
      const hy = clamp(p.y+rand(-200,200), b.y+30, b.y+b.h-30);
      game.hazards.push({ x:hx, y:hy, r:80, type:'void', telegraph:2.2, active:0.5, tick:0, dmg:boss.dmg*1.1 });
    }
    spawnToast('Dos ecos quedan plantados en el piso — van a estallar');
  }

  // ---- Piso 13: Tejido de Penumbra (transición — empieza a mezclar con luz) ----
  else if(type==='duskLash'){
    const r = 115;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.7, type:'light', telegraph:0.3, active:1.2, tick:0, dmg:boss.dmg*0.3 });
    addParticles(boss.x,boss.y,'#6a4a8a',20,190,0.4);
    shake(6);
  }
  else if(type==='duskWeb'){
    // a denser web of small hazards than tendrilBloom — more numerous, smaller, covering a wider area
    for(let i=0;i<6;i++){
      const hx = clamp(p.x+rand(-190,190), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-190,190), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'void', telegraph:0.5, active:1.8, tick:0, dmg:boss.dmg*0.26 });
    }
    spawnToast('Un tejido de penumbra cubre el piso');
  }
  else if(type==='twilightBurst'){
    const n=12;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.06;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*215, vy:Math.sin(a)*215,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#6a4a8a', life:2.5 });
    }
    addParticles(boss.x,boss.y,'#6a4a8a',18,180,0.4);
    shake(5);
  }

  // ---- Piso 14: Guardián sin Rostro (tercer tanque, el más pesado hasta ahora) ----
  else if(type==='facelessCrush'){
    const r = 175;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.4);
    spawnShockwave(boss.x,boss.y,'#7a5a9a',r,0.5);
    addParticles(boss.x,boss.y,'#7a5a9a',30,240,0.55);
    shake(11);
  }
  else if(type==='facelessWard'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:60+ring*62, type:'void', telegraph:0.35+ring*0.35, active:0.45, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('El Guardián levanta un muro de silencio');
    shake(5);
  }
  else if(type==='facelessGaze'){
    const n=3;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.32;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*160, vy:Math.sin(a)*160,
        dmg:boss.dmg*1.05, radius:11, owner:'enemy', color:'#7a5a9a', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 15: Enredadera Oscura (denegación de área, cobertura amplia) ----
  else if(type==='vineLash'){
    const r = 120;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    addParticles(boss.x,boss.y,'#3a5a3a',20,190,0.4);
    spawnShockwave(boss.x,boss.y,'#3a5a3a',r,0.4);
    shake(6);
  }
  else if(type==='vineField'){
    // covers a broad swath of the arena in small hazards — meant to shrink the safe space
    // rather than threaten any one spot directly
    const cx = clamp(p.x+rand(-60,60), b.x+120, b.x+b.w-120);
    const cy = clamp(p.y+rand(-60,60), b.y+120, b.y+b.h-120);
    for(let i=0;i<8;i++){
      const a = (i/8)*Math.PI*2;
      const hx = clamp(cx+Math.cos(a)*90, b.x+24, b.x+b.w-24);
      const hy = clamp(cy+Math.sin(a)*90, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:40, type:'void', telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.28 });
    }
    spawnToast('Raíces oscuras brotan del piso');
  }
  else if(type==='vineBurst'){
    const n=9;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*205, vy:Math.sin(a)*205,
        dmg:boss.dmg*0.48, radius:7, owner:'enemy', color:'#3a5a3a', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 16: Susurro Doble (todo lo que hace, lo hace en pares) ----
  else if(type==='whisperTwinDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    startBossDash(boss, ang, 170, {
      dmg: boss.dmg*0.85, hitPad: 12,
      onComplete: ()=>{
        // a second, shorter dash right after — the "twin" motif carried into the attack itself
        const ang2 = Math.atan2(p.y-boss.y,p.x-boss.x);
        startBossDash(boss, ang2, 90, {
          dmg: boss.dmg*0.85, hitPad: 12, dur: 0.14,
          onComplete: ()=>{ shake(7); addParticles(boss.x,boss.y,'#8a4a9a',18,200,0.4); }
        });
      }
    });
  }
  else if(type==='doubleVolley'){
    const n=6;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let pass=0; pass<2; pass++){
      for(let i=0;i<n;i++){
        const a = ang0 + (i-(n-1)/2)*0.15 + pass*0.08;
        spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*(230+pass*20), vy:Math.sin(a)*(230+pass*20),
          dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#8a4a9a', life:2.3 });
      }
    }
    shake(5);
  }
  else if(type==='twinCrawl'){
    // two crawling lines from two different points, converging on the player — a wider pincer
    // version of Susurro de Grieta's single-direction whisperCrawl
    const origins = [{x:b.x+40,y:boss.y}, {x:b.x+b.w-40,y:boss.y}];
    origins.forEach(o=>{
      const ang = Math.atan2(p.y-o.y,p.x-o.x);
      for(let i=1;i<=4;i++){
        const hx = clamp(o.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
        const hy = clamp(o.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
        game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.35+i*0.12, active:1.0, tick:0, dmg:boss.dmg*0.35 });
      }
    });
    spawnToast('Dos grietas se cierran sobre vos');
  }

  // ---- Piso 17: Fragmento Roto (espinas de cristal cayendo en oleadas escalonadas) ----
  else if(type==='shardSlam'){
    const r = 125;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#9a6ac0',22,210,0.45);
    spawnShockwave(boss.x,boss.y,'#9a6ac0',r,0.42);
    shake(7);
  }
  else if(type==='shardRain'){
    // 7 shards with staggered telegraphs — reads as falling one after another rather than
    // appearing all at once, distinct from the other bosses' simultaneous hazard fields
    for(let i=0;i<7;i++){
      const hx = clamp(p.x+rand(-200,200), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-200,200), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:36, type:'void', telegraph:0.4+i*0.14, active:1.2, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Esquirlas de cristal caen del techo');
  }
  else if(type==='shardBurst'){
    // an uneven, "shattered" spread instead of a clean radial pattern
    const n=9;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + rand(-0.18,0.18);
      const spd = 190+rand(-20,40);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*spd, vy:Math.sin(a)*spd,
        dmg:boss.dmg*0.42, radius:6, owner:'enemy', color:'#9a6ac0', life:2.4 });
    }
    shake(5);
  }

  // ---- Piso 18: Custodia de Cenizas (tanque #4, la más lenta de todas hasta ahora) ----
  else if(type==='custodianSlam'){
    const r = 150;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.25);
    spawnShockwave(boss.x,boss.y,'#a08ac0',r,0.46);
    addParticles(boss.x,boss.y,'#a08ac0',26,220,0.5);
    shake(9);
  }
  else if(type==='custodianRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:50+ring*55, type:'void', telegraph:0.3+ring*0.3, active:0.4, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('La Custodia levanta cenizas en capas');
    shake(5);
  }
  else if(type==='custodianVolley'){
    const n=6;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*185, vy:Math.sin(a)*185,
        dmg:boss.dmg*0.6, radius:8, owner:'enemy', color:'#a08ac0', life:2.8 });
    }
    shake(5);
  }

  // ---- Piso 19: Lamento sin Nombre (ágil y esquiva, ataca desde lejos) ----
  else if(type==='lamentDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 200+Math.random()*150;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*265, vy:Math.sin(a)*265,
        dmg:boss.dmg*0.45, radius:6, owner:'enemy', color:'#b07ad0', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#b07ad0',16,160,0.3);
    spawnToast('El Lamento se desvanece y reaparece');
  }
  else if(type==='lamentCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Un lamento serpentea hacia vos');
  }
  else if(type==='lamentWail'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*235, vy:Math.sin(a)*235,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#b07ad0', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#b07ad0',18,180,0.4);
    shake(5);
  }

  // ---- Piso 20: Corazón de Grieta (segundo piso "de control", 4 ataques) ----
  else if(type==='heartSlam'){
    const r = 150;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    addParticles(boss.x,boss.y,'#c08ae0',26,220,0.5);
    spawnShockwave(boss.x,boss.y,'#c08ae0',r,0.44);
    shake(8);
  }
  else if(type==='heartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    }
    spawnToast('El Corazón de Grieta parte la sala al medio');
  }
  else if(type==='heartBurst'){
    const n=12;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#c08ae0', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#c08ae0',20,190,0.4);
    shake(6);
  }
  else if(type==='heartCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'void', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.58 });
    }
    addParticles(boss.x,boss.y,'#c08ae0',28,230,0.52);
    spawnToast('El Corazón late — y colapsa hacia adentro');
    shake(8);
  }

  // ---- Piso 21: Ecos del Umbral (primer haz barredor fuera de El Sol — voidBeam) ----
  else if(type==='thresholdSlam'){
    const r = 128;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#a070c0',22,200,0.42);
    spawnShockwave(boss.x,boss.y,'#a070c0',r,0.4);
    shake(7);
  }
  else if(type==='thresholdField'){
    for(let i=0;i<5;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'void', telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El Umbral se llena de ecos');
  }

  // ---- Piso 22: Coro Hueco (ataques "corales", en abanico ancho en vez de círculo completo) ----
  else if(type==='choirSlam'){
    const r = 130;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#9a5ab0',22,200,0.42);
    spawnShockwave(boss.x,boss.y,'#9a5ab0',r,0.4);
    shake(7);
  }
  else if(type==='choirWave'){
    // a wide fan aimed at the player instead of a full radial burst — reads as a chorus of
    // voices converging on one direction rather than an omnidirectional blast
    const n=13;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.09;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#9a5ab0', life:2.3 });
    }
    shake(5);
  }
  else if(type==='choirEcho'){
    for(let i=0;i<5;i++){
      const a = (i/5)*Math.PI*2;
      const hx = clamp(p.x+Math.cos(a)*110, b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+Math.sin(a)*110, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.5, active:1.6, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El Coro Hueco canta desde todas direcciones');
  }

  // ---- Piso 23: Merodeador del Ocaso (rápido, combina embestida + zarpazo inmediato) ----
  else if(type==='marauderPounce'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=210;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*1.0, hitPad: 12,
      onComplete: ()=>{ shake(7); addParticles(boss.x,boss.y,'#b06ac0',18,210,0.38); }
    });
  }
  else if(type==='marauderRake'){
    const r = 105;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*0.95);
    addParticles(boss.x,boss.y,'#b06ac0',16,170,0.32);
    shake(5);
  }
  else if(type==='marauderHail'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + rand(-0.1,0.1);
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*255, vy:Math.sin(a)*255,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#b06ac0', life:2.2 });
    }
    shake(5);
  }

  // ---- Piso 24: Custodio de Granito (tanque #5, el más pesado hasta ahora) ----
  else if(type==='graniteCrush'){
    const r = 180;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.4);
    spawnShockwave(boss.x,boss.y,'#8a7a9a',r,0.5);
    addParticles(boss.x,boss.y,'#8a7a9a',30,240,0.55);
    shake(12);
  }
  else if(type==='graniteWall'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'void', telegraph:0.3+ring*0.32, active:0.42, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('El Custodio levanta un muro de piedra');
    shake(6);
  }
  else if(type==='graniteVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.25;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*170, vy:Math.sin(a)*170,
        dmg:boss.dmg*1.0, radius:11, owner:'enemy', color:'#8a7a9a', life:3.2 });
    }
    shake(6);
  }

  // ---- Piso 25: Florecer Marchito (primera mezcla real sombra/luz — cierre del primer tramo) ----
  else if(type==='bloomLash'){
    const r = 118;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.7, type:'light', telegraph:0.3, active:1.2, tick:0, dmg:boss.dmg*0.3 });
    addParticles(boss.x,boss.y,'#6a8a5a',20,190,0.4);
    shake(6);
  }
  else if(type==='bloomField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-170,170), b.y+24, b.y+b.h-24);
      const hazType = i%2===0 ? 'void' : 'light';
      game.hazards.push({ x:hx, y:hy, r:40, type:hazType, telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.28 });
    }
    spawnToast('Brotes a medio camino entre la sombra y la luz');
  }
  else if(type==='bloomBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*215, vy:Math.sin(a)*215,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#6a8a5a', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#6a8a5a',18,190,0.4);
    shake(5);
  }

  // ---- Piso 26: Corona de Brasas (primer jefe realmente "ardiendo" — abre el segundo tramo) ----
  else if(type==='emberSlam'){
    const r = 140;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    addParticles(boss.x,boss.y,'#d0906a',24,220,0.48);
    spawnShockwave(boss.x,boss.y,'#d0906a',r,0.42);
    shake(8);
  }
  else if(type==='crownAshfall'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-160,160), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-160,160), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:44, type:'fire', telegraph:0.5, active:2.2, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Brasas caen alrededor de la Corona');
  }
  else if(type==='emberBurst'){
    const n=12;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.05;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*235, vy:Math.sin(a)*235,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#d0906a', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#d0906a',20,200,0.42);
    shake(6);
  }

  // ---- Piso 27: Ceniza Errante (rápido y ligero, deja rastro de brasas al moverse) ----
  else if(type==='ashDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=210;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12, steps: 9,
      onStep: (i)=>{
        if(i%2===0){
          const hx = clamp(boss.x, b.x+24, b.x+b.w-24), hy = clamp(boss.y, b.y+24, b.y+b.h-24);
          game.hazards.push({ x:hx, y:hy, r:28, type:'fire', telegraph:0.15, active:1.0, tick:0, dmg:boss.dmg*0.2 });
        }
      },
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#c07850',16,200,0.35); }
    });
  }
  else if(type==='emberWake'){
    // crawling line of embers toward the player, same "reaching" feel as whisperCrawl (piso 7)
    // but with the fire hazard instead of void, matching the boss's ash/ember theme
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=5;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'fire', telegraph:0.3+i*0.11, active:1.0, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Una estela de brasas serpentea hacia vos');
  }
  else if(type==='cinderScatter'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*245, vy:Math.sin(a)*245,
        dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:'#c07850', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#c07850',18,190,0.38);
    shake(5);
  }

  // ---- Piso 28: Brasa Doliente (lento y pesado, el dolor del golpe se refleja en el jefe mismo) ----
  else if(type==='emberCrush'){
    const r = 155;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.3);
    spawnShockwave(boss.x,boss.y,'#a8452c',r,0.48);
    addParticles(boss.x,boss.y,'#a8452c',30,240,0.5);
    shake(10);
  }
  else if(type==='achingRing'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:p.x, y:p.y, r:50+ring*58, type:'fire', telegraph:0.35+ring*0.35, active:0.45, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('Brasa Doliente levanta anillos de fuego alrededor tuyo');
    shake(5);
  }
  else if(type==='emberVolley'){
    const n=5;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.24;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*165, vy:Math.sin(a)*165,
        dmg:boss.dmg*1.0, radius:11, owner:'enemy', color:'#a8452c', life:3.1 });
    }
    shake(7);
  }

  // ---- Piso 29: Llama Pálida (primer híbrido real de fuego/sombra — ni luz ni penumbra pura) ----
  else if(type==='paleFlicker'){
    const r = 130;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#8a6a7a',24,210,0.42);
    spawnShockwave(boss.x,boss.y,'#8a6a7a',r,0.4);
    shake(8);
  }
  else if(type==='paleWake'){
    // alternates fire/void hazards in the same pattern, echoing bloomField's void/light mix
    // from piso 25 but now with the boss's own ember/shadow duality
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-165,165), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-165,165), b.y+24, b.y+b.h-24);
      const hazType = i%2===0 ? 'fire' : 'void';
      game.hazards.push({ x:hx, y:hy, r:40, type:hazType, telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Fuego y sombra se turnan bajo tus pies');
  }
  else if(type==='paleBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      const col = i%2===0 ? '#c07850' : '#5a4a7a';
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*220, vy:Math.sin(a)*220,
        dmg:boss.dmg*0.46, radius:7, owner:'enemy', color:col, life:2.4 });
    }
    addParticles(boss.x,boss.y,'#8a6a7a',18,190,0.4);
    shake(6);
  }

  // ---- Piso 30: Custodio de Rescoldos (sexto tanque, quiebre temático del tramo 26-30) ----
  else if(type==='wardenEmberSlam'){
    const r = 175;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.4);
    spawnShockwave(boss.x,boss.y,'#903a20',r,0.52);
    addParticles(boss.x,boss.y,'#903a20',32,250,0.55);
    shake(11);
  }
  else if(type==='emberWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'fire', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El Custodio de Rescoldos levanta anillos de brasas');
    shake(6);
  }
  else if(type==='emberWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*160, vy:Math.sin(a)*160,
        dmg:boss.dmg*1.0, radius:11, owner:'enemy', color:'#903a20', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 31: Enjambre de Rescoldos (variante rápida que abre el siguiente bloque) ----
  else if(type==='swarmEmberDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=190;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#d68a4a',16,205,0.35); }
    });
  }
  else if(type==='emberSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'fire', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.24 });
    }
    spawnToast('El Enjambre de Rescoldos se dispersa por el suelo');
  }
  else if(type==='emberSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*235, vy:Math.sin(a)*235,
        dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:'#d68a4a', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#d68a4a',20,175,0.35);
    shake(5);
  }

  // ---- Piso 32: Bruma Apagada (el fuego se apaga — primer jefe del sub-arco "apagado") ----
  else if(type==='mistSlam'){
    const r = 135;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#5a5468',24,200,0.42);
    spawnShockwave(boss.x,boss.y,'#5a5468',r,0.4);
    shake(7);
  }
  else if(type==='mistField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-160,160), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-160,160), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'void', telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.28 });
    }
    spawnToast('La bruma se asienta sobre el suelo');
  }
  else if(type==='mistBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*210, vy:Math.sin(a)*210,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#5a5468', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#5a5468',18,180,0.38);
    shake(5);
  }

  // ---- Piso 33: Custodio Apagado (séptimo tanque — guardó una llama que ya no arde) ----
  else if(type==='dimmedCrush'){
    const r = 172;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.38);
    spawnShockwave(boss.x,boss.y,'#4a4658',r,0.5);
    addParticles(boss.x,boss.y,'#4a4658',30,240,0.52);
    shake(10);
  }
  else if(type==='dimmedRing'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*60, type:'void', telegraph:0.35+ring*0.35, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El Custodio Apagado levanta un anillo de ceniza fría');
    shake(5);
  }
  else if(type==='dimmedVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*170, vy:Math.sin(a)*170,
        dmg:boss.dmg*0.95, radius:10, owner:'enemy', color:'#4a4658', life:3.0 });
    }
    shake(6);
  }

  // ---- Piso 34: Espina Apagada (veneno frío, versión "apagada" del tema de piso 8) ----
  else if(type==='greyThornLash'){
    const r = 112;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'poison', telegraph:0.25, active:1.6, tick:0, dmg:boss.dmg*0.26 });
    addParticles(boss.x,boss.y,'#524a5a',18,180,0.4);
    shake(6);
  }
  else if(type==='greyThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'poison', telegraph:0.6, active:2.6, tick:0, dmg:boss.dmg*0.28 });
    }
    addParticles(p.x,p.y,'#524a5a',16,140,0.35);
  }
  else if(type==='greyThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*200, vy:Math.sin(a)*200,
        dmg:boss.dmg*0.48, radius:7, owner:'enemy', color:'#524a5a', life:2.5, poison:true });
    }
    shake(5);
  }

  // ---- Piso 35: Susurro Apagado (ágil, ni su propio eco recuerda el calor) ----
  else if(type==='dimWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 200+Math.random()*150;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.43, radius:6, owner:'enemy', color:'#4e485c', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#4e485c',16,160,0.3);
    spawnToast('El Susurro Apagado se desvanece y reaparece');
  }
  else if(type==='dimmedCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Un susurro sin calor serpentea hacia vos');
  }
  else if(type==='dimmedWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*230, vy:Math.sin(a)*230,
        dmg:boss.dmg*0.38, radius:7, owner:'enemy', color:'#4e485c', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#4e485c',18,180,0.4);
    shake(5);
  }

  // ---- Piso 36: Corazón Apagado (cierra el sub-arco — de la ceniza a la nada, otra vez) ----
  else if(type==='heartDimSlam'){
    const r = 148;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    addParticles(boss.x,boss.y,'#403c50',26,220,0.5);
    spawnShockwave(boss.x,boss.y,'#403c50',r,0.44);
    shake(8);
  }
  else if(type==='dimmedHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    }
    spawnToast('El Corazón Apagado parte la sala al medio');
  }
  else if(type==='dimmedHeartBurst'){
    const n=12;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*245, vy:Math.sin(a)*245,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#403c50', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#403c50',20,190,0.4);
    shake(6);
  }

  // ---- Piso 37: Polvo Errante (rápido y ligero, ni ceniza ni piedra) ----
  else if(type==='dustDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=215;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#8a8478',16,200,0.35); }
    });
  }
  else if(type==='dustTrail'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=5;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.3+i*0.11, active:1.0, tick:0, dmg:boss.dmg*0.34 });
    }
    spawnToast('Una estela de polvo serpentea hacia vos');
  }
  else if(type==='dustScatter'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*240, vy:Math.sin(a)*240,
        dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:'#8a8478', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#8a8478',18,190,0.38);
    shake(5);
  }

  // ---- Piso 38: Fisura de Ceniza (el suelo mismo empieza a resentir el peso) ----
  else if(type==='fissureLash'){
    const r = 118;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.72, type:'void', telegraph:0.28, active:1.5, tick:0, dmg:boss.dmg*0.3 });
    addParticles(boss.x,boss.y,'#6a6258',20,190,0.4);
    shake(7);
  }
  else if(type==='fissureField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-165,165), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-165,165), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'void', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Grietas se abren bajo tus pies');
  }
  else if(type==='fissureBurst'){
    const n=9;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*215, vy:Math.sin(a)*215,
        dmg:boss.dmg*0.46, radius:7, owner:'enemy', color:'#6a6258', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#6a6258',18,180,0.38);
    shake(6);
  }

  // ---- Piso 39: Reflejo Hueco (devuelve una imagen que ya no reconoce a nadie) ----
  else if(type==='hollowSlam'){
    const r = 138;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.15);
    addParticles(boss.x,boss.y,'#9a948c',24,210,0.44);
    spawnShockwave(boss.x,boss.y,'#9a948c',r,0.42);
    shake(8);
  }
  else if(type==='hollowField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:40, type:'void', telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El Reflejo Hueco dispersa su propia imagen por el suelo');
  }
  else if(type==='hollowBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*220, vy:Math.sin(a)*220,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#9a948c', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#9a948c',18,190,0.4);
    shake(6);
  }

  // ---- Piso 40: Susurro de Piedra (habla lento, nunca dos veces desde el mismo sitio) ----
  else if(type==='stoneWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 210+Math.random()*140;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*255, vy:Math.sin(a)*255,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#78726a', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#78726a',16,160,0.3);
    spawnToast('El Susurro de Piedra se reubica en silencio');
  }
  else if(type==='stoneCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'void', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('Una grieta de piedra serpentea hacia vos');
  }
  else if(type==='stoneVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.26;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*172, vy:Math.sin(a)*172,
        dmg:boss.dmg*0.92, radius:10, owner:'enemy', color:'#78726a', life:3.0 });
    }
    shake(6);
  }

  // ---- Piso 41: Corazón de Polvo (punto medio del camino, 4 ataques) ----
  else if(type==='dustHeartSlam'){
    const r = 152;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.22);
    addParticles(boss.x,boss.y,'#7a746a',27,225,0.5);
    spawnShockwave(boss.x,boss.y,'#7a746a',r,0.44);
    shake(9);
  }
  else if(type==='dustHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'void', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    }
    spawnToast('El Corazón de Polvo parte la sala al medio');
  }
  else if(type==='dustHeartBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*248, vy:Math.sin(a)*248,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#7a746a', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#7a746a',20,190,0.4);
    shake(6);
  }
  else if(type==='dustHeartCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'void', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.56 });
    }
    addParticles(boss.x,boss.y,'#7a746a',28,230,0.5);
    spawnToast('El Corazón de Polvo late — y colapsa hacia adentro');
    shake(8);
  }

  // ---- Piso 42: Brillo Apagado (apenas un destello, pero ya no es solo sombra) ----
  else if(type==='gleamSlam'){
    const r = 132;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    addParticles(boss.x,boss.y,'#948a78',24,205,0.42);
    spawnShockwave(boss.x,boss.y,'#948a78',r,0.4);
    shake(7);
  }
  else if(type==='gleamField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-165,165), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-165,165), b.y+24, b.y+b.h-24);
      const hazType = i%2===0 ? 'void' : 'light';
      game.hazards.push({ x:hx, y:hy, r:40, type:hazType, telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Sombra y un poco de luz se turnan bajo tus pies');
  }
  else if(type==='gleamBurst'){
    const n=10;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      const col = i%2===0 ? '#948a78' : '#e8dfc0';
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*222, vy:Math.sin(a)*222,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:col, life:2.4 });
    }
    addParticles(boss.x,boss.y,'#948a78',18,190,0.4);
    shake(6);
  }

  // ---- Piso 43: Custodio de Piedra (octavo tanque, el más inmóvil de todos) ----
  else if(type==='stoneWardenCrush'){
    const r = 178;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.42);
    spawnShockwave(boss.x,boss.y,'#6a645c',r,0.52);
    addParticles(boss.x,boss.y,'#6a645c',32,250,0.55);
    shake(11);
  }
  else if(type==='stoneWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'void', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El Custodio de Piedra levanta anillos de escombros');
    shake(6);
  }
  else if(type==='stoneWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*158, vy:Math.sin(a)*158,
        dmg:boss.dmg*1.0, radius:11, owner:'enemy', color:'#6a645c', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 44: Espina de Luz (el primer dolor que quema en vez de pudrir) ----
  else if(type==='lightThornLash'){
    const r = 114;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.0);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.6, tick:0, dmg:boss.dmg*0.28 });
    addParticles(boss.x,boss.y,'#c9b878',18,185,0.4);
    shake(6);
  }
  else if(type==='lightThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.6, tick:0, dmg:boss.dmg*0.3 });
    }
    addParticles(p.x,p.y,'#c9b878',16,140,0.35);
  }
  else if(type==='lightThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*205, vy:Math.sin(a)*205,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#c9b878', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 45: Ecos Grises (cada eco repite un poco menos de sombra que el anterior) ----
  else if(type==='greyEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=200;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#8a8290',16,200,0.35); }
    });
  }
  else if(type==='greyEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'void', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.26 });
    }
    spawnToast('Ecos Grises se dispersan por el suelo');
  }
  else if(type==='greyEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*232, vy:Math.sin(a)*232,
        dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#8a8290', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#8a8290',20,175,0.35);
    shake(5);
  }

  // ---- Piso 46: Guardiana de Ceniza y Luz (cierra el tramo — ya no defiende solo la sombra) ----
  else if(type==='ashLightSlam'){
    const r = 145;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    addParticles(boss.x,boss.y,'#b0a488',26,220,0.48);
    spawnShockwave(boss.x,boss.y,'#b0a488',r,0.44);
    shake(8);
  }
  else if(type==='ashLightField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-170,170), b.y+24, b.y+b.h-24);
      const hazType = i%2===0 ? 'void' : 'light';
      game.hazards.push({ x:hx, y:hy, r:42, type:hazType, telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('Ceniza y luz caen juntas al suelo');
  }
  else if(type==='ashLightBurst'){
    const n=12;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      const col = i%2===0 ? '#b0a488' : '#e8dfc0';
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*228, vy:Math.sin(a)*228,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:col, life:2.4 });
    }
    addParticles(boss.x,boss.y,'#b0a488',20,190,0.4);
    shake(6);
  }

  // ---- Piso 47: Velo Tenue (ni sombra ni luz — todavía no decide qué es) ----
  else if(type==='veilSlam'){
    const r = 128;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.12);
    addParticles(boss.x,boss.y,'#a89ccc',24,208,0.42);
    spawnShockwave(boss.x,boss.y,'#a89ccc',r,0.4);
    shake(7);
  }
  else if(type==='veilField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-165,165), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-165,165), b.y+24, b.y+b.h-24);
      const hazType = i%2===0 ? 'void' : 'light';
      game.hazards.push({ x:hx, y:hy, r:40, type:hazType, telegraph:0.55, active:2.0, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El Velo Tenue no termina de decidir qué dejar caer');
  }
  else if(type==='veilBurst'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      const col = i%2===0 ? '#a89ccc' : '#e0d8f0';
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*225, vy:Math.sin(a)*225,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:col, life:2.4 });
    }
    addParticles(boss.x,boss.y,'#a89ccc',18,190,0.4);
    shake(6);
  }

  // ---- Piso 48: Guardiana del Límite (novena en guardia, custodia la frontera misma) ----
  else if(type==='edgeGuardCrush'){
    const r = 180;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.42);
    spawnShockwave(boss.x,boss.y,'#7a6e98',r,0.52);
    addParticles(boss.x,boss.y,'#7a6e98',32,250,0.55);
    shake(11);
  }
  else if(type==='edgeGuardRing'){
    for(let ring=0; ring<5; ring++){
      const hazType = ring%2===0 ? 'void' : 'light';
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:hazType, telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('La Guardiana del Límite traza un anillo que es mitad y mitad');
    shake(6);
  }
  else if(type==='edgeGuardVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*162, vy:Math.sin(a)*162,
        dmg:boss.dmg*1.02, radius:11, owner:'enemy', color:'#7a6e98', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 49: Espina del Alba (ya no quema como fuego ni pudre como sombra — quema como el alba) ----
  else if(type==='dawnThornLash'){
    const r = 116;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.02);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.6, tick:0, dmg:boss.dmg*0.28 });
    addParticles(boss.x,boss.y,'#d8b878',18,185,0.4);
    shake(6);
  }
  else if(type==='dawnThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.6, tick:0, dmg:boss.dmg*0.3 });
    }
    addParticles(p.x,p.y,'#d8b878',16,140,0.35);
  }
  else if(type==='dawnThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*208, vy:Math.sin(a)*208,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#d8b878', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 50: Corazón del Límite (cierra el tramo 26-50 entero, 4 ataques) ----
  else if(type==='edgeHeartSlam'){
    const r = 158;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.25);
    addParticles(boss.x,boss.y,'#8878a8',28,228,0.5);
    spawnShockwave(boss.x,boss.y,'#8878a8',r,0.46);
    shake(9);
  }
  else if(type==='edgeHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        const hazType = (Math.floor((y-b.y)/spacing))%2===0 ? 'void' : 'light';
        game.hazards.push({ x:boss.x, y, r:40, type:hazType, telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        const hazType = (Math.floor((x-b.x)/spacing))%2===0 ? 'void' : 'light';
        game.hazards.push({ x, y:boss.y, r:40, type:hazType, telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.48 });
      }
    }
    spawnToast('El Corazón del Límite parte la sala entre sombra y luz');
  }
  else if(type==='edgeHeartBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      const col = i%2===0 ? '#8878a8' : '#e8dfc0';
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:col, life:2.4 });
    }
    addParticles(boss.x,boss.y,'#8878a8',20,190,0.4);
    shake(6);
  }
  else if(type==='edgeHeartCollapse'){
    for(let ring=0; ring<3; ring++){
      const hazType = ring%2===0 ? 'void' : 'light';
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:hazType, telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.56 });
    }
    addParticles(boss.x,boss.y,'#8878a8',28,230,0.5);
    spawnToast('El Corazón del Límite colapsa — la penumbra termina acá');
    shake(8);
  }

  // ---- Piso 51: Alba Errante (abre el tramo — la luz empieza a crecer de verdad) ----
  else if(type==='dawnDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=218;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#e8c888',16,205,0.35); }
    });
  }
  else if(type==='dawnTrail'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=5;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.11, active:1.0, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('Una estela de alba serpentea hacia vos');
  }
  else if(type==='dawnScatter'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*246, vy:Math.sin(a)*246,
        dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:'#e8c888', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#e8c888',18,190,0.38);
    shake(5);
  }

  // ---- Piso 52: Guardiana del Alba (décima en guardia, la luz también sabe ser paciente) ----
  else if(type==='dawnGuardCrush'){
    const r = 182;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.44);
    spawnShockwave(boss.x,boss.y,'#c8a848',r,0.52);
    addParticles(boss.x,boss.y,'#c8a848',32,250,0.55);
    shake(11);
  }
  else if(type==='dawnGuardRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('La Guardiana del Alba levanta un anillo dorado');
    shake(6);
  }
  else if(type==='dawnGuardVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*164, vy:Math.sin(a)*164,
        dmg:boss.dmg*1.02, radius:11, owner:'enemy', color:'#c8a848', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 53: Eco Dorado (cada eco brilla un poco más que el anterior) ----
  else if(type==='goldenEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=205;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#e0b858',16,200,0.35); }
    });
  }
  else if(type==='goldenEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.26 });
    }
    spawnToast('El Eco Dorado se dispersa por el suelo');
  }
  else if(type==='goldenEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*235, vy:Math.sin(a)*235,
        dmg:boss.dmg*0.28, radius:6, owner:'enemy', color:'#e0b858', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#e0b858',20,175,0.35);
    shake(5);
  }

  // ---- Piso 54: Espina Dorada (el dolor del alba ya pesa más que el de la sombra) ----
  else if(type==='goldenThornLash'){
    const r = 118;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.05);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.3 });
    addParticles(boss.x,boss.y,'#f0c868',18,188,0.4);
    shake(6);
  }
  else if(type==='goldenThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.32 });
    }
    addParticles(p.x,p.y,'#f0c868',16,140,0.35);
  }
  else if(type==='goldenThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*210, vy:Math.sin(a)*210,
        dmg:boss.dmg*0.52, radius:7, owner:'enemy', color:'#f0c868', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 55: Susurro del Alba (ni siquiera necesita esconderse en la penumbra) ----
  else if(type==='dawnWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 205+Math.random()*145;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*258, vy:Math.sin(a)*258,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#e8d078', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#e8d078',16,160,0.3);
    spawnToast('El Susurro del Alba se reubica a plena luz');
  }
  else if(type==='dawnWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.36 });
    }
    spawnToast('Una estela dorada serpentea hacia vos');
  }
  else if(type==='dawnWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*233, vy:Math.sin(a)*233,
        dmg:boss.dmg*0.39, radius:7, owner:'enemy', color:'#e8d078', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#e8d078',18,180,0.4);
    shake(5);
  }

  // ---- Piso 56: Hueco Brillante (cierra el tramo — lo que fue vacío ahora refleja luz) ----
  else if(type==='brightSlam'){
    const r = 150;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.24);
    addParticles(boss.x,boss.y,'#f4d888',27,225,0.5);
    spawnShockwave(boss.x,boss.y,'#f4d888',r,0.45);
    shake(9);
  }
  else if(type==='brightField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'light', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.32 });
    }
    spawnToast('El Hueco Brillante inunda el suelo de luz');
  }
  else if(type==='brightBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*250, vy:Math.sin(a)*250,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#f4d888', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#f4d888',20,195,0.4);
    shake(6);
  }

  // ---- Piso 57: Enjambre Dorado (cientos de chispas que ya no recuerdan haber sido sombra) ----
  else if(type==='swarmGoldenDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=195;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#f0d068',16,205,0.35); }
    });
  }
  else if(type==='goldenSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.24 });
    }
    spawnToast('El Enjambre Dorado se dispersa por el suelo');
  }
  else if(type==='goldenSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*238, vy:Math.sin(a)*238,
        dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:'#f0d068', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#f0d068',20,178,0.35);
    shake(5);
  }

  // ---- Piso 58: Custodio Radiante (undécimo en guardia — ni la luz más fuerte lo hace parpadear) ----
  else if(type==='radiantCrush'){
    const r = 185;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.46);
    spawnShockwave(boss.x,boss.y,'#e8c048',r,0.53);
    addParticles(boss.x,boss.y,'#e8c048',33,255,0.56);
    shake(11);
  }
  else if(type==='radiantRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('El Custodio Radiante levanta un anillo cegador');
    shake(6);
  }
  else if(type==='radiantVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*166, vy:Math.sin(a)*166,
        dmg:boss.dmg*1.05, radius:11, owner:'enemy', color:'#e8c048', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 59: Espina Radiante (duele más de lo que cualquier sombra dolió jamás) ----
  else if(type==='radiantThornLash'){
    const r = 120;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.08);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.32 });
    addParticles(boss.x,boss.y,'#ffd868',18,190,0.4);
    shake(6);
  }
  else if(type==='radiantThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.34 });
    }
    addParticles(p.x,p.y,'#ffd868',16,140,0.35);
  }
  else if(type==='radiantThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*212, vy:Math.sin(a)*212,
        dmg:boss.dmg*0.54, radius:7, owner:'enemy', color:'#ffd868', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 60: Heraldo del Sol (anuncia lo que viene, 4 ataques, milestone del tramo) ----
  else if(type==='sunHeraldSlam'){
    const r = 162;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.28);
    addParticles(boss.x,boss.y,'#ffdc78',29,232,0.5);
    spawnShockwave(boss.x,boss.y,'#ffdc78',r,0.46);
    shake(9);
  }
  else if(type==='sunHeraldLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.5 });
      }
    }
    spawnToast('El Heraldo del Sol parte la sala con un rayo de luz');
  }
  else if(type==='sunHeraldBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*252, vy:Math.sin(a)*252,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#ffdc78', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#ffdc78',21,195,0.4);
    shake(6);
  }
  else if(type==='sunHeraldCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'light', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.58 });
    }
    addParticles(boss.x,boss.y,'#ffdc78',29,232,0.5);
    spawnToast('El Heraldo del Sol colapsa en un solo destello');
    shake(8);
  }

  // ---- Piso 61: Centinela Dorado (abre el tramo final antes del ecuador del camino) ----
  else if(type==='sentinelDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=220;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffe088',16,208,0.35); }
    });
  }
  else if(type==='sentinelTrail'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=5;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*55, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*55, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.11, active:1.0, tick:0, dmg:boss.dmg*0.33 });
    }
    spawnToast('Una estela dorada serpentea hacia vos');
  }
  else if(type==='sentinelScatter'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*248, vy:Math.sin(a)*248,
        dmg:boss.dmg*0.38, radius:6, owner:'enemy', color:'#ffe088', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#ffe088',18,192,0.38);
    shake(5);
  }

  // ---- Piso 62: Custodio Solar (duodécimo en guardia, ya casi no queda sombra que proteger) ----
  else if(type==='solarWardenCrush'){
    const r = 188;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.48);
    spawnShockwave(boss.x,boss.y,'#ffcc48',r,0.53);
    addParticles(boss.x,boss.y,'#ffcc48',34,258,0.56);
    shake(12);
  }
  else if(type==='solarWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('El Custodio Solar levanta un anillo de calor');
    shake(6);
  }
  else if(type==='solarWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*168, vy:Math.sin(a)*168,
        dmg:boss.dmg*1.06, radius:11, owner:'enemy', color:'#ffcc48', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 63: Susurro Solar (su voz ya no es un susurro, apenas logra contenerse) ----
  else if(type==='solarWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 210+Math.random()*145;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.46, radius:7, owner:'enemy', color:'#ffd858', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#ffd858',16,160,0.3);
    spawnToast('El Susurro Solar apenas logra contenerse');
  }
  else if(type==='solarWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.37 });
    }
    spawnToast('Una estela solar serpentea hacia vos');
  }
  else if(type==='solarWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*236, vy:Math.sin(a)*236,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#ffd858', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#ffd858',18,182,0.4);
    shake(5);
  }

  // ---- Piso 64: Eco Solar (cada eco es un poco más brillante que la fuente) ----
  else if(type==='solarEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=210;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffe068',16,205,0.35); }
    });
  }
  else if(type==='solarEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.27 });
    }
    spawnToast('El Eco Solar se dispersa por el suelo');
  }
  else if(type==='solarEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*238, vy:Math.sin(a)*238,
        dmg:boss.dmg*0.29, radius:6, owner:'enemy', color:'#ffe068', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#ffe068',20,178,0.35);
    shake(5);
  }

  // ---- Piso 65: Enjambre de Llamas (ya no quedan cenizas, solo llama pura y en movimiento) ----
  else if(type==='swarmBlazeDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=198;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffb848',16,208,0.35); }
    });
  }
  else if(type==='blazeSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'fire', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.25 });
    }
    spawnToast('El Enjambre de Llamas se dispersa por el suelo');
  }
  else if(type==='blazeSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*240, vy:Math.sin(a)*240,
        dmg:boss.dmg*0.31, radius:6, owner:'enemy', color:'#ffb848', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#ffb848',20,180,0.35);
    shake(5);
  }

  // ---- Piso 66: Guardiana Solar (cierra el tramo — el ecuador del camino al Sol está cerca) ----
  else if(type==='solarGuardSlam'){
    const r = 154;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.26);
    addParticles(boss.x,boss.y,'#ffe488',27,228,0.5);
    spawnShockwave(boss.x,boss.y,'#ffe488',r,0.46);
    shake(9);
  }
  else if(type==='solarGuardField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-172,172), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-172,172), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'light', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.33 });
    }
    spawnToast('La Guardiana Solar inunda el suelo de calor');
  }
  else if(type==='solarGuardBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*252, vy:Math.sin(a)*252,
        dmg:boss.dmg*0.41, radius:7, owner:'enemy', color:'#ffe488', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#ffe488',21,196,0.4);
    shake(6);
  }

  // ---- Piso 67: Custodio de Flare (decimotercero en guardia, hasta el fuego respeta su turno) ----
  else if(type==='flareWardenCrush'){
    const r = 190;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.5);
    spawnShockwave(boss.x,boss.y,'#ffb828',r,0.54);
    addParticles(boss.x,boss.y,'#ffb828',34,260,0.56);
    shake(12);
  }
  else if(type==='flareWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'fire', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('El Custodio de Flare levanta un anillo de fuego');
    shake(6);
  }
  else if(type==='flareWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*170, vy:Math.sin(a)*170,
        dmg:boss.dmg*1.08, radius:11, owner:'enemy', color:'#ffb828', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 68: Espina de Flare (cada espina es una pequeña llamarada que no se apaga) ----
  else if(type==='flareThornLash'){
    const r = 122;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.1);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'fire', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.33 });
    addParticles(boss.x,boss.y,'#ffa838',18,192,0.4);
    shake(6);
  }
  else if(type==='flareThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'fire', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.35 });
    }
    addParticles(p.x,p.y,'#ffa838',16,140,0.35);
  }
  else if(type==='flareThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*214, vy:Math.sin(a)*214,
        dmg:boss.dmg*0.56, radius:7, owner:'enemy', color:'#ffa838', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 69: Susurro de Corona (ya brilla tanto que cuesta verlo moverse) ----
  else if(type==='coronaWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 212+Math.random()*146;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*262, vy:Math.sin(a)*262,
        dmg:boss.dmg*0.47, radius:7, owner:'enemy', color:'#ffc048', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#ffc048',16,160,0.3);
    spawnToast('El Susurro de Corona brilla tanto que cuesta verlo moverse');
  }
  else if(type==='coronaWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.38 });
    }
    spawnToast('Una estela de corona serpentea hacia vos');
  }
  else if(type==='coronaWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*238, vy:Math.sin(a)*238,
        dmg:boss.dmg*0.41, radius:7, owner:'enemy', color:'#ffc048', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#ffc048',18,184,0.4);
    shake(5);
  }

  // ---- Piso 70: Corazón de Corona (cierra el tramo, 4 ataques — la corona ya se distingue entera) ----
  else if(type==='coronaHeartSlam'){
    const r = 166;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.3);
    addParticles(boss.x,boss.y,'#ffb438',30,234,0.5);
    spawnShockwave(boss.x,boss.y,'#ffb438',r,0.47);
    shake(9);
  }
  else if(type==='coronaHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'fire', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.52 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'fire', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.52 });
      }
    }
    spawnToast('El Corazón de Corona parte la sala con un rayo de fuego');
  }
  else if(type==='coronaHeartBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*254, vy:Math.sin(a)*254,
        dmg:boss.dmg*0.43, radius:7, owner:'enemy', color:'#ffb438', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#ffb438',22,198,0.4);
    shake(6);
  }
  else if(type==='coronaHeartCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'fire', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.6 });
    }
    addParticles(boss.x,boss.y,'#ffb438',30,235,0.5);
    spawnToast('El Corazón de Corona colapsa en un solo destello');
    shake(8);
  }

  // ---- Piso 71: Enjambre de Flare (abre el tramo — cada vez menos falta para la cima) ----
  else if(type==='swarmFlareDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=200;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffcc58',16,210,0.35); }
    });
  }
  else if(type==='flareSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'fire', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.26 });
    }
    spawnToast('El Enjambre de Flare se dispersa por el suelo');
  }
  else if(type==='flareSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*242, vy:Math.sin(a)*242,
        dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:'#ffcc58', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#ffcc58',20,182,0.35);
    shake(5);
  }

  // ---- Piso 72: Custodio del Cenit (decimocuarto en guardia, arriba el sol ya pesa sobre todos) ----
  else if(type==='zenithWardenCrush'){
    const r = 192;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.52);
    spawnShockwave(boss.x,boss.y,'#ffdc38',r,0.54);
    addParticles(boss.x,boss.y,'#ffdc38',35,262,0.57);
    shake(12);
  }
  else if(type==='zenithWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.44 });
    }
    spawnToast('El Custodio del Cenit levanta un anillo de sol pleno');
    shake(6);
  }
  else if(type==='zenithWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*172, vy:Math.sin(a)*172,
        dmg:boss.dmg*1.1, radius:11, owner:'enemy', color:'#ffdc38', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 73: Espina del Cenit (a esta altura, hasta el dolor tiene su propio brillo) ----
  else if(type==='zenithThornLash'){
    const r = 124;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.12);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.34 });
    addParticles(boss.x,boss.y,'#ffe048',18,194,0.4);
    shake(6);
  }
  else if(type==='zenithThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.36 });
    }
    addParticles(p.x,p.y,'#ffe048',16,140,0.35);
  }
  else if(type==='zenithThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*216, vy:Math.sin(a)*216,
        dmg:boss.dmg*0.58, radius:7, owner:'enemy', color:'#ffe048', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 74: Susurro del Cenit (ya no necesita sombra ninguna para moverse rápido) ----
  else if(type==='zenithWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 214+Math.random()*148;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*264, vy:Math.sin(a)*264,
        dmg:boss.dmg*0.48, radius:7, owner:'enemy', color:'#ffe458', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#ffe458',16,160,0.3);
    spawnToast('El Susurro del Cenit ya no necesita ninguna sombra');
  }
  else if(type==='zenithWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.39 });
    }
    spawnToast('Una estela cegadora serpentea hacia vos');
  }
  else if(type==='zenithWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*240, vy:Math.sin(a)*240,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#ffe458', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#ffe458',18,186,0.4);
    shake(5);
  }

  // ---- Piso 75: Eco del Cenit (marca los tres cuartos del camino — cada eco es puro mediodía) ----
  else if(type==='zenithEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=212;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffe868',16,207,0.35); }
    });
  }
  else if(type==='zenithEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.28 });
    }
    spawnToast('El Eco del Cenit se dispersa por el suelo');
  }
  else if(type==='zenithEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*240, vy:Math.sin(a)*240,
        dmg:boss.dmg*0.3, radius:6, owner:'enemy', color:'#ffe868', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#ffe868',20,180,0.35);
    shake(5);
  }

  // ---- Piso 76: Guardiana del Cenit (cierra el tramo — desde acá, todo el camino es cuesta de luz) ----
  else if(type==='zenithGuardSlam'){
    const r = 156;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.28);
    addParticles(boss.x,boss.y,'#ffec78',27,230,0.5);
    spawnShockwave(boss.x,boss.y,'#ffec78',r,0.46);
    shake(9);
  }
  else if(type==='zenithGuardField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-172,172), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-172,172), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'light', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.35 });
    }
    spawnToast('La Guardiana del Cenit inunda el suelo de mediodía');
  }
  else if(type==='zenithGuardBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*254, vy:Math.sin(a)*254,
        dmg:boss.dmg*0.42, radius:7, owner:'enemy', color:'#ffec78', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#ffec78',22,198,0.4);
    shake(6);
  }

  // ---- Piso 77: Custodio Cegador (decimoquinto en guardia, casi no se distingue ya su forma) ----
  else if(type==='blindWardenCrush'){
    const r = 195;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.54);
    spawnShockwave(boss.x,boss.y,'#fff088',r,0.55);
    addParticles(boss.x,boss.y,'#fff088',36,265,0.58);
    shake(12);
  }
  else if(type==='blindWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.46 });
    }
    spawnToast('El Custodio Cegador levanta un anillo de luz pura');
    shake(6);
  }
  else if(type==='blindWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*174, vy:Math.sin(a)*174,
        dmg:boss.dmg*1.12, radius:11, owner:'enemy', color:'#fff088', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 78: Espina Cegadora (el dolor y la luz son, a esta altura, la misma cosa) ----
  else if(type==='blindThornLash'){
    const r = 126;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.14);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.36 });
    addParticles(boss.x,boss.y,'#fff498',18,196,0.4);
    shake(6);
  }
  else if(type==='blindThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.38 });
    }
    addParticles(p.x,p.y,'#fff498',16,140,0.35);
  }
  else if(type==='blindThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*218, vy:Math.sin(a)*218,
        dmg:boss.dmg*0.6, radius:7, owner:'enemy', color:'#fff498', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 79: Susurro Cegador (ya nadie recuerda si alguna vez fue penumbra) ----
  else if(type==='blindWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 216+Math.random()*150;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*266, vy:Math.sin(a)*266,
        dmg:boss.dmg*0.49, radius:7, owner:'enemy', color:'#fff6a8', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#fff6a8',16,160,0.3);
    spawnToast('El Susurro Cegador ya no recuerda haber sido penumbra');
  }
  else if(type==='blindWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.4 });
    }
    spawnToast('Una estela cegadora serpentea hacia vos');
  }
  else if(type==='blindWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*242, vy:Math.sin(a)*242,
        dmg:boss.dmg*0.43, radius:7, owner:'enemy', color:'#fff6a8', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#fff6a8',18,188,0.4);
    shake(5);
  }

  // ---- Piso 80: Corazón Cegador (cierra el tramo, 4 ataques — falta poco para el final) ----
  else if(type==='blindHeartSlam'){
    const r = 168;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.32);
    addParticles(boss.x,boss.y,'#fff8b8',31,236,0.5);
    spawnShockwave(boss.x,boss.y,'#fff8b8',r,0.47);
    shake(9);
  }
  else if(type==='blindHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.54 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.54 });
      }
    }
    spawnToast('El Corazón Cegador parte la sala con un rayo puro');
  }
  else if(type==='blindHeartBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*256, vy:Math.sin(a)*256,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#fff8b8', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#fff8b8',23,200,0.4);
    shake(6);
  }
  else if(type==='blindHeartCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'light', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.62 });
    }
    addParticles(boss.x,boss.y,'#fff8b8',31,236,0.5);
    spawnToast('El Corazón Cegador colapsa en pura luz');
    shake(8);
  }

  // ---- Piso 81: Enjambre Cegador (abre la recta final — cada chispa ya es casi Sol) ----
  else if(type==='swarmBlindDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=202;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#fffac8',16,212,0.35); }
    });
  }
  else if(type==='blindSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.27 });
    }
    spawnToast('El Enjambre Cegador se dispersa por el suelo');
  }
  else if(type==='blindSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*244, vy:Math.sin(a)*244,
        dmg:boss.dmg*0.33, radius:6, owner:'enemy', color:'#fffac8', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#fffac8',20,184,0.35);
    shake(5);
  }

  // ---- Piso 82: Custodio Ascendente (decimosexto en guardia, sube con el camino) ----
  else if(type==='ascWardenCrush'){
    const r = 198;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.56);
    spawnShockwave(boss.x,boss.y,'#fff4a0',r,0.55);
    addParticles(boss.x,boss.y,'#fff4a0',36,268,0.58);
    shake(12);
  }
  else if(type==='ascWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.46 });
    }
    spawnToast('El Custodio Ascendente levanta un anillo que sube con vos');
    shake(6);
  }
  else if(type==='ascWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*176, vy:Math.sin(a)*176,
        dmg:boss.dmg*1.14, radius:11, owner:'enemy', color:'#fff4a0', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 83: Espina Ascendente (cada paso hacia arriba se paga con un poco de dolor propio) ----
  else if(type==='ascThornLash'){
    const r = 128;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.16);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.38 });
    addParticles(boss.x,boss.y,'#fff6b0',18,198,0.4);
    shake(6);
  }
  else if(type==='ascThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.4 });
    }
    addParticles(p.x,p.y,'#fff6b0',16,140,0.35);
  }
  else if(type==='ascThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*220, vy:Math.sin(a)*220,
        dmg:boss.dmg*0.62, radius:7, owner:'enemy', color:'#fff6b0', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 84: Susurro Ascendente (habla en el idioma que solo se escucha cerca de la cima) ----
  else if(type==='ascWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 218+Math.random()*152;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*268, vy:Math.sin(a)*268,
        dmg:boss.dmg*0.5, radius:7, owner:'enemy', color:'#fff8c0', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#fff8c0',16,160,0.3);
    spawnToast('El Susurro Ascendente habla un idioma casi imposible de oír');
  }
  else if(type==='ascWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.41 });
    }
    spawnToast('Una estela ascendente serpentea hacia vos');
  }
  else if(type==='ascWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*244, vy:Math.sin(a)*244,
        dmg:boss.dmg*0.44, radius:7, owner:'enemy', color:'#fff8c0', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#fff8c0',18,190,0.4);
    shake(5);
  }

  // ---- Piso 85: Eco Ascendente (cada eco sube un poco más que el anterior, sin cansarse nunca) ----
  else if(type==='ascEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=214;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#fffad0',16,209,0.35); }
    });
  }
  else if(type==='ascEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.29 });
    }
    spawnToast('El Eco Ascendente se dispersa por el suelo');
  }
  else if(type==='ascEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*242, vy:Math.sin(a)*242,
        dmg:boss.dmg*0.31, radius:6, owner:'enemy', color:'#fffad0', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#fffad0',20,186,0.35);
    shake(5);
  }

  // ---- Piso 86: Guardiana Ascendente (cierra el tramo — desde acá se ve la cima entera) ----
  else if(type==='ascGuardSlam'){
    const r = 158;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.3);
    addParticles(boss.x,boss.y,'#fffce0',28,232,0.5);
    spawnShockwave(boss.x,boss.y,'#fffce0',r,0.46);
    shake(9);
  }
  else if(type==='ascGuardField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-174,174), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-174,174), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'light', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.37 });
    }
    spawnToast('La Guardiana Ascendente inunda el suelo — la cima ya se ve');
  }
  else if(type==='ascGuardBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*256, vy:Math.sin(a)*256,
        dmg:boss.dmg*0.43, radius:7, owner:'enemy', color:'#fffce0', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#fffce0',23,200,0.4);
    shake(6);
  }

  // ---- Piso 87: Custodio de la Cumbre (decimoséptimo en guardia, último antes del Sol) ----
  else if(type==='summitWardenCrush'){
    const r = 200;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.58);
    spawnShockwave(boss.x,boss.y,'#fffef0',r,0.56);
    addParticles(boss.x,boss.y,'#fffef0',37,270,0.58);
    shake(12);
  }
  else if(type==='summitWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.48 });
    }
    spawnToast('El Custodio de la Cumbre levanta un anillo final de luz');
    shake(6);
  }
  else if(type==='summitWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*178, vy:Math.sin(a)*178,
        dmg:boss.dmg*1.16, radius:11, owner:'enemy', color:'#fffef0', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 88: Espina de la Cumbre (a esta altura, el dolor y la luz ya no se distinguen) ----
  else if(type==='summitThornLash'){
    const r = 130;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.18);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.4 });
    addParticles(boss.x,boss.y,'#fffff4',18,200,0.4);
    shake(6);
  }
  else if(type==='summitThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.42 });
    }
    addParticles(p.x,p.y,'#fffff4',16,140,0.35);
  }
  else if(type==='summitThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*222, vy:Math.sin(a)*222,
        dmg:boss.dmg*0.64, radius:7, owner:'enemy', color:'#fffff4', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 89: Susurro de la Cumbre (el último susurro — después solo queda gritar) ----
  else if(type==='summitWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 220+Math.random()*154;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*270, vy:Math.sin(a)*270,
        dmg:boss.dmg*0.51, radius:7, owner:'enemy', color:'#fffff8', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#fffff8',16,160,0.3);
    spawnToast('El último susurro antes del silencio final');
  }
  else if(type==='summitWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.42 });
    }
    spawnToast('Una estela final serpentea hacia vos');
  }
  else if(type==='summitWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*246, vy:Math.sin(a)*246,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#fffff8', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#fffff8',18,192,0.4);
    shake(5);
  }

  // ---- Piso 90: Corazón de la Cumbre (cierra el tramo, 4 ataques — el Sol está tras la puerta) ----
  else if(type==='summitHeartSlam'){
    const r = 170;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.34);
    addParticles(boss.x,boss.y,'#fffffc',32,238,0.5);
    spawnShockwave(boss.x,boss.y,'#fffffc',r,0.47);
    shake(10);
  }
  else if(type==='summitHeartLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 56;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 72) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.56 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 72) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.56 });
      }
    }
    spawnToast('El Corazón de la Cumbre parte la sala con luz total');
  }
  else if(type==='summitHeartBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*258, vy:Math.sin(a)*258,
        dmg:boss.dmg*0.45, radius:7, owner:'enemy', color:'#fffffc', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#fffffc',24,202,0.4);
    shake(6);
  }
  else if(type==='summitHeartCollapse'){
    for(let ring=0; ring<3; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:70+ring*68, type:'light', telegraph:0.3+ring*0.35, active:0.4, tick:0, dmg:boss.dmg*0.64 });
    }
    addParticles(boss.x,boss.y,'#fffffc',32,238,0.5);
    spawnToast('El Corazón de la Cumbre colapsa — solo queda el Sol');
    shake(8);
  }

  // ---- Piso 91: Enjambre de la Cumbre (abre el tramo final — ya no hay más tramos después) ----
  else if(type==='swarmSummitDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=204;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#ffffff',16,214,0.35); }
    });
  }
  else if(type==='summitSwarmField'){
    for(let i=0;i<7;i++){
      const hx = clamp(targetX+rand(-180,180), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-180,180), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:32, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.28 });
    }
    spawnToast('El Enjambre de la Cumbre se dispersa por el suelo');
  }
  else if(type==='summitSwarmBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.1;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*246, vy:Math.sin(a)*246,
        dmg:boss.dmg*0.34, radius:6, owner:'enemy', color:'#ffffff', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#ffffff',20,186,0.35);
    shake(5);
  }

  // ---- Piso 92: Custodio del Portal (decimoctavo en guardia, el último que custodia la entrada) ----
  else if(type==='portalWardenCrush'){
    const r = 202;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.6);
    spawnShockwave(boss.x,boss.y,'#fffef5',r,0.56);
    addParticles(boss.x,boss.y,'#fffef5',38,272,0.58);
    shake(13);
  }
  else if(type==='portalWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.5 });
    }
    spawnToast('El Custodio del Portal levanta el último anillo de guardia');
    shake(6);
  }
  else if(type==='portalWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*180, vy:Math.sin(a)*180,
        dmg:boss.dmg*1.18, radius:11, owner:'enemy', color:'#fffef5', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 93: Espina del Portal (ya no queda distancia entre el dolor y la luz misma) ----
  else if(type==='portalThornLash'){
    const r = 132;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.2);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.42 });
    addParticles(boss.x,boss.y,'#fffff6',18,202,0.4);
    shake(6);
  }
  else if(type==='portalThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.44 });
    }
    addParticles(p.x,p.y,'#fffff6',16,140,0.35);
  }
  else if(type==='portalThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*224, vy:Math.sin(a)*224,
        dmg:boss.dmg*0.66, radius:7, owner:'enemy', color:'#fffff6', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 94: Susurro del Portal (lo que susurra ya no es idioma — es solo calor) ----
  else if(type==='portalWhisperDodge'){
    const bnds = arenaBounds();
    const ang = Math.random()*Math.PI*2;
    const dist2 = 222+Math.random()*156;
    boss.x = clamp(p.x+Math.cos(ang)*dist2, bnds.x+boss.radius, bnds.x+bnds.w-boss.radius);
    boss.y = clamp(p.y+Math.sin(ang)*dist2, bnds.y+boss.radius, bnds.y+bnds.h-boss.radius);
    const shootAng = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<6;i++){
      const a = shootAng + (i-2.5)*0.11;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*272, vy:Math.sin(a)*272,
        dmg:boss.dmg*0.52, radius:7, owner:'enemy', color:'#fffff9', life:2.2 });
    }
    addParticles(boss.x,boss.y,'#fffff9',16,160,0.3);
    spawnToast('El Susurro del Portal ya solo emite calor puro');
  }
  else if(type==='portalWhisperCrawl'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const steps=6;
    for(let i=1;i<=steps;i++){
      const hx = clamp(boss.x+Math.cos(ang)*i*50, b.x+24, b.x+b.w-24);
      const hy = clamp(boss.y+Math.sin(ang)*i*50, b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:38, type:'light', telegraph:0.3+i*0.1, active:1.0, tick:0, dmg:boss.dmg*0.43 });
    }
    spawnToast('Una estela de calor puro serpentea hacia vos');
  }
  else if(type==='portalWhisperVolley'){
    const n=11;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*248, vy:Math.sin(a)*248,
        dmg:boss.dmg*0.46, radius:7, owner:'enemy', color:'#fffff9', life:2.3 });
    }
    addParticles(boss.x,boss.y,'#fffff9',18,194,0.4);
    shake(5);
  }

  // ---- Piso 95: Eco del Portal (el último eco antes del silencio total del Sol) ----
  else if(type==='portalEchoDash'){
    const ang = Math.atan2(p.y-boss.y,p.x-boss.x);
    const dashDist=216;
    startBossDash(boss, ang, dashDist, {
      dmg: boss.dmg*0.9, hitPad: 12,
      onComplete: ()=>{ shake(6); addParticles(boss.x,boss.y,'#fffffb',16,211,0.35); }
    });
  }
  else if(type==='portalEchoField'){
    for(let i=0;i<6;i++){
      const hx = clamp(targetX+rand(-170,170), b.x+24, b.x+b.w-24);
      const hy = clamp(targetY+rand(-170,170), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:34, type:'light', telegraph:0.4, active:1.8, tick:0, dmg:boss.dmg*0.3 });
    }
    spawnToast('El Eco del Portal se dispersa por el suelo');
  }
  else if(type==='portalEchoBurst'){
    const n=14;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2 + Math.random()*0.08;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*244, vy:Math.sin(a)*244,
        dmg:boss.dmg*0.32, radius:6, owner:'enemy', color:'#fffffb', life:2.0 });
    }
    addParticles(boss.x,boss.y,'#fffffb',20,188,0.35);
    shake(5);
  }

  // ---- Piso 96: Guardiana del Portal (cierra el tramo — el Sol está justo del otro lado) ----
  else if(type==='portalGuardSlam'){
    const r = 172;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.36);
    addParticles(boss.x,boss.y,'#fffffd',33,240,0.5);
    spawnShockwave(boss.x,boss.y,'#fffffd',r,0.48);
    shake(10);
  }
  else if(type==='portalGuardField'){
    for(let i=0;i<5;i++){
      const hx = clamp(p.x+rand(-176,176), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-176,176), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:42, type:'light', telegraph:0.55, active:2.1, tick:0, dmg:boss.dmg*0.39 });
    }
    spawnToast('La Guardiana del Portal inunda el suelo — el Sol está cerca');
  }
  else if(type==='portalGuardBurst'){
    const n=13;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.46, radius:7, owner:'enemy', color:'#fffffd', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#fffffd',25,204,0.4);
    shake(6);
  }

  // ---- Piso 97: Último Custodio (el último que hace guardia — nadie viene después de él) ----
  else if(type==='lastWardenCrush'){
    const r = 205;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.62);
    spawnShockwave(boss.x,boss.y,'#fffefb',r,0.57);
    addParticles(boss.x,boss.y,'#fffefb',39,275,0.6);
    shake(13);
  }
  else if(type==='lastWardenRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*58, type:'light', telegraph:0.35+ring*0.3, active:0.45, tick:0, dmg:boss.dmg*0.52 });
    }
    spawnToast('El Último Custodio levanta el anillo final de guardia');
    shake(6);
  }
  else if(type==='lastWardenVolley'){
    const n=4;
    const ang0 = Math.atan2(p.y-boss.y,p.x-boss.x);
    for(let i=0;i<n;i++){
      const a = ang0 + (i-(n-1)/2)*0.27;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*182, vy:Math.sin(a)*182,
        dmg:boss.dmg*1.2, radius:11, owner:'enemy', color:'#fffefb', life:3.2 });
    }
    shake(7);
  }

  // ---- Piso 98: Última Espina (el último dolor antes de que ya no haya más que luz) ----
  else if(type==='lastThornLash'){
    const r = 134;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.22);
    game.hazards.push({ x:boss.x, y:boss.y, r:r*0.75, type:'light', telegraph:0.25, active:1.7, tick:0, dmg:boss.dmg*0.44 });
    addParticles(boss.x,boss.y,'#fffefe',18,204,0.4);
    shake(6);
  }
  else if(type==='lastThornField'){
    for(let i=0;i<4;i++){
      const hx = clamp(p.x+rand(-150,150), b.x+24, b.x+b.w-24);
      const hy = clamp(p.y+rand(-150,150), b.y+24, b.y+b.h-24);
      game.hazards.push({ x:hx, y:hy, r:46, type:'light', telegraph:0.6, active:2.7, tick:0, dmg:boss.dmg*0.46 });
    }
    addParticles(p.x,p.y,'#fffefe',16,140,0.35);
  }
  else if(type==='lastThornBurst'){
    const n=8;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*226, vy:Math.sin(a)*226,
        dmg:boss.dmg*0.68, radius:7, owner:'enemy', color:'#fffefe', life:2.5 });
    }
    shake(5);
  }

  // ---- Piso 99: Precursor del Sol (anuncia al Sol en persona, 5 ataques — última puerta) ----
  else if(type==='precursorSlam'){
    const r = 178;
    if(dist(boss.x,boss.y,p.x,p.y)<r) hitPlayer(boss.dmg*1.4);
    addParticles(boss.x,boss.y,'#ffffff',35,245,0.52);
    spawnShockwave(boss.x,boss.y,'#ffffff',r,0.5);
    shake(11);
  }
  else if(type==='precursorRing'){
    for(let ring=0; ring<5; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:55+ring*60, type:'light', telegraph:0.32+ring*0.28, active:0.45, tick:0, dmg:boss.dmg*0.44 });
    }
    spawnToast('El Precursor del Sol traza un anillo total de luz');
    shake(6);
  }
  else if(type==='precursorLine'){
    const vertical = Math.random()<0.5;
    const gapCenter = vertical ? p.y : p.x;
    const spacing = 54;
    if(vertical){
      for(let y=b.y+30; y<b.y+b.h-30; y+=spacing){
        if(Math.abs(y-gapCenter) < 70) continue;
        game.hazards.push({ x:boss.x, y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.56 });
      }
    } else {
      for(let x=b.x+30; x<b.x+b.w-30; x+=spacing){
        if(Math.abs(x-gapCenter) < 70) continue;
        game.hazards.push({ x, y:boss.y, r:40, type:'light', telegraph:0.85, active:1.5, tick:0, dmg:boss.dmg*0.56 });
      }
    }
    spawnToast('El Precursor del Sol parte la sala con un rayo total');
  }
  else if(type==='precursorBurst'){
    const n=15;
    for(let i=0;i<n;i++){
      const a = (i/n)*Math.PI*2;
      spawnProjectile({ x:boss.x,y:boss.y, vx:Math.cos(a)*260, vy:Math.sin(a)*260,
        dmg:boss.dmg*0.4, radius:7, owner:'enemy', color:'#ffffff', life:2.4 });
    }
    addParticles(boss.x,boss.y,'#ffffff',26,208,0.42);
    shake(7);
  }
  else if(type==='precursorCollapse'){
    for(let ring=0; ring<4; ring++){
      game.hazards.push({ x:boss.x, y:boss.y, r:65+ring*62, type:'light', telegraph:0.28+ring*0.3, active:0.4, tick:0, dmg:boss.dmg*0.5 });
    }
    addParticles(boss.x,boss.y,'#ffffff',35,248,0.52);
    spawnToast('El Precursor del Sol colapsa — la última puerta se abre');
    shake(9);
  }
}

/* ---------- projectiles ---------- */
function spawnProjectile(pr){
  if(game._guardianAttack && pr.owner==='enemy'){
    // guardians' projectiles fly noticeably faster than the same attack from a regular floor
    // boss — less time between "I see it" and "it's here", which is what actually makes an
    // attack harder to dodge, rather than just hitting harder
    const speed = Math.hypot(pr.vx,pr.vy);
    if(speed>0){
      const boost = 1.28;
      pr = { ...pr, vx: pr.vx*boost, vy: pr.vy*boost };
    }
  }
  game.projectiles.push(pr);
  if(game._echoProjectiles && pr.owner==='enemy'){
    // boss attacks fire an extra echo alongside each projectile, roughly doubling their bullet
    // count without needing to hand-edit every single attack implementation
    const speed = Math.hypot(pr.vx,pr.vy)||1;
    const ang = Math.atan2(pr.vy,pr.vx) + (Math.random()<0.5?1:-1)*0.12;
    game.projectiles.push({ ...pr, vx:Math.cos(ang)*speed, vy:Math.sin(ang)*speed });
  }
}
function updateProjectiles(dt){
  const b = arenaBounds();
  const p = game.player;
  for(let i=game.projectiles.length-1;i>=0;i--){
    const pr = game.projectiles[i];
    if(pr.homing){
      const targAng = Math.atan2(p.y-pr.y, p.x-pr.x);
      const curAng = Math.atan2(pr.vy, pr.vx);
      let diff = targAng-curAng;
      while(diff>Math.PI) diff-=Math.PI*2;
      while(diff<-Math.PI) diff+=Math.PI*2;
      const turn = clamp(diff, -2.2*dt, 2.2*dt);
      const spd = Math.hypot(pr.vx,pr.vy);
      const newAng = curAng+turn;
      pr.vx = Math.cos(newAng)*spd; pr.vy = Math.sin(newAng)*spd;
    }
    pr.x += pr.vx*dt; pr.y += pr.vy*dt; pr.life -= dt;
    if(Math.random()<0.55){
      game.particles.push({ x:pr.x, y:pr.y, vx:-pr.vx*0.04, vy:-pr.vy*0.04, life:0.16, maxLife:0.16,
        color:pr.color, r:Math.max(1.5,pr.radius*0.4), type:'circle' });
    }
    let remove=false;
    if(pr.x<b.x||pr.x>b.x+b.w||pr.y<b.y||pr.y>b.y+b.h||pr.life<=0) remove=true;

    if(!remove && pr.owner==='player'){
      const targets = [...game.enemies, ...bossTargets()];
      for(const t of targets){
        // pierce: skip targets this same projectile already hit, so it can keep going through a line
        if(pr.pierce && pr.hitSet && pr.hitSet.has(t)) continue;
        if(dist(pr.x,pr.y,t.x,t.y) < pr.radius+t.radius){
          if(t.def && t.def.erratic && Math.random()<t.def.dodgeChance){
            addParticles(t.x,t.y,'#c9b8ff',5,90,0.18);
            continue; // phased through, no hit
          }
          const dmgObj = pr.dmg.value!==undefined ? pr.dmg : computeDamage(pr.dmg);
          dealDamageToTarget(t, dmgObj.value!==undefined?dmgObj:{value:dmgObj,crit:false}, 'proj');
          if(pr.explode){ explodeAt(pr.x,pr.y,pr.explodeRadius, computeDamage(pr.dmg.value?pr.dmg.value*0.6:20)); }
          if(pr.pierce){
            pr.hitSet = pr.hitSet || new Set();
            pr.hitSet.add(t);
            pr.pierceLeft = (pr.pierceLeft===undefined ? (pr.pierceCount!==undefined?pr.pierceCount:99) : pr.pierceLeft) - 1;
            if(pr.pierceLeft<=0) remove=true;
          } else {
            remove=true;
          }
          break;
        }
      }
    } else if(!remove && pr.owner==='enemy'){
      if(p.invuln<=0 && dist(pr.x,pr.y,p.x,p.y) < pr.radius+p.radius){
        hitPlayer(pr.dmg);
        if(pr.poison){ game.player.poisonTimer=3; game.hazards.push({x:p.x,y:p.y,r:1,dot:true,timer:3,tick:0}); }
        if(pr.slow){ p.slowTimer = Math.max(p.slowTimer||0, pr.slow.dur); p.slowFactor = pr.slow.factor; }
        remove=true;
      }
    }
    if(remove) game.projectiles.splice(i,1);
  }
}
function explodeAt(x,y,radius,dmgObj,color){
  // used to be a flat orange particle burst with no ring — the actual blast radius was invisible,
  // so a 60px mine and a 220px detonation looked identical. Now shows a shockwave scaled to the
  // real radius, screen shake scales a bit with size too, and callers can pass a thematic color
  // instead of always orange (optional — omitting it keeps the exact old look).
  const c = color || '#ff6a3d';
  addParticles(x,y,c,18,200,0.4);
  spawnShockwave(x,y,c,radius,0.35);
  shake(Math.min(5+radius*0.02, 10));
  [...game.enemies, ...bossTargets()].forEach(t=>{
    if(dist(x,y,t.x,t.y)<radius+t.radius) dealDamageToTarget(t, dmgObj, 'explode');
  });
}

/* ---------- hazards (poison dot on player) ---------- */
function updateHazards(dt){
  for(let i=game.hazards.length-1;i>=0;i--){
    const h = game.hazards[i];
    // unified telegraph->active hazard system: used by every hazard type (fire, poison, spike,
    // ice, storm, void, light...). Detected by the presence of `active`, NOT by a type whitelist —
    // that whitelist was the bug: any new hazard type added later silently never dealt damage.
    if(h.active !== undefined){
      if(h.telegraph>0){
        h.telegraph-=dt;
      } else {
        // BUG (real): expanding hazards with a *negative* expandRate ("closing ring" moves) had
        // no floor, so h.r eventually went to 0 and below. Every hazard is drawn with
        // ctx.createRadialGradient(..., h.r) somewhere, and a negative radius there throws
        // IndexSizeError and kills the whole render loop. Floor it well above 0.
        if(h.expanding) h.r = Math.max(4, h.r + (h.expandRate||100)*dt);
        h.active-=dt; h.tick-=dt;
        const p=game.player;
        if(h.tick<=0 && p.invuln<=0 && dist(h.x,h.y,p.x,p.y)<h.r){
          h.tick = h.type==='poison' ? 0.6 : 0.45;
          // Paso Fantasma: the first time you touch each hazard type on a given floor, it's free
          if(p.relics.effect_ghostStep && !(p._ghostStepUsed && p._ghostStepUsed[h.type])){
            p._ghostStepUsed = p._ghostStepUsed || {};
            p._ghostStepUsed[h.type] = true;
            addParticles(p.x,p.y,'#ffffff',12,140,0.3);
            spawnToast('Paso Fantasma te dejó atravesar el peligro sin daño');
          } else {
            hitPlayer(h.dmg);
            if(h.slow){ p.slowTimer = Math.max(p.slowTimer, h.slow.dur); p.slowFactor = h.slow.factor; }
          }
        }
        if(h.active<=0){ game.hazards.splice(i,1); continue; }
      }
      continue;
    }
    h.timer-=dt; h.tick-=dt;
    if(h.tick<=0 && h.dot){
      h.tick=0.5;
      const p=game.player;
      if(p.invuln<=0){
        hitPlayer(2); // was a direct `p.hp -= 2` that bypassed devMode's damage immunity entirely
        addDamageText(p.x,p.y-30,2,'#8bff6b',false);
      }
    }
    if(h.timer<=0) game.hazards.splice(i,1);
  }
}

/* ---------- mines (Mecha, Zapador): player-placed, only ever hurt enemies/bosses, mirrors the
   hazard system above but deliberately kept separate since hazards are wired to hitPlayer() ---------- */
function updateMines(dt){
  for(let i=game.mines.length-1;i>=0;i--){
    const m = game.mines[i];
    m.life -= dt;
    if(m.armTimer>0) m.armTimer -= dt;
    if(m.life<=0){ game.mines.splice(i,1); continue; }
    if(m.armTimer>0) continue;
    const targets = [...game.enemies, ...bossTargets()];
    const triggered = targets.some(t=> dist(m.x,m.y,t.x,t.y) < m.triggerRadius+(t.radius||16));
    if(triggered){
      explodeAt(m.x, m.y, m.blastRadius, computeDamage(m.dmgBase));
      game.mines.splice(i,1);
    }
  }
}
function drawMine(m){
  ctx.save();
  ctx.translate(m.x,m.y);
  const armed = m.armTimer<=0;
  ctx.globalAlpha = armed ? (0.65+Math.sin(performance.now()/160)*0.3) : 0.5;
  ctx.fillStyle = armed ? '#ff6a3d' : '#5a4a3a';
  ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle = '#2a1c14'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.restore();
}

/* ---------- gold orbs ---------- */
function updateGoldOrbs(dt){
  const p = game.player;
  for(let i=game.goldOrbs.length-1;i>=0;i--){
    const g = game.goldOrbs[i];
    const d = dist(g.x,g.y,p.x,p.y);
    if(d<130){
      const ang = Math.atan2(p.y-g.y,p.x-g.x);
      g.x += Math.cos(ang)*420*dt;
      g.y += Math.sin(ang)*420*dt;
    } else {
      g.x += g.vx*dt*0.3; g.y += g.vy*dt*0.3;
      g.vx*=0.9; g.vy*=0.9;
    }
    if(d<22){
      game.gold += Math.round(g.value * p.goldMult * (game.pacts.hardMode ? 1.15 : 1) * (game.pacts.vultureMode ? 1.25 : 1) * comboFactor(p) * game.routeGoldMult);
      if(p.relics.effect_lifeCurrent){ p.hp = Math.min(p.maxHp, p.hp+1); }
      game.goldOrbs.splice(i,1);
    }
  }
}

function maybeDropRelic(t){
  if(!t.isElite || Math.random()>RELIC_DROP_CHANCE) return;
  const p = game.player;
  const available = RELICS.filter(r=>!p.relics[r.id]);
  if(!available.length) return;
  const relic = available[Math.floor(Math.random()*available.length)];
  game.relicPickups.push({ x:t.x, y:t.y, relic, pulse:Math.random()*10 });
}

function maybeDropUtilityChest(t){
  if(game.phase!=='combat' || Math.random()>UTILITY_CHEST_CHANCE) return;
  game.utilityChests.push({ x:t.x, y:t.y, pulse:Math.random()*10 });
}

function updateUtilityChests(dt){
  const p = game.player;
  for(let i=game.utilityChests.length-1;i>=0;i--){
    const uc = game.utilityChests[i];
    if(dist(uc.x,uc.y,p.x,p.y)<34){
      const potion = POTIONS[Math.floor(Math.random()*POTIONS.length)];
      p.potions[potion.id]++;
      spawnToast(`🧪 Cofre de utilidad: +1 ${potion.name} (tecla ${potion.key.replace('Digit','')})`);
      addParticles(uc.x,uc.y,potion.color,26,200,0.5);
      game.utilityChests.splice(i,1);
    }
  }
}

function drawUtilityChest(uc){
  const bob = Math.sin(performance.now()/360+uc.pulse)*4;
  ctx.save();
  ctx.translate(uc.x, uc.y+bob);
  const grad = ctx.createRadialGradient(0,0,2,0,0,24);
  grad.addColorStop(0,'rgba(139,255,107,0.5)');
  grad.addColorStop(1,'rgba(139,255,107,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0,0,24,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='#2a3a1a'; ctx.strokeStyle='#8bff6b'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.rect(-13,-9,26,18); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-13,-9); ctx.quadraticCurveTo(0,-22,13,-9); ctx.stroke();
  ctx.fillStyle='#8bff6b'; ctx.font='14px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('🧪', 0, 1);
  ctx.restore();
}

function usePotion(id){
  const p = game.player;
  if(!p.potions[id] || p.potions[id]<=0) return;
  p.potions[id]--;
  const def = POTIONS.find(x=>x.id===id);
  if(id==='hp'){
    p.hp = Math.min(p.maxHp, p.hp + 25*(p.relics.effect_altarBlessing?1.5:1));
    addParticles(p.x,p.y,'#e8434f',20,160,0.4);
  } else if(id==='def'){
    p.potionEffects.def = 6;
    addParticles(p.x,p.y,'#8a8f9c',18,150,0.4);
  } else if(id==='dmg'){
    p.potionEffects.dmg = 6;
    addParticles(p.x,p.y,'#ff6a3d',18,150,0.4);
  } else if(id==='spd'){
    p.potionEffects.spd = 6;
    addParticles(p.x,p.y,'#6a8dff',18,150,0.4);
  }
  spawnToast(`${def.icon} ${def.name} usada`);
}

function updateRelicPickups(dt){
  const p = game.player;
  for(let i=game.relicPickups.length-1;i>=0;i--){
    const rp = game.relicPickups[i];
    if(dist(rp.x,rp.y,p.x,p.y)<34){
      rp.relic.apply(p);
      p.relics[rp.relic.id] = true;
      p.items.push({ id:rp.relic.id, name:rp.relic.name, icon:rp.relic.icon, desc:rp.relic.desc });
      registerItemDiscovery(rp.relic);
      spawnToast(`✨ Reliquia: ${rp.relic.name} — ${rp.relic.desc}`);
      addParticles(rp.x,rp.y,'#ffd54a',30,220,0.6);
      shake(6);
      game.relicPickups.splice(i,1);
    }
  }
}

function drawRelicPickup(rp){
  const bob = Math.sin(performance.now()/380+rp.pulse)*4;
  ctx.save();
  ctx.translate(rp.x, rp.y+bob);
  const grad = ctx.createRadialGradient(0,0,2,0,0,26);
  grad.addColorStop(0,'rgba(255,213,74,0.55)');
  grad.addColorStop(1,'rgba(255,213,74,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0,0,26,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#ffd54a'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(0,0,13,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='#ffd54a';
  ctx.font='16px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText(rp.relic.icon, 0, 1);
  ctx.restore();
}

/* ---------- chests / altar ---------- */
function updateChests(dt){
  game.chests.forEach(c=>{
    if(c.opened || c.tier==='common') return;
    c.sparkTimer -= dt;
    if(c.sparkTimer<=0){
      c.sparkTimer = c.tier==='epic' ? rand(0.12,0.24) : rand(0.3,0.55);
      const t = CHEST_TIERS[c.tier];
      const ang = Math.random()*Math.PI*2;
      const r = c.radius*0.8;
      game.particles.push({ x:c.x+Math.cos(ang)*r, y:c.y+Math.sin(ang)*r-6, vx:rand(-6,6), vy:-rand(18,34),
        life:0.6, maxLife:0.6, color:t.color, r:rand(1.2,2.2), type:'circle' });
    }
  });
}
function updateAltarPrompt(){
  const p = game.player;
  const toast = $('prompt-toast');
  let msg='';
  if(game.phase==='shopping'){
    game.chests.forEach(c=>{
      if(!c.opened && dist(p.x,p.y,c.x,c.y)<60) msg = `Espacio: abrir cofre ${CHEST_TIERS[c.tier].label} (${c.cost} oro)`;
    });
    if(!msg && game.altar && dist(p.x,p.y,game.altar.x,game.altar.y)<70) msg='Espacio: invocar al jefe';
    if(!msg && game.sacrificeAltar && !game.sacrificeAltar.used && dist(p.x,p.y,game.sacrificeAltar.x,game.sacrificeAltar.y)<60) msg='Espacio: sacrificar 15% HP máx por oro';
    if(!msg && game.corruptionAltar && !game.corruptionAltar.used && dist(p.x,p.y,game.corruptionAltar.x,game.corruptionAltar.y)<60) msg='Espacio: objeto legendario a cambio de una maldición';
    if(!msg && game.merchant && dist(p.x,p.y,game.merchant.x,game.merchant.y)<70) msg = game.merchant.chosen ? 'El mercader ya no tiene nada para vos' : 'Espacio: ver la mercancía del mercader';
  } else if(game.phase==='portal'){
    if(game.portal && dist(p.x,p.y,game.portal.x,game.portal.y)<70) msg='Espacio: entrar al portal';
  }
  if(msg){ toast.textContent=msg; toast.classList.add('show'); }
  else { toast.classList.remove('show'); }
}

/* ---------- particles ---------- */
function updateParticles(dt){
  for(let i=game.particles.length-1;i>=0;i--){
    const pt = game.particles[i];
    pt.life-=dt;
    if(pt.type==='circle'){ pt.x+=pt.vx*dt; pt.y+=pt.vy*dt; pt.vx*=0.92; pt.vy*=0.92; }
    else { pt.x+=pt.vx*dt; pt.y+=pt.vy*dt; pt.vy+=40*dt; }
    if(pt.life<=0) game.particles.splice(i,1);
  }
}

/* ---------- melee swing visuals ---------- */
function updateSwings(dt){
  for(let i=game.swings.length-1;i>=0;i--){
    const s = game.swings[i];
    s.life -= dt;
    if(s.life<=0) game.swings.splice(i,1);
  }
}

/* ---------- shockwave rings for heavy self-centered impacts ---------- */
function spawnShockwave(x,y,color,maxR,life){
  game.shockwaves.push({ x,y,color,maxR, r:maxR*0.15, life:life||0.4, maxLife:life||0.4 });
}
function updateShockwaves(dt){
  for(let i=game.shockwaves.length-1;i>=0;i--){
    const s = game.shockwaves[i];
    s.life -= dt;
    const prog = 1-clamp(s.life/s.maxLife,0,1);
    s.r = s.maxR*(0.15+prog*0.85);
    if(s.life<=0) game.shockwaves.splice(i,1);
  }
}
function drawShockwave(s){
  const fade = clamp(s.life/s.maxLife,0,1);
  ctx.save();
  ctx.globalAlpha = fade*0.8;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 5*fade+1.5;
  ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha = fade*0.35;
  ctx.lineWidth = 12*fade+2;
  ctx.beginPath(); ctx.arc(s.x,s.y,s.r*0.92,0,Math.PI*2); ctx.stroke();
  ctx.restore();
}

/* ---------- ghost afterimages for dashes and blinks ---------- */
function spawnAfterimage(x,y,radius,color,icon){
  game.afterimages.push({ x,y,radius,color,icon, life:0.26, maxLife:0.26 });
}
function updateAfterimages(dt){
  for(let i=game.afterimages.length-1;i>=0;i--){
    const a = game.afterimages[i];
    a.life -= dt;
    if(a.life<=0) game.afterimages.splice(i,1);
  }
}
function drawAfterimage(a){
  // used to draw a flat circle + emoji icon — a leftover from the old circle-avatar look, before
  // characters got redrawn as hooded figures. Now a glowing rim-silhouette in the class's accent
  // color, which reads as a proper motion streak and matches every dash-type ability at once.
  const fade = clamp(a.life/a.maxLife,0,1);
  ctx.save();
  ctx.globalAlpha = fade*0.4;
  ctx.shadowColor = a.color; ctx.shadowBlur = 10;
  ctx.fillStyle = a.color;
  ctx.beginPath(); ctx.arc(a.x,a.y,a.radius*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = fade*0.65;
  ctx.strokeStyle = a.color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(a.x,a.y,a.radius*0.85,0,Math.PI*2); ctx.stroke();
  ctx.restore();
}

/* ============================================================
   HUD SYNC
   ============================================================ */
function syncPotionRow(p){
  const row = $('potion-row');
  if(!row) return;
  row.innerHTML = POTIONS.map(pt=>{
    const n = p.potions[pt.id]||0;
    return `<div class="potion-slot${n>0?' has':''}"><span class="key">${pt.key.replace('Digit','')}</span><span class="ic">${pt.icon}</span>${n>0?`<span class="n">${n}</span>`:''}</div>`;
  }).join('');
}

// Every buff/debuff timer the player can be under, and how to describe it in the HUD panel.
const EFFECT_DEFS = [
  { get:p=>p.effects.warcry, label:'Grito de Guerra', desc:'+35% daño', kind:'buff' },
  { get:p=>p.effects.shadow, label:'Paso Sombrío', desc:'invisible, +15% vel., próx. golpe crítico', kind:'buff' },
  { get:p=>p.effects.wall, label:'Escudo Sagrado', desc:'+25% reducción de daño', kind:'buff' },
  { get:p=>p.effects.mirrorShield, label:'Escudo Especular', desc:'devuelve el daño recibido', kind:'buff' },
  { get:p=>p.effects.mantoLuz, label:'Manto de Luz', desc:'invulnerable, +40% vel.', kind:'buff' },
  { get:p=>p.potionEffects.def, label:'Poción de Defensa', desc:'+30% reducción de daño', kind:'buff' },
  { get:p=>p.potionEffects.dmg, label:'Poción de Daño', desc:'+25% daño', kind:'buff' },
  { get:p=>p.potionEffects.spd, label:'Poción de Velocidad', desc:'+30% velocidad', kind:'buff' },
  { get:p=>p.weakenTimer, label:'Debilitado', desc:'daño reducido', kind:'debuff' },
  { get:p=>p.chillTimer, label:'Enfriado', desc:'ataques más lentos', kind:'debuff' },
  { get:p=>p.slowTimer, label:'Ralentizado', desc:'movimiento reducido', kind:'debuff' },
  { get:p=>p.invertTimer, label:'Confundido', desc:'controles invertidos', kind:'debuff' },
  { get:p=>p.qLockTimer, label:'Q bloqueada', desc:'', kind:'debuff' },
  { get:p=>p.eLockTimer, label:'E bloqueada', desc:'', kind:'debuff' },
  { get:p=>p.frozenTimer, label:'Congelado', desc:'presioná WASD para romper el hielo', kind:'debuff' },
  { get:p=>p.iceSlideTimer, label:'Piso resbaladizo', desc:'perdiste tracción', kind:'debuff' },
  { get:p=> p.corruptionCurse ? Math.max(0, 3-(game.roomsSinceCorruption||0)) : 0,
    label:'Maldición del Altar', desc:'visión reducida, -28% velocidad', kind:'debuff',
    fmt:t=>{ const n=Math.ceil(t); return `${n} sala${n===1?'':'s'} restante${n===1?'':'s'}`; } },
];
function syncEffectsPanel(p){
  const panel = $('effects-panel');
  if(!panel) return;
  const active = EFFECT_DEFS.map(e=>({ label:e.label, desc:e.desc, kind:e.kind, t:e.get(p), fmt:e.fmt })).filter(e=>e.t>0.05);
  if(!active.length){ panel.innerHTML=''; return; }
  panel.innerHTML = active.map(e=>`
    <div class="effect-chip ${e.kind}">
      <span class="nm">${e.label}${e.desc?` <i>(${e.desc})</i>`:''}</span>
      <span class="t">${e.fmt ? e.fmt(e.t) : e.t.toFixed(1)+'s'}</span>
    </div>
  `).join('');
}

function syncHud(){
  const p = game.player;
  if(devMode) syncDevAttackPanel();
  $('hp-fill').style.width = clamp(p.hp/p.maxHp*100,0,100)+'%';
  $('hp-label').textContent = `${Math.max(0,Math.round(p.hp))}/${Math.round(p.maxHp)}` + (p.shield>0?`  ⛨${Math.round(p.shield)}`:'');
  $('gold-count').textContent = game.gold;
  $('hud-char-level').textContent = p.charLevel;
  syncPotionRow(p);
  syncEffectsPanel(p);
  const comboWrap = $('combo-wrap');
  if(p.combo>=5){ comboWrap.style.display='block'; $('combo-count').textContent = p.combo; }
  else { comboWrap.style.display='none'; }
  $('hud-hero-name').textContent = p.def.name;
  $('hud-hero-class').textContent = p.def.className;
  $('q-icon').textContent = p.def.q.icon;
  $('e-icon').textContent = p.def.e.icon;
  const qcd = $('q-cd'), ecd = $('e-cd');
  if(p.qTimer>0){ qcd.style.display='flex'; qcd.textContent = p.qTimer.toFixed(1); } else qcd.style.display='none';
  if(p.eTimer>0){ ecd.style.display='flex'; ecd.textContent = p.eTimer.toFixed(1); } else ecd.style.display='none';
  const rSlot = $('r-slot');
  if(p.activeUltimate){
    rSlot.style.display='flex';
    const ab = ULTIMATE_ABILITIES.find(a=>a.id===p.activeUltimate);
    const cd = p.ultCooldowns[p.activeUltimate]||0;
    const rIcon = $('r-icon');
    rIcon.textContent = ab.icon;
    rIcon.style.color = ab.color;
    const rcd = $('r-cd');
    if(cd>0){ rcd.style.display='flex'; rcd.textContent = cd.toFixed(1); } else rcd.style.display='none';
  } else {
    rSlot.style.display='none';
  }
  const shiftSlot = $('shift-slot');
  if(p.activeShiftAbility){
    shiftSlot.style.display='flex';
    const sab = SHIFT_ABILITIES.find(a=>a.id===p.activeShiftAbility);
    const scd = p.shiftCooldowns[p.activeShiftAbility]||0;
    const shiftIcon = $('shift-icon');
    shiftIcon.textContent = sab.icon;
    shiftIcon.style.color = sab.color;
    const shiftCdEl = $('shift-cd');
    if(scd>0){ shiftCdEl.style.display='flex'; shiftCdEl.textContent = scd.toFixed(1); } else shiftCdEl.style.display='none';
  } else {
    shiftSlot.style.display='none';
  }
  updatePhaseNote();
  if(game.boss){
    $('boss-hp-fill').style.width = clamp(game.boss.hp/game.boss.maxHp*100,0,100)+'%';
    $('boss-hp-wrap').classList.toggle('enraged', game.boss.phase===2);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function render(){
  ctx.save();
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = '#0a0710';
  ctx.fillRect(0,0,canvas.width,canvas.height);

  if(!game){ ctx.restore(); return; }

  ctx.save();
  if(game.shake>0){
    ctx.translate(rand(-game.shake,game.shake), rand(-game.shake,game.shake));
  }
  ctx.translate(-game.camera.x, -game.camera.y);

  const b = arenaBounds();
  drawArena(b);

  // altar
  if(game.altar) drawAltar(game.altar);
  if(game.sacrificeAltar) drawSacrificeAltar(game.sacrificeAltar);
  if(game.corruptionAltar) drawCorruptionAltar(game.corruptionAltar);
  if(game.merchant) drawMerchant(game.merchant);
  // portal
  if(game.portal) drawPortal(game.portal);
  // ground hazards (fire patches etc)
  game.hazards.forEach(h=>drawHazard(h));
  game.mines.forEach(m=>drawMine(m));
  // chests
  game.chests.forEach(c=>drawChest(c));
  // gold orbs
  game.goldOrbs.forEach(g=>drawGold(g));
  game.relicPickups.forEach(rp=>drawRelicPickup(rp));
  game.utilityChests.forEach(uc=>drawUtilityChest(uc));
  // melee swing effects
  game.swings.forEach(s=>drawSwing(s));
  game.shockwaves.forEach(s=>drawShockwave(s));
  game.afterimages.forEach(a=>drawAfterimage(a));
  // enemies
  game.enemies.forEach(en=>drawEnemy(en));
  if(game.pet) drawPet(game.pet);
  game.pack.forEach(m=>drawPet(m));
  drawGravityWell();
  drawSlowZone();
  drawPendingBursts();
  drawVortex();
  drawPullLines();
  // boss
  if(game.boss && game.boss.telegraph) drawBossTelegraphIndicator(game.boss);
  if(game.boss) drawBoss(game.boss);
  if(game.boss && game.boss.cores) drawBossCores(game.boss.cores.filter(c=>c.alive));
  if(game.boss && game.boss.barrierActive) drawClosingBarrier(game.boss);
  if(game.boss && game.boss.movers) drawBossMovers(game.boss.movers);
  if(game.boss && game.boss.enrageActive) drawAbyssEnrageWorld(game.boss);
  if(game.boss && game.boss.twin && game.boss.twin.alive) drawTwinCompanion(game.boss.twin, game.boss.def);
  // projectiles
  game.projectiles.forEach(pr=>drawProjectile(pr));
  // player
  drawPlayer(game.player);
  // particles
  game.particles.forEach(pt=>drawParticle(pt));

  ctx.restore();

  if(game.boss && game.boss.enrageActive) drawAbyssEnrageOverlay(game.boss);
  if(game.phase==='bossIntro' || game.phase==='ascensoBossIntro') drawBossCountdown(game.bossCountdown);

  ctx.restore();
}

function drawAbyssEnrageWorld(boss){
  const bnds = arenaBounds();
  const heatProg = clamp(1-boss.enrageTimer/boss.enrageMaxTimer, 0, 1);
  ctx.save();
  const ringR = 40 + heatProg*Math.max(bnds.w,bnds.h)*0.75;
  const grad = ctx.createRadialGradient(boss.x,boss.y,20,boss.x,boss.y,ringR);
  grad.addColorStop(0,'rgba(255,90,61,0.28)');
  grad.addColorStop(0.7,'rgba(255,90,61,0.08)');
  grad.addColorStop(1,'rgba(255,90,61,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(boss.x,boss.y,ringR,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

function drawAbyssEnrageOverlay(boss){
  const heatProg = clamp(1-boss.enrageTimer/boss.enrageMaxTimer, 0, 1);
  ctx.save();
  ctx.globalAlpha = 0.08+heatProg*0.22;
  ctx.fillStyle = '#ff3d1a';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 22px monospace';
  ctx.fillStyle = '#ffcb47';
  ctx.globalAlpha = 0.9;
  const secs = Math.max(0, Math.ceil(boss.enrageTimer));
  ctx.fillText(`⚠ SUPERNOVA EN ${secs}s ⚠`, canvas.width/2, 64);
  ctx.restore();
}

function drawBossCountdown(t){
  const n = Math.ceil(t);
  if(n<1) return;
  const frac = t-(n-1); // 1 -> 0 within this second
  const scale = 1 + (1-frac)*0.6;
  const alpha = clamp(frac*1.4,0,1);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(canvas.width/2, canvas.height/2 - 20);
  ctx.scale(scale,scale);
  ctx.font = "900 120px 'Cinzel Decorative', serif";
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.shadowColor='#ff6a3d'; ctx.shadowBlur=40;
  ctx.fillStyle='#ff6a3d';
  ctx.fillText(String(n), 0, 0);
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.textAlign='center';
  ctx.font = "600 14px 'JetBrains Mono', monospace";
  ctx.fillStyle='#ece2cf';
  ctx.letterSpacing = '4px';
  ctx.fillText('EL ALTAR DESPIERTA', canvas.width/2, canvas.height/2+70);
  ctx.restore();
}

const ZONE_THEMES = {
  cripta:    { top:'#5a4426', bottom:'#2e2210', terrainA:'#caa25c', terrainB:'#a97f3e', grid:'rgba(120,90,40,0.15)', border:'#7a5c30', decor:'cactus',      decorColor:'#4f7a3d', secondaryColor:'#8a6438', landmark:'ruins' },
  pantano:   { top:'#1c3320', bottom:'#0c1810', terrainA:'#3f6b42', terrainB:'#274a2c', grid:'rgba(90,180,110,0.12)', border:'#3a5c3e', decor:'reeds',        decorColor:'#4f8a5a', secondaryColor:'#1f3a28', landmark:'deadtree' },
  fortaleza: { top:'#4a1c0c', bottom:'#210a04', terrainA:'#7a2f14', terrainB:'#4a1a0a', grid:'rgba(255,120,60,0.12)', border:'#7a3010', decor:'rockspike',    decorColor:'#3a2018', secondaryColor:'#c94a1e', landmark:'brokenpillar' },
  jardin:    { top:'#3a2350', bottom:'#1c1030', terrainA:'#7a4f9e', terrainB:'#5a3878', grid:'rgba(255,214,240,0.10)', border:'#6a4090', decor:'flowercluster',decorColor:'#ffb0d9', secondaryColor:'#c98adf', landmark:'archvines' },
  espejos:   { top:'#232c42', bottom:'#10141f', terrainA:'#3f4d6e', terrainB:'#2a3450', grid:'rgba(207,214,232,0.12)', border:'#4a5a80', decor:'mirrorshards', decorColor:'#cfd6e8', secondaryColor:'#5a6a90', landmark:'brokenmirror' },
  gemelo:    { top:'#4a2438', bottom:'#20101c', terrainA:'#8a3f64', terrainB:'#5e2844', grid:'rgba(255,176,217,0.10)', border:'#7a3a5c', decor:'twinmotif',    decorColor:'#ffb0d9', secondaryColor:'#c9698f', landmark:'twinstatues' },
  glaciar:   { top:'#1c4258', bottom:'#0c1e28', terrainA:'#4f8ab0', terrainB:'#2f5f7e', grid:'rgba(159,216,255,0.14)', border:'#3f7294', decor:'icecrystal',   decorColor:'#bfe6ff', secondaryColor:'#7cc4e8', landmark:'icespire' },
  tormenta:  { top:'#4a4318', bottom:'#221f0a', terrainA:'#8a7d2e', terrainB:'#5e5518', grid:'rgba(255,228,90,0.12)', border:'#7a6e28', decor:'stormshard',   decorColor:'#ffe45a', secondaryColor:'#3a3612', landmark:'watchtower' },
  abismo:    { top:'#241a3e', bottom:'#0f0a1e', terrainA:'#4a3578', terrainB:'#2e2050', grid:'rgba(155,122,224,0.12)', border:'#4a3578', decor:'starpoint',    decorColor:'#c9b6ff', secondaryColor:'#3a2a5c', landmark:'monolith' },
  trono:     { top:'#4a3a14', bottom:'#221a08', terrainA:'#8a6f2e', terrainB:'#5e4c18', grid:'rgba(224,201,160,0.14)', border:'#8a6f2e', decor:'crownmotif',   decorColor:'#ffd97a', secondaryColor:'#6b5220', landmark:'thronesil' },
  ascenso:   { top:'#0d0a1a', bottom:'#050308', terrainA:'#1a1530', terrainB:'#0a0815', grid:'rgba(160,140,220,0.10)', border:'#2a2040', decor:'starpoint',    decorColor:'#c9b6ff', secondaryColor:'#1a1530', landmark:'monolith' },
};

// Deterministic per-floor decoration layout, generated once when a stage loads (see startStage)
// and stored on game.arenaDecor — kept stable across the whole floor instead of reshuffling every
// frame, and reused as-is if you ever revisit the same floor number.
function generateArenaDecor(stage, b){
  const key = stage ? stage.key : 'cripta';
  const isFinal = !!(stage && stage.floor === TOWER_MAX_FLOOR);
  let seed = ((stage ? stage.floor : 1) * 9301 + 49297) % 233280;
  const rnd = ()=>{ seed = (seed*9301+49297)%233280; return seed/233280; };

  // soft organic terrain blobs — replaces the old flat linear gradient with patches of light/dark
  // ground tone, so the floor reads as actual uneven terrain instead of a flat color
  const terrain = [];
  for(let i=0;i<7;i++){
    terrain.push({
      x: b.x + rnd()*b.w, y: b.y + rnd()*b.h,
      r: 90 + rnd()*160, dark: rnd()<0.5, a: 0.25+rnd()*0.25,
    });
  }

  const primaryCount = key==='abismo' ? 42 : 11;
  const items = [];
  for(let i=0;i<primaryCount;i++){
    items.push({
      x: b.x + 30 + rnd()*(b.w-60),
      y: b.y + 30 + rnd()*(b.h-60),
      s: 0.75 + rnd()*0.95,
      r: rnd()*Math.PI*2,
      seed: rnd(),
    });
  }

  const secondaryCount = 6;
  const patches = [];
  for(let i=0;i<secondaryCount;i++){
    patches.push({
      x: b.x + 40 + rnd()*(b.w-80),
      y: b.y + 40 + rnd()*(b.h-80),
      s: 0.8 + rnd()*0.7,
      r: rnd()*Math.PI*2,
      seed: rnd(),
    });
  }

  // one background landmark structure, tucked into whichever corner keeps it clear of the
  // portal/altar that spawns near the arena's center
  const corners = [
    { x:b.x+b.w*0.14, y:b.y+b.h*0.22 }, { x:b.x+b.w*0.86, y:b.y+b.h*0.22 },
    { x:b.x+b.w*0.14, y:b.y+b.h*0.82 }, { x:b.x+b.w*0.86, y:b.y+b.h*0.82 },
  ];
  const landmark = corners[Math.floor(rnd()*corners.length)];
  landmark.s = 1.0 + rnd()*0.4;

  return { key, isFinal, terrain, items, patches, landmark };
}

// Small ambient cluster props — one per zone theme — scattered across the floor.
function drawArenaDecorItem(type, item, color){
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.r*0.25); // gentle tilt only — most of these read as "standing" props, not debris
  ctx.scale(item.s, item.s);
  ctx.globalAlpha = 0.55 + item.seed*0.3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  if(type==='cactus'){
    const dark = '#345c29';
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-6,-26,12,32,6) : ctx.rect(-6,-26,12,32); ctx.fill();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-16,-10,10,16,5) : ctx.rect(-16,-10,10,16); ctx.fill();
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(6,-16,10,16,5) : ctx.rect(6,-16,10,16); ctx.fill();
    ctx.fillStyle = color;
    ctx.globalAlpha *= 0.9;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(-4,-24,4,28,3) : ctx.rect(-4,-24,4,28); ctx.fill();
  } else if(type==='reeds'){
    for(let k=-1;k<=1;k++){
      ctx.beginPath();
      ctx.moveTo(k*6,10);
      ctx.quadraticCurveTo(k*10,-8, k*4,-22-Math.abs(k)*3);
      ctx.stroke();
      ctx.beginPath(); ctx.ellipse(k*4,-24-Math.abs(k)*3,2.6,5,0,0,Math.PI*2); ctx.fill();
    }
  } else if(type==='rockspike'){
    ctx.beginPath();
    ctx.moveTo(-12,10); ctx.lineTo(-9,-14); ctx.lineTo(0,-24); ctx.lineTo(8,-10); ctx.lineTo(13,10);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ff8a5a'; ctx.globalAlpha = 0.7+0.25*Math.sin(performance.now()/300+item.seed*10);
    ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.moveTo(-2,6); ctx.lineTo(2,-6); ctx.lineTo(-1,-16); ctx.stroke();
  } else if(type==='flowercluster'){
    [[-9,4,0.8],[9,6,0.7],[0,-6,1]].forEach(([fx,fy,fs])=>{
      ctx.save(); ctx.translate(fx,fy); ctx.scale(fs,fs);
      for(let k=0;k<5;k++){
        const a = (k/5)*Math.PI*2;
        ctx.beginPath(); ctx.ellipse(Math.cos(a)*6,Math.sin(a)*6,4.4,2.6,a,0,Math.PI*2); ctx.fill();
      }
      ctx.globalAlpha = 0.85; ctx.fillStyle='#ffe6a0';
      ctx.beginPath(); ctx.arc(0,0,2.2,0,Math.PI*2); ctx.fill();
      ctx.fillStyle = color;
      ctx.restore();
    });
  } else if(type==='mirrorshards'){
    [[-7,0,1],[7,-4,0.75],[3,7,0.6]].forEach(([mx,my,ms])=>{
      ctx.save(); ctx.translate(mx,my); ctx.scale(ms,ms);
      ctx.globalAlpha = 0.35 + 0.3*Math.sin(performance.now()/450 + item.seed*12 + mx);
      ctx.beginPath(); ctx.moveTo(0,-11); ctx.lineTo(8,0); ctx.lineTo(0,11); ctx.lineTo(-8,0); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    });
  } else if(type==='twinmotif'){
    ctx.beginPath(); ctx.arc(-9,0,5,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.arc(9,0,5,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha *= 0.6;
    ctx.beginPath(); ctx.moveTo(-4,0); ctx.lineTo(4,0); ctx.stroke();
  } else if(type==='icecrystal'){
    [[-8,0,0.85],[6,3,0.7],[0,-3,1]].forEach(([ix,iy,is])=>{
      ctx.save(); ctx.translate(ix,iy); ctx.scale(is,is);
      ctx.beginPath(); ctx.moveTo(0,-16); ctx.lineTo(6,0); ctx.lineTo(0,14); ctx.lineTo(-6,0); ctx.closePath();
      ctx.globalAlpha=0.45; ctx.fill();
      ctx.globalAlpha=0.85; ctx.stroke();
      ctx.restore();
    });
  } else if(type==='stormshard'){
    ctx.beginPath();
    ctx.moveTo(-4,-17); ctx.lineTo(4,-4); ctx.lineTo(-2,-4); ctx.lineTo(6,17); ctx.lineTo(-2,2); ctx.lineTo(4,2);
    ctx.closePath(); ctx.globalAlpha *= 0.55+0.3*Math.sin(performance.now()/260+item.seed*9); ctx.fill();
  } else if(type==='starpoint'){
    ctx.globalAlpha = 0.4 + item.seed*0.5;
    ctx.beginPath(); ctx.arc(0,0,1.5,0,Math.PI*2); ctx.fill();
  } else if(type==='crownmotif'){
    ctx.beginPath(); ctx.moveTo(-10,10); ctx.lineTo(-6,-6); ctx.lineTo(0,4); ctx.lineTo(6,-10); ctx.lineTo(10,10); ctx.closePath(); ctx.stroke();
    ctx.globalAlpha *= 0.9; ctx.fillStyle='#fff3c9';
    ctx.beginPath(); ctx.arc(0,-1,2,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// Filled ground patches with a bit of surface detail — puddles, cracked earth, frost, embers —
// drawn under the standing props so the floor itself feels textured, not just decorated.
function drawArenaSecondaryPatch(type, item, color){
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.scale(item.s, item.s);
  ctx.globalAlpha = 0.22 + item.seed*0.12;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  if(type==='crackedearth'){
    ctx.beginPath(); ctx.ellipse(0,0,42,24,item.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.8; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.moveTo(-24,-4); ctx.lineTo(-4,4); ctx.lineTo(8,-6); ctx.lineTo(22,6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-4,4); ctx.lineTo(-8,16); ctx.stroke();
  } else if(type==='puddle'){
    ctx.beginPath(); ctx.ellipse(0,0,38,18,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.5; ctx.lineWidth=1.2;
    ctx.beginPath(); ctx.ellipse(0,0,20,9,0,0,Math.PI*2); ctx.stroke();
  } else if(type==='lavacrack'){
    ctx.beginPath(); ctx.ellipse(0,0,40,20,item.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=0.7+0.25*Math.sin(performance.now()/260+item.seed*11); ctx.fillStyle='#ff8a5a';
    ctx.beginPath(); ctx.moveTo(-26,4); ctx.lineTo(-6,-6); ctx.lineTo(4,4); ctx.lineTo(24,-4); ctx.lineTo(26,2); ctx.lineTo(4,10); ctx.lineTo(-6,0); ctx.lineTo(-24,10); ctx.closePath(); ctx.fill();
  } else if(type==='lightpatch'){
    ctx.beginPath(); ctx.arc(0,0,34,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.6; ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(0,0,5,0,Math.PI*2); ctx.fill();
  } else if(type==='mirrorsheen'){
    ctx.beginPath(); ctx.ellipse(0,0,36,20,item.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha = 0.3+0.25*Math.sin(performance.now()/500+item.seed*8); ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.ellipse(0,0,22,4,item.r+0.5,0,Math.PI*2); ctx.fill();
  } else if(type==='heartpetal'){
    ctx.beginPath(); ctx.ellipse(0,0,30,18,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.6;
    [[-8,-2],[6,3],[0,8]].forEach(([hx,hy])=>{ ctx.beginPath(); ctx.arc(hx,hy,3,0,Math.PI*2); ctx.fill(); });
  } else if(type==='frostpatch'){
    ctx.beginPath(); ctx.ellipse(0,0,36,20,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.6; ctx.lineWidth=1.2;
    for(let k=0;k<5;k++){ const a=(k/5)*Math.PI*2; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*22,Math.sin(a)*11); ctx.stroke(); }
  } else if(type==='scorchedpatch'){
    ctx.beginPath(); ctx.ellipse(0,0,38,20,item.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=0.6+0.3*Math.sin(performance.now()/300+item.seed*7); ctx.fillStyle='#ffb347';
    ctx.beginPath(); ctx.arc(-6,-2,3,0,Math.PI*2); ctx.arc(8,4,2.4,0,Math.PI*2); ctx.fill();
  } else if(type==='voidcrack'){
    ctx.beginPath(); ctx.ellipse(0,0,34,20,item.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.7; ctx.lineWidth=1.2;
    for(let k=0;k<4;k++){ const a=(k/4)*Math.PI*2+item.r; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*20,Math.sin(a)*12); ctx.stroke(); }
  } else if(type==='goldinlay'){
    ctx.beginPath(); ctx.ellipse(0,0,34,20,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha *= 1.7; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.ellipse(0,0,18,10,0,0,Math.PI*2); ctx.stroke();
  }
  ctx.restore();
}

// One background landmark per floor — a big, low-opacity structural silhouette that gives the
// place an identity, sitting behind everything else and well clear of the portal/altar.
function drawArenaLandmark(type, item, theme){
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.scale(item.s, item.s);
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = theme.border;
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 3;
  if(type==='ruins'){
    ctx.fillRect(-48,-70,16,140); ctx.fillRect(32,-70,16,140);
    ctx.beginPath(); ctx.moveTo(-48,-70); ctx.lineTo(0,-108); ctx.lineTo(48,-70); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.5; ctx.fillStyle='#0a0710';
    ctx.beginPath(); ctx.moveTo(-20,60); ctx.lineTo(-20,-30); ctx.quadraticCurveTo(0,-55,20,-30); ctx.lineTo(20,60); ctx.closePath(); ctx.fill();
  } else if(type==='deadtree'){
    ctx.beginPath(); ctx.moveTo(0,80); ctx.lineTo(-6,-20); ctx.lineTo(-36,-70); ctx.moveTo(-6,-20); ctx.lineTo(22,-64);
    ctx.moveTo(-6,-20); ctx.lineTo(-4,-90); ctx.moveTo(-20,-40); ctx.lineTo(-42,-52); ctx.moveTo(10,-42); ctx.lineTo(34,-38);
    ctx.lineWidth=6; ctx.stroke();
  } else if(type==='brokenpillar'){
    ctx.fillRect(-18,-40,36,120);
    ctx.beginPath(); ctx.moveTo(-24,-40); ctx.lineTo(-6,-70); ctx.lineTo(14,-52); ctx.lineTo(24,-40); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.55; ctx.fillStyle='#ff8a5a';
    ctx.beginPath(); ctx.arc(0,60,10,0,Math.PI*2); ctx.fill();
  } else if(type==='archvines'){
    ctx.lineWidth=16; ctx.beginPath(); ctx.arc(0,20,70,Math.PI,0); ctx.stroke();
    ctx.globalAlpha=0.45; ctx.strokeStyle='#7fbf6a'; ctx.lineWidth=3;
    for(let k=0;k<6;k++){ const a=Math.PI+ (k/5)*Math.PI; ctx.beginPath(); ctx.moveTo(Math.cos(a)*70,20+Math.sin(a)*70); ctx.lineTo(Math.cos(a)*70,20+Math.sin(a)*70+22); ctx.stroke(); }
  } else if(type==='brokenmirror'){
    ctx.strokeRect(-40,-70,80,140);
    ctx.globalAlpha=0.35; ctx.fillStyle='#cfd6e8';
    ctx.beginPath(); ctx.moveTo(-36,-66); ctx.lineTo(10,10); ctx.lineTo(-36,40); ctx.closePath(); ctx.fill();
  } else if(type==='twinstatues'){
    [-46,46].forEach(sx=>{
      ctx.beginPath(); ctx.ellipse(sx,-10,16,40,0,0,Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(sx,-56,14,0,Math.PI*2); ctx.fill();
    });
  } else if(type==='icespire'){
    ctx.beginPath(); ctx.moveTo(-30,70); ctx.lineTo(-10,-90); ctx.lineTo(14,-60); ctx.lineTo(30,70); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.4; ctx.strokeStyle='#fff'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(-10,-90); ctx.lineTo(-4,40); ctx.stroke();
  } else if(type==='watchtower'){
    ctx.fillRect(-22,-20,44,110);
    ctx.beginPath(); ctx.moveTo(-30,-20); ctx.lineTo(0,-56); ctx.lineTo(30,-20); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.6; ctx.strokeStyle='#ffe45a'; ctx.lineWidth=3;
    ctx.beginPath(); ctx.moveTo(0,-56); ctx.lineTo(-8,-30); ctx.lineTo(4,-30); ctx.lineTo(-6,0); ctx.stroke();
  } else if(type==='monolith'){
    ctx.beginPath(); ctx.moveTo(-20,60); ctx.lineTo(-26,-70); ctx.lineTo(0,-96); ctx.lineTo(24,-64); ctx.lineTo(20,60); ctx.closePath(); ctx.fill();
    ctx.globalAlpha=0.35; ctx.strokeStyle='#c9b6ff'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(-10,40); ctx.lineTo(-14,-50); ctx.stroke();
  } else if(type==='thronesil'){
    ctx.fillRect(-40,-20,80,90);
    ctx.fillRect(-48,-80,16,80); ctx.fillRect(32,-80,16,80);
    ctx.globalAlpha=0.55; ctx.fillStyle='#ffd97a';
    ctx.beginPath(); ctx.arc(-40,-80,6,0,Math.PI*2); ctx.arc(40,-80,6,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

// maps each zone's primary prop type to the ground-patch type that belongs with it
function secondaryDecorFor(decorType){
  const map = {
    cactus:'crackedearth', reeds:'puddle', rockspike:'lavacrack', flowercluster:'lightpatch',
    mirrorshards:'mirrorsheen', twinmotif:'heartpetal', icecrystal:'frostpatch',
    stormshard:'scorchedpatch', starpoint:'voidcrack', crownmotif:'goldinlay',
  };
  return map[decorType] || 'crackedearth';
}

// Ascenso arenas were deliberately left undecorated (no terrain props — see enterAscensoFloor),
// which read as too bare/empty in practice. This draws a procedural sacred-geometry mandala
// instead: concentric rings + a rotated diamond, in magenta/cyan on the early dark floors,
// crossfading to gold/white as ascensoLight climbs toward the Sun at floor 100.
// Small utility: '#rrggbb' -> 'rgba(r,g,b,a)', used by the arena accent-glow rendering
function hexToRgba(hex, alpha){
  const h = hex.replace('#','');
  const r = parseInt(h.substring(0,2),16), g = parseInt(h.substring(2,4),16), bl = parseInt(h.substring(4,6),16);
  return `rgba(${r},${g},${bl},${alpha})`;
}

// Ambient motes for Ascenso arenas — a small fixed set of drifting particles, regenerated once
// per floor (not every frame) so this stays cheap. Cool magenta/cyan sparks on the dark floors,
// warm drifting light motes as ascensoLight climbs toward the Sun.
let _ascensoMotesFloor = null;
let _ascensoMotesCache = [];
function getAscensoMotes(b){
  if(_ascensoMotesFloor !== game.ascensoFloor){
    _ascensoMotesFloor = game.ascensoFloor;
    _ascensoMotesCache = [];
    const n = 26;
    for(let i=0;i<n;i++){
      _ascensoMotesCache.push({
        fx: Math.random(), fy: Math.random(),
        size: 1+Math.random()*2.2,
        speed: 6+Math.random()*14,
        phase: Math.random()*Math.PI*2,
        drift: (Math.random()-0.5)*8,
      });
    }
  }
  return _ascensoMotesCache;
}

function drawAscensoMandala(b){
  const light = clamp(game.ascensoLight||0, 0, 1);
  const cx = b.x+b.w/2, cy = b.y+b.h/2;
  const isSunFloor = game.ascensoFloor === ASCENSO_MAX_FLOOR-1;
  const t = performance.now()/1000;
  const colDarkA = [255,47,214];   // magenta
  const colDarkB = [70,225,255];   // cyan
  const colLight = [255,214,120];  // warm gold
  const lerp3 = (c1,c2,f)=>[
    Math.round(c1[0]*(1-f)+c2[0]*f),
    Math.round(c1[1]*(1-f)+c2[1]*f),
    Math.round(c1[2]*(1-f)+c2[2]*f),
  ];

  // horizon glow band across the lower third — deep violet fading up in the dark, warm dawn/dusk
  // gradient in the light — gives the arena a sense of depth beyond the flat grid
  ctx.save();
  const horizonCol = lerp3(colDarkB, colLight, light);
  const bandGrad = ctx.createLinearGradient(0, b.y+b.h*0.55, 0, b.y+b.h);
  bandGrad.addColorStop(0, `rgba(${horizonCol[0]},${horizonCol[1]},${horizonCol[2]},0)`);
  bandGrad.addColorStop(1, `rgba(${horizonCol[0]},${horizonCol[1]},${horizonCol[2]},${0.05+light*0.07})`);
  ctx.fillStyle = bandGrad;
  ctx.fillRect(b.x, b.y+b.h*0.55, b.w, b.h*0.45);
  ctx.restore();

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // concentric rings, alternating accent color, slowly breathing in opacity — two staggered
  // layers now (offset radii + offset phase) so it reads less like a single flat set of circles
  for(let layer=0; layer<2; layer++){
    const ringCount = 5;
    for(let i=0;i<ringCount;i++){
      const r = 55 + layer*24 + i*68 + Math.sin(t*0.4+i+layer)*4;
      const baseCol = lerp3(i%2===0?colDarkA:colDarkB, colLight, light);
      const alpha = ((0.05 + i*0.012) + light*0.05) * (layer===0?1:0.5);
      ctx.strokeStyle = `rgba(${baseCol[0]},${baseCol[1]},${baseCol[2]},${alpha})`;
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
    }
  }

  // slowly rotating diamond + square, sacred-geometry style
  ctx.save();
  ctx.translate(cx,cy);
  ctx.rotate(t*0.03);
  const s = 150;
  const diamondCol = lerp3(colDarkB, colLight, light);
  ctx.strokeStyle = `rgba(${diamondCol[0]},${diamondCol[1]},${diamondCol[2]},${0.06+light*0.06})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0,-s); ctx.lineTo(s,0); ctx.lineTo(0,s); ctx.lineTo(-s,0); ctx.closePath();
  ctx.stroke();
  ctx.rotate(Math.PI/4);
  ctx.strokeStyle = `rgba(255,255,255,${0.03+light*0.04})`;
  ctx.strokeRect(-s*0.62,-s*0.62,s*1.24,s*1.24);
  ctx.restore();

  // radiating lines from center, faint — more of them and brighter the closer to the Sun
  const rayCount = isSunFloor ? 16 : 8;
  const rayCol = lerp3(colDarkA, colLight, light);
  for(let i=0;i<rayCount;i++){
    const ang = (i/rayCount)*Math.PI*2 + t*0.02;
    const rr = Math.max(b.w,b.h)*0.6;
    ctx.strokeStyle = `rgba(${rayCol[0]},${rayCol[1]},${rayCol[2]},${0.03+light*0.05})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(ang)*60, cy+Math.sin(ang)*60);
    ctx.lineTo(cx+Math.cos(ang)*rr, cy+Math.sin(ang)*rr);
    ctx.stroke();
  }

  // drifting ambient motes — cool sparks in the dark, warm light-dust nearer the Sun
  const motes = getAscensoMotes(b);
  const moteCol = lerp3(colDarkA, colLight, light);
  motes.forEach(m=>{
    const twinkle = 0.4+0.6*Math.abs(Math.sin(t*0.8+m.phase));
    const yOff = ((t*m.speed + m.phase*20) % (b.h+40)) - 20;
    const mx = b.x + m.fx*b.w + Math.sin(t*0.3+m.phase)*m.drift;
    const my = b.y + ((m.fy*b.h - yOff) % b.h + b.h) % b.h;
    ctx.globalAlpha = (0.15+light*0.2) * twinkle;
    ctx.fillStyle = `rgb(${moteCol[0]},${moteCol[1]},${moteCol[2]})`;
    ctx.beginPath(); ctx.arc(mx,my,m.size,0,Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha = 1;

  ctx.restore();

  // the Sun's own floor gets one extra bright core glow behind everything else, gold/white
  if(isSunFloor){
    ctx.save();
    const pulse = 0.5+Math.sin(t*1.4)*0.5;
    const glow = ctx.createRadialGradient(cx,cy,10,cx,cy,Math.max(b.w,b.h)*0.5);
    glow.addColorStop(0, `rgba(255,243,196,${0.10+pulse*0.05})`);
    glow.addColorStop(1, 'rgba(255,243,196,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }
}

function drawArena(b){
  const stage = game.currentStage;
  const theme = ZONE_THEMES[stage ? stage.key : 'cripta'] || ZONE_THEMES.cripta;
  const isFinal = !!(stage && stage.floor === TOWER_MAX_FLOOR);
  const decor = game.arenaDecor;

  const bgGrad = ctx.createLinearGradient(b.x,b.y,b.x,b.y+b.h);
  bgGrad.addColorStop(0, isFinal ? '#3a1a20' : theme.top);
  bgGrad.addColorStop(1, isFinal ? '#180a0e' : theme.bottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(b.x,b.y,b.w,b.h);

  // soft organic terrain blobs — patches of lighter/darker ground tone so the floor reads as
  // uneven natural terrain instead of one flat color
  if(decor && decor.terrain){
    ctx.save();
    decor.terrain.forEach(t=>{
      const tg = ctx.createRadialGradient(t.x,t.y,0,t.x,t.y,t.r);
      const c = t.dark ? theme.terrainB : theme.terrainA;
      tg.addColorStop(0, c); tg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = t.a;
      ctx.fillStyle = tg;
      ctx.beginPath(); ctx.arc(t.x,t.y,t.r,0,Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }

  ctx.strokeStyle = theme.grid;
  ctx.lineWidth=1;
  const grid=40;
  for(let x=b.x; x<b.x+b.w; x+=grid){
    ctx.beginPath(); ctx.moveTo(x,b.y); ctx.lineTo(x,b.y+b.h); ctx.stroke();
  }
  for(let y=b.y; y<b.y+b.h; y+=grid){
    ctx.beginPath(); ctx.moveTo(b.x,y); ctx.lineTo(b.x+b.w,y); ctx.stroke();
  }

  // background landmark structure — drawn early so props and gameplay elements always read on top
  if(decor && decor.landmark){
    drawArenaLandmark(theme.landmark, decor.landmark, theme);
  }

  // Descenso: a faint theme-colored accent glow behind the action, echoing the Ascenso mandola's
  // sense of atmosphere without needing per-zone prop art — cheap, subtle, always-on ambiance
  if(!game.ascenso){
    ctx.save();
    const cx = b.x+b.w/2, cy = b.y+b.h/2;
    const pulse = 0.5+Math.sin(performance.now()/1400)*0.5;
    const accentGlow = ctx.createRadialGradient(cx,cy,10,cx,cy,Math.max(b.w,b.h)*0.55);
    accentGlow.addColorStop(0, hexToRgba(theme.decorColor, 0.05+pulse*0.03));
    accentGlow.addColorStop(1, hexToRgba(theme.decorColor, 0));
    ctx.fillStyle = accentGlow;
    ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }

  // filled ground patches (puddles, cracks, frost...), then standing props on top of them
  if(decor && decor.patches){
    decor.patches.forEach(p2=> drawArenaSecondaryPatch(secondaryDecorFor(theme.decor), p2, theme.secondaryColor));
  }
  if(decor && decor.items){
    decor.items.forEach(item=> drawArenaDecorItem(theme.decor, item, theme.decorColor));
  }

  // floor 100 gets an extra, more ceremonial treatment on top of the throne zone's usual theme
  if(isFinal){
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffcb47';
    const pillarW = 10;
    ctx.fillRect(b.x+18, b.y, pillarW, b.h);
    ctx.fillRect(b.x+b.w-18-pillarW, b.y, pillarW, b.h);
    ctx.restore();
    const glow = ctx.createRadialGradient(b.x+b.w/2,b.y+b.h/2,10,b.x+b.w/2,b.y+b.h/2,Math.max(b.w,b.h)*0.55);
    glow.addColorStop(0,'rgba(255,203,71,0.12)');
    glow.addColorStop(1,'rgba(255,203,71,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(b.x,b.y,b.w,b.h);
  }

  // Ascenso: the whole tower brightens gradually from pure darkness (floor 1) toward the light
  // (floor 100). Used to be a single flat rect at up to 0.8 alpha, which washed the mandala
  // underneath out into "just yellow" near the Sun — now a radial glow (reads as light gathering
  // toward a source rather than a flat tint) plus a much weaker flat warm wash underneath.
  if(game.ascenso){
    drawAscensoMandala(b);
    ctx.save();
    const lightAmt = (game.ascensoLight||0);
    const glowGrad = ctx.createRadialGradient(b.x+b.w/2, b.y+b.h*0.42, 10, b.x+b.w/2, b.y+b.h*0.42, Math.max(b.w,b.h)*0.75);
    glowGrad.addColorStop(0, `rgba(255,246,214,${lightAmt*0.55})`);
    glowGrad.addColorStop(0.55, `rgba(255,224,150,${lightAmt*0.22})`);
    glowGrad.addColorStop(1, 'rgba(255,203,71,0)');
    ctx.fillStyle = glowGrad;
    ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.globalAlpha = lightAmt*0.18;
    ctx.fillStyle = '#fff3c4';
    ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.restore();
  }

  ctx.strokeStyle = isFinal ? '#ffcb47' : theme.border;
  ctx.lineWidth = isFinal ? 4 : 3;
  ctx.strokeRect(b.x,b.y,b.w,b.h);
  // vignette
  const grad = ctx.createRadialGradient(b.x+b.w/2,b.y+b.h/2,Math.min(b.w,b.h)*0.2,b.x+b.w/2,b.y+b.h/2,Math.max(b.w,b.h)*0.7);
  grad.addColorStop(0,'rgba(0,0,0,0)');
  grad.addColorStop(1, isFinal ? 'rgba(20,0,10,0.6)' : 'rgba(0,0,0,0.55)');
  ctx.fillStyle=grad;
  ctx.fillRect(b.x,b.y,b.w,b.h);
  // Altar de Corrupción: a tight, player-centered fog while cursed — vision drops hard, on top of
  // (not instead of) the room's normal vignette above
  if(game.player.corruptionCurse){
    const p = game.player;
    const fog = ctx.createRadialGradient(p.x,p.y,90,p.x,p.y,340);
    fog.addColorStop(0,'rgba(10,4,16,0)');
    fog.addColorStop(1,'rgba(6,2,10,0.94)');
    ctx.fillStyle = fog;
    ctx.fillRect(b.x,b.y,b.w,b.h);
  }
}

function drawPortal(portal){
  portal.pulse += 0.04;
  const t = performance.now()/500;
  const R = 34 + Math.sin(portal.pulse)*4;
  ctx.save();
  ctx.translate(portal.x, portal.y);
  const grad = ctx.createRadialGradient(0,0,2,0,0,R+26);
  grad.addColorStop(0,'rgba(106,141,255,0.55)');
  grad.addColorStop(0.6,'rgba(210,74,255,0.35)');
  grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0,0,R+26,0,Math.PI*2); ctx.fill();
  for(let ring=0; ring<3; ring++){
    ctx.save();
    ctx.rotate(t*(ring%2?1:-1)*(0.6+ring*0.2));
    ctx.strokeStyle = ring===1?'#d24aff':'#6a8dff';
    ctx.lineWidth=2;
    ctx.setLineDash([6,8]);
    ctx.beginPath(); ctx.ellipse(0,0,R-ring*7,(R-ring*7)*0.9,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  ctx.setLineDash([]);
  ctx.fillStyle='#ece2cf';
  ctx.font='22px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('◈', 0, 1);
  ctx.restore();
  if(Math.random()<0.5){
    const ang = Math.random()*Math.PI*2;
    game.particles.push({ x:portal.x+Math.cos(ang)*(R+20), y:portal.y+Math.sin(ang)*(R+20),
      vx:-Math.cos(ang)*60, vy:-Math.sin(ang)*60, life:0.5, maxLife:0.5, color:'#6a8dff', r:2, type:'circle' });
  }
}

const HAZARD_COLORS = {
  fire:   { ring:'rgba(255,90,61,0.7)',   fillA:'rgba(255,138,61,0.55)', fillB:'rgba(255,90,61,0.05)' },
  poison: { ring:'rgba(139,255,107,0.7)', fillA:'rgba(139,255,107,0.45)', fillB:'rgba(139,255,107,0.05)' },
  spike:  { ring:'rgba(217,205,179,0.8)', fillA:'rgba(217,205,179,0.55)', fillB:'rgba(217,205,179,0.05)' },
  ice:    { ring:'rgba(159,216,255,0.8)', fillA:'rgba(159,216,255,0.55)', fillB:'rgba(159,216,255,0.05)' },
  storm:  { ring:'rgba(255,224,90,0.8)',  fillA:'rgba(255,224,90,0.55)',  fillB:'rgba(255,224,90,0.05)' },
  void:   { ring:'rgba(138,90,217,0.8)',  fillA:'rgba(138,90,217,0.55)',  fillB:'rgba(138,90,217,0.05)' },
  light:  { ring:'rgba(255,179,236,0.8)', fillA:'rgba(255,179,236,0.55)', fillB:'rgba(255,179,236,0.05)' },
  solar:  { ring:'rgba(255,224,140,0.9)', fillA:'rgba(255,236,180,0.6)', fillB:'rgba(255,224,140,0.08)' },
};
function drawHazard(h){
  const c = HAZARD_COLORS[h.type];
  if(!c) return;
  ctx.save();
  if(h.telegraph>0){
    // soft pulsing fill plus marching dashed ring, easier to read at a glance than an empty outline
    const pulse = 0.5+Math.sin(performance.now()/120)*0.15;
    ctx.globalAlpha = 0.16+pulse*0.14;
    ctx.fillStyle = c.ring;
    ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle=c.ring;
    ctx.lineWidth=2;
    ctx.setLineDash([5,5]);
    ctx.lineDashOffset = -performance.now()/40;
    ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  } else if(h.type==='fire'){
    drawFireHazard(h,c);
  } else if(h.type==='poison'){
    drawPoisonHazard(h,c);
  } else if(h.type==='ice'){
    drawCrystalHazard(h,c);
  } else if(h.type==='storm'){
    drawSparkHazard(h,c);
  } else if(h.type==='void'){
    drawVortexHazard(h,c);
  } else {
    // spike, light, solar — the shared fallback silhouette (see drawSpikeHazard for why its
    // spike length is now clamped instead of scaling linearly with h.r)
    drawSpikeHazard(h,c);
  }
  ctx.restore();
}

// crackling pool with licking flames around the rim and rising cinders
function drawFireHazard(h,c){
  const wobble = 1 + Math.sin(performance.now()/150 + h.x)*0.035;
  const r = h.r*wobble;
  const grad = ctx.createRadialGradient(h.x,h.y,2,h.x,h.y,r);
  grad.addColorStop(0,c.fillA);
  grad.addColorStop(1,c.fillB);
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(h.x,h.y,r,0,Math.PI*2); ctx.fill();
  const n=6;
  for(let i=0;i<n;i++){
    const ang = (i/n)*Math.PI*2 + performance.now()/900;
    const flick = 0.6+Math.sin(performance.now()/90+i*1.7)*0.4;
    const fx = h.x+Math.cos(ang)*r*0.72, fy = h.y+Math.sin(ang)*r*0.72;
    ctx.save();
    ctx.translate(fx,fy);
    ctx.rotate(ang+Math.PI/2);
    ctx.globalAlpha = 0.5*flick;
    ctx.fillStyle = '#ffcb47';
    ctx.beginPath();
    ctx.moveTo(0,6);
    ctx.quadraticCurveTo(5,-4-flick*8, 0,-13-flick*9);
    ctx.quadraticCurveTo(-5,-4-flick*8, 0,6);
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(h.x,h.y,r,0,Math.PI*2); ctx.stroke();
  if(Math.random()<0.3){
    const ang = Math.random()*Math.PI*2;
    game.particles.push({ x:h.x+Math.cos(ang)*r*0.6, y:h.y+Math.sin(ang)*r*0.6, vx:rand(-10,10), vy:-42-Math.random()*28,
      life:0.5, maxLife:0.5, color:'#ffcb47', r:1.6, type:'circle' });
  }
}

// bubbling toxic pool with rising bubbles
function drawPoisonHazard(h,c){
  const wobble = 1 + Math.sin(performance.now()/150 + h.x)*0.035;
  const r = h.r*wobble;
  const grad = ctx.createRadialGradient(h.x,h.y,2,h.x,h.y,r);
  grad.addColorStop(0,c.fillA);
  grad.addColorStop(1,c.fillB);
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(h.x,h.y,r,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(h.x,h.y,r,0,Math.PI*2); ctx.stroke();
  const n=5;
  for(let i=0;i<n;i++){
    const seed = i*137.5;
    const bt = ((performance.now()/900)+i/n)%1;
    const bx = h.x+Math.sin(seed+h.x)*r*0.55;
    const by = h.y + r*0.5 - bt*r*0.95;
    ctx.globalAlpha = (1-bt)*0.6;
    ctx.fillStyle = '#c8ffb0';
    ctx.beginPath(); ctx.arc(bx,by, 2+Math.sin(seed)*1.4, 0, Math.PI*2); ctx.fill();
  }
}

// jagged spikes bursting up from the ground instead of a plain filled circle
// spike/light/solar: a burst of short shards clustered around the danger zone. Length is now
// clamped instead of scaling linearly with h.r — this is what was blowing up into a screen-filling
// star on any hazard with a large radius (e.g. Colapso Estelar at r:150).
function drawSpikeHazard(h,c){
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = c.fillB;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.translate(h.x,h.y);
  const n=7;
  const maxLen = Math.min(h.r*0.7, 58);
  for(let i=0;i<n;i++){
    const ang = (i/n)*Math.PI*2 + h.x*0.013;
    const len = maxLen*(0.7+((i%3)*0.12));
    ctx.save();
    ctx.rotate(ang);
    const grad = ctx.createLinearGradient(0,0,0,-len);
    grad.addColorStop(0,c.fillA);
    grad.addColorStop(1,'#ffffff');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-6,0);
    ctx.lineTo(0,-len);
    ctx.lineTo(6,0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.5,0,Math.PI*2); ctx.stroke();
}

// ice: a cluster of faceted crystal shards, clamped the same way as the spikes above
function drawCrystalHazard(h,c){
  ctx.save();
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = c.fillB;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 1;
  ctx.translate(h.x,h.y);
  const n=6;
  const rr = Math.min(h.r*0.55, 46);
  for(let i=0;i<n;i++){
    const ang = (i/n)*Math.PI*2 + h.x*0.01;
    ctx.save();
    ctx.rotate(ang);
    ctx.fillStyle = c.fillA;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0,-rr);
    ctx.lineTo(rr*0.22,-rr*0.3);
    ctx.lineTo(rr*0.14,rr*0.15);
    ctx.lineTo(-rr*0.14,rr*0.15);
    ctx.lineTo(-rr*0.22,-rr*0.3);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.5,0,Math.PI*2); ctx.stroke();
}

// storm: jagged lightning bolts crackling outward instead of solid triangles
function drawSparkHazard(h,c){
  ctx.save();
  ctx.globalAlpha = 0.26;
  ctx.fillStyle = c.fillB;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 0.9;
  ctx.translate(h.x,h.y);
  const n=5;
  const len = Math.min(h.r*0.75, 55);
  for(let i=0;i<n;i++){
    const ang = (i/n)*Math.PI*2 + performance.now()/700 + h.x*0.01;
    ctx.save();
    ctx.rotate(ang);
    ctx.strokeStyle = c.fillA;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round'; ctx.lineJoin='round';
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.lineTo(len*0.35,-len*0.18);
    ctx.lineTo(len*0.55,len*0.12);
    ctx.lineTo(len,-len*0.1);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.5,0,Math.PI*2); ctx.stroke();
}

// void: a swirling vortex of counter-rotating rings pulling toward a dark center — actually fits
// "collapse"/gravity-well flavored attacks, instead of yet another spike burst
function drawVortexHazard(h,c){
  const t = performance.now()/1000;
  ctx.save();
  ctx.globalAlpha = 0.32;
  ctx.fillStyle = c.fillB;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r,0,Math.PI*2); ctx.fill();
  ctx.translate(h.x,h.y);
  const rings=3;
  for(let i=0;i<rings;i++){
    const rr = Math.min(h.r,70) * (0.3+i*0.28);
    ctx.save();
    ctx.rotate(t*(1.4-i*0.3)*(i%2===0?1:-1));
    ctx.strokeStyle = c.fillA;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.55-i*0.12;
    ctx.beginPath(); ctx.arc(0,0,rr,0.4,Math.PI*1.5); ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#0a0416';
  ctx.beginPath(); ctx.arc(0,0,Math.min(h.r*0.22,16),0,Math.PI*2); ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 0.4;
  ctx.strokeStyle = c.ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(h.x,h.y,h.r*0.5,0,Math.PI*2); ctx.stroke();
}

function drawSwing(s){
  const t = clamp(s.life/s.maxLife,0,1);   // 1 -> 0 over the swing's life
  const prog = 1-t;                         // 0 -> 1 as the swing plays out
  const fade = t;
  ctx.save();
  ctx.translate(s.x,s.y);

  // trailing afterimages behind the main slash, giving it a sense of motion/swoosh
  for(let i=3;i>=1;i--){
    const trailAng = s.angle - i*0.1*(1-prog*0.3);
    ctx.save();
    ctx.rotate(trailAng);
    ctx.globalAlpha = fade*0.13*(4-i)/3;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.arc(0,0,s.range,-s.arc,s.arc);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  ctx.rotate(s.angle);

  // core wedge: brighter and sharper near the blade's outer edge instead of a flat fade
  const grad = ctx.createRadialGradient(0,0,s.range*0.35,0,0,s.range);
  grad.addColorStop(0,'rgba(255,255,255,0)');
  grad.addColorStop(0.6, s.color);
  grad.addColorStop(0.88, '#ffffff');
  grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.globalAlpha = fade*0.85;
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0,0);
  ctx.arc(0,0,s.range,-s.arc,s.arc);
  ctx.closePath();
  ctx.fill();

  // crisp white cutting-edge along the outer curve
  ctx.globalAlpha = fade;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0,0,s.range*0.97,-s.arc,s.arc);
  ctx.stroke();

  // colored glow just inside the white edge, for extra punch
  ctx.globalAlpha = fade*0.7;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(0,0,s.range*0.9,-s.arc,s.arc);
  ctx.stroke();

  // small spark flashes where the blade starts and ends its arc
  [-s.arc, s.arc].forEach(a=>{
    const tx = Math.cos(a)*s.range, ty = Math.sin(a)*s.range;
    ctx.globalAlpha = fade*0.9;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(tx,ty,3.2,0,Math.PI*2); ctx.fill();
  });

  ctx.restore();
}

function drawSacrificeAltar(a){
  ctx.save();
  ctx.globalAlpha = a.used?0.3:1;
  a.pulse += 0.03;
  const r = 22+Math.sin(a.pulse)*4;
  const grad = ctx.createRadialGradient(a.x,a.y,3,a.x,a.y,r+22);
  grad.addColorStop(0,'rgba(232,67,79,0.45)');
  grad.addColorStop(1,'rgba(232,67,79,0)');
  ctx.fillStyle=grad;
  ctx.beginPath(); ctx.arc(a.x,a.y,r+22,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#e8434f'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(a.x,a.y,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='#e8434f'; ctx.font='18px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('♦', a.x, a.y);
  ctx.restore();
}
function drawCorruptionAltar(a){
  ctx.save();
  ctx.globalAlpha = a.used?0.3:1;
  a.pulse += 0.035;
  const r = 23+Math.sin(a.pulse)*5;
  const grad = ctx.createRadialGradient(a.x,a.y,3,a.x,a.y,r+26);
  grad.addColorStop(0,'rgba(122,47,191,0.5)');
  grad.addColorStop(1,'rgba(122,47,191,0)');
  ctx.fillStyle=grad;
  ctx.beginPath(); ctx.arc(a.x,a.y,r+26,0,Math.PI*2); ctx.fill();
  // jagged crown, distinguishes it from the round sacrifice altar at a glance
  ctx.strokeStyle='#7a2fbf'; ctx.lineWidth=2;
  ctx.beginPath();
  for(let i=0;i<8;i++){
    const ang = (i/8)*Math.PI*2;
    const rr = r*(i%2===0?1:0.7);
    const x=a.x+Math.cos(ang)*rr, y=a.y+Math.sin(ang)*rr;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle='#7a2fbf'; ctx.font='18px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('👑', a.x, a.y);
  ctx.restore();
}

function drawMerchant(m){
  ctx.save();
  ctx.globalAlpha = m.chosen?0.4:1;
  m.pulse += 0.025;
  const r = 24+Math.sin(m.pulse)*3;
  const grad = ctx.createRadialGradient(m.x,m.y,3,m.x,m.y,r+26);
  grad.addColorStop(0,'rgba(255,203,71,0.4)');
  grad.addColorStop(1,'rgba(255,203,71,0)');
  ctx.fillStyle=grad;
  ctx.beginPath(); ctx.arc(m.x,m.y,r+26,0,Math.PI*2); ctx.fill();
  ctx.strokeStyle='#ffcb47'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(m.x,m.y,r,0,Math.PI*2); ctx.stroke();
  ctx.fillStyle='#ffcb47'; ctx.font='20px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('⚖', m.x, m.y);
  ctx.restore();
}

function drawAltar(a){
  a.pulse += 0.03;
  const glowR = 26+Math.sin(a.pulse)*5;
  ctx.save();
  ctx.globalAlpha = a.active?1:0.35;
  const grad = ctx.createRadialGradient(a.x,a.y,4,a.x,a.y,glowR+30);
  grad.addColorStop(0,'rgba(210,74,255,0.5)');
  grad.addColorStop(1,'rgba(210,74,255,0)');
  ctx.fillStyle=grad;
  ctx.beginPath(); ctx.arc(a.x,a.y,glowR+30,0,7); ctx.fill();
  ctx.strokeStyle='#d24aff';
  ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(a.x,a.y,glowR,0,Math.PI*2); ctx.stroke();
  ctx.setLineDash([4,6]);
  ctx.beginPath(); ctx.arc(a.x,a.y,glowR+10,a.pulse,a.pulse+Math.PI*1.5); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#ece2cf';
  ctx.font='20px serif';
  ctx.textAlign='center'; ctx.textBaseline='middle';
  ctx.fillText('☥', a.x, a.y);
  ctx.restore();
}

function drawChest(c){
  const t = CHEST_TIERS[c.tier];
  if(c.opened){
    ctx.save(); ctx.globalAlpha=0.28;
    ctx.fillStyle=t.wood; ctx.strokeStyle=t.color; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.rect(c.x-14,c.y-6,28,14); ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  const bob = Math.sin(performance.now()/420+c.bob)*3;
  const scale = c.radius/18;
  const pulse = 0.5+Math.sin(performance.now()/500+c.bob)*0.5;
  ctx.save();
  ctx.translate(c.x, c.y+bob);
  ctx.scale(scale, scale);

  // ambient glow halo (rare/epic)
  if(c.tier!=='common'){
    const haloR = 34 + pulse*(c.tier==='epic'?14:8);
    const grad = ctx.createRadialGradient(0,0,4,0,0,haloR);
    grad.addColorStop(0, t.glow);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle=grad;
    ctx.beginPath(); ctx.arc(0,0,haloR,0,Math.PI*2); ctx.fill();
  }
  // epic: rotating rays behind chest
  if(c.tier==='epic'){
    ctx.save();
    ctx.rotate(performance.now()/2600);
    ctx.strokeStyle='rgba(210,74,255,0.25)';
    ctx.lineWidth=2;
    for(let i=0;i<6;i++){
      ctx.save(); ctx.rotate((i/6)*Math.PI*2);
      ctx.beginPath(); ctx.moveTo(0,-20); ctx.lineTo(0,-40); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // base / lid
  ctx.fillStyle = t.wood;
  ctx.strokeStyle = t.color;
  ctx.lineWidth = 2.2;
  ctx.beginPath(); ctx.rect(-16,-10,32,20); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-16,-10); ctx.quadraticCurveTo(0,-27,16,-10); ctx.closePath(); ctx.fill(); ctx.stroke();

  // metal bands
  ctx.strokeStyle = c.tier==='epic' ? '#ffcb47' : (c.tier==='rare' ? '#c9d4ff' : '#8a7a5a');
  ctx.lineWidth = c.tier==='common' ? 1.4 : 2;
  ctx.beginPath(); ctx.moveTo(-4,-10); ctx.lineTo(-4,10); ctx.moveTo(4,-10); ctx.lineTo(4,10); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-16,-10); ctx.quadraticCurveTo(0,-24,0,-10); ctx.stroke();

  // lock / gem
  if(c.tier==='common'){
    ctx.fillStyle='#8a7a5a';
    ctx.fillRect(-4,-4,8,7);
  } else {
    const gemPulse = 3+pulse*2;
    ctx.fillStyle = t.color;
    ctx.shadowColor = t.color; ctx.shadowBlur = 10+pulse*8;
    ctx.beginPath();
    ctx.moveTo(0,-8-gemPulse*0.3); ctx.lineTo(5,-8); ctx.lineTo(0,-3); ctx.lineTo(-5,-8); ctx.closePath();
    ctx.fill();
    ctx.shadowBlur=0;
  }
  ctx.restore();

  // label + cost (unscaled, above chest)
  ctx.save();
  ctx.translate(c.x, c.y+bob);
  ctx.textAlign='center';
  ctx.font = (c.tier==='epic'?'700 11px':'600 10px') + " 'JetBrains Mono', monospace";
  ctx.fillStyle = t.color;
  ctx.shadowColor = t.color; ctx.shadowBlur = c.tier==='common'?0:6;
  ctx.fillText(t.label.toUpperCase(), 0, -34*scale-6);
  ctx.shadowBlur=0;
  ctx.fillStyle = '#ffcb47';
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillText(c.cost+'◆', 0, 30*scale);
  ctx.restore();
}

function drawGold(g){
  if(g.seed===undefined) g.seed = Math.random()*10;
  const spin = Math.sin(performance.now()/260 + g.seed);
  const scaleX = 0.35 + Math.abs(spin)*0.65;
  ctx.save();
  ctx.translate(g.x, g.y);
  ctx.scale(scaleX, 1);
  const grad = ctx.createRadialGradient(-2,-2,1, 0,0,7);
  grad.addColorStop(0,'#fff3c4');
  grad.addColorStop(0.55,'#ffcb47');
  grad.addColorStop(1,'#a8760f');
  ctx.fillStyle = grad;
  ctx.shadowColor='#ffcb47'; ctx.shadowBlur=7;
  ctx.beginPath(); ctx.arc(0,0,7,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#8a5a10'; ctx.lineWidth=1; ctx.stroke();
  if(scaleX>0.7){
    ctx.strokeStyle='rgba(138,90,16,0.6)'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.arc(0,0,4,0,Math.PI*2); ctx.stroke();
  }
  ctx.restore();
}

function drawEnemy(en){
  // telegraphs drawn in world space, before the local translate below
  if(en.def.charger && en.chargeState==='windup'){
    const prog = 1 - clamp(en.chargeTimer/en.def.chargeWindup, 0, 1);
    const p = game.player;
    ctx.save();
    ctx.strokeStyle = en.def.color;
    ctx.globalAlpha = 0.35+prog*0.4;
    ctx.lineWidth = 3;
    ctx.setLineDash([4,8]);
    ctx.beginPath(); ctx.moveTo(en.x,en.y); ctx.lineTo(p.x,p.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  if(en.def.chargeShot && en.aiming){
    const prog = 1 - clamp(en.aimTimer/en.def.chargeShotWindup, 0, 1);
    const p = game.player;
    ctx.save();
    ctx.strokeStyle = '#ffb3ec';
    ctx.globalAlpha = 0.25+prog*0.55;
    ctx.lineWidth = 2;
    ctx.setLineDash([2,6]);
    ctx.beginPath(); ctx.moveTo(en.x,en.y); ctx.lineTo(p.x,p.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(en.x,en.y);
  if(en.def.erratic) ctx.globalAlpha = 0.72;
  if(en.isElite){
    ctx.shadowColor='#ffd54a'; ctx.shadowBlur=16;
  }
  // shared "creature" silhouette for every common enemy — a slightly notched blob instead of a
  // bare circle, plus a pair of dark eye-slits, cheap enough to draw for a whole screen of them
  const r = en.radius;
  ctx.fillStyle = en.hitFlash>0 ? '#ffffff' : en.def.color;
  ctx.beginPath();
  ctx.moveTo(0,-r);
  ctx.quadraticCurveTo(r*0.9,-r*0.7, r*0.95,0);
  ctx.quadraticCurveTo(r*0.9, r*0.65, r*0.35, r*0.95);
  ctx.quadraticCurveTo(0, r*1.05, -r*0.35, r*0.95);
  ctx.quadraticCurveTo(-r*0.9, r*0.65, -r*0.95, 0);
  ctx.quadraticCurveTo(-r*0.9,-r*0.7, 0,-r);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle = en.isElite ? '#ffd54a' : 'rgba(0,0,0,0.4)';
  ctx.lineWidth = en.isElite ? 3 : 2;
  ctx.stroke();
  ctx.fillStyle = 'rgba(10,7,16,0.85)';
  ctx.beginPath();
  ctx.ellipse(-r*0.28,-r*0.12, r*0.14, r*0.18, -0.3, 0, Math.PI*2);
  ctx.ellipse(r*0.28,-r*0.12, r*0.14, r*0.18, 0.3, 0, Math.PI*2);
  ctx.fill();
  if(en.armorHp>0){
    ctx.strokeStyle='rgba(200,200,215,0.85)';
    ctx.lineWidth=2;
    ctx.setLineDash([4,3]);
    ctx.beginPath(); ctx.arc(0,0,en.radius+4,0,Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if(en.bleedTimer>0){
    ctx.strokeStyle='rgba(201,56,74,0.7)';
    ctx.globalAlpha = 0.5+Math.sin(performance.now()/140)*0.25;
    ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(0,0,en.radius+3,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if(en.stunTimer>0){
    // small dizzy stars orbiting overhead — the classic "stunned" tell
    const st = performance.now()/300;
    ctx.fillStyle='#ffe07a'; ctx.globalAlpha=0.9;
    for(let i=0;i<3;i++){
      const a = st + (i/3)*Math.PI*2;
      const sx = Math.cos(a)*en.radius*0.7, sy = -en.radius-9+Math.sin(a)*3;
      ctx.save(); ctx.translate(sx,sy); ctx.rotate(a);
      ctx.beginPath();
      for(let k=0;k<4;k++){ const ka=(k/4)*Math.PI*2; ctx.lineTo(Math.cos(ka)*3, Math.sin(ka)*3); ctx.lineTo(Math.cos(ka+Math.PI/4)*1.2, Math.sin(ka+Math.PI/4)*1.2); }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha=1;
  } else if(en.slowTimer>0){
    // slow drip icicles trailing below — distinct from bleed's ring, no ring here at all
    ctx.fillStyle='rgba(159,216,255,0.75)';
    for(let i=-1;i<=1;i++){
      ctx.beginPath();
      ctx.moveTo(i*en.radius*0.4-2, en.radius*0.5);
      ctx.lineTo(i*en.radius*0.4+2, en.radius*0.5);
      ctx.lineTo(i*en.radius*0.4, en.radius*0.5+7);
      ctx.closePath(); ctx.fill();
    }
  }
  if(en.plagueTimer>0){
    // sickly spores drifting upward off the body
    const pt = performance.now()/260;
    ctx.fillStyle='rgba(122,209,74,0.7)';
    for(let i=0;i<3;i++){
      const off = (pt+i*1.7)%1;
      const sx = (i-1)*en.radius*0.5;
      const sy = en.radius*0.5 - off*en.radius*1.6;
      ctx.globalAlpha = (1-off)*0.8;
      ctx.beginPath(); ctx.arc(sx,sy,2,0,Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha=1;
  }
  if(en.weakenMarkTimer>0){
    // a small red crosshair marking it as a priority target
    ctx.strokeStyle='rgba(232,67,79,0.85)'; ctx.lineWidth=1.6;
    const mr = en.radius+8;
    ctx.beginPath(); ctx.arc(0,-mr,3,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-3,-mr); ctx.lineTo(3,-mr); ctx.moveTo(0,-mr-3); ctx.lineTo(0,-mr+3); ctx.stroke();
  }
  if(en.def.healer){
    ctx.strokeStyle='rgba(90,217,138,0.55)';
    ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.arc(0,0,en.radius+5,0,Math.PI*2); ctx.stroke();
  }
  // hp bar
  const w=en.radius*2;
  ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(-w/2,-en.radius-12,w,4);
  ctx.fillStyle = en.isElite ? '#ffd54a' : '#e8434f';
  ctx.fillRect(-w/2,-en.radius-12,w*clamp(en.hp/en.maxHp,0,1),4);
  ctx.restore();
}

function drawBossMovers(movers){
  movers.forEach(mv=>{
    if(!mv.alive) return;
    if(mv.spawnDelay>0){
      // ground-crack warning before this lane's boulder actually arrives
      if(mv.warnY!==undefined){
        ctx.save();
        const pulse = 0.5+Math.sin(performance.now()/130)*0.5;
        ctx.globalAlpha = 0.25+pulse*0.35;
        ctx.strokeStyle = '#ff3d3d'; ctx.lineWidth = 4;
        ctx.setLineDash([10,7]);
        ctx.beginPath(); ctx.moveTo(mv.warnFromLeft? mv.x+40 : mv.x-40, mv.warnY);
        ctx.lineTo(mv.warnFromLeft? mv.x+220 : mv.x-220, mv.warnY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
      return;
    }
    ctx.save();
    ctx.globalAlpha = mv.breakable ? 0.95 : 0.9;
    const grad = ctx.createRadialGradient(mv.x,mv.y,4,mv.x,mv.y,mv.radius);
    grad.addColorStop(0, mv.breakable?'#dff3ff':'#c8ecff');
    grad.addColorStop(1, mv.breakable?'#8ec9ff':'#9fd8ff');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(mv.x,mv.y,mv.radius,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(mv.x,mv.y,mv.radius,0,Math.PI*2); ctx.stroke();
    if(mv.breakable){
      const hpFrac = clamp(mv.hp/mv.maxHp,0,1);
      ctx.fillStyle = 'rgba(6,4,10,0.7)';
      ctx.fillRect(mv.x-mv.radius, mv.y-mv.radius-12, mv.radius*2, 5);
      ctx.fillStyle = '#8ec9ff';
      ctx.fillRect(mv.x-mv.radius, mv.y-mv.radius-12, mv.radius*2*hpFrac, 5);
    }
    if(mv.hitFlash>0){ ctx.globalAlpha=mv.hitFlash*3; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(mv.x,mv.y,mv.radius,0,Math.PI*2); ctx.fill(); }
    ctx.restore();
  });
}

function drawBossCores(cores){
  cores.forEach(c=>{
    ctx.save();
    const pulse = 0.6+Math.sin(performance.now()/180)*0.4;
    const grad = ctx.createRadialGradient(c.x,c.y,2,c.x,c.y,c.radius+14);
    grad.addColorStop(0, 'rgba(142,201,255,0.55)');
    grad.addColorStop(1, 'rgba(142,201,255,0)');
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.5+pulse*0.3;
    ctx.beginPath(); ctx.arc(c.x,c.y,c.radius+14,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#8ec9ff';
    ctx.beginPath(); ctx.arc(c.x,c.y,c.radius,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c.x,c.y,c.radius,0,Math.PI*2); ctx.stroke();
    // tiny HP bar so it reads as "breakable" rather than just decorative
    const hpFrac = clamp(c.hp/c.maxHp,0,1);
    ctx.fillStyle = 'rgba(6,4,10,0.7)';
    ctx.fillRect(c.x-c.radius, c.y-c.radius-10, c.radius*2, 5);
    ctx.fillStyle = '#8ec9ff';
    ctx.fillRect(c.x-c.radius, c.y-c.radius-10, c.radius*2*hpFrac, 5);
    if(c.hitFlash>0){ ctx.globalAlpha=c.hitFlash*3; ctx.fillStyle='#fff'; ctx.beginPath(); ctx.arc(c.x,c.y,c.radius,0,Math.PI*2); ctx.fill(); }
    ctx.restore();
  });
}

function drawClosingBarrier(boss){
  const b = arenaBounds();
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = '#fff05a';
  ctx.lineWidth = 14;
  ctx.beginPath(); ctx.moveTo(boss.barrierLeftX,b.y); ctx.lineTo(boss.barrierLeftX,b.y+b.h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(boss.barrierRightX,b.y); ctx.lineTo(boss.barrierRightX,b.y+b.h); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(boss.barrierLeftX,b.y); ctx.lineTo(boss.barrierLeftX,b.y+b.h); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(boss.barrierRightX,b.y); ctx.lineTo(boss.barrierRightX,b.y+b.h); ctx.stroke();
  ctx.restore();
}
function drawBossTelegraphIndicator(boss){
  const tg = boss.telegraph;
  if(!tg) return;
  const prog = 1 - clamp(tg.t/tg.dur, 0, 1); // 0 -> 1 as the wind-up completes
  const p = game.player;
  const color = boss.def.color;
  const b = arenaBounds();

  if(tg.type==='boneGrab'){
    const windProg = clamp((tg.elapsed||0)/(tg.rampDur||3.2), 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.05+windProg*0.12;
    ctx.fillStyle = color;
    ctx.fillRect(b.x,b.y,b.w,b.h);
    ctx.restore();
    // the safe pocket now gets an explicit hollow ring marker — a real, readable dodge target
    // instead of only being noticeable as "the one spot the wind particles don't reach"
    if(tg.safeX!==undefined){
      ctx.save();
      const pulse = 0.55+Math.sin(performance.now()/180)*0.25;
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = '#8bff6b';
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(tg.safeX,tg.safeY,tg.safeR,0,Math.PI*2); ctx.stroke();
      ctx.globalAlpha = pulse*0.5;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(tg.safeX,tg.safeY,tg.safeR*0.6,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }
    // streaking wind particles drifting toward the boss, arena-wide — skipped inside the safe
    // pocket so it visibly sits calmer than everywhere else, on top of the explicit ring above
    if(Math.random()<0.6){
      const ang0 = Math.random()*Math.PI*2;
      const rr = 60+Math.random()*Math.max(b.w,b.h)*0.6;
      const sx = clamp(boss.x+Math.cos(ang0)*rr, b.x+4, b.x+b.w-4);
      const sy = clamp(boss.y+Math.sin(ang0)*rr, b.y+4, b.y+b.h-4);
      const insideSafe = tg.safeX!==undefined && dist(tg.safeX,tg.safeY,sx,sy) < tg.safeR;
      if(!insideSafe){
        game.particles.push({ x:sx, y:sy, vx:(boss.x-sx)*0.9, vy:(boss.y-sy)*0.9,
          life:0.4, maxLife:0.4, color, r:1.6, type:'circle' });
      }
    }
  } else if(tg.type==='infiniteReflections'){
    // every position looks like the boss — the only readable difference is glow strength, real
    // pulsing bright, decoys staying dim. No other tell before they all fire together.
    (tg.reflectPositions||[]).forEach(pos=>{
      const pulse = 0.6+Math.sin(performance.now()/140)*0.4;
      const alpha = pos.real ? 0.35+pulse*0.4 : 0.10+pulse*0.08;
      ctx.save();
      ctx.globalAlpha = alpha;
      const grad = ctx.createRadialGradient(pos.x,pos.y,4,pos.x,pos.y,boss.radius+20);
      grad.addColorStop(0, pos.real?'rgba(232,232,245,0.9)':'rgba(120,120,140,0.6)');
      grad.addColorStop(1, 'rgba(120,120,140,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(pos.x,pos.y,boss.radius+20,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha = Math.min(1,alpha+0.25);
      ctx.fillStyle = pos.real?'#e8e8f5':'#6a6a7a';
      ctx.beginPath(); ctx.arc(pos.x,pos.y,boss.radius*0.8,0,Math.PI*2); ctx.fill();
      ctx.restore();
    });
  } else if(tg.type==='megaLaser'){
    // preview fan while charging, then a hard bright sweeping beam once it goes hot — drawn for
    // both origins if the twin sister is still alive
    const elapsedL = tg.dur - tg.t;
    const drawOrigin = (originX, originY, startAngle)=>{
      ctx.save();
      ctx.translate(originX, originY);
      if(elapsedL <= tg.hotAt){
        // preview: a soft fan showing the full sweep range so you can plan where to end up
        ctx.globalAlpha = 0.12+0.1*Math.sin(performance.now()/120);
        ctx.fillStyle = '#ff3d3d';
        ctx.beginPath();
        ctx.moveTo(0,0);
        ctx.arc(0,0, tg.beamLen, startAngle, startAngle+tg.sweepDir*tg.sweepArc, tg.sweepDir<0);
        ctx.closePath();
        ctx.fill();
      } else {
        const sweepProg = clamp((elapsedL-tg.hotAt)/(tg.dur-tg.hotAt), 0, 1);
        const curAngle = startAngle + tg.sweepDir*tg.sweepArc*sweepProg;
        ctx.rotate(curAngle);
        ctx.globalAlpha = 0.85;
        ctx.strokeStyle = '#ff3d3d';
        ctx.lineWidth = 10;
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(tg.beamLen,0); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(tg.beamLen,0); ctx.stroke();
      }
      ctx.restore();
    };
    drawOrigin(boss.x, boss.y, tg.startAngle);
    if(boss.twin && boss.twin.alive && tg.twinStartAngle!==undefined){
      drawOrigin(boss.twin.x, boss.twin.y, tg.twinStartAngle);
    }
  } else if(tg.type==='geoSweep'){
    // twin parallel magenta walls with a visible gap between them — preview both starting
    // lines while charging, then the two thick moving walls with the safe gap left dark
    const elapsedG = tg.dur - tg.t;
    if(elapsedG <= tg.hotAt){
      ctx.save();
      ctx.globalAlpha = 0.35+0.25*Math.sin(performance.now()/110);
      ctx.strokeStyle = '#ff2fd6'; ctx.lineWidth = 6;
      const lx = tg.fromStart ? b.x+6 : b.x+b.w-6;
      ctx.beginPath(); ctx.moveTo(lx,b.y); ctx.lineTo(lx,b.y+b.h); ctx.stroke();
      ctx.restore();
    } else if(tg.curPos!==undefined){
      const gapHalf = tg.gap/2;
      [tg.curPos-gapHalf, tg.curPos+gapHalf].forEach(wallX=>{
        ctx.save();
        ctx.shadowColor = '#ff2fd6'; ctx.shadowBlur = 18;
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ff2fd6'; ctx.lineWidth = 22;
        ctx.beginPath(); ctx.moveTo(wallX,b.y); ctx.lineTo(wallX,b.y+b.h); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 6;
        ctx.beginPath(); ctx.moveTo(wallX,b.y); ctx.lineTo(wallX,b.y+b.h); ctx.stroke();
        ctx.restore();
      });
      // a faint cyan marker line down the middle of the safe gap — the "aim here" cue
      ctx.save();
      ctx.globalAlpha = 0.4+0.2*Math.sin(performance.now()/140);
      ctx.strokeStyle = '#33e5ff'; ctx.lineWidth = 2;
      ctx.setLineDash([6,8]);
      ctx.beginPath(); ctx.moveTo(tg.curPos,b.y); ctx.lineTo(tg.curPos,b.y+b.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  } else if(tg.type==='stormSpiral'){
    // charging preview: a rotating sacred-geometry glyph at El Sol's position — diamond inside
    // a ring, magenta/cyan — before the spiral itself starts firing (handled in updateBoss)
    const elapsedS3 = tg.dur - tg.t;
    if(elapsedS3 <= tg.hotAt){
      ctx.save();
      ctx.translate(boss.x,boss.y);
      ctx.rotate(performance.now()/260);
      ctx.globalAlpha = 0.5+0.3*Math.sin(performance.now()/120);
      ctx.strokeStyle = '#ff2fd6'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0,0,46,0,Math.PI*2); ctx.stroke();
      ctx.strokeStyle = '#33e5ff'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0,-30); ctx.lineTo(30,0); ctx.lineTo(0,30); ctx.lineTo(-30,0); ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  } else if(tg.type==='eruptionConvergence'){
    // El Sol "se pone blanco brillante" while channeling — a bright expanding white core glow
    ctx.save();
    const pulse = 0.5+Math.sin(performance.now()/90)*0.5;
    ctx.globalAlpha = 0.3+prog*0.4+pulse*0.15;
    const r = 55+prog*45;
    const glow = ctx.createRadialGradient(boss.x,boss.y,4,boss.x,boss.y,r);
    glow.addColorStop(0,'rgba(255,255,255,0.95)');
    glow.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(boss.x,boss.y,r,0,Math.PI*2); ctx.fill();
    ctx.restore();
  } else if(tg.type==='totalCollapse'){
    // Colapso Total: El Sol compresses toward a single blinding point while a countdown ring
    // drains away — the core itself (the small bright center) is what actually needs the damage
    const collProg = boss.supernovaActive ? clamp(1-boss.supernovaTimer/boss.supernovaMaxTimer, 0, 1) : 0;
    const coreR = Math.max(14, boss.radius*(1-collProg*0.7));
    ctx.save();
    // arena edges visually "cracking" — jagged lines creeping in from each corner as time runs out
    ctx.globalAlpha = 0.15+collProg*0.35;
    ctx.strokeStyle = '#ff2fd6';
    ctx.lineWidth = 2;
    const corners = [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]];
    corners.forEach(([cx0,cy0])=>{
      const dirx = cx0<boss.x?1:-1, diry = cy0<boss.y?1:-1;
      ctx.beginPath();
      ctx.moveTo(cx0,cy0);
      let x=cx0,y=cy0;
      for(let k=0;k<4;k++){
        x += dirx*(30+Math.random()*30)*collProg;
        y += diry*(22+Math.random()*22)*collProg;
        ctx.lineTo(x,y);
      }
      ctx.stroke();
    });
    ctx.restore();
    // the shrinking, ever-brighter core — the actual damage target
    ctx.save();
    const pulseC = 0.6+Math.sin(performance.now()/70)*0.4;
    const coreGlow = ctx.createRadialGradient(boss.x,boss.y,2,boss.x,boss.y,coreR*2.2);
    coreGlow.addColorStop(0, `rgba(255,255,255,${0.7+pulseC*0.3})`);
    coreGlow.addColorStop(0.5, 'rgba(255,47,214,0.4)');
    coreGlow.addColorStop(1, 'rgba(255,47,214,0)');
    ctx.fillStyle = coreGlow;
    ctx.beginPath(); ctx.arc(boss.x,boss.y,coreR*2.2,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(boss.x,boss.y,coreR*0.4,0,Math.PI*2); ctx.fill();
    ctx.restore();
    // countdown ring around the core, draining clockwise as the timer runs out
    ctx.save();
    ctx.strokeStyle = '#33e5ff';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(boss.x,boss.y,coreR+18,-Math.PI/2,-Math.PI/2+(1-collProg)*Math.PI*2);
    ctx.stroke();
    ctx.restore();
  } else if(tg.type==='plasmaBeam' || tg.type==='dawnBeam' || tg.type==='voidBeam'){
    // preview: a thin line at the starting edge while charging, then a thick moving wall of light.
    // dawnBeam (El Sol) reuses the exact same mechanic/telegraph, just recolored gold instead of orange.
    const beamColor = tg.type==='dawnBeam' ? '#fff3c4' : tg.type==='voidBeam' ? '#a070c0' : '#ff6a3d';
    const elapsedB = tg.dur - tg.t;
    if(elapsedB <= tg.hotAt){
      ctx.save();
      ctx.globalAlpha = 0.35+0.25*Math.sin(performance.now()/110);
      ctx.strokeStyle = beamColor; ctx.lineWidth = 6;
      ctx.beginPath();
      if(tg.vertical){
        const lx = tg.fromStart ? b.x+6 : b.x+b.w-6;
        ctx.moveTo(lx,b.y); ctx.lineTo(lx,b.y+b.h);
      } else {
        const ly = tg.fromStart ? b.y+6 : b.y+b.h-6;
        ctx.moveTo(b.x,ly); ctx.lineTo(b.x+b.w,ly);
      }
      ctx.stroke();
      ctx.restore();
    } else if(tg.curPos!==undefined){
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = beamColor; ctx.lineWidth = 26;
      ctx.beginPath();
      if(tg.vertical){ ctx.moveTo(tg.curPos,b.y); ctx.lineTo(tg.curPos,b.y+b.h); }
      else { ctx.moveTo(b.x,tg.curPos); ctx.lineTo(b.x+b.w,tg.curPos); }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 8;
      ctx.beginPath();
      if(tg.vertical){ ctx.moveTo(tg.curPos,b.y); ctx.lineTo(tg.curPos,b.y+b.h); }
      else { ctx.moveTo(b.x,tg.curPos); ctx.lineTo(b.x+b.w,tg.curPos); }
      ctx.stroke();
      ctx.restore();
    }
  } else if(tg.type==='gravityWell'){
    // a swirling vortex anchored at a fixed point in space (not on the boss), spinning faster and
    // pulling tighter as it charges — visually distinct from the directional boneGrab cone
    const wx = tg.tx, wy = tg.ty;
    ctx.save();
    ctx.translate(wx,wy);
    ctx.rotate(performance.now()/(260-prog*140));
    for(let k=0;k<3;k++){
      const rr = 14+prog*34-k*8;
      ctx.globalAlpha = (0.22+prog*0.4)*(1-k*0.25);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0,0, Math.max(4,rr), k*0.9, k*0.9+Math.PI*1.3);
      ctx.stroke();
    }
    ctx.restore();
    if(Math.random()<0.4+prog*0.3){
      const ang = Math.random()*Math.PI*2;
      const rr = 40+prog*30;
      game.particles.push({ x:wx+Math.cos(ang)*rr, y:wy+Math.sin(ang)*rr, vx:-Math.cos(ang)*50, vy:-Math.sin(ang)*50,
        life:0.3, maxLife:0.3, color, r:1.8, type:'circle' });
    }
  } else if(tg.type==='magmaCross'){
    const armLen = 58*3*prog;
    ctx.save();
    ctx.translate(boss.x,boss.y);
    ctx.globalAlpha = 0.18+prog*0.32;
    ctx.fillStyle = color;
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
      ctx.fillRect(dx>0?0:(dx<0?-armLen:-24), dy>0?0:(dy<0?-armLen:-24), dx!==0?armLen:48, dy!==0?armLen:48);
    });
    ctx.globalAlpha = 0.5+prog*0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6,6]);
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dx,dy])=>{
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(dx*armLen, dy*armLen); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.restore();
  } else if(tg.type==='blazingFissure'){
    if(tg.fissureVertical===undefined){ tg.fissureVertical = Math.random()<0.5; tg.fissureGap = rand(0.22,0.78); }
    const vertical = tg.fissureVertical, gapFrac = tg.fissureGap;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.2+prog*0.45;
    const segs = 24;
    ctx.beginPath();
    for(let i=0;i<segs;i++){
      const frac = i/(segs-1);
      if(Math.abs(frac-gapFrac) < 0.06) continue; // matches the eventual escape gap
      let x1,y1;
      if(vertical){ x1 = tg.tx; y1 = b.y+30+frac*(b.h-60); }
      else { y1 = tg.ty; x1 = b.x+30+frac*(b.w-60); }
      ctx.moveTo(x1-3,y1); ctx.lineTo(x1+3,y1);
    }
    ctx.stroke();
    ctx.restore();
  } else if(tg.type==='pincerScan'){
    const elapsedPD = tg.dur - tg.t;
    if(elapsedPD > tg.hotAt){
      ctx.save();
      ctx.globalAlpha=0.85;
      ctx.strokeStyle = '#fff05a';
      ctx.lineWidth = 10;
      ctx.beginPath(); ctx.moveTo(b.x,tg.laserY); ctx.lineTo(b.x+b.w,tg.laserY); ctx.stroke();
      ctx.strokeStyle='#fff'; ctx.lineWidth=3;
      ctx.beginPath(); ctx.moveTo(b.x,tg.laserY); ctx.lineTo(b.x+b.w,tg.laserY); ctx.stroke();
      ctx.restore();
    }
  } else if(tg.type==='desperateRush'){
    ctx.save();
    ctx.globalAlpha = 0.5+Math.sin(performance.now()/70)*0.3;
    ctx.strokeStyle = '#ff3d3d';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(tg.lockX,tg.lockY,22,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tg.lockX-14,tg.lockY); ctx.lineTo(tg.lockX+14,tg.lockY); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(tg.lockX,tg.lockY-14); ctx.lineTo(tg.lockX,tg.lockY+14); ctx.stroke();
    ctx.restore();
  } else if(tg.type==='energyBond'){
    const elapsedED = tg.dur - tg.t;
    if(elapsedED > tg.hotAt && boss.twin && boss.twin.alive){
      ctx.save();
      ctx.globalAlpha=0.75;
      ctx.strokeStyle = boss.def.color;
      ctx.lineWidth = 8;
      ctx.beginPath(); ctx.moveTo(boss.x, boss.y); ctx.lineTo(boss.twin.x, boss.twin.y); ctx.stroke();
      // the safe passage is the whole strip between the two eyes at bondGapY, not just a single
      // point in the middle — draw it as a band so that reads clearly
      ctx.globalAlpha=0.85;
      ctx.fillStyle='#fff';
      ctx.fillRect(boss.x-16, tg.bondGapY-40, (boss.twin.x-boss.x)+32, 80);
      ctx.restore();
    }
  } else if(tg.type==='predictiveLightning'){
    const elapsedLD = tg.dur - tg.t;
    const pastLock = elapsedLD >= tg.hotAt;
    ctx.save();
    ctx.globalAlpha = pastLock ? 0.9 : 0.5+Math.sin(performance.now()/80)*0.3;
    ctx.strokeStyle = pastLock ? '#ff3d3d' : '#fff05a';
    ctx.lineWidth = pastLock ? 4 : 2;
    ctx.setLineDash(pastLock?[]:[6,6]);
    ctx.beginPath(); ctx.moveTo(tg.lockX,b.y); ctx.lineTo(tg.lockX,b.y+b.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  } else if(GROUND_SELF_ATTACKS.includes(tg.type)){
    const maxR = tg.type==='slam' ? 170 : 150;
    const r = maxR*prog;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 3;
    ctx.setLineDash([10,7]);
    ctx.beginPath(); ctx.arc(boss.x, boss.y, r, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.14*prog;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(boss.x, boss.y, r, 0, Math.PI*2); ctx.fill();
    // faint outer ring marking the final blast radius
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(boss.x, boss.y, maxR, 0, Math.PI*2); ctx.stroke();
    ctx.restore();
  } else if(GROUND_TARGET_ATTACKS.includes(tg.type)){
    const spread = tg.type==='meteor' ? 95 : (tg.type==='boneCage' ? 118 : (tg.type==='poisonPool' ? 190 : (tg.type==='growingMagma' ? 130 : 170)));
    ctx.save();
    // falling shadow / impact mark
    ctx.globalAlpha = 0.35+prog*0.35;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(tg.tx, tg.ty, 30+spread*0.22, 14+spread*0.1, 0, 0, Math.PI*2); ctx.fill();
    // expanding warning ring sweeping clockwise
    ctx.globalAlpha = 0.65;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(tg.tx, tg.ty, spread*0.55, -Math.PI/2, -Math.PI/2 + Math.PI*2*prog); ctx.stroke();
    // outer boundary of the whole danger patch
    ctx.globalAlpha = 0.22;
    ctx.setLineDash([6,6]);
    ctx.beginPath(); ctx.arc(tg.tx, tg.ty, spread, 0, Math.PI*2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    if(Math.random()<0.5){
      const ang = Math.random()*Math.PI*2;
      const rr = Math.random()*spread;
      game.particles.push({ x:tg.tx+Math.cos(ang)*rr, y:tg.ty+Math.sin(ang)*rr, vx:0, vy:-16, life:0.3, maxLife:0.3, color, r:1.6, type:'circle' });
    }
  } else if(DASH_ATTACKS.includes(tg.type) || DASH_ATTACKS_EXTRA_TELEGRAPH.includes(tg.type)){
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4+Math.sin(performance.now()/55)*0.25;
    ctx.lineWidth = 3;
    ctx.setLineDash([4,10]);
    ctx.beginPath(); ctx.moveTo(boss.x,boss.y); ctx.lineTo(p.x,p.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  } else if(BURST_ATTACKS.includes(tg.type)){
    const r = 6+prog*30;
    ctx.save();
    const grad = ctx.createRadialGradient(boss.x,boss.y,1,boss.x,boss.y,r+16);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.45+prog*0.5;
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(boss.x,boss.y,r+16,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
}

function drawTwinCompanion(t, def){
  ctx.save();
  ctx.translate(t.x,t.y);
  if(t.shieldTimer>0){
    ctx.globalAlpha = 0.5+Math.sin(performance.now()/90)*0.15;
    ctx.strokeStyle = '#ff9ad1';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0,0,t.radius+7,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawGuardianTwinBoss({ radius:t.radius, def, hitFlash:t.hitFlash });
  const w=t.radius*2;
  ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(-w/2,-t.radius-12,w,4);
  ctx.fillStyle='#ff9ad1'; ctx.fillRect(-w/2,-t.radius-12,w*clamp(t.hp/t.maxHp,0,1),4);
  ctx.restore();
}

// ============================================================
// BOSS BODY ART — every Guardián de Piso (floors 10/20/30...100) gets its own hand-built
// silhouette below. All other bosses (the 90 regular Descenso floors + every Ascenso boss)
// intentionally share a single generic design, per design direction: only guardians are unique.
// ============================================================

// crown of triangular spikes radiating from a ring at radius r*innerRFactor — reused by several
// guardians (and the generic boss) with different counts/colors/widths so each still reads distinctly
function drawSpikeCrown(r, count, len, color, opts){
  opts = opts||{};
  const innerR = r*(opts.innerRFactor!==undefined?opts.innerRFactor:0.9);
  const halfW = opts.width!==undefined?opts.width:0.13;
  const rotate = opts.rotate||0;
  ctx.save();
  ctx.fillStyle = color;
  for(let i=0;i<count;i++){
    const a = (i/count)*Math.PI*2 + rotate;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a-halfW)*innerR, Math.sin(a-halfW)*innerR);
    ctx.lineTo(Math.cos(a)*(innerR+len), Math.sin(a)*(innerR+len));
    ctx.lineTo(Math.cos(a+halfW)*innerR, Math.sin(a+halfW)*innerR);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}
// twin glowing eye dots — the one element every boss silhouette shares, so they all still read
// as "alive" regardless of how different the rest of the body is
function drawBossEyes(r, color){
  ctx.save();
  ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(-r*0.22,-r*0.1,r*0.09,0,Math.PI*2);
  ctx.arc(r*0.22,-r*0.1,r*0.09,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

// ---- shared design for every non-guardian boss (variant 0 of 4 — see GENERIC_BOSS_VARIANTS) ----
function drawGenericBossBody(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 20;
  drawSpikeCrown(r, 7, r*0.38, color, {rotate:performance.now()/9000});
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-15);
  ctx.beginPath();
  ctx.moveTo(0,-r);
  ctx.quadraticCurveTo(r*0.95,-r*0.65, r, r*0.05);
  ctx.quadraticCurveTo(r*0.9, r*0.75, r*0.4, r);
  ctx.quadraticCurveTo(0, r*1.12, -r*0.4, r);
  ctx.quadraticCurveTo(-r*0.9, r*0.75, -r, r*0.05);
  ctx.quadraticCurveTo(-r*0.95,-r*0.65, 0,-r);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#0a0710'; ctx.lineWidth = 3; ctx.stroke();
  drawBossEyes(r, color);
  ctx.restore();
}
// ---- variant 1: Bulto Acorazado — thick body, overlapping armor plates, no spikes ----
function drawBossVariantArmored(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-20);
  ctx.beginPath(); ctx.arc(0,0,r*0.95,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=3; ctx.stroke();
  ctx.fillStyle = shadeColor(color,-45);
  ctx.strokeStyle = '#0a0710'; ctx.lineWidth=1.5;
  for(let i=0;i<5;i++){
    const a = (i/5)*Math.PI*2 + Math.PI/10;
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.rect(-r*0.22, -r*1.02, r*0.44, r*0.4);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  drawBossEyes(r*0.7, color);
  ctx.restore();
}
// ---- variant 2: Espectro Errante — translucent, tattered wavy edge, hazy outer halo ----
function drawBossVariantSpectral(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.shadowColor=color; ctx.shadowBlur=24;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,-r);
  const waves=8;
  for(let i=1;i<=waves;i++){
    const a = -Math.PI/2 + (i/waves)*Math.PI*2;
    const rr = r*(i%2===0?1.0:0.72);
    ctx.lineTo(Math.cos(a)*rr, Math.sin(a)*rr);
  }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.globalAlpha = 0.35;
  ctx.beginPath(); ctx.arc(0,r*0.15,r*1.15,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha = 0.78;
  drawBossEyes(r*0.8, '#ffffff');
  ctx.restore();
}
// ---- variant 3: Bestia Feral — hunched body with jutting fangs/claws ----
function drawBossVariantFeral(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-10);
  ctx.beginPath();
  ctx.moveTo(0,-r*0.7);
  ctx.quadraticCurveTo(r*0.95,-r*0.5,r*0.9,r*0.2);
  ctx.quadraticCurveTo(r*0.7,r*1.0,0,r*0.85);
  ctx.quadraticCurveTo(-r*0.7,r*1.0,-r*0.9,r*0.2);
  ctx.quadraticCurveTo(-r*0.95,-r*0.5,0,-r*0.7);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.5; ctx.stroke();
  ctx.fillStyle = '#e8e0cf';
  [-1,1].forEach(side=>{
    ctx.beginPath();
    ctx.moveTo(side*r*0.3, r*0.6);
    ctx.lineTo(side*r*0.65, r*1.15);
    ctx.lineTo(side*r*0.15, r*0.75);
    ctx.closePath(); ctx.fill();
  });
  drawBossEyes(r*0.75, color);
  ctx.restore();
}
// ---- variant 4: Colmena Errante — insectoid core with small orbiting drones ----
function drawBossVariantSwarm(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-18);
  ctx.beginPath();
  ctx.moveTo(0,-r*0.85);
  ctx.quadraticCurveTo(r*0.7,-r*0.5,r*0.62,r*0.15);
  ctx.quadraticCurveTo(r*0.5,r*0.85,0,r*0.7);
  ctx.quadraticCurveTo(-r*0.5,r*0.85,-r*0.62,r*0.15);
  ctx.quadraticCurveTo(-r*0.7,-r*0.5,0,-r*0.85);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.4; ctx.stroke();
  const n=5;
  for(let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2 + t*1.1;
    const rr = r*1.25;
    const dx=Math.cos(a)*rr, dy=Math.sin(a)*rr;
    ctx.fillStyle = color; ctx.shadowColor=color; ctx.shadowBlur=8;
    ctx.beginPath(); ctx.arc(dx,dy,r*0.14,0,Math.PI*2); ctx.fill();
  }
  ctx.shadowBlur=0;
  drawBossEyes(r*0.7, '#ffe07a');
  ctx.restore();
}
// ---- variant 5: Titán de Piedra — blocky angular slab body ----
function drawBossVariantStoneTitan(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=14;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-22);
  ctx.beginPath();
  ctx.moveTo(-r*0.5,-r*0.95); ctx.lineTo(r*0.55,-r*0.8); ctx.lineTo(r*0.95,-r*0.1);
  ctx.lineTo(r*0.7,r*0.9); ctx.lineTo(-r*0.15,r*1.0); ctx.lineTo(-r*0.9,r*0.55);
  ctx.lineTo(-r*0.95,-r*0.3); ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=3; ctx.stroke();
  // cracks/seams across the slabs
  ctx.strokeStyle='rgba(0,0,0,0.35)'; ctx.lineWidth=1.6;
  ctx.beginPath(); ctx.moveTo(-r*0.5,-r*0.95); ctx.lineTo(-r*0.1,r*0.1); ctx.lineTo(r*0.7,r*0.9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(r*0.95,-r*0.1); ctx.lineTo(-r*0.1,r*0.1); ctx.stroke();
  drawBossEyes(r*0.65, color);
  ctx.restore();
}
// ---- variant 6: Llama Errante — flickering flame silhouette ----
function drawBossVariantFlame(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/220;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=22;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,10);
  ctx.beginPath();
  ctx.moveTo(0,-r*1.1);
  ctx.quadraticCurveTo(r*0.5+Math.sin(t)*4,-r*0.4, r*0.55,r*0.15);
  ctx.quadraticCurveTo(r*0.35,r*0.8, 0,r*0.95);
  ctx.quadraticCurveTo(-r*0.35,r*0.8, -r*0.55,r*0.15);
  ctx.quadraticCurveTo(-r*0.5-Math.sin(t)*4,-r*0.4, 0,-r*1.1);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='#ffe07a'; ctx.globalAlpha=0.55;
  ctx.beginPath();
  ctx.moveTo(0,-r*0.5);
  ctx.quadraticCurveTo(r*0.22,-r*0.1, r*0.2,r*0.35);
  ctx.quadraticCurveTo(0,r*0.55,-r*0.2,r*0.35);
  ctx.quadraticCurveTo(-r*0.22,-r*0.1, 0,-r*0.5);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1;
  drawBossEyes(r*0.55, '#3a1a00');
  ctx.restore();
}
// ---- variant 7: Cadáver Andante — tattered asymmetric decayed body ----
function drawBossVariantRotten(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=14;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-25);
  ctx.beginPath();
  ctx.moveTo(0,-r*0.9);
  ctx.lineTo(r*0.5,-r*0.55); ctx.lineTo(r*0.35,-r*0.05); ctx.lineTo(r*0.85,r*0.3);
  ctx.lineTo(r*0.3,r*0.95); ctx.lineTo(-r*0.2,r*0.6); ctx.lineTo(-r*0.75,r*0.9);
  ctx.lineTo(-r*0.55,r*0.1); ctx.lineTo(-r*0.9,-r*0.25); ctx.lineTo(-r*0.3,-r*0.5);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.2; ctx.stroke();
  // dark wound/decay patches
  ctx.fillStyle='rgba(10,7,10,0.6)';
  ctx.beginPath(); ctx.ellipse(r*0.2,r*0.1,r*0.16,r*0.11,0.4,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-r*0.3,-r*0.15,r*0.12,r*0.08,-0.3,0,Math.PI*2); ctx.fill();
  drawBossEyes(r*0.75, '#8bff6b');
  ctx.restore();
}
// ---- variant 8: Coloso Mecánico — hexagonal plated body with glowing seams ----
function drawBossVariantMech(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=14;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-28);
  ctx.beginPath();
  for(let i=0;i<6;i++){
    const a = (i/6)*Math.PI*2 - Math.PI/2;
    const x=Math.cos(a)*r, y=Math.sin(a)*r;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.6; ctx.stroke();
  // glowing seam lines between the plates
  ctx.strokeStyle=color; ctx.lineWidth=1.4; ctx.globalAlpha=0.8; ctx.shadowColor=color; ctx.shadowBlur=6;
  for(let i=0;i<6;i++){
    const a = (i/6)*Math.PI*2 - Math.PI/2;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*r*0.94,Math.sin(a)*r*0.94); ctx.stroke();
  }
  ctx.shadowBlur=0; ctx.globalAlpha=1;
  // rivet dots
  ctx.fillStyle='#c9c9d4';
  for(let i=0;i<6;i++){
    const a = (i/6)*Math.PI*2 - Math.PI/2 + Math.PI/6;
    ctx.beginPath(); ctx.arc(Math.cos(a)*r*0.6,Math.sin(a)*r*0.6,r*0.05,0,Math.PI*2); ctx.fill();
  }
  drawBossEyes(r*0.7, color);
  ctx.restore();
}
// ---- variant 9: Sombra Líquida — amorphous oozing blob with dripping tendrils ----
function drawBossVariantOoze(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/500;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.globalAlpha=0.92;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,-r*0.85);
  const waves=10;
  for(let i=1;i<=waves;i++){
    const a = -Math.PI/2 + (i/waves)*Math.PI*2;
    const wob = Math.sin(t+i*1.3)*r*0.08;
    ctx.lineTo(Math.cos(a)*(r*0.9+wob), Math.sin(a)*(r*0.9+wob));
  }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  // dripping tendrils hanging below
  ctx.fillStyle = color;
  for(let i=-1;i<=1;i++){
    const dripLen = r*(0.35+Math.abs(Math.sin(t*1.5+i))*0.25);
    ctx.beginPath();
    ctx.moveTo(i*r*0.35-r*0.08, r*0.7);
    ctx.lineTo(i*r*0.35+r*0.08, r*0.7);
    ctx.lineTo(i*r*0.35, r*0.7+dripLen);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha=1;
  drawBossEyes(r*0.6, '#ffffff');
  ctx.restore();
}
const GENERIC_BOSS_VARIANTS = [drawGenericBossBody, drawBossVariantArmored, drawBossVariantSpectral, drawBossVariantFeral,
  drawBossVariantSwarm, drawBossVariantStoneTitan, drawBossVariantFlame, drawBossVariantRotten, drawBossVariantMech, drawBossVariantOoze];
// deterministic per-boss variant pick from its kind string, so the same floor/Ascenso boss always
// renders the same way across visits instead of flickering between variants
function bossVariantIndex(boss){
  let h=0;
  const s = boss.kind||'';
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i))>>>0;
  return h % GENERIC_BOSS_VARIANTS.length;
}

// ---- Ascenso-only generic variants: every regular Ascenso boss (not theSun/sunPrecursor, which
// get their own bespoke art below) picks from this pool instead of Descenso's earthy/monster
// GENERIC_BOSS_VARIANTS, so Ascenso reads as its own distinct, more luminous/ethereal place ----
function drawAscensoVariantShard(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=20;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,-r*1.1);
  ctx.lineTo(r*0.6,-r*0.1);
  ctx.lineTo(r*0.32,r*1.0);
  ctx.lineTo(-r*0.32,r*1.0);
  ctx.lineTo(-r*0.6,-r*0.1);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='rgba(255,255,255,0.55)'; ctx.lineWidth=1.5; ctx.stroke();
  ctx.globalAlpha=0.3;
  ctx.beginPath(); ctx.moveTo(-r*0.15,r*0.9); ctx.lineTo(0,r*1.6); ctx.lineTo(r*0.15,r*0.9); ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1;
  drawBossEyes(r*0.55, '#ffffff');
  ctx.restore();
}
function drawAscensoVariantSoul(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=22;
  ctx.globalAlpha=0.85;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.8,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  ctx.shadowBlur=0;
  for(let i=0;i<2;i++){
    ctx.save();
    ctx.rotate(t*0.5*(i===0?1:-1) + i*Math.PI/2);
    ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.ellipse(0,0,r*1.15,r*0.4,0,0,Math.PI*2); ctx.stroke();
    ctx.restore();
  }
  drawBossEyes(r*0.7, '#ffffff');
  ctx.restore();
}
function drawAscensoVariantEcho(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  for(let i=0;i<3;i++){
    const pulse = (Math.sin(t*1.4 - i*0.6)+1)/2;
    ctx.globalAlpha = 0.25+pulse*0.2;
    ctx.strokeStyle = color; ctx.lineWidth=2.5;
    ctx.beginPath(); ctx.arc(0,0,r*(0.5+i*0.25),0,Math.PI*2); ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.45,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  drawBossEyes(r*0.35, '#ffffff');
  ctx.restore();
}
// ---- 4. Constelación — orbiting points linked by faint lines, star-map look ----
function drawAscensoVariantConstellation(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1200;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-15);
  ctx.beginPath(); ctx.arc(0,0,r*0.5,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  const n=6, pts=[];
  for(let i=0;i<n;i++){
    const a=(i/n)*Math.PI*2+t;
    pts.push([Math.cos(a)*r*0.95, Math.sin(a)*r*0.95]);
  }
  ctx.strokeStyle='rgba(255,255,255,0.35)'; ctx.lineWidth=1;
  for(let i=0;i<n;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(pts[i][0],pts[i][1]); ctx.stroke(); }
  ctx.fillStyle='#ffffff';
  pts.forEach(p=>{ ctx.beginPath(); ctx.arc(p[0],p[1],3,0,Math.PI*2); ctx.fill(); });
  drawBossEyes(r*0.4, '#ffffff');
  ctx.restore();
}
// ---- 5. Espectro de Luz — prism body splitting into color bands ----
function drawAscensoVariantPrism(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.moveTo(0,-r); ctx.lineTo(r*0.7,r*0.6); ctx.lineTo(-r*0.7,r*0.6); ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  const bands=['#ff6a6a','#ffcb47','#8bff6b','#6ad8ff','#c9a8ff'];
  bands.forEach((bc,i)=>{
    ctx.globalAlpha=0.5;
    ctx.strokeStyle=bc; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(r*0.15+i*3,r*0.6); ctx.lineTo(r*0.3+i*7,r*1.15); ctx.stroke();
  });
  ctx.globalAlpha=1;
  drawBossEyes(r*0.4, '#ffffff');
  ctx.restore();
}
// ---- 6. Ánfora Estelar — glowing vessel pouring light ----
function drawAscensoVariantUrn(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-10);
  ctx.beginPath();
  ctx.moveTo(-r*0.3,-r*0.9); ctx.lineTo(r*0.3,-r*0.9); ctx.lineTo(r*0.55,-r*0.2);
  ctx.quadraticCurveTo(r*0.6,r*0.9,0,r*0.95);
  ctx.quadraticCurveTo(-r*0.6,r*0.9,-r*0.55,-r*0.2); ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#ffffff'; ctx.globalAlpha=0.5; ctx.lineWidth=1.5; ctx.stroke(); ctx.globalAlpha=1;
  ctx.fillStyle='#fff6d0'; ctx.globalAlpha=0.6+Math.sin(performance.now()/300)*0.2;
  ctx.beginPath(); ctx.arc(0,-r*0.9,r*0.22,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  drawBossEyes(r*0.3, color);
  ctx.restore();
}
// ---- 7. Ala Rota — a single large asymmetric wing ----
function drawAscensoVariantWing(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,0);
  ctx.quadraticCurveTo(r*0.6,-r*0.9, r*1.3,-r*0.5);
  ctx.quadraticCurveTo(r*0.8,-r*0.15, r*0.9,r*0.3);
  ctx.quadraticCurveTo(r*0.35,r*0.15, 0,0);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=1;
  for(let i=1;i<=3;i++){ ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(r*(0.4+i*0.28),-r*(0.3+i*0.18)); ctx.stroke(); }
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-15);
  ctx.beginPath(); ctx.arc(0,0,r*0.4,0,Math.PI*2); ctx.fill();
  drawBossEyes(r*0.3, '#ffffff');
  ctx.restore();
}
// ---- 8. Esfera de Cristal — faceted glass orb with internal glow ----
function drawAscensoVariantCrystalSphere(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=20;
  const grad = ctx.createRadialGradient(-r*0.2,-r*0.2,2,0,0,r*0.9);
  grad.addColorStop(0,'#ffffff'); grad.addColorStop(0.5,color); grad.addColorStop(1,shadeColor(color,-30));
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : grad;
  ctx.beginPath(); ctx.arc(0,0,r*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1;
  for(let i=0;i<5;i++){
    const a=(i/5)*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*r*0.85,Math.sin(a)*r*0.85); ctx.stroke();
  }
  drawBossEyes(r*0.5, '#ffffff');
  ctx.restore();
}
// ---- 9. Llama Fría — inverted icy flame, blue-white ----
function drawAscensoVariantColdFlame(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/240;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,r*1.05);
  ctx.quadraticCurveTo(r*0.5+Math.sin(t)*3,r*0.3,r*0.5,-r*0.2);
  ctx.quadraticCurveTo(r*0.3,-r*0.85,0,-r*0.95);
  ctx.quadraticCurveTo(-r*0.3,-r*0.85,-r*0.5,-r*0.2);
  ctx.quadraticCurveTo(-r*0.5-Math.sin(t)*3,r*0.3,0,r*1.05);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='#ffffff'; ctx.globalAlpha=0.55;
  ctx.beginPath(); ctx.ellipse(0,r*0.1,r*0.18,r*0.35,0,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  drawBossEyes(r*0.45, '#0a1a2a');
  ctx.restore();
}
// ---- 10. Ojo Celestial — large iris with radiating lashes ----
function drawAscensoVariantCelestialEye(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  drawSpikeCrown(r, 14, r*0.3, '#ffffff', {width:0.05, innerRFactor:0.92});
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : '#f4eef8';
  ctx.beginPath(); ctx.arc(0,0,r*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle = color; ctx.shadowColor=color; ctx.shadowBlur=10;
  ctx.beginPath(); ctx.arc(0,0,r*0.42,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='#0a0710';
  ctx.beginPath(); ctx.arc(0,0,r*0.18,0,Math.PI*2); ctx.fill();
  ctx.restore();
}
// ---- 11. Portal Roto — a ring/arch with fragments floating around it ----
function drawAscensoVariantBrokenPortal(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/900;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.strokeStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.lineWidth = r*0.22;
  ctx.beginPath(); ctx.arc(0,0,r*0.65,0.3,Math.PI*1.75); ctx.stroke();
  ctx.shadowBlur=0;
  ctx.fillStyle='#fff6ff';
  for(let i=0;i<4;i++){
    const a=(i/4)*Math.PI*2+t;
    const rr=r*1.15;
    ctx.save(); ctx.translate(Math.cos(a)*rr,Math.sin(a)*rr); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0,-6); ctx.lineTo(4,0); ctx.lineTo(0,6); ctx.lineTo(-4,0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  drawBossEyes(r*0.3, color);
  ctx.restore();
}
// ---- 12. Espina Lumínica — a single long curved thorn ----
function drawAscensoVariantThorn(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(0,-r*1.3);
  ctx.quadraticCurveTo(r*0.55,-r*0.2, r*0.22,r*0.9);
  ctx.quadraticCurveTo(0,r*0.5,-r*0.22,r*0.9);
  ctx.quadraticCurveTo(-r*0.55,-r*0.2, 0,-r*1.3);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='rgba(255,255,255,0.5)'; ctx.lineWidth=1; ctx.stroke();
  drawBossEyes(r*0.35, '#ffffff');
  ctx.restore();
}
// ---- 13. Marea de Almas — a wavy flowing ribbon body ----
function drawAscensoVariantSoulTide(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/260;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.globalAlpha=0.85;
  ctx.beginPath();
  ctx.moveTo(-r,0);
  for(let i=0;i<=8;i++){
    const x=-r+i*(2*r/8);
    const y=Math.sin(t+i*0.8)*r*0.35;
    ctx.lineTo(x,y-r*0.3);
  }
  for(let i=8;i>=0;i--){
    const x=-r+i*(2*r/8);
    const y=Math.sin(t+i*0.8)*r*0.35;
    ctx.lineTo(x,y+r*0.3);
  }
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha=1; ctx.shadowBlur=0;
  drawBossEyes(r*0.35, '#ffffff');
  ctx.restore();
}
// ---- 14. Corona Menor — a modest crown, a quieter echo of El Sol's ----
function drawAscensoVariantMinorCrown(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1400;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.save(); ctx.rotate(t);
  drawSpikeCrown(r, 8, r*0.35, color, {width:0.09, innerRFactor:0.85});
  ctx.restore();
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,15);
  ctx.beginPath(); ctx.arc(0,0,r*0.75,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#ffffff'; ctx.globalAlpha=0.4; ctx.lineWidth=1.5; ctx.stroke(); ctx.globalAlpha=1;
  drawBossEyes(r*0.65, '#ffffff');
  ctx.restore();
}
// ---- 15. Fragmento Lunar — pale crescent moon ----
function drawAscensoVariantLunar(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : '#e8e8f5';
  ctx.beginPath();
  ctx.arc(0,0,r*0.85,-1.1,1.1);
  ctx.arc(r*0.3,0,r*0.6,1.15,-1.15,true);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  drawBossEyes(r*0.3, color);
  ctx.restore();
}
// ---- 16. Enjambre de Luciérnagas — a cluster of tiny glowing dots forming a body ----
function drawAscensoVariantFireflies(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.globalAlpha=0.3; ctx.fillStyle=color;
  ctx.beginPath(); ctx.arc(0,0,r*0.7,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  const n=14;
  for(let i=0;i<n;i++){
    const a=(i/n)*Math.PI*2*3+t;
    const rr = r*(0.2+((i*37)%60)/100);
    const dx=Math.cos(a)*rr, dy=Math.sin(a)*rr;
    ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
    ctx.shadowColor=color; ctx.shadowBlur=6;
    ctx.beginPath(); ctx.arc(dx,dy,2.6,0,Math.PI*2); ctx.fill();
  }
  ctx.shadowBlur=0;
  drawBossEyes(r*0.3, '#ffffff');
  ctx.restore();
}
// ---- 17. Reloj de Arena Roto — hourglass/bowtie silhouette ----
function drawAscensoVariantHourglass(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath();
  ctx.moveTo(-r*0.75,-r*0.9); ctx.lineTo(r*0.75,-r*0.9); ctx.lineTo(r*0.15,0);
  ctx.lineTo(r*0.75,r*0.9); ctx.lineTo(-r*0.75,r*0.9); ctx.lineTo(-r*0.15,0);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='rgba(255,255,255,0.45)'; ctx.lineWidth=1.2; ctx.stroke();
  drawBossEyes(r*0.4, '#ffffff');
  ctx.restore();
}
// ---- 18. Vela Eterna — a flame atop a slender stem ----
function drawAscensoVariantCandle(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/220;
  ctx.save();
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-30);
  ctx.beginPath(); ctx.rect(-r*0.16,r*0.05,r*0.32,r*0.85); ctx.fill();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0,-r*0.95+Math.sin(t)*2);
  ctx.quadraticCurveTo(r*0.32,-r*0.2,r*0.16,r*0.1);
  ctx.quadraticCurveTo(0,r*0.25,-r*0.16,r*0.1);
  ctx.quadraticCurveTo(-r*0.32,-r*0.2,0,-r*0.95+Math.sin(t)*2);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  drawBossEyes(r*0.4, '#3a1a00');
  ctx.restore();
}
// ---- 19. Rosa de los Vientos — compass-star with many thin points ----
function drawAscensoVariantWindRose(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/2000;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.save(); ctx.rotate(t);
  drawSpikeCrown(r, 8, r*0.95, color, {width:0.035, innerRFactor:0.1});
  ctx.restore();
  ctx.shadowBlur=0;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-10);
  ctx.beginPath(); ctx.arc(0,0,r*0.32,0,Math.PI*2); ctx.fill();
  drawBossEyes(r*0.28, '#ffffff');
  ctx.restore();
}
// ---- 20. Cáliz de Luz — a goblet with glow spilling over the rim ----
function drawAscensoVariantChalice(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-10);
  ctx.beginPath();
  ctx.moveTo(-r*0.55,-r*0.8); ctx.lineTo(r*0.55,-r*0.8);
  ctx.quadraticCurveTo(r*0.5,-r*0.1,r*0.15,r*0.15);
  ctx.lineTo(r*0.15,r*0.75); ctx.lineTo(r*0.45,r*0.95); ctx.lineTo(-r*0.45,r*0.95);
  ctx.lineTo(-r*0.15,r*0.75); ctx.lineTo(-r*0.15,r*0.15);
  ctx.quadraticCurveTo(-r*0.5,-r*0.1,-r*0.55,-r*0.8);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.fillStyle='#fff6d0'; ctx.globalAlpha=0.65+Math.sin(performance.now()/280)*0.2;
  ctx.beginPath(); ctx.ellipse(0,-r*0.78,r*0.5,r*0.14,0,0,Math.PI*2); ctx.fill();
  ctx.globalAlpha=1;
  drawBossEyes(r*0.3, color);
  ctx.restore();
}
// ---- 21. Pluma Cósmica — a single large drifting feather ----
function drawAscensoVariantCosmicFeather(boss){
  const r = boss.radius, color = boss.def.color;
  const sway = Math.sin(performance.now()/500)*0.15;
  ctx.save();
  ctx.rotate(sway);
  ctx.shadowColor=color; ctx.shadowBlur=16;
  const grad = ctx.createLinearGradient(0,-r*1.1,0,r*0.7);
  grad.addColorStop(0,'#ffffff'); grad.addColorStop(0.5,color); grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : grad;
  ctx.beginPath();
  ctx.moveTo(0,-r*1.1);
  ctx.quadraticCurveTo(r*0.5,-r*0.3,r*0.28,r*0.6);
  ctx.quadraticCurveTo(0,r*0.3,0,r*0.7);
  ctx.quadraticCurveTo(0,r*0.3,-r*0.28,r*0.6);
  ctx.quadraticCurveTo(-r*0.5,-r*0.3,0,-r*1.1);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  drawBossEyes(r*0.3, '#ffffff');
  ctx.restore();
}
// ---- 22. Ecuación Estelar — abstract overlapping triangles ----
function drawAscensoVariantStellarEquation(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1600;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  [0,1,2].forEach(i=>{
    ctx.save();
    ctx.rotate(t*(i%2===0?1:-1)+i*Math.PI*2/3);
    ctx.globalAlpha=0.55;
    ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
    ctx.beginPath();
    ctx.moveTo(0,-r*0.85); ctx.lineTo(r*0.75,r*0.5); ctx.lineTo(-r*0.75,r*0.5); ctx.closePath(); ctx.fill();
    ctx.restore();
  });
  ctx.globalAlpha=1; ctx.shadowBlur=0;
  drawBossEyes(r*0.3, '#ffffff');
  ctx.restore();
}
// ---- 23. Nova Silenciosa — a soft pulsing ring-burst, quiet compared to the others ----
function drawAscensoVariantSilentNova(boss){
  const r = boss.radius, color = boss.def.color;
  const pulse = (Math.sin(performance.now()/500)+1)/2;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  for(let i=0;i<3;i++){
    ctx.globalAlpha = 0.5-i*0.14-pulse*0.1;
    ctx.strokeStyle = color; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(0,0,r*(0.45+i*0.22+pulse*0.06),0,Math.PI*2); ctx.stroke();
  }
  ctx.globalAlpha=1; ctx.shadowBlur=0;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,10);
  ctx.beginPath(); ctx.arc(0,0,r*0.4,0,Math.PI*2); ctx.fill();
  drawBossEyes(r*0.32, '#ffffff');
  ctx.restore();
}
const ASCENSO_BOSS_VARIANTS = [drawAscensoVariantShard, drawAscensoVariantSoul, drawAscensoVariantEcho,
  drawAscensoVariantConstellation, drawAscensoVariantPrism, drawAscensoVariantUrn, drawAscensoVariantWing,
  drawAscensoVariantCrystalSphere, drawAscensoVariantColdFlame, drawAscensoVariantCelestialEye,
  drawAscensoVariantBrokenPortal, drawAscensoVariantThorn, drawAscensoVariantSoulTide, drawAscensoVariantMinorCrown,
  drawAscensoVariantLunar, drawAscensoVariantFireflies, drawAscensoVariantHourglass, drawAscensoVariantCandle,
  drawAscensoVariantWindRose, drawAscensoVariantChalice, drawAscensoVariantCosmicFeather, drawAscensoVariantStellarEquation,
  drawAscensoVariantSilentNova];

// ---- El Sol (piso 100 de Ascenso) — the true final boss of the whole game, gets the most
// elaborate treatment: rotating double corona, bright radial-gradient core, dark solar-flare eyes
// (everything else is blinding, so the eyes read dark instead of glowing like every other boss) ----
function drawGuardianTheSun(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.shadowColor = '#fff6d0'; ctx.shadowBlur = 40;
  ctx.save(); ctx.rotate(t*0.15);
  drawSpikeCrown(r, 20, r*0.9, 'rgba(255,224,140,0.55)', {width:0.045, innerRFactor:0.75});
  ctx.restore();
  ctx.save(); ctx.rotate(-t*0.08);
  drawSpikeCrown(r, 12, r*0.55, '#fff6d0', {width:0.07, innerRFactor:0.82});
  ctx.restore();
  const coreGrad = ctx.createRadialGradient(0,0,0,0,0,r*0.85);
  coreGrad.addColorStop(0, '#ffffff');
  coreGrad.addColorStop(0.5, '#ffe9a8');
  coreGrad.addColorStop(1, boss.hitFlash>0 ? '#ffffff' : color);
  ctx.fillStyle = coreGrad;
  ctx.beginPath(); ctx.arc(0,0,r*0.78,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0,0,r*0.78,0,Math.PI*2); ctx.stroke();
  drawBossEyes(r*0.75, '#3a2400');
  ctx.restore();
}
// ---- Precursor del Sol — an eclipsed, not-yet-risen sun: darker core, cracks of shadow across
// the disc, a smaller/dimmer corona foreshadowing what floor 100 becomes ----
function drawGuardianSunPrecursor(boss){
  const r = boss.radius, color = boss.def.color;
  const t = performance.now()/1000;
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 24;
  ctx.save(); ctx.rotate(t*0.1);
  drawSpikeCrown(r, 10, r*0.5, shadeColor(color,10), {width:0.06, innerRFactor:0.82});
  ctx.restore();
  const coreGrad = ctx.createRadialGradient(0,0,0,0,0,r*0.85);
  coreGrad.addColorStop(0, shadeColor(color,20));
  coreGrad.addColorStop(0.6, color);
  coreGrad.addColorStop(1, shadeColor(color,-40));
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : coreGrad;
  ctx.beginPath(); ctx.arc(0,0,r*0.82,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle = 'rgba(10,5,0,0.55)'; ctx.lineWidth=2;
  for(let i=0;i<4;i++){
    const a = (i/4)*Math.PI*2 + 0.4;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*r*0.15, Math.sin(a)*r*0.15);
    ctx.lineTo(Math.cos(a)*r*0.75, Math.sin(a)*r*0.75);
    ctx.stroke();
  }
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.5;
  ctx.beginPath(); ctx.arc(0,0,r*0.82,0,Math.PI*2); ctx.stroke();
  drawBossEyes(r*0.7, '#fff6d0');
  ctx.restore();
}

// ---- 1. Guardián de Hueso — bone crown, skull core, ribcage arcs ----
function drawGuardianBoneGuardian(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  drawSpikeCrown(r, 10, r*0.34, '#f2ead2', {width:0.09, innerRFactor:0.9});
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : '#e8dfc4';
  ctx.beginPath(); ctx.arc(0,0,r*0.92,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#8a7a5a'; ctx.lineWidth=2.5; ctx.stroke();
  ctx.strokeStyle='rgba(120,105,80,0.55)'; ctx.lineWidth=2;
  for(let i=0;i<3;i++){
    ctx.beginPath();
    ctx.arc(0, r*0.15, r*(0.55+i*0.14), 0.25*Math.PI, 0.75*Math.PI);
    ctx.stroke();
  }
  ctx.fillStyle = '#100c14';
  ctx.beginPath();
  ctx.arc(-r*0.28,-r*0.15,r*0.16,0,Math.PI*2);
  ctx.arc(r*0.28,-r*0.15,r*0.16,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

// ---- 2. Bruja Madre — ragged robe, pointed hat ----
function drawGuardianMotherWitch(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-25);
  ctx.beginPath();
  ctx.moveTo(-r*0.75, r*0.9);
  for(let i=0;i<=6;i++){
    const x = -r*0.75 + (i/6)*r*1.5;
    const y = i%2===0 ? r*1.05 : r*0.75;
    ctx.lineTo(x,y);
  }
  ctx.quadraticCurveTo(r*0.55,-r*0.2, r*0.15,-r*0.7);
  ctx.quadraticCurveTo(0,-r*1.05,-r*0.15,-r*0.7);
  ctx.quadraticCurveTo(-r*0.55,-r*0.2,-r*0.75,r*0.9);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle=shadeColor(color,20); ctx.lineWidth=2; ctx.stroke();
  ctx.fillStyle = shadeColor(color,-40);
  ctx.beginPath();
  ctx.moveTo(-r*0.42,-r*0.55); ctx.lineTo(0,-r*1.35); ctx.lineTo(r*0.42,-r*0.55);
  ctx.closePath(); ctx.fill();
  drawBossEyes(r*0.65, '#c9a4ff');
  ctx.restore();
}

// ---- 3. Señor del Abismo — horns, flame-wing flares ----
function drawGuardianAbyssLord(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=22;
  ctx.fillStyle = shadeColor(color,-30);
  [-1,1].forEach(side=>{
    ctx.beginPath();
    ctx.moveTo(side*r*0.3,-r*0.2);
    ctx.lineTo(side*r*1.5,-r*0.6);
    ctx.lineTo(side*r*1.15,r*0.05);
    ctx.lineTo(side*r*1.4,r*0.35);
    ctx.lineTo(side*r*0.55,r*0.35);
    ctx.closePath(); ctx.fill();
  });
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#2a0a08'; ctx.lineWidth=3; ctx.stroke();
  ctx.strokeStyle='#1c0806'; ctx.lineWidth=6; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(-r*0.35,-r*0.6); ctx.quadraticCurveTo(-r*0.75,-r*1.25,-r*0.2,-r*1.3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(r*0.35,-r*0.6); ctx.quadraticCurveTo(r*0.75,-r*1.25,r*0.2,-r*1.3); ctx.stroke();
  drawBossEyes(r, '#ffd54a');
  ctx.restore();
}

// ---- 4. Emperatriz de la Luz — petal halo, small crown ----
function drawGuardianEmpressOfLight(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=22;
  drawSpikeCrown(r, 12, r*0.5, '#fff3fb', {width:0.11, innerRFactor:0.85, rotate:performance.now()/6000});
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.8,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#ffe3f5'; ctx.lineWidth=2.5; ctx.stroke();
  ctx.fillStyle='#ffe07a';
  ctx.beginPath();
  ctx.moveTo(-r*0.3,-r*0.6); ctx.lineTo(-r*0.15,-r*0.95); ctx.lineTo(0,-r*0.65);
  ctx.lineTo(r*0.15,-r*0.95); ctx.lineTo(r*0.3,-r*0.6); ctx.closePath(); ctx.fill();
  drawBossEyes(r*0.85, '#fff6ff');
  ctx.restore();
}

// ---- 5. Reflejo — faceted crystal shell + a faint offset mirror-duplicate ----
function drawFacetedShell(r, color, flash){
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  const facets = 8;
  ctx.fillStyle = flash ? '#ffffff' : shadeColor(color,-10);
  ctx.beginPath();
  for(let i=0;i<facets;i++){
    const a = (i/facets)*Math.PI*2;
    const rr = r*(i%2===0?1:0.82);
    const x = Math.cos(a)*rr, y = Math.sin(a)*rr;
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  }
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur=0;
  ctx.globalAlpha=0.5;
  ctx.strokeStyle='#ffffff'; ctx.lineWidth=1.4; ctx.stroke();
  ctx.globalAlpha=1;
  ctx.restore();
}
function drawGuardianMirrorLord(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.translate(r*0.35, r*0.1);
  drawFacetedShell(r*0.85, color, false);
  ctx.restore();
  drawFacetedShell(r, color, boss.hitFlash>0);
  drawBossEyes(r*0.9, '#8fa8ff');
  ctx.restore();
}

// ---- 6. Hermanas Gemelas — two overlapping circles bound by a ribbon ----
function drawGuardianTwinBoss(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=16;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(-r*0.18,0,r*0.78,0,Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(r*0.18,0,r*0.78,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.globalAlpha=0.9;
  ctx.strokeStyle='#ffe3f2'; ctx.lineWidth=2;
  ctx.beginPath(); ctx.arc(-r*0.18,0,r*0.78,0,Math.PI*2); ctx.stroke();
  ctx.beginPath(); ctx.arc(r*0.18,0,r*0.78,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha=1;
  ctx.strokeStyle='#ff6fc0'; ctx.lineWidth=2.4; ctx.setLineDash([3,4]);
  ctx.beginPath(); ctx.moveTo(-r*0.5,-r*0.3); ctx.quadraticCurveTo(0, r*0.15, r*0.5,-r*0.3); ctx.stroke();
  ctx.setLineDash([]);
  drawBossEyes(r*0.75, '#fff0fa');
  ctx.restore();
}

// ---- 7. Monarca del Glaciar — icy spike crown, hanging icicles ----
function drawGuardianGlacierMonarch(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  drawSpikeCrown(r, 8, r*0.42, '#eaf9ff', {width:0.08, innerRFactor:0.86});
  ctx.shadowColor=color; ctx.shadowBlur=18;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.88,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.globalAlpha=0.7;
  ctx.strokeStyle='#ffffff'; ctx.lineWidth=2; ctx.stroke();
  ctx.globalAlpha=1;
  ctx.fillStyle='#d8f3ff';
  for(let i=-2;i<=2;i++){
    const x = i*r*0.28;
    ctx.beginPath();
    ctx.moveTo(x-r*0.09, r*0.6); ctx.lineTo(x+r*0.09, r*0.6); ctx.lineTo(x, r*0.6+r*(0.25+Math.abs(i)*0.05));
    ctx.closePath(); ctx.fill();
  }
  drawBossEyes(r, '#eafcff');
  ctx.restore();
}

// ---- 8. Señor del Trueno — crackling lightning aura ----
function drawGuardianStormLord(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=20;
  ctx.strokeStyle='#fff6b0'; ctx.lineWidth=2.2; ctx.globalAlpha=0.85;
  for(let i=0;i<5;i++){
    const a = (i/5)*Math.PI*2 + performance.now()/500;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*r*0.9, Math.sin(a)*r*0.9);
    ctx.lineTo(Math.cos(a+0.2)*r*1.3, Math.sin(a+0.2)*r*1.1);
    ctx.lineTo(Math.cos(a+0.05)*r*1.5, Math.sin(a+0.05)*r*1.5);
    ctx.stroke();
  }
  ctx.globalAlpha=1;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0,0,r*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#4a4408'; ctx.lineWidth=2.5; ctx.stroke();
  drawBossEyes(r, '#fffbe0');
  ctx.restore();
}

// ---- 9. Devorador de Estrellas — void core swallowing orbiting stars ----
function drawGuardianStarDevourer(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=22;
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-20);
  ctx.beginPath(); ctx.arc(0,0,r*0.85,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#c9a8ff'; ctx.lineWidth=2; ctx.stroke();
  const n=6;
  for(let i=0;i<n;i++){
    const a = (i/n)*Math.PI*2 + performance.now()/900;
    const rr = r*(1.3 - (i%3)*0.15);
    ctx.fillStyle = '#e8d8ff';
    ctx.beginPath(); ctx.arc(Math.cos(a)*rr, Math.sin(a)*rr, 2.6,0,Math.PI*2); ctx.fill();
  }
  ctx.fillStyle='#0a0416';
  ctx.beginPath(); ctx.arc(0,r*0.1,r*0.32,0,Math.PI*2); ctx.fill();
  drawBossEyes(r*0.75, '#e8d8ff');
  ctx.restore();
}

// ---- 10. El Verdadero Abismo — every spike, pulsing rim, void eyes ----
function drawGuardianTrueFinal(boss){
  const r = boss.radius, color = boss.def.color;
  ctx.save();
  ctx.shadowColor=color; ctx.shadowBlur=26;
  drawSpikeCrown(r, 16, r*0.5, '#ffffff', {width:0.06, innerRFactor:0.82, rotate:performance.now()/4000});
  ctx.fillStyle = boss.hitFlash>0 ? '#ffffff' : shadeColor(color,-6);
  ctx.beginPath(); ctx.arc(0,0,r*0.78,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur=0;
  ctx.strokeStyle='#0a0710'; ctx.lineWidth=2.5; ctx.stroke();
  const pulse = 0.5+Math.sin(performance.now()/200)*0.3;
  ctx.strokeStyle=`rgba(255,255,255,${0.4+pulse*0.3})`; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.arc(0,0,r*0.95,0,Math.PI*2); ctx.stroke();
  drawBossEyes(r*0.7, '#0a0710');
  ctx.restore();
}

const GUARDIAN_BODY_DRAWERS = {
  boneGuardian: drawGuardianBoneGuardian,
  motherWitch: drawGuardianMotherWitch,
  abyssLord: drawGuardianAbyssLord,
  empressOfLight: drawGuardianEmpressOfLight,
  mirrorLord: drawGuardianMirrorLord,
  twinBoss: drawGuardianTwinBoss,
  glacierMonarch: drawGuardianGlacierMonarch,
  stormLord: drawGuardianStormLord,
  starDevourer: drawGuardianStarDevourer,
  trueFinal: drawGuardianTrueFinal,
  theSun: drawGuardianTheSun,
  sunPrecursor: drawGuardianSunPrecursor,
};
function drawBossBody(boss){
  const fn = GUARDIAN_BODY_DRAWERS[boss.kind];
  if(fn){ fn(boss); return; }
  if(game.ascenso){
    ASCENSO_BOSS_VARIANTS[bossVariantIndex(boss) % ASCENSO_BOSS_VARIANTS.length](boss);
    return;
  }
  GENERIC_BOSS_VARIANTS[bossVariantIndex(boss)](boss);
}

function drawBoss(boss){
  ctx.save();
  ctx.translate(boss.x,boss.y);
  if(boss.spawnGrace>0){
    const t = clamp(1-(boss.spawnGrace/1.1),0,1); // 0 -> 1 as it materializes
    ctx.scale(0.3+t*0.7, 0.3+t*0.7);
    ctx.globalAlpha = 0.4+t*0.6;
    const haloR = boss.radius + 40*(1-t);
    const grad = ctx.createRadialGradient(0,0,4,0,0,haloR);
    grad.addColorStop(0, boss.def.color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0,0,haloR,0,Math.PI*2); ctx.fill();
  }
  if(boss.telegraph){
    const pulse = Math.sin(performance.now()/60)*4;
    ctx.strokeStyle = boss.def.color;
    ctx.lineWidth=2.5;
    ctx.globalAlpha=0.75;
    ctx.beginPath(); ctx.arc(0,0,boss.radius+18+pulse,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha=1;
    ctx.strokeStyle='rgba(255,255,255,0.55)';
    ctx.lineWidth=1.5;
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.arc(0,0,boss.radius+9-pulse*0.5, performance.now()/220, performance.now()/220+Math.PI*1.4); ctx.stroke();
    ctx.setLineDash([]);
  }
  if(boss.shieldTimer>0){
    ctx.globalAlpha = 0.5+Math.sin(performance.now()/90)*0.15;
    ctx.strokeStyle = '#ff9ad1';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0,0,boss.radius+7,0,Math.PI*2); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  drawBossBody(boss);
  if(boss.stunTimer>0){
    // same dizzy-star tell as common enemies, scaled up — bosses can be stunned too (core-break
    // punish window, or Frey/Coloso/Marlow/Rowan's briefer "chill" on a boss)
    const st = performance.now()/300;
    ctx.fillStyle='#ffe07a'; ctx.globalAlpha=0.9;
    for(let i=0;i<4;i++){
      const a = st + (i/4)*Math.PI*2;
      const sx = Math.cos(a)*boss.radius*0.75, sy = -boss.radius-14+Math.sin(a)*4;
      ctx.save(); ctx.translate(sx,sy); ctx.rotate(a);
      ctx.beginPath();
      for(let k=0;k<4;k++){ const ka=(k/4)*Math.PI*2; ctx.lineTo(Math.cos(ka)*4, Math.sin(ka)*4); ctx.lineTo(Math.cos(ka+Math.PI/4)*1.6, Math.sin(ka+Math.PI/4)*1.6); }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha=1;
  }
  ctx.restore();
}

// deterministic string hash, reused by both boss-body variant selection and (now) default
// projectile shape selection — same string always maps to the same variant, no per-frame flicker
function drawProjectile(pr){
  if(pr.shape==='shard') return drawProjShard(pr);
  if(pr.shape==='feather') return drawProjFeather(pr);
  if(pr.shape==='wisp') return drawProjWisp(pr);
  if(pr.shape==='orb') return drawProjOrb(pr);
  if(pr.shape==='ember') return drawProjEmber(pr);
  ctx.save();
  const speed = Math.hypot(pr.vx,pr.vy)||1;
  const dirX = pr.vx/speed, dirY = pr.vy/speed;
  const tailLen = Math.min(36, pr.radius*3.4);

  // comet-style trail streaking back along the direction of travel
  const tx = pr.x - dirX*tailLen, ty = pr.y - dirY*tailLen;
  const trailGrad = ctx.createLinearGradient(tx,ty,pr.x,pr.y);
  trailGrad.addColorStop(0,'rgba(0,0,0,0)');
  trailGrad.addColorStop(1,pr.color);
  ctx.strokeStyle = trailGrad;
  ctx.lineWidth = Math.max(2,pr.radius*1.3);
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.55;
  ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(pr.x,pr.y); ctx.stroke();

  // outer glow body
  ctx.globalAlpha = 1;
  ctx.shadowColor = pr.color; ctx.shadowBlur = 14;
  ctx.fillStyle = pr.color;
  ctx.beginPath(); ctx.arc(pr.x,pr.y,pr.radius,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;

  // bright white-hot core for punch
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(pr.x,pr.y,pr.radius*0.42,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// angular spinning crystal/dagger shard — bone fragments, broken mirror glass, thrown blades
function drawProjShard(pr){
  const rot = performance.now()/130 + pr.x*0.01;
  const R = pr.radius*1.6;
  ctx.save();
  ctx.translate(pr.x,pr.y);
  ctx.rotate(rot);
  ctx.shadowColor = pr.color; ctx.shadowBlur = 9;
  ctx.fillStyle = pr.color;
  ctx.beginPath();
  ctx.moveTo(0,-R); ctx.lineTo(R*0.5,0); ctx.lineTo(0,R); ctx.lineTo(-R*0.5,0); ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0,-R*0.4); ctx.lineTo(R*0.18,0); ctx.lineTo(0,R*0.4); ctx.lineTo(-R*0.18,0); ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// soft drifting petal/feather — the garden boss's light-woven attacks
function drawProjFeather(pr){
  const ang = Math.atan2(pr.vy,pr.vx);
  const sway = Math.sin(performance.now()/90 + pr.x*0.05)*0.3;
  const len = pr.radius*2.8, wid = pr.radius*1.15;
  ctx.save();
  ctx.translate(pr.x,pr.y);
  ctx.rotate(ang+Math.PI/2+sway);
  const grad = ctx.createLinearGradient(0,-len*0.6,0,len*0.4);
  grad.addColorStop(0,'rgba(255,255,255,0.95)');
  grad.addColorStop(0.4,pr.color);
  grad.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0,-len*0.6);
  ctx.quadraticCurveTo(wid,0, 0, len*0.4);
  ctx.quadraticCurveTo(-wid,0, 0,-len*0.6);
  ctx.fill();
  ctx.restore();
}

// flickering translucent wisp — ghostly phantoms and cursed marks
function drawProjWisp(pr){
  const flicker = 0.55+Math.sin(performance.now()/70+pr.x)*0.25;
  ctx.save();
  ctx.globalAlpha = flicker;
  ctx.shadowColor = pr.color; ctx.shadowBlur = 16;
  const R = pr.radius*1.7;
  const grad = ctx.createRadialGradient(pr.x,pr.y,0,pr.x,pr.y,R);
  grad.addColorStop(0,'#ffffff');
  grad.addColorStop(0.4,pr.color);
  grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(pr.x,pr.y,R,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// pulsing orb with a tilted rotating halo ring — twin-bond and prismatic magic
function drawProjOrb(pr){
  const pulse = 1+Math.sin(performance.now()/80+pr.x)*0.15;
  ctx.save();
  ctx.translate(pr.x,pr.y);
  ctx.rotate(performance.now()/300);
  ctx.strokeStyle = pr.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.ellipse(0,0,pr.radius*1.9,pr.radius*0.7,0,0,Math.PI*2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.shadowColor = pr.color; ctx.shadowBlur = 12;
  ctx.fillStyle = pr.color;
  ctx.beginPath(); ctx.arc(0,0,pr.radius*pulse,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(0,0,pr.radius*0.4,0,Math.PI*2); ctx.fill();
  ctx.restore();
}

// molten fireball with rising cinders — abyssal fire magic
function drawProjEmber(pr){
  const speed = Math.hypot(pr.vx,pr.vy)||1;
  const dirX = pr.vx/speed, dirY = pr.vy/speed;
  const tailLen = pr.radius*3.6;
  ctx.save();
  const tx = pr.x - dirX*tailLen, ty = pr.y - dirY*tailLen;
  const trailGrad = ctx.createLinearGradient(tx,ty,pr.x,pr.y);
  trailGrad.addColorStop(0,'rgba(0,0,0,0)');
  trailGrad.addColorStop(0.5,'rgba(255,90,61,0.5)');
  trailGrad.addColorStop(1,'#ffcb47');
  ctx.strokeStyle = trailGrad;
  ctx.lineWidth = pr.radius*1.6;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(tx,ty); ctx.lineTo(pr.x,pr.y); ctx.stroke();
  ctx.shadowColor = '#ff5a3d'; ctx.shadowBlur = 16;
  ctx.fillStyle = '#ff5a3d';
  ctx.beginPath(); ctx.arc(pr.x,pr.y,pr.radius,0,Math.PI*2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffcb47';
  ctx.beginPath(); ctx.arc(pr.x,pr.y,pr.radius*0.55,0,Math.PI*2); ctx.fill();
  if(Math.random()<0.5){
    game.particles.push({ x:pr.x, y:pr.y, vx:rand(-14,14), vy:-30-Math.random()*20, life:0.3, maxLife:0.3,
      color:'#ffcb47', r:1.6, type:'circle' });
  }
  ctx.restore();
}

function drawPlayer(p){
  ctx.save();
  ctx.translate(p.x,p.y);
  if(p.invuln>0 && Math.floor(performance.now()/60)%2===0){ ctx.globalAlpha=0.4; }
  if(p.effects.shadow>0){ ctx.globalAlpha=0.5; }
  // withering curse: a sickly pulsing aura with wisps drifting off, so the debuff actually reads on-screen
  if(p.witherTimer>0){
    const pulse = 0.5+Math.sin(performance.now()/180)*0.2;
    ctx.save();
    ctx.globalAlpha = 0.35+pulse*0.25;
    ctx.strokeStyle = '#a44fd9';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(0,0,p.radius+9,0,Math.PI*2); ctx.stroke();
    ctx.restore();
    if(Math.random()<0.25){
      const ang = Math.random()*Math.PI*2;
      game.particles.push({ x:p.x+Math.cos(ang)*p.radius, y:p.y+Math.sin(ang)*p.radius, vx:Math.cos(ang)*14, vy:-24-Math.random()*14,
        life:0.6, maxLife:0.6, color:'#a44fd9', r:1.8, type:'circle' });
    }
  }
  const accent = p.skinAccent || p.def.accent;
  const glowColor = p.effects.warcry>0 ? '#ff6a3d' : accent;
  const r = p.radius;
  const dark = shadeColor(accent, -68);

  // ---- ground shadow, so the figure reads as standing on the floor rather than floating ----
  ctx.save();
  ctx.globalAlpha *= 0.32;
  ctx.fillStyle = '#000';
  ctx.beginPath(); ctx.ellipse(0, r*0.8, r*0.82, r*0.3, 0, 0, Math.PI*2); ctx.fill();
  ctx.restore();

  // ---- hooded body: a robed silhouette instead of a bare circle ----
  ctx.save();
  ctx.shadowColor = glowColor; ctx.shadowBlur = p.effects.warcry>0?26:15;
  const bodyGrad = ctx.createLinearGradient(0,-r,0,r*0.9);
  bodyGrad.addColorStop(0, dark);
  bodyGrad.addColorStop(1, '#15111c');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.moveTo(-r*0.6, r*0.9);
  ctx.quadraticCurveTo(-r*0.95, r*0.05, -r*0.44, -r*0.58);
  ctx.quadraticCurveTo(0, -r*0.95, r*0.44, -r*0.58);
  ctx.quadraticCurveTo(r*0.95, r*0.05, r*0.6, r*0.9);
  ctx.quadraticCurveTo(0, r*1.08, -r*0.6, r*0.9);
  ctx.closePath(); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = accent; ctx.lineWidth = 2.6; ctx.stroke();

  // hood shadow — the "face" reads as a void rather than a drawn face, keeping every hero
  // legible from a distance regardless of class
  ctx.fillStyle = 'rgba(6,4,10,0.88)';
  ctx.beginPath(); ctx.ellipse(0,-r*0.22, r*0.32, r*0.38, 0, 0, Math.PI*2); ctx.fill();

  // twin glowing eyes in the class's accent color
  ctx.fillStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 9;
  ctx.beginPath();
  ctx.arc(-r*0.12,-r*0.22,r*0.065,0,Math.PI*2);
  ctx.arc(r*0.12,-r*0.22,r*0.065,0,Math.PI*2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // chest emblem — removed: the old flat emoji-icon look, now that the robed silhouette itself
  // carries the class identity via accent color + weapon shape
  ctx.restore();

  // ---- weapon, rotates with aim so melee/ranged read differently at a glance ----
  ctx.save();
  ctx.rotate(p.facing);
  const atkKind = p.def.atk ? p.def.atk.kind : (p.stance==='ranged' ? 'ranged' : 'melee');
  if(atkKind==='melee'){
    ctx.save();
    ctx.translate(r*0.85,0);
    ctx.fillStyle = accent;
    ctx.fillRect(-5,-2.5,7,5); // hilt
    ctx.beginPath();
    ctx.moveTo(2,-3); ctx.lineTo(r*0.85,-1.6); ctx.lineTo(r*0.98,0); ctx.lineTo(r*0.85,1.6); ctx.lineTo(2,3);
    ctx.closePath();
    ctx.fillStyle = '#d8d2c4'; ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.restore();
  } else {
    ctx.save();
    ctx.translate(r*0.92,0);
    ctx.strokeStyle = shadeColor(accent,-40); ctx.lineWidth = 2.6;
    ctx.beginPath(); ctx.moveTo(-r*0.42,0); ctx.lineTo(r*0.2,0); ctx.stroke();
    ctx.fillStyle = accent; ctx.shadowColor = accent; ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.arc(r*0.3,0,4,0,Math.PI*2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  }
  ctx.restore();

  if(p.shield>0){
    // was a flat static ring regardless of source — now a pulsing warded barrier, shared by every
    // hero that grants a shield (Paladín, Coloso, Midas, Tempus, Lira, Anselm, the generic parry
    // fallback, Escudo de Reacción...), so improving it once covers all of them at once
    ctx.save();
    const pulse = 0.5+Math.sin(performance.now()/220)*0.2;
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle='#ffcb47'; ctx.lineWidth=2.5;
    ctx.shadowColor='#ffcb47'; ctx.shadowBlur=10+pulse*6;
    ctx.beginPath(); ctx.arc(0,0,p.radius+7,0,Math.PI*2); ctx.stroke();
    ctx.shadowBlur=0;
    ctx.globalAlpha = 0.3+pulse*0.15;
    ctx.lineWidth=1;
    const n=6;
    for(let i=0;i<n;i++){
      const a=(i/n)*Math.PI*2 + performance.now()/2000;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*(p.radius+3), Math.sin(a)*(p.radius+3));
      ctx.lineTo(Math.cos(a+Math.PI*2/n)*(p.radius+11), Math.sin(a+Math.PI*2/n)*(p.radius+11));
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

function drawParticle(pt){
  ctx.save();
  const alpha = clamp(pt.life/pt.maxLife,0,1);
  ctx.globalAlpha = alpha;
  if(pt.type==='circle'){
    ctx.fillStyle=pt.color;
    ctx.beginPath(); ctx.arc(pt.x,pt.y,pt.r,0,Math.PI*2); ctx.fill();
  } else if(pt.type==='combo'){
    // quick pop-in scale over the first ~0.07s, then holds full size while it fades out
    const progress = 1-(pt.life/pt.maxLife);
    const pop = Math.min(1, progress*7);
    ctx.translate(pt.x,pt.y);
    ctx.scale(pop,pop);
    ctx.shadowColor = pt.color; ctx.shadowBlur = 8;
    ctx.fillStyle = pt.color;
    ctx.font = `800 ${pt.size}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-mono')}`;
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(pt.text, 0, 0);
  } else {
    ctx.fillStyle=pt.color;
    ctx.font=`700 ${pt.size}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-mono')}`;
    ctx.textAlign='center';
    ctx.fillText(pt.text, pt.x, pt.y);
  }
  ctx.restore();
}

/* ============================================================
   INITIAL RENDER (idle background on menu)
   ============================================================ */
function idleRender(){
  ctx.fillStyle='#0a0710';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  requestAnimationFrame(idleRender);
}
idleRender();

})();
