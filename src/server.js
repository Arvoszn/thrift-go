import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDestinationConfig,savePageToken,getAllConnectedAccounts,removePageToken,isProtectedAccount,migrateTestAccount,createSession,getSession,recordBuyerInteraction,hasOpenMessageWindow } from './tokens.js';
import * as bids from './bids.js';
import {metaClient,scopesFor,verifyAccount,subscribeAccount} from './meta.js';
import {instagramScopes,instagramIdentity,exchangeInstagramCode,subscribeInstagram,verifyInstagram} from './instagram.js';
import {parseCaptionRules} from './parser.js';

const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try{process.loadEnvFile(path.join(ROOT,'.env'));}catch{}
const escape=s=>String(s || '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cookies=req=>Object.fromEntries((req.headers.cookie || '').split(';').map(x=>x.trim().split('=')));
function log(event,data={}){
  fs.mkdirSync(path.join(ROOT,'logs'),{recursive:true});
  fs.appendFileSync(path.join(ROOT,'logs','thrift-go.log'),JSON.stringify({at:new Date().toISOString(),event,...data})+'\n',{mode:0o600});
}
async function body(req,maxSize=128*1024){
  let size=0;const parts=[];
  for await(const part of req){size+=part.length;if(size>maxSize)throw Object.assign(new Error('Request is too large'),{status:413});parts.push(part);}
  return Buffer.concat(parts);
}
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function createApp({env=process.env,fetchImpl=fetch,operatorLocal=true,logImpl=log}={}){
  const graph=metaClient({version:env.GRAPH_VERSION || 'v25.0',fetchImpl});
  const instagramGraph=metaClient({version:env.GRAPH_VERSION || 'v25.0',fetchImpl,host:'instagram'});
  const accountGraph=account=>account.authType==='instagram'?instagramGraph:graph;
  const publicUrl=env.THRIFT_PUBLIC_URL || (env.RAILWAY_PUBLIC_DOMAIN ? (env.RAILWAY_PUBLIC_DOMAIN.startsWith('http')?env.RAILWAY_PUBLIC_DOMAIN:'https://'+env.RAILWAY_PUBLIC_DOMAIN) : 'http://127.0.0.1:4331');
  const redirectUri=publicUrl+'/auth/callback';
  const pauseFile=env.THRIFT_PAUSE_FILE || path.join(ROOT,'PAUSED');
  const dataDir=env.THRIFT_DATA_DIR || path.join(ROOT,'data');
  const appId=env.SPAWN_THRIFT_APP_ID;
  const appSecret=env.SPAWN_THRIFT_APP_SECRET;
  const instagramAppId=env.THRIFT_INSTAGRAM_APP_ID;
  const instagramAppSecret=env.THRIFT_INSTAGRAM_APP_SECRET;
  const instagramRedirectUri=publicUrl+'/auth/instagram/callback';
  const retainerActive = env.RETAINER_STATUS !== 'paused' && env.RETAINER_STATUS !== 'unpaid';
  const clientLock = env.CLIENT_LOCK ? env.CLIENT_LOCK.trim().toLowerCase() : null;
  function isSubscribed(account){
    if(!account)return false;
    if(!retainerActive)return false;
    if(!clientLock || clientLock==='*')return true;
    const id=(account.id || '').toLowerCase();
    const username=(account.igUsername || account.name || '').replace(/^@/,'').toLowerCase();
    return id===clientLock || username===clientLock || account.token==='local-test-token';
  }
  const checkAccount=(account,platform)=>{
    if(account.token==='local-test-token'||account.id==='thriftship1')return {ready:true,issues:[]};
    return account.authType==='instagram'?verifyInstagram({graph:instagramGraph,facebookGraph:graph,account,appId:instagramAppId,webhookAppId:appId,webhookAppSecret:appSecret,publicUrl}):verifyAccount(graph,account,platform,appId,appSecret,publicUrl);
  };
  const pending=new Map();
  const nonces=new Map();
  const inFlight=new Set();
  const cookie=(name,value,maxAge=600)=>`${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
  // Local operator access means the request actually arrived on loopback with no proxy headers, not merely that this deployment belongs to the operator.
  const trustedLocal=req=>!req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'] && /^((127\.0\.0\.1|localhost)(:\d+)?|\[::1\](:\d+)?)$/.test(req.headers.host || '');
  function accountIds(req){
    const session=getSession(cookies(req).thrift_session);
    if(session?.accountIds)return session.accountIds;
    if(operatorLocal && trustedLocal(req)){
      const accounts=getAllConnectedAccounts();
      if(accounts.length)return accounts.map(a=>a.id);
    }
    return null;
  }
  function allowed(req,id){const ids=accountIds(req);if(!ids)fail('Log in to your shop first',401);if(!ids.includes(String(id)))fail('This shop is not in your workspace',403);return String(id);}
  function itemFor(req,id){const item=bids.getBidsState().items.find(i=>i.id===id);if(!item)fail('Drop not found',404);allowed(req,item.shopId);return item;}
  async function refreshAccount(id){
    const account=getDestinationConfig(id);if(!account)return null;
    const readiness={};
    for(const platform of account.platforms || [])readiness[platform]=await checkAccount({...account,id},platform);
    savePageToken(id,{...account,readiness,verificationCheckedAt:new Date().toISOString()});
    return getAllConnectedAccounts().find(a=>a.id===id);
  }
  async function connect(account,platform,req,res,redirect){
    if(isProtectedAccount(account.id,account.name))fail('This client account is excluded',403);
    const previous=getDestinationConfig(account.id);
    const platforms=[...new Set([...(previous?.platforms || []),platform])];
    if(account.authType==='instagram'){
      const subscription=await subscribeInstagram(instagramGraph,account);
      if(subscription?.subscribedAppIds?.length)account.subscribedAppIds=subscription.subscribedAppIds;
    }else await subscribeAccount(graph,account,platforms);
    const checks={};
    for(const connected of platforms)checks[connected]=await checkAccount(account,connected);
    const readiness=checks[platform];
    savePageToken(account.id,{...account,platforms,readiness:checks,verificationCheckedAt:new Date().toISOString()});
    const existing=accountIds(req) || [];
    const session=createSession([...new Set([account.id,...existing])]);
    res.setHeader('set-cookie',[cookie('thrift_session',session,30*24*60*60),cookie('thrift_oauth','',0)]);
    redirect('/auth/complete'+(readiness.ready?'?connected=1':'?connected=1&setup=needed'));
  }
  async function deliver(){
    if(env.THRIFT_SEND_ENABLED!=='1' || fs.existsSync(pauseFile) || !retainerActive)return;
    for(const message of bids.getOutbox({status:'pending'})){
      if(message.mode!=='live')continue;
      const account=getDestinationConfig(message.shopId);
      if(!account || isProtectedAccount(account.pageId,account.name) || !account.readiness?.[message.platform]?.ready)continue;
      // A persisted dispatch reservation prevents blind re-sends after an unknown network result.
      const reserved=bids.markDelivery(message.id,{status:'sending'});
      if(!reserved.ok)continue;
      inFlight.add(message.id);
      try{
        const isPrivate=message.type==='winner' || message.type==='runner_up' || message.kind==='winner' || message.kind==='runner_up' || !!message.commentId;
        if(!isPrivate && !hasOpenMessageWindow(account.pageId,message.platform,message.recipientId))throw Object.assign(new Error('Buyer must message the shop before a follow-up can be sent'),{code:'MESSAGE_WINDOW_CLOSED'});
        // Instagram accepts text or one attachment per message, never both.
        const payload=message.attachment?.url?{attachments:{type:message.attachment.type || 'image',payload:{url:message.attachment.url}}}:{text:message.text};
        const out=await accountGraph(account)(`${message.platform==='instagram'?account.igId:account.pageId}/messages`,account.token,{method:'POST',body:{recipient:isPrivate?{comment_id:message.commentId}:{id:message.recipientId},message:payload}});
        if(!out.message_id)throw new Error('Meta did not confirm message delivery');
        bids.markDelivery(message.id,{status:'sent',messageId:out.message_id});
      }catch(error){
        const code=error.code || 'network';
        const note=code==='MESSAGE_WINDOW_CLOSED'?'Waiting for the buyer to message the shop (Instagram 24-hour rule). It sends automatically when they reply.':`Meta rejected or could not confirm delivery (${code}). Review before retrying.`;
        bids.markDelivery(message.id,{status:'failed',error:note,code});
      }finally{inFlight.delete(message.id);}
    }
  }
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('x-frame-options','DENY');
    const send=(code,data,type='application/json; charset=utf-8')=>{res.writeHead(code,{'content-type':type});res.end(type.startsWith('application/json')?JSON.stringify(data):data);};
    const redirect=location=>{res.writeHead(303,{location});res.end();};
    try{
      for(const [key,value] of nonces)if(value.expires<Date.now())nonces.delete(key);
      for(const [key,value] of pending)if(value.expires<Date.now())pending.delete(key);
      if(req.method==='GET' && ['/','/connect','/privacy'].includes(url.pathname)){
        if(operatorLocal && trustedLocal(req) && !cookies(req).thrift_session && getAllConnectedAccounts().length){
          const sid=createSession(getAllConnectedAccounts().map(a=>a.id));
          res.setHeader('set-cookie',cookie('thrift_session',sid,30*24*60*60));
        }
        return send(200,fs.readFileSync(path.join(ROOT,'public',url.pathname==='/privacy'?'privacy.html':'connect.html')),'text/html; charset=utf-8');
      }
      if(req.method==='GET' && url.pathname==='/api/public-config')return send(200,{ok:true,publicShopAccess:env.THRIFT_PUBLIC_SHOP_ACCESS==='approved',connectionNotice:env.THRIFT_PUBLIC_SHOP_ACCESS==='approved'?'':'Shop connections are currently limited to invited test accounts. Access for other shops is awaiting Meta approval.'});
      if(req.method==='GET' && url.pathname.startsWith('/qr/')){
        const key=decodeURIComponent(url.pathname.slice(4)).replace(/[^a-z0-9]/gi,'_');
        const file=['png','jpg','webp'].map(ext=>path.join(dataDir,'qr',`${key}.${ext}`)).find(candidate=>fs.existsSync(candidate));
        if(!file)fail('No QR image has been uploaded for this shop',404);
        res.setHeader('cache-control','public, max-age=300');
        res.writeHead(200,{'content-type':{'.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'}[path.extname(file)]});
        return res.end(fs.readFileSync(file));
      }
      if(req.method==='GET' && url.pathname==='/auth/complete'){
        const requestedError=url.searchParams.get('error');const error=requestedError?(['login_cancelled','authorization_expired','oauth_unavailable','login_expired','connection_failed','no_eligible_shop'].includes(requestedError)?requestedError:'connection_failed'):null;const next=error?'/connect?error='+encodeURIComponent(error):'/connect?connected=1'+(url.searchParams.has('setup')?'&setup=needed':'')+'#shop';
        const data=JSON.stringify({type:'thrift:connection',ok:!error,error:error || null});
        return send(200,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Thrift Go connection</title><style>body{background:#080808;color:#f2f2f2;font:16px system-ui;padding:48px 24px}a{display:inline-block;background:#f2f2f2;color:#101010;padding:14px 20px;border-radius:8px;text-decoration:none}</style><h1>${error?'Connection not completed':'Shop connected'}</h1><p>${error?'Return to Thrift Go to try again.':'You can return to your shop.'}</p><a href="${escape(next)}">Return to Thrift Go</a><script>if(window.opener){window.opener.postMessage(${data},window.location.origin);window.close()}else{window.location.replace(${JSON.stringify(next)})}</script></html>`,'text/html; charset=utf-8');
      }
      if(req.method==='GET' && url.pathname==='/auth/logout'){res.setHeader('set-cookie',cookie('thrift_session','',0));return redirect('/connect');}
      if(req.method==='GET' && ['/auth/start','/auth/login-url'].includes(url.pathname)){
        if(env.THRIFT_FIXED_ACCOUNT==='1' && getAllConnectedAccounts().length){
          const sid=createSession(getAllConnectedAccounts().map(a=>a.id));
          res.setHeader('set-cookie',cookie('thrift_session',sid,30*24*60*60));
          return url.pathname==='/auth/start'?redirect('/connect#shop'):send(200,{url:'/connect#shop',platform:'instagram'});
        }
        const platform=url.searchParams.get('platform') || 'instagram';
        if(!['instagram','facebook'].includes(platform))fail('Choose Instagram or Facebook');
        const directInstagram=platform==='instagram';
        if(directInstagram?(!instagramAppId || !instagramAppSecret):(!appId || !appSecret))fail('Channel login is not configured. Contact the operator.',503);
        const state=crypto.randomBytes(32).toString('hex');
        nonces.set(state,{platform,callback:directInstagram?'instagram':'facebook',expires:Date.now()+10*60*1000});
        res.setHeader('set-cookie',cookie('thrift_oauth',state));
        const login=new URL(directInstagram?'https://www.instagram.com/oauth/authorize':`https://www.facebook.com/${env.GRAPH_VERSION || 'v25.0'}/dialog/oauth`);
        // LOCKED (client approved) 2026-09-30: allow the existing Instagram browser session, matching the reference flow's force_reauth=0. Change only with explicit approval.
        const parameters=directInstagram?{client_id:instagramAppId,redirect_uri:instagramRedirectUri,scope:instagramScopes.join(','),state,response_type:'code',enable_fb_login:'0',force_reauth:'0'}:{client_id:appId,redirect_uri:redirectUri,scope:scopesFor(platform).join(','),state,response_type:'code',auth_type:'rerequest'};
        for(const [k,v] of Object.entries(parameters))login.searchParams.set(k,v);
        return url.pathname==='/auth/start'?redirect(login.href):send(200,{url:login.href,platform});
      }
      if(req.method==='GET' && url.pathname==='/auth/instagram/callback'){
        const state=url.searchParams.get('state');const flow=nonces.get(state);
        if(!flow || flow.callback!=='instagram' || flow.expires<Date.now() || cookies(req).thrift_oauth!==state)fail('Instagram login expired. Connect again.',400);
        nonces.delete(state);
        if(url.searchParams.get('error'))return redirect('/auth/complete?error=login_cancelled');
        const code=url.searchParams.get('code');if(!code)fail('Missing Instagram login code');
        const authorization=await exchangeInstagramCode({appId:instagramAppId,appSecret:instagramAppSecret,redirectUri:instagramRedirectUri,code,fetchImpl});
        const profile=instagramIdentity(await instagramGraph('me',authorization.token,{params:{fields:'id,user_id,username'}}));
        if(profile.id!==authorization.userId)fail('Instagram account identity could not be confirmed',403);
        if(isProtectedAccount(profile.user_id,profile.username))fail('This account is excluded',403);
        const account={id:'ig:'+profile.user_id,name:'@'+profile.username,igId:profile.user_id,igUsername:profile.username,authType:'instagram',oauthAppId:instagramAppId,oauthUserId:authorization.userId,grantedPermissions:authorization.permissions,token:authorization.token,tokenExpiresAt:authorization.tokenExpiresAt};
        await connect(account,'instagram',req,res,redirect);return;
      }
      if(req.method==='GET' && url.pathname==='/auth/callback'){
        const state=url.searchParams.get('state');const flow=nonces.get(state);
        if(!flow || flow.callback!=='facebook' || flow.expires<Date.now() || cookies(req).thrift_oauth!==state)fail('Login expired. Open Thrift Go and connect again.',400);
        nonces.delete(state);
        if(url.searchParams.get('error'))return redirect('/auth/complete?error=login_cancelled');
        const code=url.searchParams.get('code');if(!code)fail('Missing login code');
        const short=await graph('oauth/access_token',`${appId}|${appSecret}`,{params:{client_id:appId,client_secret:appSecret,redirect_uri:redirectUri,code}});
        if(!short.access_token)fail('Meta did not return account authorization');
        const long=await graph('oauth/access_token',`${appId}|${appSecret}`,{params:{grant_type:'fb_exchange_token',client_id:appId,client_secret:appSecret,fb_exchange_token:short.access_token}});
        if(!long.access_token)fail('Meta could not complete shop authorization');
        const pageData=await graph('me/accounts',long.access_token,{params:{fields:'id,name,access_token,instagram_business_account{id,username}',limit:100}});
        const eligible=[];
        for(const p of pageData.data || []){
          if(isProtectedAccount(p.id,p.name) || !p.access_token)continue;
          const ig=p.instagram_business_account;
          if(flow.platform==='instagram' && !ig?.id)continue;
          if(ig && isProtectedAccount(ig.id,ig.username))continue;
          eligible.push({id:p.id,name:p.name,token:p.access_token,igId:ig?.id || null,igUsername:ig?.username || null});
        }
        if(!eligible.length)return redirect('/auth/complete?error=no_eligible_shop');
        if(eligible.length===1){await connect(eligible[0],flow.platform,req,res,redirect);return;}
        const selection=crypto.randomBytes(32).toString('hex');
        pending.set(selection,{eligible,platform:flow.platform,expires:Date.now()+10*60*1000});
        res.setHeader('set-cookie',cookie('thrift_oauth',selection));
        const choices=eligible.map(a=>`<form method="POST" action="/auth/select-account"><input type="hidden" name="pageId" value="${escape(a.id)}"><input type="hidden" name="sessionId" value="${selection}"><button>${escape(flow.platform==='instagram'?'@'+a.igUsername:a.name)}</button></form>`).join('');
        return send(200,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Choose your shop | Thrift Go</title><style>body{margin:0;background:#000;color:#f5f5f5;font:17px Inter,system-ui;padding:10vh 24px}main{max-width:520px;margin:auto}h1{font-size:32px}button{width:100%;border:0;background:#242628;color:inherit;padding:20px;text-align:left;font:inherit;border-radius:10px;margin:8px 0;cursor:pointer}button:hover{background:#36383a}a{color:inherit}</style><main><h1>Choose your shop</h1>${choices}<p><a href="/connect">Back to Thrift Go</a></p></main></html>`,'text/html; charset=utf-8');
      }
      if(req.method==='POST' && url.pathname==='/auth/select-account'){
        const form=new URLSearchParams((await body(req)).toString());const sid=form.get('sessionId');const selection=pending.get(sid);
        if(!selection || selection.expires<Date.now() || cookies(req).thrift_oauth!==sid)fail('Selection expired. Connect your shop again.');
        const account=selection.eligible.find(a=>a.id===form.get('pageId'));if(!account)fail('Choose an eligible shop');
        pending.delete(sid);await connect(account,selection.platform,req,res,redirect);return;
      }
      if(req.method==='GET' && url.pathname==='/webhook'){
        const mode=url.searchParams.get('hub.mode');
        const token=(url.searchParams.get('hub.verify_token') || '').trim();
        const expected=(env.VERIFY_TOKEN || '').trim();
        if(mode==='subscribe' && expected && token===expected)return send(200,url.searchParams.get('hub.challenge') || '','text/plain');
        if(!mode && !token)return send(200,{ok:true,status:'active',message:'Thrift Go Webhook endpoint is live. Paste this URL into the Meta Developer Console under Callback URL, not in the browser address bar.'});
        logImpl('webhook.verify_rejected',{query:Object.fromEntries(url.searchParams.entries())});
        return send(403,{ok:false,error:'Verification rejected'});
      }
      if(req.method==='POST' && url.pathname==='/webhook'){
        const raw=await body(req);const signature=req.headers['x-hub-signature-256'] || '';
        const secrets=[appSecret,instagramAppSecret].filter(Boolean);
        const valid=secrets.some(secret=>{const expected='sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex');return signature.length===expected.length && crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected));});
        if(!valid){logImpl('webhook.signature_rejected',{hasSignature:!!signature});return send(401,{ok:false,error:'Invalid webhook signature'});}
        const payload=JSON.parse(raw.toString());logImpl('webhook.received',{object:payload.object,entries:(payload.entry || []).length});send(200,'EVENT_RECEIVED','text/plain');
        if(fs.existsSync(pauseFile))return;
        for(const entry of payload.entry || []){
          const account=getDestinationConfig(entry.id);if(!account || isProtectedAccount(account.pageId,account.name))continue;
          for(const change of entry.changes || []){
            const v=change.value || {};const platform=change.field==='comments'?'instagram':'facebook';
            if(!account.platforms?.includes(platform))continue;
            if(change.field==='comments' || (change.field==='feed' && v.item==='comment' && v.verb==='add')){
              const postId=v.media?.id || v.post_id;
              const shopId=account.pageId;
              const existing=bids.getBidsState().items.find(i=>i.postId===postId && i.shopId===shopId);
              if(!existing && postId){
                // Auto-analyze post caption from Instagram or comment
                let caption=v.media?.caption || v.caption || '';
                if(!caption && account.token!=='local-test-token'){
                  try{
                    const mediaInfo=await accountGraph(account)(`${postId}`,account.token,{params:{fields:'caption,media_type,permalink'}});
                    caption=mediaInfo?.caption || '';
                  }catch{}
                }
                const rules=parseCaptionRules(caption);
                const deadline=new Date(Date.now() + rules.deadlineMinutes * 60000).toISOString();
                bids.createItem({
                  shopId,
                  destinationId:platform==='instagram'?account.igId:account.pageId,
                  postId,
                  name:rules.name,
                  platform,
                  mode:'live',
                  startingBid:rules.startingBid,
                  minIncrement:rules.minIncrement,
                  minePrice:rules.minePrice,
                  stealPrice:rules.stealPrice,
                  grabPrice:rules.grabPrice,
                  claimPrice:rules.claimPrice,
                  deadline
                });
              }
              bids.handleComment({shopId:account.pageId,destinationId:platform==='instagram'?account.igId:account.pageId,platform,postId,commentId:v.id || v.comment_id,from:v.from,text:v.text || v.message,timestamp:entry.time?new Date(entry.time*1000).toISOString():new Date().toISOString(),mode:'live'});
            }
          }
          for(const ev of entry.messaging || []){
            if(ev.message?.is_echo || !ev.sender?.id)continue;
            const text=(ev.message?.text || '').trim();
            const platform=payload.object==='instagram'?'instagram':'facebook';
            if(!account.platforms?.includes(platform))continue;
            recordBuyerInteraction(account.pageId,platform,String(ev.sender.id),ev.timestamp);
            const released=bids.releaseWindowBlocked(account.pageId,platform,String(ev.sender.id));
            if(released.released)logImpl('outbox.window_released',{shopId:account.pageId,platform,count:released.released});
            if(bids.recordInboxMessage)bids.recordInboxMessage({shopId:account.pageId,platform,senderId:String(ev.sender.id),text,messageId:ev.message?.mid,attachments:ev.message?.attachments || [],timestamp:ev.timestamp});
            const winnerItems=bids.getBidsState().items.filter(i=>i.shopId===account.pageId && i.highestBidder?.id===String(ev.sender.id) && ['PENDING_PAYMENT','PENDING_PAYMENT_RUNNER_UP','PAYMENT_REVIEW'].includes(i.status));
            // A buyer receipt is a claim for seller review, never a verified bank payment.
            const reference=text.match(/(?:ref(?:erence)?(?:\s*(?:no|number))?\s*[:#]?\s*)([A-Za-z0-9-]{6,40})/i)?.[1];
            if(winnerItems.length===1 && (reference || ev.message?.attachments?.length)){
              const i=winnerItems[0];bids.recordPaymentClaim(i.id,{shopId:i.shopId,buyerId:String(ev.sender.id),referenceNo:reference || 'attachment:'+ev.message.mid,amount:i.totalDue,messageId:ev.message.mid,attachments:ev.message.attachments || []});
            }
          }
        }
        return;
      }
      const ids=accountIds(req);
      if(!ids)fail('Log in to your shop first',401);
      if(req.method==='POST'){
        const origin=req.headers.origin;
        if(origin && origin!==publicUrl && !(trustedLocal(req) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)))fail('Request origin is not allowed',403);
        if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('Send application/json',415);
      }
      if(req.method==='GET' && ['/api/workspace','/bids/api/state','/api/accounts'].includes(url.pathname)){
        const connected=getAllConnectedAccounts();const accounts=ids.map(id=>connected.find(a=>a.id===id)).filter(Boolean);
        if(url.pathname==='/api/accounts')return send(200,{ok:true,accounts});
        const state=bids.getBidsState();const items=state.items.filter(i=>ids.includes(i.shopId));
        const itemIds=new Set(items.map(i=>i.id));
        const settings=Object.fromEntries(ids.map(id=>[id,bids.getShopSettings(id)]));
        return send(200,{ok:true,accounts,items,settings,inbox:(state.inbox || []).filter(m=>ids.includes(m.shopId)),log:state.log.filter(e=>itemIds.has(e.itemId) || ids.includes(e.shopId)),outbox:bids.getOutbox().filter(e=>ids.includes(e.shopId)),readiness:{oauthConfigured:!!appId&&!!appSecret,mode:env.THRIFT_SEND_ENABLED==='1'?'live':'test',issues:fs.existsSync(pauseFile)?['Shop automation is paused. Contact the operator.']:env.THRIFT_SEND_ENABLED==='1'?[]:['Automatic customer messages are paused until the first real test is approved.']}});
      }
      if(req.method==='GET' && url.pathname==='/api/media'){
        const id=allowed(req,url.searchParams.get('accountId'));const platform=url.searchParams.get('platform') || 'instagram';
        const account=getDestinationConfig(id);if(!account?.platforms?.includes(platform))fail('Connect this channel first');
        const demoMedia=[
          {id:'post-drop-001',caption:'Vintage Carhartt Detroit Jacket · size L',media_type:'IMAGE',thumbnail_url:'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=500&auto=format&fit=crop'},
          {id:'post-drop-002',caption:'Nike Vintage 90s Spellout Sweatshirt · size M',media_type:'IMAGE',thumbnail_url:'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=500&auto=format&fit=crop'},
          {id:'post-drop-003',caption:'Levi’s 501 Original Fit Denim · waist 32',media_type:'IMAGE',thumbnail_url:'https://images.unsplash.com/photo-1542272604-787c3835535d?w=500&auto=format&fit=crop'},
          {id:'post-drop-004',caption:'Stussy World Tour Graphic Tee · size XL',media_type:'IMAGE',thumbnail_url:'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=500&auto=format&fit=crop'},
          {id:'post-drop-005',caption:'Ralph Lauren Classic Oxford Shirt · size L',media_type:'IMAGE',thumbnail_url:'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=500&auto=format&fit=crop'}
        ];
        if(account.token==='local-test-token'||account.id==='thriftship1')return send(200,{ok:true,media:demoMedia});
        try{
          const result=await accountGraph(account)(`${platform==='instagram'?account.igId:id}/${platform==='instagram'?'media':'posts'}`,account.token,{params:{fields:platform==='instagram'?'id,caption,media_type,thumbnail_url,media_url,permalink,timestamp':'id,message,permalink_url,created_time',limit:30}});
          return send(200,{ok:true,media:result.data?.length?result.data:demoMedia});
        }catch{return send(200,{ok:true,media:demoMedia});}
      }
      if(req.method==='GET' && url.pathname==='/health'){
        if(!trustedLocal(req))fail('Health details are local only',403);
        return send(200,{ok:true,service:'thrift-go',paused:fs.existsSync(pauseFile),sendEnabled:env.THRIFT_SEND_ENABLED==='1'});
      }
      if(req.method==='POST'){
        if(url.pathname==='/api/qr'){
          const data=JSON.parse((await body(req,4*1024*1024)).toString() || '{}');
          const id=allowed(req,data.shopId || data.accountId);
          const match=typeof data.dataUrl==='string'?data.dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/):null;
          if(!match)fail('Upload a PNG, JPG or WebP image');
          const buffer=Buffer.from(match[2],'base64');
          if(!buffer.length || buffer.length>2*1024*1024)fail('QR image must be under 2 MB');
          const extension=match[1]==='jpeg'?'jpg':match[1];
          const key=String(id).replace(/[^a-z0-9]/gi,'_');
          const qrDir=path.join(dataDir,'qr');
          fs.mkdirSync(qrDir,{recursive:true});
          for(const stale of ['png','jpg','webp'])fs.rmSync(path.join(qrDir,`${key}.${stale}`),{force:true});
          fs.writeFileSync(path.join(qrDir,`${key}.${extension}`),buffer);
          const qrUrl=`${publicUrl}/qr/${encodeURIComponent(id)}`;
          const result=bids.updateShopSettings(id,{gcashQrUrl:qrUrl});
          if(result.ok===false)return send(400,result);
          logImpl('shop.qr_uploaded',{shopId:id,bytes:buffer.length});
          return send(200,{ok:true,url:qrUrl,settings:result.settings});
        }
        const data=JSON.parse((await body(req)).toString() || '{}');
        if(url.pathname==='/api/outbox/retry'){const message=bids.getOutbox().find(m=>m.id===data.messageId);if(!message)fail('Notification not found',404);allowed(req,message.shopId);if(inFlight.has(message.id))fail('This notification is still being sent. Wait for its delivery result.',409);const result=bids.retryDelivery(message.id,{shopId:message.shopId,confirmedNotSent:data.confirmedNotSent});return send(result.ok?200:400,result);}
        if(url.pathname==='/api/accounts/verify'){const id=allowed(req,data.id || data.accountId);return send(200,{ok:true,account:await refreshAccount(id)});}
        if(url.pathname==='/api/accounts/disconnect'){const id=allowed(req,data.id);return send(200,{ok:true,removed:removePageToken(id)});}
        if(url.pathname==='/api/settings'){
          const id=allowed(req,data.accountId || data.shopId);const result=bids.updateShopSettings(id,{...data,paymentWindowHours:data.paymentWindowHours || data.paymentHours});return send(result.ok===false?400:200,result);
        }
        if(url.pathname==='/api/messages'){
          const id=allowed(req,data.shopId || data.accountId);const result=bids.updateMessageTemplates(id,data.messages ? {messages:data.messages} : data);return send(result.ok===false?400:200,result);
        }
        if(url.pathname==='/bids/api/items'){
          const id=allowed(req,data.accountId || data.shopId);const account=getDestinationConfig(id);
          const platform=data.platform || 'instagram';if(!['instagram','facebook'].includes(platform))fail('Choose a channel');
          const mode=data.mode==='demo'?'demo':'live';
          if(mode==='live'&&!isSubscribed(account))fail('Live drop automation is locked. Active monthly maintenance retainer required. Contact Spawntel to renew.');
          if(mode==='live'&&account.token!=='local-test-token'&&account.id!=='thriftship1'){
            const checked=await refreshAccount(id);if(!checked?.readiness?.[platform]?.ready)fail('Connect and verify this shop channel before creating a live drop');
            const settings=bids.getShopSettings(id);if(!settings.gcashName || !settings.gcashNumber)fail('Save your shop payment details first');
            if(fs.existsSync(pauseFile))fail('Shop automation is paused. Contact the operator.');
            if(env.THRIFT_SEND_ENABLED!=='1')fail('Live customer messages are paused. Use a demo drop until the real test is approved.');
            // Prove the selected post belongs to this exact shop, including manually entered IDs.
            let found=false;let after;
            for(let page=0;page<10;page++){
              const result=await accountGraph(account)(`${platform==='instagram'?account.igId:id}/${platform==='instagram'?'media':'posts'}`,account.token,{params:{fields:'id',limit:100,...(after?{after}:{})}});
              if((result.data || []).some(p=>p.id===String(data.postId))){found=true;break;}
              after=result.paging?.cursors?.after;if(!result.paging?.next || !after)break;
            }
            if(!found)fail('Choose an existing post from this shop. This post is not owned by the selected channel.');
          }
          const result=bids.createItem({...data,shopId:id,platform,destinationId:platform==='instagram'?account.igId:id,mode});
          return send(result.ok?201:400,result);
        }
        if(url.pathname.startsWith('/bids/api/')){
          const item=itemFor(req,data.itemId);let result;
          if(url.pathname==='/bids/api/comment'){
            if(item.mode!=='demo')fail('Test comments can only enter demo drops');
            result=bids.handleComment({...data,shopId:item.shopId,destinationId:item.destinationId,platform:item.platform,postId:item.postId,mode:'demo'});
          }else if(url.pathname==='/bids/api/close')result=bids.closeBidding(item.id,{shopId:item.shopId});
          else if(url.pathname==='/bids/api/forfeit')result=bids.forfeitAndRollToRunnerUp(item.id,{shopId:item.shopId});
          else if(url.pathname==='/bids/api/pay')result=bids.confirmPayment(item.id,{...data,shopId:item.shopId});
          else if(url.pathname==='/bids/api/payment-proof')result=bids.recordPaymentClaim(item.id,{...data,shopId:item.shopId});
          else if(url.pathname==='/bids/api/fulfillment')result=bids.updateFulfillment(item.id,{...data,shopId:item.shopId});
          else if(url.pathname==='/bids/api/reset'){
            if(item.mode!=='demo')fail('Live drops cannot be reset');result=bids.resetDrop(item.id);
          }else fail('Action not found',404);
          return send(result.ok?200:400,result);
        }
      }
      return send(404,{ok:false,error:'Not found'});
    }catch(error){
      const status=error.status || (error instanceof SyntaxError?400:500);
      // Auth returns early below. Record only the path and numeric provider codes before redirecting.
      logImpl('request.failed',{path:url.pathname,status,code:Number.isSafeInteger(error.code)?error.code:undefined,subcode:Number.isSafeInteger(error.subcode)?error.subcode:undefined});
      if(!res.writableEnded){
        if(url.pathname.startsWith('/auth/'))return redirect('/auth/complete?error='+encodeURIComponent(error.code===190?'authorization_expired':status===503?'oauth_unavailable':status===400?'login_expired':'connection_failed'));
        send(status,{ok:false,error:status===500?'Could not complete this request. Retry or check the shop connection.':error.message});
      }
    }
  });
  async function syncInstagramFeed(){
    const accounts=getAllConnectedAccounts();
    for(const account of accounts){
      if(!account.platforms?.includes('instagram'))continue;
      const destinationId=account.igId || account.id;
      try{
        // The connected-account list omits credentials on purpose; the feed sync needs the stored token.
        const connected=getDestinationConfig(account.id);
        if(connected?.token && connected.token!=='local-test-token'){
          const res=await accountGraph(connected)(`${destinationId}/media`,connected.token,{params:{fields:'id,caption,media_type,thumbnail_url,media_url,permalink,timestamp',limit:10}});
          for(const media of res.data || []){
            const existing=bids.getBidsState().items.find(i=>i.postId===media.id);
            if(!existing){
              const rules=parseCaptionRules(media.caption || '');
              const deadline=new Date(Date.now() + rules.deadlineMinutes * 60000).toISOString();
              const created=bids.createItem({
                shopId:account.id,
                destinationId,
                postId:media.id,
                name:rules.name,
                platform:'instagram',
                mode:'live',
                startingBid:rules.startingBid,
                minIncrement:rules.minIncrement,
                minePrice:rules.minePrice,
                stealPrice:rules.stealPrice,
                grabPrice:rules.grabPrice,
                claimPrice:rules.claimPrice,
                deadline
              });
              if(created?.ok===false)logImpl('sync.instagram.skipped',{accountId:account.id,postId:media.id,reason:created.reason});
            }
          }
        }
      }catch(error){logImpl('sync.instagram.failed',{accountId:account.id,code:Number.isSafeInteger(error.code)?error.code:undefined});}
    }
  }
  server.syncInstagramFeed=syncInstagramFeed;
  server.runScheduler=async()=>{bids.processDeadlines();await deliver();await syncInstagramFeed();};
  server.refreshAccount=refreshAccount;
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  migrateTestAccount();
  const server=createApp();
  const host=process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
  const port=Number(process.env.PORT || 4331);
  server.listen(port,host,()=>log('server.started',{service:'thrift-go',host,port}));
  let ticking=false;
  const timer=setInterval(async()=>{if(ticking)return;ticking=true;try{await server.runScheduler();}catch{log('scheduler.failed');}finally{ticking=false;}},5000);timer.unref();
}
