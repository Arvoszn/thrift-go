import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Client and personal accounts that must never be connected are configured per
// deployment via THRIFT_PROTECTED_IDS and THRIFT_PROTECTED_NAMES.
const parseList = raw => String(raw || '').split(',').map(v => v.trim()).filter(Boolean);
export function isProtectedAccount(id, name = '') {
  if (parseList(process.env.THRIFT_PROTECTED_IDS).includes(String(id))) return true;
  const needle = String(name || '').toLowerCase();
  return needle !== '' && parseList(process.env.THRIFT_PROTECTED_NAMES).some(v => needle.includes(v.toLowerCase()));
}
const directory = () => process.env.THRIFT_STORE_DIR || path.join(os.homedir(), '.config', 'thrift-go');
function key() {
  fs.mkdirSync(directory(), {recursive:true, mode:0o700});
  const file = path.join(directory(), 'store.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32), {mode:0o600, flag:'wx'});
  return fs.readFileSync(file);
}
export function loadStore() {
  const file = path.join(directory(), 'accounts.enc');
  if (!fs.existsSync(file)) return {pages:{}, sessions:{}};
  const b = fs.readFileSync(file); const decipher = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0,12));
  decipher.setAuthTag(b.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)),decipher.final()]).toString());
}
export function writeStore(data) {
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm',key(),iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);
  const file = path.join(directory(), 'accounts.enc');
  fs.writeFileSync(file+'.tmp', Buffer.concat([iv,cipher.getAuthTag(),encrypted]), {mode:0o600});fs.renameSync(file+'.tmp',file);
}
export function savePageToken(id, info) {
  if (isProtectedAccount(id,info.name) || isProtectedAccount(info.igId,info.igUsername)) return null;
  const store=loadStore(); const old=store.pages[String(id)] || {};
  store.pages[String(id)]={...old,...info,platforms:[...new Set([...(old.platforms || []),...(info.platforms || [])])],updated_at:new Date().toISOString()};
  writeStore(store);return store.pages[String(id)];
}
export function getDestinationConfig(id) {
  const store=loadStore();
  const entries=Object.entries(store.pages).sort(([a,x],[b,y])=>Number(y.authType==='instagram')-Number(x.authType==='instagram'));
  const entry=entries.find(([pageId,info]) => !isProtectedAccount(pageId,info.name) && (pageId===String(id) || info.igId===String(id)));
  if (!entry) return null;
  const [pageId,info]=entry;
  return {...info,id:String(id),pageId,platform:pageId===String(id)?'facebook':'instagram'};
}
export function getAllConnectedAccounts() {
  return Object.entries(loadStore().pages).filter(([id,p]) => !isProtectedAccount(id,p.name)).map(([id,p]) => ({id,name:p.name,igId:p.igId || null,igUsername:p.igUsername || null,hasToken:!!p.token,authType:p.authType || 'facebook',platforms:p.platforms || [],readiness:p.readiness || {},verificationCheckedAt:p.verificationCheckedAt,updated_at:p.updated_at}));
}
export function removePageToken(id) {
  const store=loadStore(); if (!store.pages[String(id)]) return false;
  delete store.pages[String(id)];store.legacyImportCompleted=true;writeStore(store);return true;
}
// Import a previously authorized shop from a legacy credential file, once.
// The legacy file is only read; it is never modified.
export function migrateTestAccount() {
  if (process.env.THRIFT_DISABLE_LEGACY_IMPORT==='1') return;
  const store=loadStore();if(store.legacyImportCompleted)return;
  store.legacyImportCompleted=true;writeStore(store);
  if(getAllConnectedAccounts().length)return;
  const legacy=process.env.THRIFT_LEGACY_TOKEN_FILE || path.join(os.homedir(),'.config','thrift-go','legacy-tokens.json');
  if (!fs.existsSync(legacy)) return;
  const entry = Object.entries(JSON.parse(fs.readFileSync(legacy,'utf8')).pages || {}).find(([,p]) => p?.token);
  if (!entry) return;
  const [legacyId, legacyInfo] = entry;
  savePageToken(legacyId, {...legacyInfo, platforms:['instagram'], readiness:{instagram:{ready:false,issues:['Reconnect Instagram to authorize Thrift Go.']},facebook:{ready:false,issues:['Reconnect Facebook to authorize Thrift Go.']}}});
}
export function createSession(accountIds) {
  const store=loadStore();const id=crypto.randomBytes(32).toString('hex');
  const now=Date.now();store.sessions ||= {};
  for (const [sid,s] of Object.entries(store.sessions)) if(s.expires<now)delete store.sessions[sid];
  store.sessions[id]={accountIds,expires:now+30*24*60*60*1000};writeStore(store);return id;
}
export function getSession(id) {const s=loadStore().sessions?.[id];return s?.expires>Date.now()?s:null;}
export function recordBuyerInteraction(shopId, platform, senderId, timestamp) {
  const store=loadStore();store.interactions ||= {};
  const time=Number(timestamp || Date.now());
  if(Number.isFinite(time) && time<=Date.now()+60000)store.interactions[`${shopId}:${platform}:${senderId}`]=time;
  writeStore(store);
}
export function hasOpenMessageWindow(shopId,platform,senderId) {
  const time=loadStore().interactions?.[`${shopId}:${platform}:${senderId}`];
  return Number.isFinite(time) && Date.now()-time<24*60*60*1000;
}
