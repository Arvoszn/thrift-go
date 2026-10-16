import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thrift-server-'));
process.env.THRIFT_DATA_DIR=path.join(dir,'data');process.env.THRIFT_STORE_DIR=path.join(dir,'secrets');process.env.THRIFT_DISABLE_LEGACY_IMPORT='1';process.env.THRIFT_PROTECTED_IDS='protected-page-1';process.env.THRIFT_PROTECTED_NAMES='protected client';
const {createApp}=await import('../src/server.js');
const {savePageToken,getDestinationConfig,createSession,getAllConnectedAccounts,removePageToken,migrateTestAccount}=await import('../src/tokens.js');
const bids=await import('../src/bids.js');
const env={SPAWN_THRIFT_APP_ID:'app-test',SPAWN_THRIFT_APP_SECRET:'test-secret-for-signatures',VERIFY_TOKEN:'verify-test',GRAPH_VERSION:'v25.0',SPAWNTEL_APP_SECRET:'unrelated-app-secret',THRIFT_SEND_ENABLED:'1',THRIFT_PUBLIC_URL:'https://console.example.test',THRIFT_PAUSE_FILE:path.join(dir,'PAUSED')};
const calls=[];
const mock=async(url,options)=>{
 calls.push({path:url.pathname,method:options.method || 'GET',body:options.body});
 const ep=url.pathname.replace('/v25.0/','');let data;
 if(ep==='oauth/access_token')data={access_token:'test-user-token'};
 else if(ep==='me/accounts')data={data:[{id:'shop-a',name:'Test thrift shop',access_token:'test-page-token',instagram_business_account:{id:'ig-a',username:'testshop'}},{id:'protected-page-1',name:'Protected client shop',access_token:'never-use'}]};
 else if(ep==='debug_token')data={data:{is_valid:true,app_id:'app-test',scopes:['instagram_basic','instagram_manage_comments','instagram_manage_messages','pages_show_list','pages_read_engagement','pages_manage_metadata','pages_messaging','pages_read_user_content']}};
 else if(ep==='shop-a')data={id:'shop-a',name:'Test thrift shop',instagram_business_account:{id:'ig-a',username:'testshop'}};
 else if(ep==='shop-a/subscribed_apps')data=options.method==='POST'?{success:true}:{data:[{id:'app-test',subscribed_fields:['messages','feed']}]};
 else if(ep==='app-test/subscriptions')data={data:[{object:'instagram',active:true,callback_url:'https://console.example.test/webhook',fields:[{name:'comments'},{name:'messages'}]},{object:'page',active:true,callback_url:'https://console.example.test/webhook',fields:[{name:'feed'},{name:'messages'}]}]};
 else if(ep==='ig-a/media')data={data:[{id:'owned-post',caption:'Vintage test'}]};
 else if(ep==='ig-a/messages')data={message_id:'confirmed-meta-message'};
 else return new Response(JSON.stringify({error:{code:100,message:'unknown endpoint'}}),{status:400});
 return new Response(JSON.stringify(data),{status:200});
};
const server=createApp({env,fetchImpl:mock,operatorLocal:false});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
test.after(()=>{server.close();fs.rmSync(dir,{recursive:true,force:true});});
let session;
const post=async(url,data,extra={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',cookie:session?'thrift_session='+session:'',...extra},body:JSON.stringify(data)});
test('unauthenticated visitors cannot inspect shops, bids or mutate state',async()=>{
 for(const ep of ['/api/accounts','/api/workspace','/bids/api/state'])assert.equal((await fetch(base+ep)).status,401);
 assert.equal((await post('/bids/api/reset',{itemId:'item-vintage-nike-hoodie'})).status,401);
});
test('OAuth requires unpredictable single-use state bound to HttpOnly cookie',async()=>{
 assert.equal((await fetch(base+'/auth/callback?code=bad&state=instagram',{redirect:'manual'})).status,303);
 assert.equal(calls.length,0);
 const start=await fetch(base+'/auth/start?platform=facebook',{redirect:'manual'});assert.equal(start.status,303);
 const login=new URL(start.headers.get('location'));assert.equal(login.hostname,'www.facebook.com');assert(login.searchParams.get('scope').includes('pages_manage_metadata'));
 const nonce=login.searchParams.get('state');assert.match(nonce,/^[0-9a-f]{64}$/);
 const cookie=start.headers.get('set-cookie').split(';')[0];assert.match(start.headers.get('set-cookie'),/HttpOnly/);
 const callback=await fetch(base+`/auth/callback?state=${nonce}&code=mock`,{headers:{cookie},redirect:'manual'});assert.equal(callback.status,303);assert.equal(callback.headers.get('location'),'/auth/complete?connected=1');
 session=callback.headers.getSetCookie().find(c=>c.startsWith('thrift_session=')).split(';')[0].split('=')[1];
 const replay=await fetch(base+`/auth/callback?state=${nonce}&code=mock`,{headers:{cookie},redirect:'manual'});assert.match(replay.headers.get('location'),/login_expired/);
 assert.equal(getDestinationConfig('protected-page-1'),null);
 assert.equal(getAllConnectedAccounts().length,1);
 savePageToken('shop-a',{platforms:['instagram']});await server.refreshAccount('shop-a');
});
test('operator access never extends beyond genuine loopback requests',async()=>{
 const operator=createApp({env,fetchImpl:mock,operatorLocal:true});
 await new Promise(r=>operator.listen(0,'127.0.0.1',r));
 try{
  const port=operator.address().port;
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspace`)).status,200,'a genuine loopback request keeps operator access');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspace`,{headers:{'x-forwarded-for':'203.0.113.9'}})).status,401,'forwarded visitors lose operator access');
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/workspace`,{headers:{'cf-connecting-ip':'203.0.113.9'}})).status,401,'tunnel visitors lose operator access');
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status,200,'loopback health checks keep working');
 }finally{operator.close();}
});
test('dedicated credentials are encrypted and unknown destinations never fall back',()=>{
 const contents=fs.readFileSync(path.join(dir,'secrets','accounts.enc'));assert(!contents.includes(Buffer.from('test-page-token')));
 assert.equal(getDestinationConfig('unknown'),null);assert.equal(getDestinationConfig('ig-a').pageId,'shop-a');
 if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(dir,'secrets','store.key')).mode & 0o777,0o600); } else { assert(fs.existsSync(path.join(dir,'secrets','store.key'))); }
});
test('shop workspace and actions are tenant scoped and same-origin',async()=>{
 savePageToken('shop-b',{name:'Other shop',token:'other-secret',igId:'ig-b',platforms:['instagram']});
 const state=await (await fetch(base+'/api/workspace',{headers:{cookie:'thrift_session='+session}})).json();assert.equal(state.accounts.length,1);assert.equal(state.accounts[0].id,'shop-a');assert(!JSON.stringify(state).includes('test-page-token'));
 assert.equal((await post('/api/settings',{accountId:'shop-b',gcashName:'Wrong'})).status,403);
 assert.equal((await post('/api/settings',{accountId:'shop-a'},{origin:'https://evil.example'})).status,403);
 assert.equal((await post('/api/messages',{shopId:'shop-b',messages:{winner:'stolen'}})).status,403);
 assert.equal((await post('/api/messages',{shopId:'shop-a',messages:{winner:''}})).status,200);
 const afterMessages=await (await fetch(base+'/api/workspace',{headers:{cookie:'thrift_session='+session}})).json();
 assert.match(afterMessages.settings['shop-a'].messages.winner,/^You won \{item\} at ₱\{amount\}/);
 assert.match(afterMessages.settings['shop-a'].messages.receipt,/recipient name, phone number/);
});
test('live drop creation validates payment setup, readiness and exact post ownership',async()=>{
 assert.equal((await post('/bids/api/items',{accountId:'shop-a',postId:'owned-post',name:'Test',startingBid:500,minIncrement:50,deadline:new Date(Date.now()+3600000).toISOString()})).status,400);
 assert.equal((await post('/api/settings',{accountId:'shop-a',gcashName:'Test Seller',gcashNumber:'09123456789',paymentHours:12,shippingFee:50})).status,200);
 const item={accountId:'shop-a',platform:'instagram',postId:'wrong-post',name:'Test drop',startingBid:500,minIncrement:50,deadline:new Date(Date.now()+3600000).toISOString()};
 assert.equal((await post('/bids/api/items',item)).status,400);
 const created=await (await post('/bids/api/items',{...item,postId:'owned-post'})).json();assert(created.ok);assert.equal(created.item.shopId,'shop-a');assert.equal(created.item.destinationId,'ig-a');
 assert.equal((await post('/bids/api/comment',{itemId:created.item.id,text:'550',from:{id:'buyer-a'}})).status,400);
 assert.equal((await post('/bids/api/reset',{itemId:created.item.id})).status,400);
});
test('signed exact-shop webhook bids close and dispatch through confirmed private replies',async()=>{
 const item=bids.getBidsState().items.find(i=>i.postId==='owned-post');
 const payload={object:'instagram',entry:[{id:'ig-a',time:Math.floor(Date.now()/1000),changes:[{field:'comments',value:{media:{id:'owned-post'},id:'comment-test',from:{id:'buyer-a',username:'buyer'},text:'550'}}]}]};
 const raw=JSON.stringify(payload);const signature='sha256='+crypto.createHmac('sha256',env.SPAWN_THRIFT_APP_SECRET).update(raw).digest('hex');
 assert.equal((await fetch(base+'/webhook',{method:'POST',body:raw,headers:{'content-type':'application/json'}})).status,401);
 const unrelated='sha256='+crypto.createHmac('sha256',env.SPAWNTEL_APP_SECRET).update(raw).digest('hex');assert.equal((await fetch(base+'/webhook',{method:'POST',body:raw,headers:{'x-hub-signature-256':unrelated}})).status,401);
 assert.equal((await fetch(base+'/webhook',{method:'POST',body:raw,headers:{'x-hub-signature-256':signature}})).status,200);
 await new Promise(r=>setImmediate(r));assert.equal(bids.getBidsState().items.find(i=>i.id===item.id).currentBid,550);
 assert.equal((await post('/bids/api/close',{itemId:item.id})).status,200);
 await server.runScheduler();const message=bids.getOutbox({shopId:'shop-a'})[0];assert.equal(message.status,'sent');assert.equal(message.messageId,'confirmed-meta-message');
 const sent=calls.find(c=>c.path.endsWith('/ig-a/messages'));assert.deepEqual(JSON.parse(sent.body).recipient,{comment_id:'comment-test'});
});

test('buyer proof webhook reaches inbox and suspends forfeiture, seller receipt uses open reply window',async()=>{
 const item=bids.getBidsState().items.find(i=>i.postId==='owned-post');
 const payload={object:'instagram',entry:[{id:'ig-a',messaging:[{sender:{id:'buyer-a'},timestamp:Date.now(),message:{mid:'proof-mid',text:'Reference: TESTREF123',attachments:[{type:'image',payload:{url:'https://example.test/receipt.jpg'}}]}}]}]};
 const raw=JSON.stringify(payload);const signature='sha256='+crypto.createHmac('sha256',env.SPAWN_THRIFT_APP_SECRET).update(raw).digest('hex');
 assert.equal((await fetch(base+'/webhook',{method:'POST',body:raw,headers:{'x-hub-signature-256':signature}})).status,200);
 await new Promise(r=>setImmediate(r));
 const state=bids.getBidsState();const updated=state.items.find(i=>i.id===item.id);assert.equal(updated.status,'PAYMENT_REVIEW');assert.equal(updated.paymentClaim.referenceNo,'TESTREF123');assert.equal(state.inbox[0].attachments[0].url,'https://example.test/receipt.jpg');
 assert.equal((await post('/bids/api/pay',{itemId:item.id,buyerId:'buyer-a',referenceNo:'TESTREF123',amount:updated.totalDue})).status,200);
 await server.runScheduler();const receipt=bids.getOutbox({shopId:'shop-a'}).find(m=>m.kind==='receipt');assert.equal(receipt.status,'sent');
 const normal=calls.filter(c=>c.path.endsWith('/ig-a/messages')).at(-1);assert.deepEqual(JSON.parse(normal.body).recipient,{id:'buyer-a'});
});
test('payment QR rides as an image follow-up and releases when a closed window opens',async()=>{
  bids.updateShopSettings('shop-a',{gcashName:'Test Seller',gcashNumber:'09123456789',gcashQrUrl:'https://example.test/gcash-qr.png',shippingFee:50,paymentWindowHours:12});
  const open=bids.createItem({shopId:'shop-a',destinationId:'ig-a',postId:'owned-post',platform:'instagram',name:'QR open window',startingBid:500,minIncrement:50,claimPrice:600,deadline:new Date(Date.now()+3600000).toISOString()});
  assert.equal(open.ok,true,JSON.stringify(open));
  bids.handleComment({shopId:'shop-a',destinationId:'ig-a',platform:'instagram',postId:'owned-post',commentId:'qr-open-claim',from:{id:'buyer-a',username:'buyer'},text:'claim',mode:'live'});
  const openWinner=bids.getOutbox({shopId:'shop-a'}).find(m=>m.itemId===open.item.id&&m.kind==='winner');
  assert.match(openWinner.text,/To ship QR open window, please reply with:\nName:\nContact number:\nAddress:\nPostal code:/);
  const openQr=bids.getOutbox({shopId:'shop-a'}).find(m=>m.itemId===open.item.id&&m.kind==='qr');
  assert.equal(openQr.commentId,null);
  await server.runScheduler();
  assert.equal(bids.getOutbox().find(m=>m.id===openQr.id).status,'sent');
  const imageBody=JSON.parse(calls.filter(c=>c.path.endsWith('/ig-a/messages')).at(-1).body);
  assert.deepEqual(imageBody.recipient,{id:'buyer-a'});
  assert.deepEqual(imageBody.message,{attachments:{type:'image',payload:{url:'https://example.test/gcash-qr.png'}}});
  const closed=bids.createItem({shopId:'shop-a',destinationId:'ig-a',postId:'owned-post',platform:'instagram',name:'QR closed window',startingBid:500,minIncrement:50,claimPrice:600,deadline:new Date(Date.now()+3600000).toISOString()});
  assert.equal(closed.ok,true,JSON.stringify(closed));
  bids.handleComment({shopId:'shop-a',destinationId:'ig-a',platform:'instagram',postId:'owned-post',commentId:'qr-closed-claim',from:{id:'buyer-z',username:'buyer z'},text:'claim',mode:'live'});
  const closedQr=bids.getOutbox({shopId:'shop-a'}).find(m=>m.itemId===closed.item.id&&m.kind==='qr');
  await server.runScheduler();
  const blocked=bids.getOutbox().find(m=>m.id===closedQr.id);
  assert.equal(blocked.status,'failed');assert.equal(blocked.code,'MESSAGE_WINDOW_CLOSED');assert.match(blocked.error,/24-hour rule/);
  const inbound={object:'instagram',entry:[{id:'ig-a',messaging:[{sender:{id:'buyer-z'},timestamp:Date.now(),message:{mid:'qr-reopen-mid',text:'Hello'}}]}]};
  const rawIn=JSON.stringify(inbound);const signatureIn='sha256='+crypto.createHmac('sha256',env.SPAWN_THRIFT_APP_SECRET).update(rawIn).digest('hex');
  assert.equal((await fetch(base+'/webhook',{method:'POST',body:rawIn,headers:{'x-hub-signature-256':signatureIn}})).status,200);
  await new Promise(r=>setImmediate(r));
  assert.equal(bids.getOutbox().find(m=>m.id===closedQr.id).status,'pending','a buyer reply releases window-blocked notifications');
  await server.runScheduler();
  assert.equal(bids.getOutbox().find(m=>m.id===closedQr.id).status,'sent');
});

test('public launch status exposes no shop data and reports pending Meta approval',async()=>{
 const result=await (await fetch(base+'/api/public-config')).json();assert.equal(result.publicShopAccess,false);assert.match(result.connectionNotice,/Meta approval/);assert(!JSON.stringify(result).includes('shop-a'));
});
test('connecting Facebook preserves the existing Instagram channel and readiness',async()=>{
 const start=await fetch(base+'/auth/start?platform=facebook',{redirect:'manual'});
 const nonce=new URL(start.headers.get('location')).searchParams.get('state');const cookie=start.headers.get('set-cookie').split(';')[0];
 const result=await fetch(base+`/auth/callback?state=${nonce}&code=mock`,{headers:{cookie},redirect:'manual'});assert.equal(result.status,303);
 const connected=getDestinationConfig('shop-a');assert.deepEqual([...connected.platforms].sort(),['facebook','instagram']);assert(connected.readiness.instagram.ready);assert(connected.readiness.facebook.ready);
});

test('disconnect remains disconnected across legacy migration and restart',async()=>{
 const oldStore=process.env.THRIFT_STORE_DIR;const disabled=process.env.THRIFT_DISABLE_LEGACY_IMPORT;
 const legacy=path.join(dir,'migration-source.json');
 fs.writeFileSync(legacy,JSON.stringify({pages:{'legacy-page-1':{name:'Legacy shop',token:'migration-only-token',igId:'test-legacy-ig'}}}));
 process.env.THRIFT_STORE_DIR=path.join(dir,'migration-secrets');process.env.THRIFT_DISABLE_LEGACY_IMPORT='0';process.env.THRIFT_LEGACY_TOKEN_FILE=legacy;
 try{
  migrateTestAccount();assert.equal(getAllConnectedAccounts().length,1);assert(removePageToken('legacy-page-1'));
  const child=await import('node:child_process');
  const script="import {migrateTestAccount,getAllConnectedAccounts} from './src/tokens.js';migrateTestAccount();console.log(getAllConnectedAccounts().length)";
  const result=child.spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:process.env,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),'0');assert.equal(getAllConnectedAccounts().length,0);
  assert.equal(JSON.parse(fs.readFileSync(legacy)).pages['legacy-page-1'].token,'migration-only-token');
 }finally{process.env.THRIFT_STORE_DIR=oldStore;process.env.THRIFT_DISABLE_LEGACY_IMPORT=disabled;delete process.env.THRIFT_LEGACY_TOKEN_FILE;}
});
