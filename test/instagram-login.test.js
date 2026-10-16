import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thrift-ig-login-'));
process.env.THRIFT_DATA_DIR=path.join(dir,'data');process.env.THRIFT_STORE_DIR=path.join(dir,'secrets');process.env.THRIFT_DISABLE_LEGACY_IMPORT='1';process.env.THRIFT_PROTECTED_NAMES='blocked';
const {createApp}=await import('../src/server.js');
const {getDestinationConfig,getAllConnectedAccounts}=await import('../src/tokens.js');
const {instagramScopes,exchangeInstagramCode,verifyInstagram,instagramIdentity}=await import('../src/instagram.js');
const bids=await import('../src/bids.js');
const env={SPAWN_THRIFT_APP_ID:'parent-app',SPAWN_THRIFT_APP_SECRET:'parent-secret',THRIFT_INSTAGRAM_APP_ID:'ig-app',THRIFT_INSTAGRAM_APP_SECRET:'ig-app-secret',THRIFT_SEND_ENABLED:'1',THRIFT_PUBLIC_URL:'https://console.example.test',THRIFT_PAUSE_FILE:path.join(dir,'PAUSED')};
let username='testthrift',scopedId='app-scoped-user',grants=instagramScopes.join(','),wrappedProfile=false;const calls=[];
const fetchImpl=async(url,options={})=>{
 const ep=url.pathname.replace(/^\/v25\.0\//,'');calls.push({host:url.hostname,path:ep,method:options.method,body:options.body});let data;
 if(url.hostname==='api.instagram.com'&&url.pathname==='/oauth/access_token'){assert.equal(options.body.get('client_id'),'ig-app');assert.equal(options.body.get('redirect_uri'),'https://console.example.test/auth/instagram/callback');data={data:[{access_token:'short-ig-token',user_id:'app-scoped-user',permissions:grants}]};}
 else if(url.hostname==='graph.instagram.com'&&url.pathname==='/access_token'){assert.equal(url.searchParams.get('grant_type'),'ig_exchange_token');data={access_token:'native-ig-token',expires_in:5184000};}
 else if(url.hostname==='graph.facebook.com'&&(ep==='debug_token'||ep==='ig-app/subscriptions'))return new Response(JSON.stringify({error:{code:190}}),{status:401});
 else if(url.hostname==='graph.instagram.com'&&ep==='me')data=wrappedProfile?{data:[{id:scopedId,user_id:'ig-user',username}]}:{id:scopedId,user_id:'ig-user',username};
 else if(url.hostname==='graph.instagram.com'&&ep==='ig-user/subscribed_apps')data=options.method==='POST'?{success:true}:{data:[{id:'parent-app',subscribed_fields:['comments','messages']}]};
 else if(url.hostname==='graph.facebook.com'&&ep==='parent-app/subscriptions'){assert.equal(options.headers.Authorization,'Bearer parent-app|parent-secret');data={data:[{object:'instagram',active:true,callback_url:'https://console.example.test/webhook',fields:[{name:'comments'},{name:'messages'}]}]};}
 else if(url.hostname==='graph.instagram.com'&&ep==='ig-user/media')data={data:[{id:'native-post',caption:'Own post'}]};
 else if(url.hostname==='graph.instagram.com'&&ep==='ig-user/messages')data={message_id:'native-message-confirmed'};
 else return new Response(JSON.stringify({error:{code:100}}),{status:400});
 return new Response(JSON.stringify(data));
};
const server=createApp({env,fetchImpl,operatorLocal:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});let session;
const start=async()=>{const response=await fetch(base+'/auth/start?platform=instagram',{redirect:'manual'});return {response,login:new URL(response.headers.get('location')),cookie:response.headers.get('set-cookie').split(';')[0]};};
const post=(url,data)=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',cookie:'thrift_session='+session},body:JSON.stringify(data)});
test('Instagram starts on instagram.com with its own app and scopes, never Facebook',async()=>{
 const {response,login}=await start();assert.equal(response.status,303);assert.equal(login.hostname,'www.instagram.com');assert.equal(login.searchParams.get('client_id'),'ig-app');assert.equal(login.searchParams.get('enable_fb_login'),'0');assert.equal(login.searchParams.get('force_reauth'),'0');assert.deepEqual(login.searchParams.get('scope').split(','),instagramScopes);assert(!login.href.includes('pages_'));assert.match(login.searchParams.get('state'),/^[a-f0-9]{64}$/);
});
test('native callback requires cookie binding, correct provider and single-use state',async()=>{
 const {login,cookie}=await start();const state=login.searchParams.get('state'),before=calls.length;
 for(const [route,headers] of [['/auth/callback',{cookie}],['/auth/instagram/callback',{}]]){const wrong=await fetch(base+`${route}?state=${state}&code=test`,{headers,redirect:'manual'});assert.match(wrong.headers.get('location'),/login_expired/);assert.equal(calls.length,before);}
 const returned=await fetch(base+`/auth/instagram/callback?state=${state}&code=test`,{headers:{cookie},redirect:'manual'});assert.equal(returned.headers.get('location'),'/auth/complete?connected=1');session=returned.headers.getSetCookie().find(c=>c.startsWith('thrift_session=')).split(';')[0].split('=')[1];
 const replay=await fetch(base+`/auth/instagram/callback?state=${state}&code=test`,{headers:{cookie},redirect:'manual'});assert.match(replay.headers.get('location'),/login_expired/);
 const account=getDestinationConfig('ig-user');assert.equal(account.pageId,'ig:ig-user');assert.equal(account.authType,'instagram');assert.deepEqual(account.platforms,['instagram']);assert(account.readiness.instagram.ready);assert.equal(account.oauthUserId,'app-scoped-user');assert.equal(account.igId,'ig-user');assert.equal(account.oauthAppId,'ig-app');assert.deepEqual(account.grantedPermissions,instagramScopes);assert(!calls.some(c=>c.path==='debug_token'||c.path==='ig-app/subscriptions'));assert(!calls.some(c=>c.path==='me/accounts'));assert(!fs.readFileSync(path.join(dir,'secrets/accounts.enc')).includes(Buffer.from('native-ig-token')));
});
test('native workspace exposes only Instagram and owned media uses graph.instagram.com',async()=>{
 const data=await (await fetch(base+'/api/workspace',{headers:{cookie:'thrift_session='+session}})).json();assert.equal(data.accounts.length,1);assert.equal(data.accounts[0].id,'ig:ig-user');assert.deepEqual(data.accounts[0].platforms,['instagram']);assert(!JSON.stringify(data).includes('native-ig-token'));
 const media=await fetch(base+'/api/media?accountId=ig:ig-user&platform=instagram',{headers:{cookie:'thrift_session='+session}});assert.equal((await media.json()).media[0].id,'native-post');assert.equal((await fetch(base+'/api/media?accountId=ig:ig-user&platform=facebook',{headers:{cookie:'thrift_session='+session}})).status,400);
});
test('native signed bids and private replies use the Instagram endpoint',async()=>{
 await post('/api/settings',{accountId:'ig:ig-user',gcashName:'Test',gcashNumber:'09123456789',shippingFee:20});const made=await (await post('/bids/api/items',{accountId:'ig:ig-user',platform:'instagram',mode:'live',postId:'native-post',name:'Native test',startingBid:500,minIncrement:50,deadline:new Date(Date.now()+3600000).toISOString()})).json();assert(made.ok,JSON.stringify(made));
 const raw=JSON.stringify({object:'instagram',entry:[{id:'ig-user',changes:[{field:'comments',value:{id:'native-comment',media:{id:'native-post'},from:{id:'buyer',username:'buyer'},text:'550'}}]}]});const signature='sha256='+crypto.createHmac('sha256',env.THRIFT_INSTAGRAM_APP_SECRET).update(raw).digest('hex');await fetch(base+'/webhook',{method:'POST',headers:{'x-hub-signature-256':signature},body:raw});await new Promise(r=>setImmediate(r));assert.equal(bids.getBidsState().items.find(i=>i.id===made.item.id).currentBid,550);
 await post('/bids/api/close',{itemId:made.item.id});await server.runScheduler();const sent=bids.getOutbox({shopId:'ig:ig-user'})[0];assert.equal(sent.status,'sent');assert.equal(sent.messageId,'native-message-confirmed');assert(calls.some(c=>c.host==='graph.instagram.com'&&c.path==='ig-user/messages'));
});
test('protected client Instagram identity is rejected before subscription or storage',async()=>{
 try{for(const protectedName of ['blockedbrand','blocked.brand','blocked_brand','Blocked Brand']){username=protectedName;const {login,cookie}=await start();const before=calls.filter(c=>c.method==='POST'&&c.path.endsWith('subscribed_apps')).length;const response=await fetch(base+`/auth/instagram/callback?state=${login.searchParams.get('state')}&code=test`,{headers:{cookie},redirect:'manual'});assert.match(response.headers.get('location'),/connection_failed/);assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('subscribed_apps')).length,before);assert.equal(getAllConnectedAccounts()[0].igUsername,'testthrift');}}finally{username='testthrift';}
});
test('unconfigured native login never falls back to Facebook',async()=>{
 const unconfigured=createApp({env:{SPAWN_THRIFT_APP_ID:'parent',SPAWN_THRIFT_APP_SECRET:'parent-secret'},operatorLocal:false});await new Promise(r=>unconfigured.listen(0,'127.0.0.1',r));try{const result=await fetch(`http://127.0.0.1:${unconfigured.address().port}/auth/start?platform=instagram`,{redirect:'manual'});assert.match(result.headers.get('location'),/oauth_unavailable/);assert(!result.headers.get('location').includes('facebook.com'));}finally{unconfigured.close();}
});
test('popup completion sends only the outcome to the exact same origin',async()=>{
 const html=await (await fetch(base+'/auth/complete?connected=1')).text();assert(html.includes('window.location.origin'));assert(html.includes('window.close()'));assert(!html.includes('native-ig-token'));assert(html.includes('thrift:connection'));
});
test('native token exchange rejects ambiguous identities',async()=>{
 await assert.rejects(exchangeInstagramCode({appId:'app',appSecret:'secret',redirectUri:'https://example.test',code:'test',fetchImpl:async()=>new Response(JSON.stringify({data:[{access_token:'a',user_id:'1'},{access_token:'b',user_id:'2'}]}))}),/ambiguous/);
});

