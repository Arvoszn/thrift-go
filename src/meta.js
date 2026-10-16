// Every Graph error is reduced to safe public fields. Never log token-bearing URLs.
export function metaClient({version='v25.0',fetchImpl=fetch,host='facebook'}={}) {
  return async function graph(endpoint,token,{method='GET',body,params={}}={}) {
    const url=new URL(`https://graph.${host==='instagram'?'instagram':'facebook'}.com/${version}/${endpoint.replace(/^\//,'')}`);
    for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
    const response=await fetchImpl(url,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    const data=JSON.parse(await response.text(),(key,value,context)=>['id','user_id'].includes(key)&&typeof value==='number'?context.source:value);
    if(!response.ok || data.error)throw Object.assign(new Error(data.error?.message || 'Meta request failed'),{code:data.error?.code || response.status,subcode:data.error?.error_subcode});
    return data;
  };
}
export const scopesFor=platform=>platform==='instagram'?['instagram_basic','instagram_manage_comments','instagram_manage_messages','pages_show_list','pages_read_engagement','pages_manage_metadata']:['pages_show_list','pages_read_engagement','pages_read_user_content','pages_manage_metadata','pages_messaging'];
export async function verifyAccount(graph,account,platform,appId,appSecret,publicUrl) {
  const issues=[];
  try {
    const debug=await graph('debug_token',`${appId}|${appSecret}`,{params:{input_token:account.token}});
    if(!debug.data?.is_valid)issues.push('Authorization expired. Reconnect this account.');
    if(String(debug.data?.app_id)!==String(appId))issues.push('Reconnect this account using Thrift Go login.');
    const granted=debug.data?.scopes || [];
    for(const scope of scopesFor(platform))if(!granted.includes(scope))issues.push(`Meta has not granted ${scope}. Reconnect or finish app review.`);
    const identity=await graph(account.id,account.token,{params:{fields:'id,name,instagram_business_account{id,username}'}});
    if(platform==='instagram' && (!account.igId || identity.instagram_business_account?.id!==account.igId))issues.push('Link an Instagram professional account to this Facebook Page.');
    const destination=account.id;
    if(destination){
      const subscriptions=await graph(`${destination}/subscribed_apps`,account.token);
      const subscription=(subscriptions.data || []).find(s=>String(s.id)===String(appId));
      const fields=platform==='instagram'?['messages']:['feed','messages'];
      if(!subscription)issues.push('Reconnect to finish the shop webhook subscription.');
      else for(const field of fields)if(!subscription.subscribed_fields?.includes(field))issues.push(`The ${field} webhook is not subscribed. Reconnect this account.`);
    }
    const appSubscriptions=await graph(`${appId}/subscriptions`,`${appId}|${appSecret}`);
    const wanted=platform==='instagram'?['comments','messages']:['feed','messages'];
    const object=platform==='instagram'?'instagram':'page';
    const sub=(appSubscriptions.data || []).find(s=>s.object===object && s.active && s.callback_url=== (publicUrl || process.env.THRIFT_PUBLIC_URL || 'http://127.0.0.1:4331')+'/webhook');
    for(const field of wanted)if(!sub?.fields?.some(f=>(typeof f==='string'?f:f.name)===field))issues.push(`Thrift Go needs the ${object} ${field} app webhook enabled.`);
  } catch(err){issues.push(err.code===190?'Authorization expired. Reconnect this account.':`Meta check failed (${err.code || 'network'}). Reconnect or retry.`);}
  return {ready:issues.length===0,issues};
}
export async function subscribeAccount(graph,account,platform) {
  const dest=account.id;
  if(!dest)throw new Error('No Instagram professional account was selected');
  const platforms=Array.isArray(platform)?platform:[platform];
  const fields=platforms.includes('facebook')?'feed,messages,messaging_postbacks':'messages,messaging_postbacks';
  const result=await graph(`${dest}/subscribed_apps`,account.token,{method:'POST',params:{subscribed_fields:fields}});
  if(!result.success)throw new Error('Meta did not confirm the webhook subscription');
}
