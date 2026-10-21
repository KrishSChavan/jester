/** Optional real-Chrome smoke: node tests/browser-smoke.mjs
 * Uses a fresh temporary profile and fake extension/media APIs. No devices,
 * provider endpoints, installed extension state or user browser profiles.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DEFAULT_SETTINGS } from '../jester-extension/src/common/constants.js';

const extension = fileURLToPath(new URL('../jester-extension/', import.meta.url));
const chromeBinary = process.env.JESTER_SMOKE_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
await access(chromeBinary);
const artifacts = await mkdtemp(resolve(tmpdir(), 'jester-browser-smoke-'));
const profile = resolve(artifacts, 'isolated-profile');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const fixture = `<!doctype html><meta charset="utf-8"><title>Jester browser smoke</title>
<style>body{background:#17202b;color:white;font:20px system-ui;padding:70px}button{font:inherit;padding:18px;margin:15px}input{font:inherit}</style>
<h1>Rick &amp; Morty</h1><h2>Season 3 Episode 1</h2><p>Episode 1 is ready to play.</p>
<button id="play" onclick="this.dataset.pressed='true'">Play episode 1</button>
<label>Search shows <input id="search" aria-label="Search shows"></label>
<p hidden>hidden fixture text should be omitted</p>
<script src="/src/content/agent-page.js"></script><script src="/src/content/content.js"></script>`;
const entertainmentFixture = `<!doctype html><meta charset="utf-8"><title>Streaming fixture</title>
<style>body{font:20px system-ui;padding:40px}button,select{font:inherit;padding:15px;margin:12px}video{width:500px;height:280px;background:#17202b}</style>
<main id="app"><h1>Continue Watching</h1><button id="show">Rick &amp; Morty</button></main>
<script>
window.__episodeFixture={activeSeason:1,clickedSeason:null,trace:[],seasonDelayMs:80};
document.getElementById('show').onclick=()=>{
  __episodeFixture.trace.push('open-show');document.title='Rick & Morty';
  document.getElementById('app').innerHTML='<h1>Rick &amp; Morty</h1><h2 id="season-heading">Season 1</h2><label>Season <select id="season" aria-label="Season"><option value="1" selected>Season 1</option><option value="3">Season 3</option></select></label><article id="episode-card">Season 1 <button id="episode">Play episode 1</button></article>';
  document.getElementById('season').onchange=()=>{
    __episodeFixture.trace.push('request-season-'+document.getElementById('season').value);
    // Native selection changes immediately; old episode controls remain until
    // the asynchronous pane update. Clicking them would play the wrong season.
    setTimeout(()=>{
      __episodeFixture.activeSeason=3;
      document.getElementById('season-heading').textContent='Season 3';
      document.getElementById('episode-card').firstChild.nodeValue='Season 3 ';
      __episodeFixture.trace.push('season-3-ready');
    },__episodeFixture.seasonDelayMs);
  };
  document.getElementById('episode').onclick=()=>{
    const season=__episodeFixture.activeSeason;
    __episodeFixture.clickedSeason=season;__episodeFixture.trace.push('play-season-'+season+'-episode-1');
    document.title='Rick & Morty Season '+season+' Episode 1';
    document.getElementById('app').innerHTML='<h1>Rick &amp; Morty Season '+season+' Episode 1</h1><video aria-label="Rick &amp; Morty Season '+season+' Episode 1"></video>';
    // A fixture playback state, with no media/network/device dependency.
    Object.defineProperty(document.querySelector('video'),'paused',{get:()=>false});
  };
};
</script><script src="/src/content/agent-page.js"></script><script src="/src/content/content.js"></script>`;
// YouTube's in-app navigation as measured live: the address changes at once, the
// old page goes ~100 ms later, then nothing changes for ~800 ms while results load,
// with the top progress bar up throughout. Reading in that gap found no results.
const spaNavigationFixture = `<!doctype html><meta charset="utf-8"><title>Home - Fixture</title>
<yt-page-navigation-progress hidden aria-valuenow="0"></yt-page-navigation-progress>
<button id="go">Search</button><main id="app"><a href="/watch?v=old">Old feed video</a></main>
<script>
window.__spa={trace:[]};
document.getElementById('go').onclick=()=>{
  const bar=document.querySelector('yt-page-navigation-progress');
  history.pushState({},'','/results?search_query=MrBeast');document.title='MrBeast - Fixture';
  bar.hidden=false;bar.setAttribute('aria-valuenow','5');__spa.trace.push('navigate-start');
  setTimeout(()=>{document.getElementById('app').innerHTML='';},100);
  let value=5;const tick=setInterval(()=>{value=Math.min(95,value+10);bar.setAttribute('aria-valuenow',String(value));},100);
  setTimeout(()=>{
    clearInterval(tick);
    document.getElementById('app').innerHTML='<a href="/@MrBeast">Go to channel MrBeast</a><a href="/watch?v=new">Newest upload</a>';
    bar.setAttribute('aria-valuenow','100');bar.hidden=true;__spa.trace.push('results-ready');
  },900);
};
</script><script src="/src/content/agent-page.js"></script><script src="/src/content/content.js"></script>`;
// Representative Hulu-style controls, not a copy of the live Hulu DOM. The
// absent home-page title forces search; asynchronous results and season panes
// exercise production observations rather than predetermined model replies.
const huluSearchFixture = `<!doctype html><meta charset="utf-8"><title>Hulu-style home fixture</title>
<style>body{font:20px system-ui;padding:40px;background:#f5f5f5}button,input{font:inherit;padding:15px;margin:12px}a{display:inline-block;margin:15px}img{width:170px;height:220px}video{width:500px;height:280px;background:#17202b}.result-card{display:inline-block;position:relative;width:260px;vertical-align:top}.result-card .poster{display:block;margin:0;min-height:290px}.result-card .details{position:absolute;inset:0;margin:0;z-index:2;background:rgba(20,30,40,.12);display:flex;align-items:flex-end;padding:16px;box-sizing:border-box}.fragmented-card{line-height:220px}.fragmented-card .poster{display:inline;min-height:0}.fragmented-card .poster span{white-space:nowrap}</style>
<nav><button id="search-nav">Search</button></nav>
<main id="app"><h1>Home</h1><h2>Continue Watching</h2><button>Only Murders in the Building</button></main>
<script>
const fixtureParams=new URLSearchParams(location.search);
const fixtureEpisode=fixtureParams.has('episode')?Number(fixtureParams.get('episode')):1;
window.__huluFixture={activeSeason:1,clickedSeason:null,clickedEpisode:null,searchDelayMs:1200,seasonDelayMs:80,trace:[]};
function openShow(event){
  event.preventDefault();__huluFixture.trace.push('open-exact-show');document.title='Hulu | Series';
  document.getElementById('app').innerHTML='<h1>Rick and Morty</h1><h2 id="season-heading">Season 1</h2><button id="season-menu" aria-haspopup="listbox" aria-expanded="false">Select a season</button><div id="season-options" role="listbox" hidden><button role="option" aria-selected="true" data-season="1">Season 1 (11 Episodes)</button><button role="option" aria-selected="false" data-season="3">Season 3 (10 Episodes)</button></div><article id="episode-card">Season 1 <button id="episode">S1 E'+fixtureEpisode+'</button></article>';
  const menu=document.getElementById('season-menu'),options=document.getElementById('season-options');
  menu.onclick=()=>{__huluFixture.trace.push('open-seasons');menu.setAttribute('aria-expanded','true');options.hidden=false};
  for(const option of options.querySelectorAll('[role="option"]'))option.onclick=()=>{
    const requested=Number(option.dataset.season);__huluFixture.trace.push('request-season-'+requested);
    menu.textContent='Season '+requested+' (10 Episodes)';menu.setAttribute('aria-expanded','false');options.hidden=true;
    // The selector reflects the request immediately, but the old season heading
    // and episode remain until the pane arrives. Their disagreement must wait.
    setTimeout(()=>{
      __huluFixture.activeSeason=requested;document.getElementById('season-heading').textContent='Season '+requested;
      document.getElementById('episode-card').firstChild.nodeValue='Season '+requested+' ';
      document.getElementById('episode').textContent='S'+requested+' E'+fixtureEpisode;
      __huluFixture.trace.push('season-'+requested+'-ready');
    },__huluFixture.seasonDelayMs);
  };
  document.getElementById('episode').onclick=()=>{
    const season=__huluFixture.activeSeason;__huluFixture.clickedSeason=season;__huluFixture.clickedEpisode=fixtureEpisode;
    __huluFixture.trace.push('play-season-'+season+'-episode-'+fixtureEpisode);document.title='Rick and Morty Season '+season+' Episode '+fixtureEpisode;
    document.getElementById('app').innerHTML='<h1>Rick and Morty Season '+season+' Episode '+fixtureEpisode+'</h1><video aria-label="Rick and Morty Season '+season+' Episode '+fixtureEpisode+'"></video>';
    Object.defineProperty(document.querySelector('video'),'paused',{get:()=>false});
  };
}
document.getElementById('search-nav').onclick=()=>{
  __huluFixture.trace.push('open-search');document.title='Search';
  document.getElementById('app').innerHTML='<h1>Search</h1><input id="search-input" name="search" type="search" role="searchbox" aria-label="What are you looking for?"><section id="search-results" aria-live="polite"></section>';
  let pending;document.getElementById('search-input').oninput=()=>{
    clearTimeout(pending);const value=document.getElementById('search-input').value;
    __huluFixture.trace.push('search-input:'+value);
    pending=setTimeout(()=>{
      if(!/rick.*morty/i.test(value))return;
      const poster='data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="170" height="220"%3E%3Crect width="170" height="220" fill="%23435c46"/%3E%3C/svg%3E';
      // A multiline inline link has separate browser client rectangles. Its
      // union rectangle includes the noninteractive line-height gap, which is
      // not evidence that another page control covers the result.
      const fragmented=fixtureParams.has('fragmented');
      const posterContent=fragmented?'<span>Rick and Morty</span><br><span>(2013) TV-MA 7 Seasons</span>':'<img alt="Rick and Morty"><span>Rick and Morty (2013) TV-MA 7 Seasons</span>';
      const results=document.getElementById('search-results');results.innerHTML='<h2>Top Results</h2><article class="result-card"><a id="anime-result" href="/series/rick-and-morty-the-anime"><img alt="Rick and Morty: The Anime"></a></article><article class="result-card'+(fragmented?' fragmented-card':'')+'"><a id="exact-result" class="poster" href="/series/rick-and-morty" aria-label="Rick and Morty (2013) TV-MA 7 Seasons">'+posterContent+'</a>'+(fixtureParams.has('covered')?'<a id="exact-details" class="details" href="/series/rick-and-morty">Details</a>':'')+'</article>';
      for(const image of results.querySelectorAll('img'))image.src=poster;
      document.getElementById('anime-result').onclick=event=>{event.preventDefault();__huluFixture.trace.push('wrong-anime-click')};
      if(fixtureParams.has('covered')){
        // These are siblings, so a hit test on the poster cannot succeed by
        // treating the visible Details control as a child of that poster.
        document.getElementById('exact-result').onclick=event=>{event.preventDefault();__huluFixture.trace.push('forbidden-poster-click')};
        document.getElementById('exact-details').onclick=event=>{__huluFixture.trace.push('click-live-details');openShow(event)};
      }else document.getElementById('exact-result').onclick=openShow;
      __huluFixture.trace.push('search-results-ready');
    },__huluFixture.searchDelayMs);
  };
  // Hulu's instant search: while the keyboard drives the list, an empty
  // transparent layer covers the page until the next mouse move.
  if(fixtureParams.has('blocker'))for(const type of ['input','keydown'])document.getElementById('search-input').addEventListener(type,()=>{
    if(document.getElementById('mouse-blocker'))return;
    const blocker=document.createElement('div');blocker.id='mouse-blocker';blocker.setAttribute('role','none');
    blocker.style.cssText='position:fixed;inset:0;z-index:200;background:transparent';
    blocker.onmousemove=()=>queueMicrotask(()=>{blocker.remove();__huluFixture.trace.push('mouse-blocker-removed')});
    document.getElementById('search-input').style.cssText='position:relative;z-index:201';
    document.body.append(blocker);__huluFixture.trace.push('mouse-blocker-shown');
  });
};
if(new URLSearchParams(location.search).has('series'))openShow({preventDefault(){}});
</script><script src="/src/content/agent-page.js"></script><script src="/src/content/content.js"></script>`;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/fixture.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixture); return; }
    if (pathname === '/entertainment-fixture.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(entertainmentFixture); return; }
    if (pathname === '/hulu-search-fixture.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(huluSearchFixture); return; }
    if (pathname === '/spa-navigation-fixture.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(spaNavigationFixture); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const file = resolve(extension, pathname.slice(1));
    if (!file.startsWith(extension)) throw new Error('Invalid fixture path');
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(await readFile(file));
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const origin = `http://127.0.0.1:${server.address().port}`;
let child;
let socket;
let chromeError = '';
const checks = [];
try {
  child = spawn(chromeBinary, [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-default-apps',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-features=MediaRouter', '--window-size=1280,900', 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (data) => { chromeError = (chromeError + data).slice(-10000); });
  let portFile;
  for (let count = 0; count < 120; count++) {
    try { portFile = await readFile(resolve(profile, 'DevToolsActivePort'), 'utf8'); break; } catch {}
    if (child.exitCode !== null) throw new Error(`Chrome exited ${child.exitCode}: ${chromeError}`);
    await pause(50);
  }
  if (!portFile) throw new Error(`Chrome did not start its isolated debugger: ${chromeError}`);
  const [port, path] = portFile.trim().split('\n');
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push({ sessionId: message.sessionId, detail: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text });
    }
  });
  function command(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const fakeState = { settings: DEFAULT_SETTINGS, engine: { state: 'off', mic: { state: 'idle' } }, history: [], hasTarget: false, context: 'windowed', voiceBlocked: false };
  const stub = `(() => {
    const state = ${JSON.stringify(fakeState)};
    const runtimeListeners = [], storageListeners = [], log = [], modelConnections = [];
    let nextModelId = 1;
    const local = {settings: structuredClone(state.settings)};
    function event(list) {return {addListener(fn){list.push(fn)},removeListener(fn){const i=list.indexOf(fn);if(i>=0)list.splice(i,1)}};}
    function area(data, name) {return {
      async get(keys){if(typeof keys==='string')return {[keys]:data[keys]};return structuredClone(data)},
      async set(patch){const changes={};for(const [key,value] of Object.entries(patch)){changes[key]={oldValue:structuredClone(data[key]),newValue:structuredClone(value)};data[key]=structuredClone(value)};for(const fn of storageListeners)await fn(changes,name)},
      async remove(key){delete data[key]}
    };}
    Object.defineProperty(globalThis,'chrome',{configurable:true,value:{
      runtime:{id:'jester-smoke',getURL:path=>location.origin+'/'+path,onMessage:event(runtimeListeners),
        async sendMessage(message){
          log.push(structuredClone(message));
          if(message.type==='jester/get-state')return {...structuredClone(state),settings:structuredClone(local.settings)};
          if(message.type==='jester/model-get')return {ok:true,connection:{connected:!!modelConnections.length,connections:structuredClone(modelConnections),...structuredClone(modelConnections[0]||{})}};
          if(message.type==='jester/model-save'){
            const {key,...metadata}=message.connection;
            const connection={...metadata,id:metadata.id||'fixture-model-'+nextModelId++,masked:'••••fixture',cooldownUntil:0};
            const index=modelConnections.findIndex(item=>item.id===connection.id);
            if(index<0)modelConnections.push(connection);else modelConnections[index]=connection;
          }
          if(message.type==='jester/model-clear'){
            const index=modelConnections.findIndex(item=>item.id===message.id);
            if(index>=0)modelConnections.splice(index,1);
          }
          if(message.type==='jester/model-reorder'){
            const ordered=message.ids.map(id=>modelConnections.find(item=>item.id===id));
            modelConnections.splice(0,modelConnections.length,...ordered);
          }
          if(message.type==='jester/model-list')return {ok:true,models:['fixture-listed-model']};
          if(message.type==='jester/get-calibration')return {calibration:null};
          return {ok:true};
        },
        openOptionsPage(){}
      },
      storage:{local:area(local,'local'),session:area({history:[]},'session'),onChanged:event(storageListeners)},
      permissions:{async contains(){return false},async request(){return true},async remove(){return true}},
      scripting:{async registerContentScripts(){},async unregisterContentScripts(){}},
      tabs:{async create(){return {id:99}}}
    }});
    Object.defineProperty(navigator,'permissions',{configurable:true,value:{async query(){return {state:'granted',onchange:null}}}});
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{async enumerateDevices(){return []},async getUserMedia(){throw new DOMException('No media devices in smoke tests','NotAllowedError')}}});
    class Speech {static async available(){return 'available'}static async install(){return true}}
    Speech.prototype.processLocally=false;
    Object.defineProperty(globalThis,'SpeechRecognition',{configurable:true,value:Speech});
    globalThis.__smoke={local,log,async deliver(message){let response;const sender={id:'jester-smoke',url:location.origin+'/src/background/service-worker.js'};for(const fn of runtimeListeners)fn(message,sender,value=>response=value);await new Promise(resolve=>setTimeout(resolve,30));return response},
      request(message){const sender={id:'jester-smoke',url:location.origin+'/src/background/service-worker.js'};return new Promise(resolve=>{for(const fn of runtimeListeners)fn(message,sender,resolve);});}};
  })();`;
  async function page(pathname) {
    const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
    await command('Runtime.enable', {}, sessionId);
    await command('Page.enable', {}, sessionId);
    await command('Page.addScriptToEvaluateOnNewDocument', { source: stub }, sessionId);
    await command('Page.navigate', { url: origin + pathname }, sessionId);
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    async function until(expression) {
      for (let attempt = 0; attempt < 120; attempt++) { if (await evaluate(expression)) return; await pause(25); }
      throw new Error(`Page did not become ready: ${pathname} (${expression})`);
    }
    await until('document.readyState === "complete" && !!globalThis.__smoke');
    const capture = async (name) => {
      const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      await writeFile(resolve(artifacts, name + '.png'), Buffer.from(screenshot.data, 'base64'));
    };
    return { evaluate, until, capture, sessionId, targetId };
  }

  const options = await page('/src/options/options.html');
  await options.until('document.querySelectorAll("#gestureTable tbody tr").length === 7 && document.getElementById("pointerAim").options.length === 3');
  await options.evaluate(`(() => {const input=document.getElementById('pointerInput');input.value='voice';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await options.until('__smoke.local.settings.pointerInput === "voice" && document.getElementById("eyeControls").hidden');
  await options.evaluate(`(() => {const input=document.getElementById('pointerInput');input.value='both';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await options.until('__smoke.local.settings.pointerInput === "both" && !document.getElementById("eyeControls").hidden');
  assert.equal(await options.evaluate('document.getElementById("speechStatus").textContent'), 'On-device speech is ready.');
  await options.capture('options');
  await options.evaluate(`document.getElementById('pointerSection').scrollIntoView({block:'start'})`);
  await pause(80);
  await options.capture('options-cursor-voice');
  await options.evaluate(`document.getElementById('aiSection').scrollIntoView({block:'start'})`);
  await pause(80);
  await options.capture('options-model-provider');
  const originalModelFields = await options.evaluate(`(() => ({provider:document.getElementById('provider').value,model:document.getElementById('modelId').value,key:document.getElementById('apiKey').value}))()`);
  await options.evaluate(`(() => {
    document.getElementById('modelId').value='existing-model-to-preserve';
    document.getElementById('apiKey').value='fixture-only-not-a-real-key';
    const provider=document.getElementById('provider');provider.value='google';provider.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await options.until('!document.getElementById("googleProviderHelp").hidden');
  const googleHelp = await options.evaluate(`(() => ({
    text:document.getElementById('googleProviderHelp').textContent,
    suggestion:[...document.getElementById('modelList').options].map(option=>option.value),
    placeholder:document.getElementById('modelId').placeholder,
    model:document.getElementById('modelId').value,key:document.getElementById('apiKey').value,
    saves:__smoke.log.filter(message=>message.type==='jester/model-save').length
  }))()`);
  assert.match(googleHelp.text, /gemini-3\.5-flash-lite/);
  assert.match(googleHelp.text, /quotas vary by project/);
  assert.ok(googleHelp.suggestion.includes('gemini-3.5-flash-lite'));
  assert.equal(googleHelp.placeholder, 'gemini-3.5-flash-lite');
  assert.equal(googleHelp.model, 'existing-model-to-preserve');
  assert.equal(googleHelp.key, 'fixture-only-not-a-real-key');
  assert.equal(googleHelp.saves, 0, 'Choosing a provider must not save or connect it');
  await options.capture('options-model-google');
  await options.evaluate(`(() => {
    const original=${JSON.stringify(originalModelFields)};
    const provider=document.getElementById('provider');provider.value=original.provider;provider.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('modelId').value=original.model;document.getElementById('apiKey').value=original.key;
  })()`);
  assert.equal(await options.evaluate('document.getElementById("googleProviderHelp").hidden'), true);
  await options.evaluate(`(() => {const provider=document.getElementById('provider');provider.value='custom';provider.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await options.capture('options-model-custom');
  checks.push('Options loaded, gesture/aim choices populated, cursor mode changed and persisted.');
  checks.push('Google model help and suggestion render without changing or saving the existing model/key fields.');

  await options.evaluate(`(() => {
    const provider=document.getElementById('provider');provider.value='groq';provider.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('modelId').value='openai/gpt-oss-120b';document.getElementById('apiKey').value='fixture-only-not-a-real-key';
    document.getElementById('connectModelBtn').click();
  })()`);
  await options.until('document.querySelectorAll("#modelConnections li").length === 1 && !document.getElementById("connectModelBtn").disabled');
  await options.evaluate(`(() => {
    const provider=document.getElementById('provider');provider.value='google';provider.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('modelId').value='gemini-fixture';document.getElementById('apiKey').value='fixture-only-not-a-real-key';
    document.getElementById('connectModelBtn').click();
  })()`);
  await options.until('document.querySelectorAll("#modelConnections li").length === 2 && !document.getElementById("connectModelBtn").disabled');
  assert.equal(await options.evaluate('document.getElementById("apiKey").value'), '', 'Adding a model clears its key from the form');
  assert.equal(await options.evaluate('[...document.querySelectorAll("#modelConnections li button")].find(button=>button.textContent==="Move up").disabled'), true);
  await options.evaluate('[...document.querySelectorAll("#modelConnections li")][1].querySelector("button").click()');
  await options.until('document.querySelector("#modelConnections li strong").textContent.includes("gemini-fixture")');
  await options.evaluate('[...document.querySelector("#modelConnections li").querySelectorAll("button")].find(button=>button.textContent==="Edit").click()');
  assert.equal(await options.evaluate('document.getElementById("modelFormTitle").textContent'), 'Edit model');
  assert.equal(await options.evaluate('document.getElementById("apiKey").value'), '', 'Editing never reads a saved key back into the form');
  assert.equal(await options.evaluate('document.getElementById("modelId").value'), 'gemini-fixture');
  await options.evaluate(`document.getElementById('loadModelsBtn').click()`);
  await options.until('document.querySelector("#modelList option")?.value === "fixture-listed-model"');
  assert.equal(await options.evaluate('__smoke.log.find(message=>message.type==="jester/model-list").id'), 'fixture-model-2');
  await options.evaluate(`document.getElementById('modelId').value='gemini-edited-fixture';document.getElementById('apiKey').value='fixture-only-not-a-real-key';document.getElementById('connectModelBtn').click()`);
  await options.until('document.querySelector("#modelConnections li strong").textContent.includes("gemini-edited-fixture") && !document.getElementById("connectModelBtn").disabled');
  assert.equal(await options.evaluate('document.querySelectorAll("#modelConnections li").length'), 2, 'Editing updates the existing model');
  assert.equal(await options.evaluate('document.querySelector("#modelConnections li").dataset.modelId'), 'fixture-model-2');
  assert.doesNotMatch(await options.evaluate('document.getElementById("modelConnections").textContent'), /fixture-only-not-a-real-key/);
  await options.capture('options-model-fallback-order');
  await options.evaluate('[...document.querySelector("#modelConnections li").querySelectorAll("button")].find(button=>button.textContent==="Remove").click()');
  await options.until('document.querySelectorAll("#modelConnections li").length === 1 && document.querySelector("#modelConnections li strong").textContent.includes("gpt-oss-120b")');
  checks.push('Model settings add two providers, reorder the queue, edit by stable ID without reading a key back, list models using the chosen connection, and remove one model.');

  const popup = await page('/src/popup/popup.html');
  await popup.until('document.getElementById("pointerInput").value === "eyes-head"');
  await popup.evaluate(`document.getElementById('listenBtn').click()`);
  assert.equal(await popup.evaluate(`__smoke.log.filter(message=>message.type==='jester/voice-control'&&message.action==='start').length`), 1);
  await popup.evaluate(`__smoke.deliver({type:'jester/telemetry',telemetry:{pointer:{active:true,state:'active',progress:.75},mic:{state:'idle'},fps:20}})`);
  assert.equal(await popup.evaluate('document.getElementById("gestureBar").style.width'), '75%');
  assert.equal(await popup.evaluate('document.getElementById("notice").hidden'), true);
  await popup.capture('popup');
  checks.push('Popup loaded; Start voice sends once; eyes/head progress renders without idle warnings.');

  const calibration = await page('/src/calibration/calibration.html');
  await calibration.until('!!document.getElementById("startBtn") && __smoke.log.some(message=>message.type==="jester/calibration-mode")');
  checks.push('Calibration module initialized against its real HTML without camera access.');

  const content = await page('/fixture.html');
  await content.until('!!globalThis.__jesterAgentPage && !!globalThis.__jesterContentLoaded');
  const observation = await content.evaluate(`__jesterAgentPage.observe({goal:'Play Rick & Morty Season 3 Episode 1'})`);
  assert.match(observation.text, /Season 3 Episode 1/);
  assert.doesNotMatch(JSON.stringify(observation), /hidden fixture text/);
  const play = observation.elements.find(element => element.name === 'Play episode 1');
  assert.ok(play?.id, 'Play button has a stable ID');
  const performed = await content.evaluate(`__jesterAgentPage.execute(${JSON.stringify({ action: 'click', elementId: play.id, pageId: observation.pageId })})`);
  assert.equal(performed.ok, true);
  assert.equal(await content.evaluate('document.getElementById("play").dataset.pressed'), 'true');
  await content.evaluate(`__smoke.deliver({type:'jester/voice',voice:{active:true,start:true,position:'bottom-center',levels:[1,.8,.6,.4,.2]}})`);
  await content.until('document.getElementById("jester-voice-host")?.shadowRoot?.querySelector(".pill.show")');
  assert.equal(await content.evaluate('document.getElementById("jester-voice-host").shadowRoot.querySelectorAll(".bar").length'), 5);
  await content.capture('voice-pill');
  await content.evaluate(`document.getElementById('jester-voice-host').shadowRoot.querySelector('button').click()`);
  assert.equal(await content.evaluate(`__smoke.log.filter(message=>message.type==='jester/cancel-task').length`), 1);
  checks.push('Real DOM semantic IDs execute the intended button; hidden text excluded; waveform pill and Cancel work.');

  await content.evaluate(`__smoke.deliver({type:'jester/model-cooldown',cooldown:{allLimited:true,readyAt:Date.now()+3500,provider:'Google',model:'gemini-fixture'}})`);
  await content.until('document.getElementById("jester-model-cooldown-host")?.shadowRoot?.querySelector(".badge:not([hidden])")');
  assert.match(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.textContent'), /All models rate-limited · Google gemini-fixture/);
  assert.match(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".clock").textContent'), /next retry in 0:0[34]/);
  assert.equal(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".clock").getAttribute("aria-hidden")'), 'true');
  assert.doesNotMatch(await content.evaluate('JSON.stringify(__jesterAgentPage.observe({goal:"All models rate-limited gemini-fixture"}))'), /All models rate-limited|gemini-fixture/);
  await content.evaluate(`__smoke.deliver({type:'jester/model-cooldown',cooldown:{allLimited:true,readyAt:Date.now()+1800,provider:'Groq',model:'next-fixture'}})`);
  assert.match(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".summary").textContent'), /Groq next-fixture/);
  await content.until('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".clock").textContent.endsWith("0:01")');
  await content.until('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".badge").hidden');
  await content.evaluate(`__smoke.deliver({type:'jester/model-cooldown',cooldown:{allLimited:true,readyAt:Date.now()+30000,provider:'Google',model:'gemini-fixture'}})`);
  await content.evaluate(`__smoke.deliver({type:'jester/model-cooldown',cooldown:null})`);
  assert.equal(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".badge").hidden'), true);
  await content.evaluate(`__smoke.deliver({type:'jester/model-cooldown',cooldown:{allLimited:true,readyAt:Infinity,provider:'Google',model:'gemini-fixture'}})`);
  assert.equal(await content.evaluate('document.getElementById("jester-model-cooldown-host").shadowRoot.querySelector(".badge").hidden'), true);
  checks.push('All-model cooldown shows the next model and live clock, updates on replacement, stays out of page observations, and hides at readiness or clear.');

  const streaming = await page('/entertainment-fixture.html');
  await streaming.until('!!globalThis.__jesterAgentPage && !!globalThis.__episodeFixture');
  const localFlow = await streaming.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0;const actions=[];let observations=0;
    const started=performance.now();
    const result=await runAssistant({text:'Play Rick and Morty season 3 episode 1',
      env:{provider:'groq',model:'openai/gpt-oss-120b',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('The local fixture must not require a provider');},
      host:{
        observe:async options=>{observations++;await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{const policy=__jesterAgentPage.classify(action);actions.push({action:action.action,label:policy.label});return __jesterAgentPage.execute(action,{boundary:'entertainment'});},
        checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,observations,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__episodeFixture.clickedSeason,trace:__episodeFixture.trace};
  })()`);
  assert.equal(localFlow.result.ok, true, JSON.stringify(localFlow));
  assert.equal(localFlow.modelCalls, 0, 'Visible exact show/season/episode controls require no model calls');
  assert.equal(localFlow.clickedSeason, 3, 'Old Season 1 controls must never be clicked while Season 3 loads');
  assert.equal(localFlow.actions.filter(action=>action.action==='click').length, 2);
  assert.ok(localFlow.trace.indexOf('season-3-ready') < localFlow.trace.indexOf('play-season-3-episode-1'));
  assert.ok(localFlow.elapsedMs < 10000, 'Local fixture should complete within the user\'s ten-second target');
  await writeFile(resolve(artifacts,'local-episode-flow.json'),JSON.stringify(localFlow,null,2));
  checks.push('Production assistant and real DOM tools select the correct delayed season/episode with zero provider calls.');

  const hulu = await page('/hulu-search-fixture.html');
  await hulu.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  const huluSearchFlow = await hulu.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0;const actions=[];let observations=0;
    const started=performance.now();
    const result=await runAssistant({text:'Can you please play season 3, episode 1 of Rick and Morty?',
      env:{provider:'groq',model:'openai/gpt-oss-120b',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('The Hulu-style search fixture must not require a provider');},
      host:{
        observe:async options=>{observations++;await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{const policy=__jesterAgentPage.classify(action);actions.push({action:action.action,label:policy.label});return __jesterAgentPage.execute(action,{boundary:'entertainment'});},
        checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,observations,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__huluFixture.clickedSeason,trace:__huluFixture.trace};
  })()`);
  assert.equal(huluSearchFlow.result.ok, true, JSON.stringify(huluSearchFlow));
  assert.equal(huluSearchFlow.modelCalls, 0, 'Search, exact poster, custom season and shorthand episode require no model calls');
  assert.equal(huluSearchFlow.clickedSeason, 3, 'Search flow must await the requested season pane');
  assert.equal(huluSearchFlow.trace.includes('wrong-anime-click'), false, 'The similarly named Anime poster must not be selected');
  assert.equal(huluSearchFlow.actions.filter(action=>action.action==='type').length, 1, 'Search is typed once');
  for(const [before,after] of [['open-search','search-results-ready'],['search-results-ready','open-exact-show'],
    ['open-exact-show','open-seasons'],['open-seasons','request-season-3'],['request-season-3','season-3-ready'],
    ['season-3-ready','play-season-3-episode-1']]){
    assert.ok(huluSearchFlow.trace.indexOf(before)>=0 && huluSearchFlow.trace.indexOf(before)<huluSearchFlow.trace.indexOf(after),
      'Expected '+before+' before '+after+': '+JSON.stringify(huluSearchFlow));
  }
  assert.ok(huluSearchFlow.elapsedMs < 10000, 'Controlled Hulu-style search fixture should finish within ten seconds');
  await writeFile(resolve(artifacts,'hulu-search-flow.json'),JSON.stringify(huluSearchFlow,null,2));
  checks.push('Representative Hulu home-to-search path waits for 1.2-second results, chooses the exact decorated poster and delayed custom season with zero provider calls.');

  const covered = await page('/hulu-search-fixture.html?covered=1&episode=2');
  await covered.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  const coveredSearchFlow = await covered.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0;const actions=[];let observations=0;
    const started=performance.now();
    const result=await runAssistant({text:'go to rick and morty season 3 episode 2',
      env:{provider:'google',model:'gemini-3.5-flash-lite',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('Covered search cards must recover from live semantic controls locally');},
      host:{
        observe:async options=>{observations++;await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{
          const policy=__jesterAgentPage.classify(action);
          const execution=await __jesterAgentPage.execute(action,{boundary:'entertainment'});
          actions.push({action:action.action,label:policy.label,result:execution});
          return execution;
        },
        checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,observations,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__huluFixture.clickedSeason,clickedEpisode:__huluFixture.clickedEpisode,trace:__huluFixture.trace};
  })()`);
  await writeFile(resolve(artifacts,'covered-search-card-flow.json'),JSON.stringify(coveredSearchFlow,null,2));
  assert.equal(coveredSearchFlow.result.ok,true,JSON.stringify(coveredSearchFlow));
  assert.equal(coveredSearchFlow.modelCalls,0,'The exact spoken command and a covered exact search poster must recover without provider calls');
  assert.equal(coveredSearchFlow.clickedSeason,3);
  assert.equal(coveredSearchFlow.clickedEpisode,2);
  assert.equal(coveredSearchFlow.trace.includes('wrong-anime-click'),false,'The similarly named Anime card must not be clicked');
  assert.equal(coveredSearchFlow.trace.includes('forbidden-poster-click'),false,'A covered poster must never receive a bypassed click');
  assert.equal(coveredSearchFlow.trace.filter(entry=>entry==='click-live-details').length,1,'Only the live Details link may open the exact series');
  const coveredFailures=coveredSearchFlow.actions.filter(entry=>entry.result.errorClass==='covered_target');
  assert.equal(coveredFailures.length,1,'Inspect one blocked poster and recover instead of repeating its failed click');
  assert.equal(coveredFailures[0].result.notDispatched,true,'Recovery is only safe before a press is dispatched');
  const blockingDetails=coveredFailures[0].result.blockingElements?.find(element=>element.name==='Details');
  assert.ok(blockingDetails?.id,'The blocker must be a registered live semantic control');
  assert.equal(blockingDetails.url,origin+'/series/rick-and-morty','The visible blocker must preserve the exact observed series destination');
  assert.equal(blockingDetails.sameDestination,true,'Raw destinations must also match before selecting the visible blocker');
  assert.ok(coveredSearchFlow.trace.indexOf('season-3-ready')<coveredSearchFlow.trace.indexOf('play-season-3-episode-2'));
  assert.ok(coveredSearchFlow.elapsedMs<10000,'Controlled covered-card flow should finish within ten seconds');
  checks.push('Exact spoken go-to command recovers a covered search poster using its live same-card Details link, avoids the Anime decoy and verifies season 3 episode 2 with zero provider calls.');

  const fragmented = await page('/hulu-search-fixture.html?fragmented=1&episode=2');
  await fragmented.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  const fragmentedSearchFlow = await fragmented.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0,geometry=null;const actions=[];const started=performance.now();
    const result=await runAssistant({text:'go to rick and morty season 3 episode 2',
      env:{provider:'google',model:'gemini-3.5-flash-lite',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('Visible fragmented search links must work without a provider');},
      host:{
        observe:async options=>{await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{
          const policy=__jesterAgentPage.classify(action),target=document.getElementById('exact-result');
          if(!geometry&&target&&action.action==='click'&&policy.label===target.getAttribute('aria-label')){
            target.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
            const r=target.getBoundingClientRect(),left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),
              top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
            const oldPoints=[[(left+right)/2,(top+bottom)/2],
              [left+(right-left)/4,top+(bottom-top)/4],[left+3*(right-left)/4,top+(bottom-top)/4],
              [left+(right-left)/4,top+3*(bottom-top)/4],[left+3*(right-left)/4,top+3*(bottom-top)/4]];
            const hit=([x,y])=>{const node=document.elementFromPoint(x,y);return !!node&&(node===target||target.contains(node));};
            const rects=Array.from(target.getClientRects()).filter(rect=>rect.width>0&&rect.height>0)
              .map(rect=>({left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom}));
            geometry={rects,oldPoints,oldUnionHits:oldPoints.map(hit),
              fragmentHits:rects.map(rect=>hit([(rect.left+rect.right)/2,(rect.top+rect.bottom)/2]))};
          }
          const execution=await __jesterAgentPage.execute(action,{boundary:'entertainment'});
          actions.push({action:action.action,label:policy.label,result:execution});return execution;
        },checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,geometry,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__huluFixture.clickedSeason,clickedEpisode:__huluFixture.clickedEpisode,trace:__huluFixture.trace};
  })()`);
  await writeFile(resolve(artifacts,'fragmented-search-card-flow.json'),JSON.stringify(fragmentedSearchFlow,null,2));
  assert.ok(fragmentedSearchFlow.geometry?.rects.length>=2,'Chrome must lay out a genuinely fragmented inline anchor');
  assert.deepEqual(fragmentedSearchFlow.geometry.oldUnionHits,[false,false,false,false,false],
    'All five old union-bounds samples must miss the actual link, reproducing its false covered error');
  assert.ok(fragmentedSearchFlow.geometry.fragmentHits.some(Boolean),'A live client-rectangle fragment must be the actual topmost hit');
  assert.equal(fragmentedSearchFlow.result.ok,true,JSON.stringify(fragmentedSearchFlow));
  assert.equal(fragmentedSearchFlow.modelCalls,0,'Fragmented search results must keep the exact episode command local');
  assert.equal(fragmentedSearchFlow.clickedSeason,3);
  assert.equal(fragmentedSearchFlow.clickedEpisode,2);
  assert.equal(fragmentedSearchFlow.trace.includes('wrong-anime-click'),false,'The Anime result remains a decoy');
  assert.equal(fragmentedSearchFlow.trace.filter(entry=>entry==='open-exact-show').length,1,'The live exact-show anchor must be activated once');
  assert.equal(fragmentedSearchFlow.actions.filter(entry=>entry.result.errorClass==='covered_target').length,0,
    'Whitespace between real link fragments must not be reported as an occluding control');
  assert.ok(fragmentedSearchFlow.trace.indexOf('season-3-ready')<fragmentedSearchFlow.trace.indexOf('play-season-3-episode-2'));
  assert.ok(fragmentedSearchFlow.elapsedMs<10000,'Controlled fragmented-card flow should finish within ten seconds');
  checks.push('Real multiline search-link fragments reproduce five false union-bounds misses; production hit testing selects a topmost fragment and verifies season 3 episode 2 with zero provider calls.');

  const blocked = await page('/hulu-search-fixture.html?blocker=1&episode=2');
  await blocked.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  const blockedSearchFlow = await blocked.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0;const actions=[];const started=performance.now();
    const result=await runAssistant({text:'go to rick and morty season 3 episode 2',
      env:{provider:'google',model:'gemini-3.5-flash-lite',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('A mouse blocker over search results must not need a provider');},
      host:{
        observe:async options=>{await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{
          const policy=__jesterAgentPage.classify(action);
          const execution=await __jesterAgentPage.execute(action,{boundary:'entertainment'});
          actions.push({action:action.action,label:policy.label,result:execution});return execution;
        },checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__huluFixture.clickedSeason,clickedEpisode:__huluFixture.clickedEpisode,trace:__huluFixture.trace};
  })()`);
  await writeFile(resolve(artifacts,'mouse-blocker-search-flow.json'),JSON.stringify(blockedSearchFlow,null,2));
  assert.equal(blockedSearchFlow.result.ok,true,JSON.stringify(blockedSearchFlow));
  assert.equal(blockedSearchFlow.modelCalls,0,'A layer that a mouse move removes must not hand the task to a provider');
  assert.equal(blockedSearchFlow.clickedSeason,3);
  assert.equal(blockedSearchFlow.clickedEpisode,2);
  assert.equal(blockedSearchFlow.actions.filter(entry=>entry.result.errorClass==='covered_target').length,0,
    'The mouse blocker must not be reported as covering the exact result');
  for(const [before,after] of [['open-search','mouse-blocker-shown'],['search-results-ready','mouse-blocker-removed'],
    ['mouse-blocker-removed','open-exact-show']]){
    assert.ok(blockedSearchFlow.trace.indexOf(before)>=0&&blockedSearchFlow.trace.indexOf(before)<blockedSearchFlow.trace.indexOf(after),
      'Expected '+before+' before '+after+': '+JSON.stringify(blockedSearchFlow));
  }
  assert.ok(blockedSearchFlow.elapsedMs<10000,'Controlled mouse-blocker flow should finish within ten seconds');
  checks.push('A Hulu-style transparent mouse blocker over instant-search results gets one mouse move and goes; the exact result opens and season 3 episode 2 plays with zero provider calls.');

  // Real input: the gesture the worker drives through chrome.debugger, here through
  // this test's own DevTools connection. Every event the page sees is trusted.
  const real = await page('/hulu-search-fixture.html?blocker=1');
  await real.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  const mouse = (params) => command('Input.dispatchMouseEvent', { button: 'none', buttons: 0, ...params }, real.sessionId);
  const step = (name, action) => real.evaluate(`__jesterAgentPage.input(${JSON.stringify(name)},${JSON.stringify(action)},{boundary:'entertainment'})`);
  const idOf = (name) => real.evaluate(`__jesterAgentPage.observe({goal:'rick and morty'}).elements.find(e=>e.name===${JSON.stringify(name)})?.id`);
  async function realClick(action) {
    const aimed = await step('aim', action);
    assert.equal(aimed.ok, true, JSON.stringify(aimed));
    await mouse({ type: 'mouseMoved', x: aimed.x, y: aimed.y });
    await pause(100);
    const landed = await step('land', action);
    assert.equal(landed.ok, true, JSON.stringify(landed));
    await mouse({ type: 'mousePressed', x: landed.x, y: landed.y, button: 'left', buttons: 1, clickCount: 1 });
    await mouse({ type: 'mouseReleased', x: landed.x, y: landed.y, button: 'left', clickCount: 1 });
    await step('done', action);
    return { aimed, landed };
  }
  await realClick({ action: 'click', elementId: await idOf('Search') });
  await real.until(`__huluFixture.trace.includes('open-search')`);
  const field = { action: 'type', elementId: await idOf('What are you looking for?'), text: 'rick and morty' };
  assert.equal((await step('ready', field)).ok, true);
  await command('Input.insertText', { text: field.text }, real.sessionId);
  await step('done', field);
  await real.until(`__huluFixture.trace.includes('search-results-ready')`);
  const blockedBeforeAim = await real.evaluate(`!!document.getElementById('mouse-blocker')`);
  const resultGesture = await realClick({ action: 'click', elementId: await idOf('Rick and Morty (2013) TV-MA 7 Seasons') });
  await real.until(`__huluFixture.trace.includes('open-exact-show')`);
  const realTrace = await real.evaluate('__huluFixture.trace');
  await writeFile(resolve(artifacts, 'real-input-flow.json'), JSON.stringify({ realTrace, resultGesture }, null, 2));
  assert.equal(blockedBeforeAim, true, 'The blocker covers the results when the real gesture starts');
  assert.ok(realTrace.includes('search-input:rick and morty'), 'Real text reaches the field as input');
  assert.ok(realTrace.indexOf('mouse-blocker-removed') < realTrace.indexOf('open-exact-show'),
    'The trusted move removes the blocker before the press: ' + JSON.stringify(realTrace));
  assert.equal(realTrace.includes('wrong-anime-click'), false);
  checks.push('Real trusted input through the DevTools protocol: aim, move, land and press open Search, type the show and click the exact result through a Hulu-style mouse blocker that the real move removes.');

  // Screenshot labels, painted by real Chrome and captured the way the worker does.
  const marked = await page('/hulu-search-fixture.html');
  await marked.until('!!globalThis.__jesterAgentPage && !!globalThis.__huluFixture');
  await marked.evaluate(`(() => { document.getElementById('search-nav').click(); const input = document.getElementById('search-input');
    input.value = 'rick and morty'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await marked.until(`__huluFixture.trace.includes('search-results-ready')`);
  const labels = await marked.evaluate(`(async () => { const shown = __jesterAgentPage.marks('show');
    await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); return shown; })()`);
  const shot = await command('Page.captureScreenshot', { format: 'jpeg', quality: 70, captureBeyondViewport: false }, marked.sessionId);
  await writeFile(resolve(artifacts, 'screenshot-labels.jpg'), Buffer.from(shot.data, 'base64'));
  const labelledHost = await marked.evaluate(`!!document.getElementById('jester-marks')`);
  await marked.evaluate(`__jesterAgentPage.marks('hide')`);
  assert.equal(labels.ok, true, JSON.stringify(labels));
  assert.equal(labelledHost, true);
  assert.equal(await marked.evaluate(`!!document.getElementById('jester-marks')`), false, 'Labels come off after the capture');
  const legendNames = labels.legend.map((entry) => entry.name);
  assert.ok(legendNames.includes('Rick and Morty (2013) TV-MA 7 Seasons'), JSON.stringify(legendNames));
  assert.ok(legendNames.includes('Rick and Morty: The Anime'), 'Poster-only links carry their image title');
  assert.ok(shot.data.length > 1000);
  checks.push(`Screenshot labels: ${labels.legend.length} clickable controls numbered in a real Chrome capture (screenshot-labels.jpg), then removed.`);

  const series = await page('/hulu-search-fixture.html?series=1');
  await series.until('document.title === "Hulu | Series" && !!globalThis.__jesterAgentPage');
  const seriesFlow = await series.evaluate(`(async()=>{
    const {runAssistant}=await import('/src/background/assistant.js');
    let modelCalls=0;const actions=[];const started=performance.now();
    const result=await runAssistant({text:'Play season 3 episode 1 of Rick and Morty',
      env:{provider:'google',model:'gemini-3.5-flash-lite',key:'fixture-only-not-a-real-key'},
      modelClient:async()=>{modelCalls++;throw new Error('The named season picker must work locally');},
      host:{
        observe:async options=>{await new Promise(done=>requestAnimationFrame(done));return __jesterAgentPage.observe(options);},
        execute:async action=>{const policy=__jesterAgentPage.classify(action);actions.push({action:action.action,label:policy.label});return __jesterAgentPage.execute(action,{boundary:'entertainment'});},
        checkpoint:async()=>{},thinking:async()=>{}
      }});
    return {result,modelCalls,actions,elapsedMs:Math.round(performance.now()-started),
      clickedSeason:__huluFixture.clickedSeason,trace:__huluFixture.trace};
  })()`);
  assert.equal(seriesFlow.result.ok,true,JSON.stringify(seriesFlow));
  assert.equal(seriesFlow.modelCalls,0);
  assert.deepEqual(seriesFlow.actions.map(action=>action.label),['Select a season','Season 3 (10 Episodes)','S3 E1']);
  assert.equal(seriesFlow.clickedSeason,3);
  assert.ok(seriesFlow.trace.indexOf('season-3-ready')<seriesFlow.trace.indexOf('play-season-3-episode-1'));
  await writeFile(resolve(artifacts,'series-dropdown-flow.json'),JSON.stringify(seriesFlow,null,2));
  checks.push('Starting on the generic Series page opens a closed named season picker, waits for its episode pane and verifies playback with zero provider calls.');

  const spa = await page('/spa-navigation-fixture.html');
  await spa.until('!!globalThis.__jesterAgentPage && !!globalThis.__spa');
  const spaNavigation = await spa.evaluate(`(async()=>{
    const observe=options=>__smoke.request({type:'jester/agent-observe',options:{settle:'frame',...options}});
    const before=await observe({});
    let started=performance.now();
    const unchanged=await observe({since:before.pageId});
    const unchangedMs=Math.round(performance.now()-started);
    document.getElementById('go').click();
    started=performance.now();
    const after=await observe({since:before.pageId});
    const navigatedMs=Math.round(performance.now()-started);
    // The bar alone also means a navigation is under way, whoever started it.
    document.getElementById('go').click();
    started=performance.now();
    const pending=await observe({});
    return {unchangedMs,navigatedMs,pendingMs:Math.round(performance.now()-started),samePage:unchanged.pageId===before.pageId,
      newPage:after.pageId!==before.pageId,url:after.url,names:after.elements.map(entry=>entry.name),
      pendingNames:pending.elements.map(entry=>entry.name),trace:__spa.trace};
  })()`);
  assert.equal(spaNavigation.samePage, true, JSON.stringify(spaNavigation));
  assert.ok(spaNavigation.unchangedMs < 300, 'A look with no navigation keeps the one-frame wait: ' + spaNavigation.unchangedMs);
  assert.equal(spaNavigation.newPage, true);
  assert.match(spaNavigation.url, /\/results\?search_query=MrBeast$/);
  for (const names of [spaNavigation.names, spaNavigation.pendingNames]) {
    assert.ok(names.includes('Newest upload') && names.includes('Go to channel MrBeast'), JSON.stringify(spaNavigation));
    assert.equal(names.includes('Old feed video'), false);
  }
  assert.ok(spaNavigation.navigatedMs >= 800 && spaNavigation.navigatedMs < 4000, 'Waited for the results: ' + spaNavigation.navigatedMs);
  assert.ok(spaNavigation.pendingMs >= 800, 'Waited while the progress bar was up: ' + spaNavigation.pendingMs);
  await writeFile(resolve(artifacts,'spa-navigation.json'),JSON.stringify(spaNavigation,null,2));
  checks.push(`A YouTube-style in-app navigation (address at once, results 900 ms later behind a quiet progress bar) is read only once its results arrive (${spaNavigation.navigatedMs} ms); a look with no navigation still takes one frame (${spaNavigation.unchangedMs} ms).`);

  assert.deepEqual(exceptions, [], `Browser runtime exceptions: ${JSON.stringify(exceptions)}`);
  console.log(JSON.stringify({ ok: true, checks, localFlow, huluSearchFlow, coveredSearchFlow, fragmentedSearchFlow, blockedSearchFlow, seriesFlow, spaNavigation, artifacts, runtimeExceptions: exceptions.length }, null, 2));
  await command('Browser.close');
} finally {
  socket?.close();
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await new Promise((done) => server.close(done));
  await writeFile(resolve(artifacts, 'chrome-stderr.log'), chromeError);
}