test('popup failure page cannot reflect executable error content',async()=>{const html=await(await fetch(base+'/auth/complete?error='+encodeURIComponent('</script><script>alert(1)</script>'))).text();assert(!html.includes('alert(1)'));assert(html.includes('connection_failed'));});

test('Instagram numeric user IDs retain exact digits during token exchange',async()=>{let n=0;const auth=await exchangeInstagramCode({appId:'a',appSecret:'s',redirectUri:'https://example.test',code:'c',fetchImpl:async()=>new Response(++n===1?JSON.stringify({access_token:'short',permissions:instagramScopes}).replace('}',',"user_id":17890000000000001}'):'{"access_token":"long","expires_in":5184000}')});assert.equal(auth.userId,'17890000000000001');});


test('native callback rejects a different app-scoped identity before subscription or storage',async()=>{
 scopedId='different-scoped-user';const before=calls.filter(c=>c.method==='POST'&&c.path.endsWith('subscribed_apps')).length;
 try{const {login,cookie}=await start();const response=await fetch(base+`/auth/instagram/callback?state=${login.searchParams.get('state')}&code=test`,{headers:{cookie},redirect:'manual'});assert.match(response.headers.get('location'),/connection_failed/);assert.equal(calls.filter(c=>c.method==='POST'&&c.path.endsWith('subscribed_apps')).length,before);assert.equal(getDestinationConfig('ig-user').oauthUserId,'app-scoped-user');}finally{scopedId='app-scoped-user';}
});
test('native callback accepts a single wrapped profile with distinct scoped and webhook IDs',async()=>{
 wrappedProfile=true;try{const {login,cookie}=await start();const response=await fetch(base+`/auth/instagram/callback?state=${login.searchParams.get('state')}&code=test`,{headers:{cookie},redirect:'manual'});assert.equal(response.headers.get('location'),'/auth/complete?connected=1');assert.equal(getDestinationConfig('ig-user').igId,'ig-user');}finally{wrappedProfile=false;}
 assert.throws(()=>instagramIdentity({data:[{id:'1',user_id:'2',username:'a'},{id:'3',user_id:'4',username:'b'}]}),/ambiguous/);
});
test('declined or missing native grants fail before long-token exchange and subscription',async()=>{
 const before=calls.filter(c=>c.path==='/access_token'||(c.method==='POST'&&c.path.endsWith('subscribed_apps'))).length;
 try{for(const missing of ['instagram_business_basic','instagram_business_manage_comments','instagram_business_manage_messages',null]){grants=missing?instagramScopes.filter(s=>s!==missing).join(','):undefined;const {login,cookie}=await start();const response=await fetch(base+`/auth/instagram/callback?state=${login.searchParams.get('state')}&code=test`,{headers:{cookie},redirect:'manual'});assert.match(response.headers.get('location'),/connection_failed/);}}
 finally{grants=instagramScopes.join(',');}
 assert.equal(calls.filter(c=>c.path==='/access_token'||(c.method==='POST'&&c.path.endsWith('subscribed_apps'))).length,before);
});
test('native readiness keeps expired tokens, wrong app, missing grants and mismatched identity unavailable',async()=>{
 const account=getDestinationConfig('ig-user');
 const graph=async(endpoint)=>endpoint==='me'?{id:account.oauthUserId,user_id:account.igId,username:'testthrift'}:{data:[{id:'parent-app',subscribed_fields:['comments','messages']}]};
 const facebookGraph=async(endpoint,token)=>{assert.equal(endpoint,'parent-app/subscriptions');assert.equal(token,'parent-app|parent-secret');return {data:[{object:'instagram',active:true,callback_url:'https://console.example.test/webhook',fields:['comments','messages']}]};};
 const args={graph,facebookGraph,account,appId:'ig-app',webhookAppId:'parent-app',webhookAppSecret:'parent-secret',publicUrl:'https://console.example.test'};
 assert((await verifyInstagram(args)).ready);
 for(const override of [{tokenExpiresAt:'2020-01-01T00:00:00Z'},{tokenExpiresAt:'invalid'},{oauthAppId:'other-app'},{grantedPermissions:['instagram_business_basic']},{oauthUserId:'other-user'},{igId:'other-ig'}]){const result=await verifyInstagram({...args,account:{...account,...override}});assert.equal(result.ready,false);assert(result.issues.length);}
 const unrelated=await verifyInstagram({...args,graph:async(endpoint)=>endpoint==='me'?await graph(endpoint):{data:[{id:'unrelated-app',subscribed_fields:['comments','messages']}]}});assert.equal(unrelated.ready,false);
});

test('failed native returns record provider codes without the code, state, secrets or raw error',async()=>{
 const failures=[],sentinel='credential-must-not-appear';
 const failing=createApp({env,operatorLocal:false,logImpl:(event,fields)=>failures.push({event,...fields}),fetchImpl:async()=>{throw Object.assign(new Error('raw provider error '+sentinel),{code:190,subcode:12345});}});
 await new Promise(r=>failing.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${failing.address().port}`;
 try{const began=await fetch(endpoint+'/auth/start?platform=instagram',{redirect:'manual'}),state=new URL(began.headers.get('location')).searchParams.get('state'),cookie=began.headers.get('set-cookie').split(';')[0];
 const returned=await fetch(endpoint+`/auth/instagram/callback?code=${sentinel}&state=${state}`,{headers:{cookie},redirect:'manual'});assert.equal(returned.headers.get('location'),'/auth/complete?error=authorization_expired');
 assert.deepEqual(failures,[{event:'request.failed',path:'/auth/instagram/callback',status:500,code:190,subcode:12345}]);assert(!JSON.stringify(failures).includes(sentinel));assert(!JSON.stringify(failures).includes(state));
 }finally{failing.close();}
});
