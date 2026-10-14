/* Abandoned but Not Forgotten — offline companion service worker.
 * Keep this file beside the HTML and serve both over HTTPS (Vercel is suitable).
 * Educational simulations and saved local interactions continue offline. Remote
 * resources are cached when used; NASA/JPL responses refresh when online again.
 */
'use strict';
const VERSION='abnf-v30';
const SHELL_CACHE=VERSION+'-shell';
const RUNTIME_CACHE=VERSION+'-runtime';
const MAX_RUNTIME_ENTRIES=90;
const EXTERNAL_HOSTS=new Set([
  'images-api.nasa.gov',
  'images-assets.nasa.gov',
  'svs.gsfc.nasa.gov',
  'ssd.jpl.nasa.gov'
]);

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{await self.skipWaiting()})());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const names=await caches.keys();
    await Promise.all(names.filter(n=>n.startsWith('abnf-v')&&n!==SHELL_CACHE&&n!==RUNTIME_CACHE).map(n=>caches.delete(n)));
    await self.clients.claim();
  })());
});

function inScope(url){
  try{return url.origin===self.location.origin&&url.pathname.startsWith(new URL(self.registration.scope).pathname)}catch(e){return false}
}
function allowedExternal(url){return url.protocol==='https:'&&EXTERNAL_HOSTS.has(url.hostname)}
async function trimCache(cacheName,maxEntries){
  try{const cache=await caches.open(cacheName),keys=await cache.keys();if(keys.length>maxEntries){await Promise.all(keys.slice(0,keys.length-maxEntries).map(k=>cache.delete(k)))}}catch(e){}
}
async function store(cacheName,request,response){
  if(!response||(response.type!=='opaque'&&!response.ok))return;
  try{const cache=await caches.open(cacheName);await cache.put(request,response.clone());await trimCache(cacheName,MAX_RUNTIME_ENTRIES)}catch(e){}
}
async function fetchWithTimeout(request,ms){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
  try{return await fetch(request,{signal:controller.signal,cache:'no-store'})}finally{clearTimeout(timer)}
}
async function cachedPage(request){
  const shell=await caches.open(SHELL_CACHE);
  let hit=await shell.match(request,{ignoreSearch:true});
  if(hit)return hit;
  const bare=new URL(request.url);bare.search='';bare.hash='';
  hit=await shell.match(bare.href);
  if(hit)return hit;
  return null;
}
async function cachePageURL(rawURL){
  let url;
  try{url=new URL(rawURL)}catch(e){return false}
  if(!inScope(url)||url.protocol!=='http:'&&url.protocol!=='https:')return false;
  url.hash='';
  try{
    const request=new Request(url.href,{method:'GET',credentials:'same-origin'});
    const response=await fetchWithTimeout(request,7000);
    if(!response.ok)return false;
    const shell=await caches.open(SHELL_CACHE);
    await shell.put(request,response.clone());
    const bare=new URL(url.href);bare.search='';
    if(bare.href!==url.href)await shell.put(bare.href,response.clone());
    return true;
  }catch(e){return false}
}

self.addEventListener('message',event=>{
  const data=event.data||{};
  if(data.type==='ABNF_PRECACHE_PAGE'){
    const task=cachePageURL(data.url).then(ok=>{
      try{event.source&&event.source.postMessage({type:'ABNF_OFFLINE_READY',ok})}catch(e){}
    });
    event.waitUntil(task);
  }
});

self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET')return;
  let url;try{url=new URL(request.url)}catch(e){return}
  // Let browser manage service-worker upgrades and avoid caching executable worker code.
  if(url.origin===self.location.origin&&url.pathname===new URL(self.location.href).pathname)return;

  if(request.mode==='navigate'&&inScope(url)){
    event.respondWith((async()=>{
      try{
        const response=await fetchWithTimeout(request,2800);
        if(response.ok){const shell=await caches.open(SHELL_CACHE);await shell.put(request,response.clone());const bare=new URL(request.url);bare.search='';if(bare.href!==request.url)await shell.put(bare.href,response.clone())}
        return response;
      }catch(e){const hit=await cachedPage(request);if(hit)return hit;return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><main style="font:16px system-ui;max-width:36rem;margin:3rem auto;padding:1rem"><h1>You are offline</h1><p>This page has not been cached on this device yet. Reconnect once, open the website, and let it finish loading to enable offline use.</p><p><a href="./">Try the site home page</a></p></main>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}})}
    })());
    return;
  }

  const sameOrigin=inScope(url)&&url.origin===self.location.origin;
  const external=allowedExternal(url);
  if(!sameOrigin&&!external)return;

  // A live connection is preferred for NASA/JPL data; cached responses are a graceful
  // offline fallback. Images and shell assets use stale-while-revalidate for speed.
  if(external&&(url.hostname==='images-api.nasa.gov'||url.hostname==='ssd.jpl.nasa.gov'||url.pathname.includes('/api/'))){
    event.respondWith((async()=>{
      try{const response=await fetchWithTimeout(request,4500);if(response.ok)await store(RUNTIME_CACHE,request,response);return response}
      catch(e){const hit=await caches.match(request);if(hit)return hit;return Response.error()}
    })());
    return;
  }
  event.respondWith((async()=>{
    const hit=await caches.match(request);
    const update=fetch(request).then(async response=>{if(response.ok||response.type==='opaque')await store(sameOrigin?SHELL_CACHE:RUNTIME_CACHE,request,response);return response});
    if(hit){event.waitUntil(update.catch(()=>{}));return hit}
    try{return await update}catch(e){const fallback=await caches.match(request);if(fallback)return fallback;return Response.error()}
  })());
});
