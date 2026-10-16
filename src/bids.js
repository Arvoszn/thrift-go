import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.THRIFT_DATA_DIR || path.join(ROOT, 'data');
const BIDS_FILE = path.join(DATA_DIR, 'bids.json');
// Buyer messages use {placeholders} so the seller can reword them in the console.
const DEFAULT_MESSAGES = {
  winner: 'You won {item} at ₱{amount}. Total including shipping: ₱{total}. {payment} Payment is due {due}. Send your payment reference or proof for seller review. Your payment is confirmed only after the seller checks receipt.',
  runner_up: 'The previous buyer did not complete payment. {item} is now offered to you at your bid of ₱{amount}. Total including shipping: ₱{total}. {payment} Payment is due {due}. Send your payment reference or proof for seller review. Your payment is confirmed only after the seller checks receipt.',
  info: 'To ship {item}, please reply with:\nName:\nContact number:\nAddress:\nPostal code:',
  receipt: 'The seller confirmed your payment of ₱{amount} for {item}. Reference: {reference}. Please send your recipient name, phone number, and complete shipping address so the seller can arrange delivery.',
};
const MESSAGE_KINDS = Object.keys(DEFAULT_MESSAGES);
// Kinds where the buyer still has to pay: these carry the shipping-details request and the payment QR.
const PAYMENT_KINDS = new Set(['winner', 'runner_up']);
const MESSAGE_MAX_LENGTH = 1000;
const DEFAULTS = { gcashName: '', gcashNumber: '', gcashQrUrl: '', paymentWindowHours: 12, shippingFee: 0, shippingMethod: 'Seller arranges shipping', messages: DEFAULT_MESSAGES };
const PAYMENT_PENDING = new Set(['PENDING_PAYMENT', 'PENDING_PAYMENT_RUNNER_UP']);
const copy = (value) => structuredClone(value);
const iso = (now = Date.now()) => new Date(now).toISOString();
const money = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
const rounded = (value) => Math.round(value * 100) / 100;
const cleanId = (value) => typeof value === 'string' ? value.trim() : '';
function normalizeAttachments(attachments) {
  return Array.isArray(attachments) ? attachments.slice(0, 10).flatMap(attachment => {
    const url = typeof attachment === 'string' ? attachment : attachment?.url || attachment?.payload?.url;
    if (typeof url !== 'string' || url.length > 4000 || !/^https:\/\//i.test(url)) return [];
    return [{ type: typeof attachment?.type === 'string' ? attachment.type.slice(0, 50) : 'image', url }];
  }) : [];
}

function seed() {
  return {
    version: 2, shops: {}, log: [], outbox: [], inbox: [], deliveries: {}, items: [{
      id: 'item-vintage-nike-hoodie', name: 'Vintage Nike hoodie', mode: 'demo',
      shopId: 'demo-shop', platform: 'instagram', destinationId: 'demo-shop', postId: 'demo-hoodie',
      startingBid: 500, minIncrement: 50, currentBid: 500, totalDue: 500,
      highestBidder: null, status: 'ACTIVE', deadline: iso(Date.now() + 6 * 3600000),
      antiSnipingWindowMinutes: 2, antiSnipingExtensionMinutes: 3, bids: [], forfeitedBidderIds: [],
      fulfillment: { status: 'AWAITING_PAYMENT' },
    }],
  };
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
let state;
if (fs.existsSync(BIDS_FILE)) {
  // Refuse to replace unreadable records with a fresh demo. Operator recovery is safer than data loss.
  state = JSON.parse(fs.readFileSync(BIDS_FILE, 'utf8'));
  if (!Array.isArray(state.items)) throw new Error('Invalid auction data: items must be an array');
} else state = seed();

function persist(next) {
  const tmp = `${BIDS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(next, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, BIDS_FILE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

if (state.version !== 2) {
  if (fs.existsSync(BIDS_FILE)) fs.copyFileSync(BIDS_FILE, `${BIDS_FILE}.pre-v2-backup`);
  state.version = 2;
  state.shops ||= {};
  state.log ||= [];
  state.outbox ||= [];
  state.deliveries ||= {};
  for (const item of state.items) {
    // Old records had no account binding and the built-in hoodie pointed at a real IG media ID.
    // Preserve history, but make every unbound record explicitly disconnected before accepting events.
    if (!item.shopId || !item.destinationId || item.id === 'item-vintage-nike-hoodie') {
      item.mode = 'demo';
      item.shopId = 'demo-shop';
      item.destinationId = 'demo-shop';
      item.postId = item.id === 'item-vintage-nike-hoodie' ? 'demo-hoodie' : `demo-${item.id}`;
    }
    item.platform ||= 'instagram';
    item.mode ||= 'live';
    item.bids ||= [];
    item.forfeitedBidderIds ||= [];
    item.antiSnipingWindowMinutes ??= 2;
    item.antiSnipingExtensionMinutes ??= 3;
    item.fulfillment ||= { status: item.status === 'PAID_CONFIRMED' ? 'READY_TO_SHIP' : 'AWAITING_PAYMENT' };
    item.totalDue ??= item.currentBid;
    if (item.highestBidder) item.highestBidder.commentId ||= [...item.bids].reverse().find(b => b.bidderId === item.highestBidder.id)?.commentId || null;
  }
}
state.inbox ||= [];
persist(state);

function change(fn) {
  const before = copy(state);
  try {
    const result = fn();
    persist(state);
    return copy(result);
  } catch (error) {
    state = before;
    throw error;
  }
}
function scopedItem(itemId, options = {}) {
  return state.items.find(item => item.id === itemId && (!options.shopId || item.shopId === options.shopId));
}
function event(name, item, details = {}, now = Date.now()) {
  state.log.push({ event: name, itemId: item.id, shopId: item.shopId, ...details, t: iso(now) });
}
function settings(shopId) { return { ...DEFAULTS, ...state.shops[shopId] }; }
function cancelMessages(item) {
  for (const message of state.outbox) if (message.itemId === item.id) {
    if (['pending', 'failed'].includes(message.status)) message.status = 'cancelled';
    // A provider request may already be in flight. Keep its delivery outcome observable.
    if (message.status === 'sending') message.obsolete = true;
  }
}
const renderTemplate = (template, vars) => template.replace(/\{(\w+)\}/g, (token, key) => vars[key] === undefined ? token : String(vars[key]));
function queue(item, kind, now) {
  const shop = settings(item.shopId);
  const payment = [shop.gcashNumber ? `Pay through GCash to ${shop.gcashName || 'the seller'} (${shop.gcashNumber}).` : '',
    shop.gcashQrUrl ? `Seller GCash QR: ${shop.gcashQrUrl}` : ''].filter(Boolean).join(' ') || 'Contact the seller for payment details.';
  const vars = {
    item: item.name, amount: kind === 'receipt' ? item.payment?.amount : item.currentBid, total: item.totalDue,
    due: item.paymentDeadline, reference: item.payment?.referenceNo || '', payment, bidder: item.highestBidder?.username || '',
  };
  // The shipping-details request goes out inside the same private reply as the payment message.
  const text = renderTemplate(shop.messages?.[kind] || DEFAULT_MESSAGES[kind], vars)
    + (PAYMENT_KINDS.has(kind) ? '\n\n' + renderTemplate(shop.messages?.info || DEFAULT_MESSAGES.info, vars) : '');
  state.outbox.push({ id: randomUUID(), itemId: item.id, shopId: item.shopId, mode: item.mode,
    destinationId: item.destinationId, platform: item.platform, recipientId: item.highestBidder.id,
    commentId: kind === 'receipt' ? null : item.highestBidder.commentId, kind, text, status: item.mode === 'demo' ? 'demo' : 'pending',
    attempts: 0, createdAt: iso(now), messageId: null });
  // Instagram allows text OR an image in one message, never both. The payment QR rides as its own follow-up image.
  if (PAYMENT_KINDS.has(kind) && shop.gcashQrUrl) {
    state.outbox.push({ id: randomUUID(), itemId: item.id, shopId: item.shopId, mode: item.mode,
      destinationId: item.destinationId, platform: item.platform, recipientId: item.highestBidder.id,
      commentId: null, kind: 'qr', text: '', attachment: { type: 'image', url: shop.gcashQrUrl },
      status: item.mode === 'demo' ? 'demo' : 'pending', attempts: 0, createdAt: iso(now), messageId: null });
  }
}
function chooseWinner(item, bid, kind, now) {
  const shop = settings(item.shopId);
  item.currentBid = bid.amount;
  item.highestBidder = { id: bid.bidderId, username: bid.username, commentId: bid.commentId, amount: bid.amount };
  item.status = kind === 'runner_up' ? 'PENDING_PAYMENT_RUNNER_UP' : 'PENDING_PAYMENT';
  item.paymentDeadline = iso(now + shop.paymentWindowHours * 3600000);
  item.shippingFee = shop.shippingFee;
  item.totalDue = rounded(bid.amount + shop.shippingFee);
  item.paymentClaim = null;
  item.payment = null;
  queue(item, kind, now);
}

export function parseBidText(text, item = null) {
  if (typeof text !== 'string') return null;
  const clean = text.trim().toLowerCase();
  
  // Pure keywords without numbers resolve against post pricing
  if (/^mine$/.test(clean)) return item?.minePrice ? { type: 'MINE', amount: item.minePrice } : { type: 'MINE' };
  if (/^steal$/.test(clean)) return item?.stealPrice ? { type: 'STEAL', amount: item.stealPrice } : { type: 'STEAL' };
  if (/^grab$/.test(clean)) return item?.grabPrice ? { type: 'GRAB', amount: item.grabPrice } : { type: 'GRAB' };
  if (/^claim$/.test(clean)) return (item?.claimPrice || item?.minePrice) ? { type: 'CLAIM', amount: item.claimPrice || item.minePrice } : { type: 'CLAIM' };

  // Expressions with numbers (e.g. 'mine 750', 'bid 500', 'steal 600')
  const match = clean.match(/^(?:(?:bid|mine|bin|steal|grab|claim)\s+)?(?:(?:php|p|₱)\s*)?((?:\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.\d{1,2})?)\s*(?:pesos?|php)?$/i);
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  return money(amount) && amount > 0 ? { type: 'BID', amount } : null;
}

export function createItem(input = {}) {
  const { shopId, destinationId, postId, name, startingBid, minIncrement, deadline } = input;
  const mode = input.mode || 'live';
  const platform = input.platform || 'instagram';
  if (![shopId, destinationId, postId, name].every(v => cleanId(v))) return { ok: false, reason: 'MISSING_ITEM_DETAILS' };
  if (input.id !== undefined && !cleanId(input.id)) return { ok: false, reason: 'INVALID_ITEM_ID' };
  if (!['live', 'demo'].includes(mode) || !['instagram', 'facebook'].includes(platform)) return { ok: false, reason: 'INVALID_CHANNEL' };
  if (!money(startingBid) || startingBid <= 0 || !money(minIncrement) || minIncrement <= 0) return { ok: false, reason: 'INVALID_BID_RULES' };
  if (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now()) return { ok: false, reason: 'INVALID_DEADLINE' };
  const window = input.antiSnipingWindowMinutes ?? 2;
  const extension = input.antiSnipingExtensionMinutes ?? 3;
  if (![window, extension].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 60)) return { ok: false, reason: 'INVALID_ANTI_SNIPING' };
  if (state.items.some(i => i.mode === mode && i.platform === platform && i.destinationId === destinationId.trim() && i.postId === postId.trim() && i.status === 'ACTIVE')) return { ok: false, reason: 'POST_ALREADY_ACTIVE' };
  if (input.id && state.items.some(i => i.id === input.id.trim())) return { ok: false, reason: 'ITEM_ID_EXISTS' };
  return change(() => {
    const item = { id: input.id?.trim() || randomUUID(), shopId: shopId.trim(), destinationId: destinationId.trim(),
      postId: postId.trim(), name: name.trim(), platform, mode, startingBid, minIncrement, currentBid: startingBid,
      minePrice: input.minePrice || null, stealPrice: input.stealPrice || null, grabPrice: input.grabPrice || null, claimPrice: input.claimPrice || null,
      totalDue: startingBid, deadline: iso(Date.parse(deadline)), antiSnipingWindowMinutes: window,
      antiSnipingExtensionMinutes: extension, highestBidder: null, status: 'ACTIVE', bids: [],
      forfeitedBidderIds: [], fulfillment: { status: 'AWAITING_PAYMENT' }, createdAt: iso() };
    state.items.push(item);
    event('ITEM_CREATED', item);
    return { ok: true, item };
  });
}

export function handleComment(input = {}, options = {}) {
  const { destinationId, postId, commentId, from, text } = input;
  const now = options.now ?? Date.now();
  const mode = input.mode || 'live';
  if (![destinationId, postId, commentId, from?.id].every(v => cleanId(v))) return { ok: false, reason: 'MISSING_COMMENT_CONTEXT' };
  const key = JSON.stringify([mode, destinationId, postId, commentId]);
  if (state.deliveries[key]) return { ...copy(state.deliveries[key]), duplicate: true };
  const item = state.items.find(i => i.mode === mode && i.destinationId === destinationId && i.postId === postId &&
    (!input.shopId || i.shopId === input.shopId) && (!input.platform || i.platform === input.platform) && i.status === 'ACTIVE');
  if (!item) return { ok: false, reason: 'NO_ACTIVE_ITEM' };
  const parsed = parseBidText(text, item);
  if (!parsed) return { ok: false, reason: 'NOT_A_BID' };
  return change(() => {
    let result;
    if (Date.parse(item.deadline) <= now) result = { ok: false, reason: 'BIDDING_CLOSED', item };
    else if (!parsed.amount) result = { ok: false, reason: 'AMOUNT_REQUIRED', item };
    else {
      // MINE, STEAL and GRAB are open bids: the drop stays ACTIVE and keeps reading higher bids.
      // CLAIM is the lock: it names the winner at the claim rung and closes the bidding.
      const isRung = ['MINE', 'STEAL', 'GRAB', 'CLAIM'].includes(parsed.type);
      const isClaim = parsed.type === 'CLAIM';
      let requiredMin;
      if (!item.bids.length) requiredMin = item.startingBid;
      else if (isRung) {
        const nextRungs = [item.minePrice, item.stealPrice, item.grabPrice, item.claimPrice].filter(v => money(v) && v > 0 && v > item.currentBid);
        requiredMin = nextRungs.length ? Math.min(...nextRungs) : rounded(item.currentBid + item.minIncrement);
      } else requiredMin = rounded(item.currentBid + item.minIncrement);
      if (parsed.amount < requiredMin) result = { ok: false, reason: 'BID_TOO_LOW', amount: parsed.amount, requiredMin, currentBid: item.currentBid, item };
      else {
        const bid = { commentId, bidderId: from.id, username: from.username || from.name || from.id,
          amount: parsed.amount, actionType: parsed.type, timestamp: input.timestamp || iso(now), receivedAt: iso(now) };
        item.currentBid = parsed.amount;
        item.totalDue = rounded(parsed.amount + settings(item.shopId).shippingFee);
        item.highestBidder = { id: bid.bidderId, username: bid.username, commentId, amount: bid.amount };
        item.bids.push(bid);
        if (isClaim) {
          chooseWinner(item, bid, 'winner', now);
          event('CLAIM_LOCKED', item, { claimType: parsed.type, winner: item.highestBidder, amount: parsed.amount }, now);
          result = { ok: true, action: 'CLAIM_LOCKED', item, bid, claimType: parsed.type };
        } else {
          let extended = false;
          if (item.antiSnipingWindowMinutes > 0 && Date.parse(item.deadline) - now <= item.antiSnipingWindowMinutes * 60000) {
            const deadline = Math.max(Date.parse(item.deadline), now + item.antiSnipingExtensionMinutes * 60000);
            extended = deadline > Date.parse(item.deadline);
            item.deadline = iso(deadline);
          }
          event('BID_ACCEPTED', item, { bid, extended, actionType: parsed.type }, now);
          result = { ok: true, action: 'NEW_HIGHEST_BID', item, bid, extended };
        }
      }
    }
    // Keep only the event outcome, rather than recursive copies of the entire auction history.
    const { item: ignored, ...outcome } = result;
    state.deliveries[key] = outcome;
    return result;
  });
}

export function closeBidding(itemId, options = {}) {
  const item = scopedItem(itemId, options);
  if (!item) return { ok: false, reason: 'ITEM_NOT_FOUND' };
  if (item.status !== 'ACTIVE') return { ok: false, reason: 'BIDDING_ALREADY_CLOSED', item: copy(item) };
  const now = options.now ?? Date.now();
  return change(() => {
    item.closedAt = iso(now);
    if (!item.bids.length) { item.status = 'ENDED'; event('BIDDING_CLOSED_NO_BIDS', item, {}, now); return { ok: true, status: 'NO_BIDS', item }; }
    chooseWinner(item, item.bids.at(-1), 'winner', now);
    event('WINNER_SELECTED', item, { winner: item.highestBidder }, now);
    return { ok: true, status: 'WINNER_SELECTED', item, winner: item.highestBidder, amount: item.currentBid, paymentDeadline: item.paymentDeadline };
  });
}

export function forfeitAndRollToRunnerUp(itemId, options = {}) {
  const item = scopedItem(itemId, options);
  if (!item) return { ok: false, reason: 'ITEM_NOT_FOUND' };
  if (![...PAYMENT_PENDING, 'PAYMENT_REVIEW'].includes(item.status)) return { ok: false, reason: 'NOT_AWAITING_PAYMENT', item: copy(item) };
  const now = options.now ?? Date.now();
  return change(() => {
    const forfeited = copy(item.highestBidder);
    if (forfeited?.id && !item.forfeitedBidderIds.includes(forfeited.id)) item.forfeitedBidderIds.push(forfeited.id);
    cancelMessages(item);
    const runnerUp = [...item.bids].sort((a, b) => b.amount - a.amount).find(b => !item.forfeitedBidderIds.includes(b.bidderId));
    if (!runnerUp) {
      item.status = 'FORFEITED_UNSOLD'; item.highestBidder = null; item.paymentDeadline = null; item.paymentClaim = null;
      event('FORFEITED_UNSOLD', item, { forfeited }, now);
      return { ok: false, reason: 'NO_RUNNER_UP', item, forfeited };
    }
    chooseWinner(item, runnerUp, 'runner_up', now);
    event('RUNNER_UP_PROMOTED', item, { forfeited, newWinner: item.highestBidder, amount: item.currentBid }, now);
    return { ok: true, status: 'RUNNER_UP_PROMOTED', item, forfeited, newWinner: item.highestBidder, amount: item.currentBid, paymentDeadline: item.paymentDeadline };
  });
}

function validatePayment(item, data) {
  if (!item) return 'ITEM_NOT_FOUND';
  if (![...PAYMENT_PENDING, 'PAYMENT_REVIEW'].includes(item.status)) return 'NOT_AWAITING_PAYMENT';
  if (!cleanId(data.buyerId) || data.buyerId !== item.highestBidder?.id) return 'WINNER_MISMATCH';
  if (!cleanId(data.referenceNo)) return 'PAYMENT_REFERENCE_REQUIRED';
  if (!money(data.amount) || data.amount !== item.totalDue) return 'PAYMENT_AMOUNT_MISMATCH';
  return null;
}
export function recordPaymentClaim(itemId, data = {}) {
  const item = scopedItem(itemId, data);
  const reason = validatePayment(item, data);
  if (reason) return { ok: false, reason };
  return change(() => {
    const attachments = normalizeAttachments(data.attachments);
    item.paymentClaim = { buyerId: data.buyerId, referenceNo: data.referenceNo.trim(), amount: data.amount,
      proofUrl: typeof data.proofUrl === 'string' && /^https:\/\//i.test(data.proofUrl) ? data.proofUrl.slice(0, 4000) : '',
      messageId: cleanId(data.messageId) || null, attachments,
      submittedAt: iso(), status: 'PENDING_SELLER_REVIEW' };
    item.status = 'PAYMENT_REVIEW';
    event('PAYMENT_CLAIM_SUBMITTED', item);
    return { ok: true, item, verified: false };
  });
}
export function confirmPayment(itemId, data = {}) {
  const item = scopedItem(itemId, data);
  const reason = validatePayment(item, data);
  if (reason) return { ok: false, reason };
  if (state.items.some(other => other.id !== item.id && other.shopId === item.shopId && other.payment?.referenceNo === data.referenceNo.trim())) return { ok: false, reason: 'PAYMENT_REFERENCE_ALREADY_USED' };
  return change(() => {
    item.status = 'PAID_CONFIRMED';
    item.payment = { buyerId: data.buyerId, referenceNo: data.referenceNo.trim(), amount: data.amount,
      confirmedAt: iso(), confirmationMethod: 'SELLER_REVIEW', providerVerified: false };
    if (item.paymentClaim) item.paymentClaim.status = 'SELLER_CONFIRMED';
    item.fulfillment.status = 'READY_TO_SHIP';
    cancelMessages(item);
    queue(item, 'receipt', Date.now());
    event('PAYMENT_SELLER_CONFIRMED', item);
    return { ok: true, item };
  });
}

export function updateShopSettings(shopId, data = {}) {
  if (!cleanId(shopId)) return { ok: false, reason: 'SHOP_REQUIRED' };
  const next = settings(shopId);
  for (const key of ['gcashName', 'gcashNumber', 'gcashQrUrl', 'shippingMethod']) if (data[key] !== undefined) {
    if (typeof data[key] !== 'string' || data[key].length > 1000) return { ok: false, reason: 'INVALID_SHOP_SETTINGS' };
    next[key] = data[key].trim();
  }
  if (next.gcashNumber && !/^\+?\d[\d\s-]{8,15}$/.test(next.gcashNumber)) return { ok: false, reason: 'INVALID_GCASH_NUMBER' };
  if (next.gcashQrUrl && !/^https:\/\//i.test(next.gcashQrUrl)) return { ok: false, reason: 'INVALID_GCASH_QR_URL' };
  if (data.paymentWindowHours !== undefined) next.paymentWindowHours = data.paymentWindowHours;
  if (typeof next.paymentWindowHours !== 'number' || !Number.isFinite(next.paymentWindowHours) || next.paymentWindowHours <= 0 || next.paymentWindowHours > 168) return { ok: false, reason: 'INVALID_PAYMENT_WINDOW' };
  if (data.shippingFee !== undefined) next.shippingFee = data.shippingFee;
  if (!money(next.shippingFee)) return { ok: false, reason: 'INVALID_SHIPPING_FEE' };
  return change(() => { state.shops[shopId] = next; return { ok: true, shopId, settings: next }; });
}
export function getShopSettings(shopId) { return copy(settings(shopId)); }
export function getMessageTemplates(shopId) { return copy({ ...DEFAULT_MESSAGES, ...(settings(shopId).messages || {}) }); }
export function updateMessageTemplates(shopId, data = {}) {
  if (!cleanId(shopId)) return { ok: false, reason: 'SHOP_REQUIRED' };
  const incoming = data.messages && typeof data.messages === 'object' ? data.messages : data;
  const next = getMessageTemplates(shopId);
  for (const kind of MESSAGE_KINDS) {
    if (incoming[kind] === undefined) continue;
    if (typeof incoming[kind] !== 'string') return { ok: false, reason: 'INVALID_MESSAGE_TEMPLATE' };
    const text = incoming[kind].trim();
    // An emptied field restores the built-in wording.
    if (text.length > MESSAGE_MAX_LENGTH) return { ok: false, reason: 'MESSAGE_TEMPLATE_TOO_LONG' };
    next[kind] = text || DEFAULT_MESSAGES[kind];
  }
  return change(() => { state.shops[shopId] = { ...settings(shopId), messages: next }; return { ok: true, shopId, messages: copy(next) }; });
}

export function updateFulfillment(itemId, data = {}) {
  const item = scopedItem(itemId, data);
  if (!item) return { ok: false, reason: 'ITEM_NOT_FOUND' };
  if (item.status !== 'PAID_CONFIRMED') return { ok: false, reason: 'PAYMENT_NOT_CONFIRMED' };
  const next = { ...item.fulfillment };
  for (const key of ['recipientName', 'phone', 'address', 'carrier', 'trackingNumber', 'notes']) if (data[key] !== undefined) {
    if (typeof data[key] !== 'string' || data[key].length > 2000) return { ok: false, reason: 'INVALID_FULFILLMENT' };
    next[key] = data[key].trim();
  }
  if (data.status) {
    if (!['READY_TO_SHIP', 'SHIPPED', 'DELIVERED'].includes(data.status)) return { ok: false, reason: 'INVALID_FULFILLMENT_STATUS' };
    next.status = data.status;
  }
  if (['SHIPPED', 'DELIVERED'].includes(next.status) && (!next.recipientName || !next.phone || !next.address || !next.carrier || !next.trackingNumber)) return { ok: false, reason: 'SHIPPING_DETAILS_REQUIRED' };
  if (item.fulfillment.status === 'DELIVERED' && next.status !== 'DELIVERED') return { ok: false, reason: 'ALREADY_DELIVERED' };
  return change(() => { item.fulfillment = { ...next, updatedAt: iso() }; event('FULFILLMENT_UPDATED', item, { status: next.status }); return { ok: true, item }; });
}

export function processDeadlines(now = Date.now()) {
  if (now instanceof Date) now = now.getTime();
  if (typeof now === 'string') now = Date.parse(now);
  if (!Number.isFinite(now)) return { ok: false, reason: 'INVALID_TIME' };
  const results = [];
  for (const item of [...state.items]) {
    if (item.status === 'ACTIVE' && Date.parse(item.deadline) <= now) results.push(closeBidding(item.id, { now }));
    // Submitted proof suspends automatic forfeiture until the seller has reviewed it.
    else if (PAYMENT_PENDING.has(item.status) && Date.parse(item.paymentDeadline) <= now) results.push(forfeitAndRollToRunnerUp(item.id, { now }));
  }
  return { ok: true, processed: results.length, results };
}
export function getOutbox({ shopId, status } = {}) {
  return copy(state.outbox.filter(message => (!shopId || message.shopId === shopId) && (!status || message.status === status)));
}
export function recordInboxMessage(input = {}) {
  const shopId = cleanId(input.shopId);
  const senderId = cleanId(input.senderId);
  const messageId = cleanId(input.messageId);
  if (!shopId || !senderId || !messageId) return { ok: false, reason: 'MISSING_MESSAGE_CONTEXT' };
  if (!['instagram', 'facebook'].includes(input.platform)) return { ok: false, reason: 'INVALID_CHANNEL' };
  const existing = state.inbox.find(message => message.shopId === shopId && message.messageId === messageId);
  if (existing) return { ok: true, duplicate: true, message: copy(existing) };
  return change(() => {
    const message = { shopId, platform: input.platform, senderId, messageId,
      text: typeof input.text === 'string' ? input.text.slice(0, 5000) : '',
      attachments: normalizeAttachments(input.attachments),
      timestamp: Number.isFinite(Date.parse(input.timestamp)) ? iso(Date.parse(input.timestamp)) : iso(),
      receivedAt: iso() };
    state.inbox.push(message);
    return { ok: true, message };
  });
}
export function markDelivery(id, data = {}) {
  const message = state.outbox.find(m => m.id === id);
  if (!message) return { ok: false, reason: 'MESSAGE_NOT_FOUND' };
  if (message.mode === 'demo') return { ok: false, reason: 'DEMO_NEVER_SENDS' };
  if (['sent', 'cancelled'].includes(message.status)) return { ok: false, reason: 'MESSAGE_ALREADY_FINAL' };
  if (!['sending', 'sent', 'failed'].includes(data.status)) return { ok: false, reason: 'INVALID_DELIVERY_STATUS' };
  if (data.status === 'sending' && message.status === 'sending') return { ok: false, reason: 'MESSAGE_ALREADY_SENDING' };
  if (data.status === 'sent' && !cleanId(data.messageId)) return { ok: false, reason: 'PROVIDER_MESSAGE_ID_REQUIRED' };
  return change(() => {
    if (message.status !== 'sending') message.attempts += 1;
    message.status = data.status;
    message.lastAttemptAt = iso();
    message.messageId = data.status === 'sent' ? data.messageId : null;
    message.error = data.status === 'failed' ? String(data.error || 'Delivery failed').slice(0, 500) : null;
    message.code = data.status === 'failed' && data.code !== undefined && data.code !== null ? String(data.code).slice(0, 60) : null;
    if (data.status === 'sent') message.sentAt = iso();
    return { ok: true, message };
  });
}
export function retryDelivery(id, data = {}) {
  const message = state.outbox.find(m => m.id === id && (!data.shopId || m.shopId === data.shopId));
  if (!message) return { ok: false, reason: 'MESSAGE_NOT_FOUND' };
  if (message.mode === 'demo') return { ok: false, reason: 'DEMO_NEVER_SENDS' };
  if (data.confirmedNotSent !== true) return { ok: false, reason: 'SELLER_CONFIRMATION_REQUIRED' };
  if (!['failed', 'sending'].includes(message.status)) return { ok: false, reason: 'MESSAGE_NOT_RETRYABLE' };
  const item = scopedItem(message.itemId, { shopId: message.shopId });
  if (message.obsolete || !item || item.highestBidder?.id !== message.recipientId) return { ok: false, reason: 'MESSAGE_OBSOLETE' };
  return change(() => {
    message.status = 'pending';
    message.error = null;
    message.code = null;
    message.messageId = null;
    message.manualRetryAt = iso();
    message.manualRetryCount = (message.manualRetryCount || 0) + 1;
    event('DELIVERY_MANUALLY_REQUEUED', item, { messageId: message.id, confirmedNotSent: true });
    return { ok: true, message };
  });
}
// Instagram only allows a follow-up once the buyer messages the shop. When that happens, load those messages back into the queue automatically.
export function releaseWindowBlocked(shopId, platform, recipientId) {
  const sid = cleanId(shopId);
  const rid = cleanId(recipientId);
  const stuck = state.outbox.filter(m => m.shopId === sid && m.recipientId === rid && (!platform || m.platform === platform)
    && m.status === 'failed' && m.code === 'MESSAGE_WINDOW_CLOSED');
  if (!stuck.length) return { ok: true, released: 0 };
  return change(() => {
    for (const message of stuck) {
      message.status = 'pending';
      message.error = null;
      message.code = null;
      message.autoRetryAt = iso();
    }
    return { ok: true, released: stuck.length };
  });
}
export function resetDrop(itemId = 'item-vintage-nike-hoodie', options = {}) {
  const item = scopedItem(itemId, options);
  if (!item) return { ok: false, reason: 'ITEM_NOT_FOUND' };
  if (item.mode !== 'demo') return { ok: false, reason: 'ONLY_DEMO_CAN_RESET' };
  return change(() => {
    cancelMessages(item);
    Object.assign(item, { status: 'ACTIVE', currentBid: item.startingBid, totalDue: item.startingBid,
      highestBidder: null, bids: [], forfeitedBidderIds: [], deadline: iso(Date.now() + 6 * 3600000),
      payment: null, paymentClaim: null, paymentDeadline: null, fulfillment: { status: 'AWAITING_PAYMENT' } });
    for (const key of Object.keys(state.deliveries)) {
      const [mode, destinationId, postId] = JSON.parse(key);
      if (mode === item.mode && destinationId === item.destinationId && postId === item.postId) delete state.deliveries[key];
    }
    event('DEMO_RESET', item);
    return { ok: true, item };
  });
}
export function getBidsState({ shopId } = {}) {
  const snapshot = copy(state);
  delete snapshot.deliveries;
  if (shopId) {
    snapshot.items = snapshot.items.filter(i => i.shopId === shopId);
    snapshot.log = snapshot.log.filter(i => i.shopId === shopId);
    snapshot.outbox = snapshot.outbox.filter(i => i.shopId === shopId);
    snapshot.inbox = snapshot.inbox.filter(i => i.shopId === shopId);
    snapshot.shops = { [shopId]: settings(shopId) };
  }
  return snapshot;
}
