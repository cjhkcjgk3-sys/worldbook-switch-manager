import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeST} from './sim.js';
const entries=()=>[1,2,3].map((uid,i)=>({world:'book',uid,key:[['alpha','beta','gamma'][i]],content:`LORE_${uid}`,position:0}));
const make=patch=>{const s=new FakeST({capEnabled:true,capLimit:1,cooldown:2,...patch});s.entries=entries();return s;};
const ids=r=>r.active.map(e=>e.uid);
const delta=s=>s.chat.at(-1).extra?.wsm?.d;
const cap=s=>delta(s)?.cap;
async function round(s,opts={}){await s.user('alpha beta gamma');return s.generate('normal',opts);}
async function stage(s,list,{next=0,loopCount=1}={}){const accepted=new Map(list.map(e=>[`${e.world}.${e.uid}`,e]));await s.emit('WORLDINFO_SCAN_DONE',{state:{next,loopCount},activated:{entries:accepted}});return [...accepted.values()];}

test('A01: native accepted description/recursive/macro candidates are limited even without a raw-chat match',async()=>{const s=make();await s.user('hello');const r=await s.generate('normal',{nativeEligible:entries()});assert.equal(r.active.length,1);assert.deepEqual(cap(s),[['book','1']]);});
test('A02: ineligible quiet-only/failed-probability entries do not take a native accepted slot',async()=>{const s=make();await s.user('alpha beta');const r=await s.generate('normal',{nativeEligible:[entries()[1]]});assert.deepEqual(ids(r),[2]);assert.deepEqual(cap(s),[['book','2']]);});
test('A03: continue has one shared round quota independent of automatic cooldown',async()=>{for(const automatic of [true,false]){const s=make({automatic});await round(s);const r=await s.generate('continue',{nativeEligible:[entries()[1]]});assert.deepEqual(ids(r),[]);assert.deepEqual(cap(s),[['book','1']]);assert.equal(delta(s).round,1);if(!automatic)assert.deepEqual(delta(s).inj,[]);}});
test('A04: regenerate after host removes only target keeps surviving prior AI context',async()=>{const s=make();await s.user('start');await s.generate('normal',{text:'alpha beta',scanText:''});await s.generate('normal',{text:'old target',scanText:''});const r=await s.generate('regenerate',{nativeEligible:entries().slice(0,2)});assert.equal(r.active.length,1);});
test('native scan pruning waits for final loop, includes max recursion termination',async()=>{const s=make();await s.user('alpha beta');await s.emit('GENERATION_STARTED','normal',{},false);let a=await stage(s,entries(),{next:2});assert.equal(a.length,3);a=await stage(s,a);assert.equal(a.length,1);s.manager.adapter.scanOptions=()=>({maxRecursionSteps:2});a=await stage(s,entries(),{next:2,loopCount:2});assert.equal(a.length,1);});
test('stop/failure creates no quota, retries are free; successful reload preserves quota',async()=>{for(const opts of [{stream:true,stop:true},{fail:true}]){const s=make({automatic:false});await round(s,opts);assert.equal(cap(s),undefined);const r=await s.generate(opts.fail?'normal':'regenerate');assert.deepEqual(ids(r),[1]);await s.reload();assert.deepEqual(ids(await s.generate('continue',{nativeEligible:[entries()[1]]})),[]);}});
test('n>1, selected swipes, deletion and branch rollback carry only current visible quota',async()=>{const s=make({automatic:false});await round(s,{n:3,stream:true});for(const sw of s.chat.at(-1).swipe_info)assert.deepEqual(sw.extra.wsm.d.cap,[['book','1']]);await s.generate('swipe',{nativeEligible:[entries()[1]]});assert.deepEqual(cap(s),[['book','2']]);await s.swipeTo(0);assert.deepEqual(cap(s),[['book','1']]);await s.deleteSwipe();assert.deepEqual(cap(s),[['book','1']]);const point=s.chat.length-1;await round(s);const main=await s.branch(point);assert.deepEqual(ids(await s.generate('continue',{nativeEligible:[entries()[2]]})),[]);await s.open(main);await s.truncate(point+1);assert.deepEqual(ids(await s.generate('continue',{nativeEligible:[entries()[1]]})),[]);});
test('tool continuation shares transient quota; failure rolls it back, success commits just once',async()=>{const s=make({automatic:false});await round(s,{tool:true});assert.deepEqual(cap(s),[['book','1']]);const f=make({automatic:false});await round(f,{tool:true,toolText:'visible',followFail:true});assert.ok(!f.chat.some(m=>m.extra?.wsm?.d?.cap));assert.deepEqual(ids(await round(f)),[1]);});
test('dryRun/quiet native selections never commit quota or overwrite successful summary',async()=>{const s=make();await round(s,{quietInside:true,preview:true});assert.deepEqual(cap(s),[['book','1']]);const n=s.manager.lastCapSkipped;await s.emit('GENERATION_STARTED','normal',{},true);await stage(s,entries());assert.equal(s.manager.lastCapSkipped,n);});
test('cap off does not alter accepted map or add quota fields',async()=>{const s=make({capEnabled:false});const r=await round(s);assert.deepEqual(ids(r),[1,2,3]);assert.equal(cap(s),undefined);});
test('native hook missing: disable cap safely with explicit notice, no legacy simulation',async()=>{const s=make();s.manager.stop();delete s.ctx.eventTypes.WORLDINFO_SCAN_DONE;s.manager.start();assert.match(s.manager.capWarning,/WORLDINFO_SCAN_DONE/);const r=await round(s);assert.deepEqual(ids(r),[1,2,3]);assert.equal(cap(s),undefined);});

test('A05: 600 different native candidate depths fit a 128MB independent Node heap', async()=>{
    const {spawnSync}=await import('node:child_process');
    const core=new URL('../core.js',import.meta.url).href;
    const js=`import {selectGreenCapVictims,settingsWithDefaults} from ${JSON.stringify(core)};
    const chat=Array.from({length:600},(_,i)=>({is_user:!!(i%2),mes:'x'.repeat(1000)}));
    const es=Array.from({length:600},(_,uid)=>({world:'b',uid,key:['absent'],scanDepth:uid+1}));
    const v=selectGreenCapVictims(es,chat,settingsWithDefaults({capEnabled:true,capLimit:5}));
    if(v.length!==595)process.exit(2);`;
    const r=spawnSync(process.execPath,['--max-old-space-size=128','--input-type=module','-e',js],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);assert.equal(r.error,undefined);
});

test('automatic off + capEnabled on does not render or emit cooldown evidenceWarning while committing quota',async()=>{
    const s=make({automatic:false,capEnabled:true,capLimit:1});
    let renders=0;
    s.manager.adapter.render=()=>{renders++;return '';};
    await round(s);
    assert.equal(renders,0);
    assert.equal(s.manager.evidenceWarning,'');
    assert.deepEqual(cap(s),[['book','1']]);
});

test('continue with full quota and active constant entry preserves lastCapSkipped',async()=>{
    const blue={world:'book',uid:99,key:[],constant:true,content:'BLUE_RULE',position:0};
    const s=make({capEnabled:true,capLimit:1,automatic:false});
    s.entries=[...entries(),blue];
    await round(s,{nativeEligible:[entries()[0],blue]});
    const r=await s.generate('continue',{nativeEligible:[entries()[1],entries()[2],blue]});
    assert.deepEqual(ids(r),[99]);
    assert.equal(s.manager.lastCapSkipped,2);
});
