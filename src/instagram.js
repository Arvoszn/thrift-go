// Instagram Login uses a dedicated Instagram app and Instagram user tokens.
// Never substitute Facebook Page credentials or log provider responses/secret-bearing URLs.
export const instagramScopes=['instagram_business_basic','instagram_business_manage_comments','instagram_business_manage_messages'];
export function instagramIdentity(response){
  if(response.data && (!Array.isArray(response.data) || response.data.length!==1 || response.user_id))throw new Error('Instagram returned ambiguous identity');
  const profile=response.data?.[0] || response;
  if(!profile.id || !profile.user_id || !profile.username)throw new Error('Instagram account identity could not be confirmed');
  return {id:String(profile.id),user_id:String(profile.user_id),username:profile.username};
}
async function result(response){
  let value;try{value=JSON.parse(await response.text(),(key,value,context)=>['id','user_id'].includes(key)&&typeof value==='number'?context.source:value);}catch{throw new Error('Instagram returned an invalid response');}
  if(!response.ok || value.error || value.error_type)throw Object.assign(new Error('Instagram could not complete authorization'),{code:value.error?.code || response.status});
  return value;
}
export async function exchangeInstagramCode({appId,appSecret,redirectUri,code,fetchImpl=fetch}){
  const form=new FormData();for(const [k,v] of Object.entries({client_id:appId,client_secret:appSecret,grant_type:'authorization_code',redirect_uri:redirectUri,code}))form.set(k,v);
  const response=await result(await fetchImpl(new URL('https://api.instagram.com/oauth/access_token'),{method:'POST',body:form,signal:AbortSignal.timeout(15000)}));
  if(response.data && (response.data.length!==1 || response.access_token))throw new Error('Instagram returned ambiguous authorization');
  const short=response.data?.[0] || response;if(!short.access_token || !short.user_id)throw new Error('Instagram did not authorize a professional account');
  const permissions=Array.isArray(short.permissions)?short.permissions:typeof short.permissions==='string'?short.permissions.split(',').map(p=>p.trim()):[];
  if(instagramScopes.some(scope=>!permissions.includes(scope)))throw new Error('Instagram did not grant the required shop permissions');
  const url=new URL('https://graph.instagram.com/access_token');for(const [k,v] of Object.entries({grant_type:'ig_exchange_token',client_secret:appSecret,access_token:short.access_token}))url.searchParams.set(k,v);
  const long=await result(await fetchImpl(url,{signal:AbortSignal.timeout(15000)}));
  if(!long.access_token)throw new Error('Instagram did not return a persistent authorization');
  return {token:long.access_token,userId:String(short.user_id),permissions,tokenExpiresAt:new Date(Date.now()+Number(long.expires_in || 3600)*1000).toISOString()};
}
export async function subscribeInstagram(graph,account){
  const read=async()=>{try{return (await graph(`${account.igId}/subscribed_apps`,account.token)).data || [];}catch{return [];}};
  const before=await read();
  const response=await graph(`${account.igId}/subscribed_apps`,account.token,{method:'POST',params:{subscribed_fields:'comments,messages'}});
  if(!response.success)throw new Error('Instagram did not confirm the webhook subscription');
  // Meta reports the subscription under this app's scoped id, which is neither the OAuth client id
  // nor the parent Meta app id, so remember the entry created by this exact subscription call.
  const after=await read();
  const carriesBoth=entry=>['comments','messages'].every(field=>entry.subscribed_fields?.includes(field));
  const claimed=after.filter(carriesBoth).map(entry=>String(entry.id));
  const prior=new Set(before.filter(carriesBoth).map(entry=>String(entry.id)));
  const fresh=claimed.filter(id=>!prior.has(id));
  return {subscribedAppIds:fresh.length?fresh:(claimed.length===1?claimed:[])};
}
export async function verifyInstagram({graph,facebookGraph,account,appId,webhookAppId,webhookAppSecret,publicUrl}){
  const issues=[];
  try{
    // The Instagram app credentials are for native token exchange, not Facebook app introspection.
    // Grants come from the authenticated exchange; /me validates the token's two distinct IDs.
    if(String(account.oauthAppId)!==String(appId))issues.push('Connect Instagram using Thrift Go login.');
    if(!account.tokenExpiresAt || Date.parse(account.tokenExpiresAt)<=Date.now() || !Number.isFinite(Date.parse(account.tokenExpiresAt)))issues.push('Instagram authorization expired. Connect Instagram again.');
    for(const scope of instagramScopes)if(!account.grantedPermissions?.includes(scope))issues.push(`Instagram has not granted ${scope}. Connect Instagram again.`);
    const identity=instagramIdentity(await graph('me',account.token,{params:{fields:'id,user_id,username'}}));
    if(identity.user_id!==String(account.igId) || identity.id!==String(account.oauthUserId))issues.push('Instagram account identity did not match. Connect Instagram again.');
    const subscribed=await graph(`${account.igId}/subscribed_apps`,account.token);
    // Meta may report the account subscription under the app-scoped id captured at connect time.
    const knownIds=[appId,webhookAppId,...(account.subscribedAppIds || [])].map(String);
    const own=(subscribed.data || []).find(a=>knownIds.includes(String(a.id)));
    for(const field of ['comments','messages'])if(!own?.subscribed_fields?.includes(field))issues.push(`Instagram ${field} subscription needs setup.`);
    const app=await facebookGraph(`${webhookAppId}/subscriptions`,`${webhookAppId}|${webhookAppSecret}`);
    const sub=(app.data || []).find(a=>a.object==='instagram' && a.active && a.callback_url===publicUrl+'/webhook');
    for(const field of ['comments','messages'])if(!sub?.fields?.some(f=>(typeof f==='string'?f:f.name)===field))issues.push(`Thrift Go needs the Instagram ${field} webhook enabled.`);
  }catch(error){issues.push(`Instagram connection check failed (${error.code || 'network'}). Check the connection again.`);}
  return {ready:issues.length===0,issues};
}
