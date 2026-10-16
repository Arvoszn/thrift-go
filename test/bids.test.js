import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thrift-engine-test-'));
process.env.THRIFT_DATA_DIR = dataDir;
const engineUrl = new URL('../src/bids.js', import.meta.url);
const e = await import(engineUrl);
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
let serial = 0;
function auction(extra = {}) {
  serial += 1;
  const result = e.createItem({ shopId: `shop-${serial}`, destinationId: `ig-${serial}`, postId: `post-${serial}`,
    platform: 'instagram', name: 'Vintage jacket', startingBid: 500, minIncrement: 50,
    deadline: new Date(Date.now() + 3600000).toISOString(), ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.item;
}
function bid(item, buyerId, amount, extra = {}, options = {}) {
  return e.handleComment({ shopId: item.shopId, destinationId: item.destinationId, platform: item.platform,
    postId: item.postId, commentId: `comment-${item.id}-${buyerId}-${amount}`, from: { id: buyerId, username: buyerId },
    text: String(amount), mode: item.mode, ...extra }, options);
}
function stateItem(item) { return e.getBidsState().items.find(i => i.id === item.id); }

test('only whole bid expressions count, conversational numbers are ignored', () => {
  for (const [text, amount] of [['500', 500], ['₱550', 550], ['600 pesos', 600], ['bid 700', 700], ['mine 750', 750], ['PHP 1,500.50', 1500.5]]) {
    assert.deepEqual(e.parseBidText(text), { type: 'BID', amount });
  }
  for (const text of ['size 32', 'from 1990', 'call 09171234567', 'is 500 shipping included?', '500 for two?', '500 then 600', '500.123', '2,50', '']) assert.equal(e.parseBidText(text), null, text);
  assert.deepEqual(e.parseBidText('mine'), { type: 'MINE' });
});

test('live comments never reach demo or another shop/post', () => {
  const demo = e.getBidsState().items[0];
  assert.equal(demo.mode, 'demo');
  assert.equal(demo.postId, 'demo-hoodie');
  assert.equal(e.handleComment({ destinationId: demo.destinationId, postId: demo.postId, commentId: 'live-demo', from: { id: 'real-user' }, text: '500' }).ok, false);
  const a = auction();
  const b = auction();
  assert.equal(bid(a, 'alice', 500, { destinationId: b.destinationId }).reason, 'NO_ACTIVE_ITEM');
  assert.equal(bid(a, 'alice', 500, { postId: b.postId }).reason, 'NO_ACTIVE_ITEM');
  assert.equal(bid(a, 'alice', 500, { shopId: b.shopId }).reason, 'NO_ACTIVE_ITEM');
  assert.equal(bid(a, 'alice', 500, { platform: 'facebook' }).reason, 'NO_ACTIVE_ITEM');
  assert.equal(e.handleComment({ postId: a.postId, commentId: 'no-context', from: { id: 'alice' }, text: '500' }).reason, 'MISSING_COMMENT_CONTEXT');
  assert.equal(stateItem(a).bids.length, 0);
  assert.equal(stateItem(b).bids.length, 0);
});

test('first bid can equal starting bid, increment applies thereafter, duplicate retries cannot raise twice', () => {
  const a = auction();
  assert.equal(bid(a, 'alice', 499).reason, 'BID_TOO_LOW');
  const first = bid(a, 'alice', 500);
  assert.equal(first.ok, true);
  assert.equal(first.item.highestBidder.commentId, first.bid.commentId);
  assert.equal(bid(a, 'bob', 525).requiredMin, 550);
  const accepted = bid(a, 'bob', 550);
  assert.equal(accepted.ok, true);
  const replay = bid(a, 'bob', 900, { commentId: accepted.bid.commentId });
  assert.equal(replay.duplicate, true);
  assert.equal(stateItem(a).currentBid, 550);
  assert.equal(stateItem(a).bids.length, 2);
  first.item.bids.length = 0;
  assert.equal(stateItem(a).bids.length, 2, 'returned snapshots cannot corrupt persisted state');
});

test('rung keywords are open bids and only claim locks the drop', () => {
  const a = auction({ startingBid: 150, minIncrement: 50, minePrice: 150, stealPrice: 250, grabPrice: 300, claimPrice: 600 });
  const mine = bid(a, 'alice', 'mine');
  assert.equal(mine.ok, true);
  assert.equal(mine.action, 'NEW_HIGHEST_BID');
  assert.equal(stateItem(a).status, 'ACTIVE');
  assert.equal(stateItem(a).currentBid, 150);
  assert.equal(stateItem(a).highestBidder.username, 'alice');
  assert.equal(e.getOutbox({ shopId: a.shopId }).length, 0, 'open bids do not queue buyer messages');
  assert.equal(bid(a, 'bob', 'mine').reason, 'BID_TOO_LOW', 'a bid under the standing price is ignored');
  const steal = bid(a, 'bob', 'steal');
  assert.equal(steal.ok, true);
  assert.equal(stateItem(a).currentBid, 250);
  assert.equal(stateItem(a).status, 'ACTIVE', 'steal keeps the bidding open');
  assert.equal(bid(a, 'carol', 'steal').reason, 'BID_TOO_LOW', 'the same rung cannot be repeated');
  assert.equal(bid(a, 'carol', 'grab').ok, true);
  assert.equal(stateItem(a).currentBid, 300);
  assert.equal(stateItem(a).status, 'ACTIVE', 'grab keeps the bidding open');
  const claim = bid(a, 'carol', 'claim');
  assert.equal(claim.ok, true);
  assert.equal(claim.action, 'CLAIM_LOCKED');
  assert.equal(stateItem(a).status, 'PENDING_PAYMENT');
  assert.equal(stateItem(a).currentBid, 600);
  assert.equal(stateItem(a).highestBidder.id, 'carol');
  assert.match(e.getOutbox({ shopId: a.shopId })[0].text, /You won Vintage jacket at ₱600/);
  assert.equal(bid(a, 'dave', 'grab').reason, 'NO_ACTIVE_ITEM', 'a locked drop accepts no further bids');
  assert.deepEqual(e.getBidsState().log.filter(l => l.itemId === a.id).map(l => l.event).slice(-2), ['BID_ACCEPTED', 'CLAIM_LOCKED']);
  const b = auction({ startingBid: 150, minePrice: 150, stealPrice: 250, claimPrice: 600 });
  assert.equal(bid(b, 'eve', 'claim').ok, true, 'a claim can open and lock in one move');
  assert.equal(stateItem(b).status, 'PENDING_PAYMENT');
  const c = auction({ startingBid: 500, minIncrement: 50, claimPrice: 600 });
  bid(c, 'frank', 700);
  assert.equal(bid(c, 'gina', 'claim').reason, 'BID_TOO_LOW', 'a claim cannot undercut a higher standing bid');
  assert.equal(stateItem(c).status, 'ACTIVE');
});

test('message templates are customizable per shop and fill live values', () => {
  const a = auction({ startingBid: 500, claimPrice: 600 });
  e.updateShopSettings(a.shopId, { gcashName: 'Seller', gcashNumber: '09171234567', shippingFee: 80, paymentWindowHours: 4 });
  const saved = e.updateMessageTemplates(a.shopId, { messages: { winner: 'Congrats {bidder}! {item} is yours for ₱{amount}. Pay ₱{total} by {due}. {payment}' } });
  assert.equal(saved.ok, true);
  assert.equal(bid(a, 'alice', 'claim').ok, true);
  const text = e.getOutbox({ shopId: a.shopId })[0].text;
  assert.match(text, /^Congrats alice! Vintage jacket is yours for ₱600\./);
  assert.match(text, /Pay ₱680 by /);
  assert.match(text, /09171234567/);
  assert.equal(e.updateMessageTemplates(a.shopId, { messages: { winner: 42 } }).reason, 'INVALID_MESSAGE_TEMPLATE');
  assert.equal(e.updateMessageTemplates(a.shopId, { messages: { winner: 'x'.repeat(1001) } }).reason, 'MESSAGE_TEMPLATE_TOO_LONG');
  assert.equal(e.updateMessageTemplates(a.shopId, { messages: { winner: '' } }).ok, true, 'clearing restores the default wording');
  assert.match(e.getMessageTemplates(a.shopId).winner, /^You won \{item\} at ₱\{amount\}/);
  assert.match(e.getMessageTemplates(a.shopId).runner_up, /^The previous buyer did not complete payment/);
  assert.match(e.getMessageTemplates(a.shopId).receipt, /^The seller confirmed your payment/);
  const other = auction();
  assert.match(e.getMessageTemplates(other.shopId).winner, /^You won \{item\} at ₱\{amount\}/, 'templates are per shop');
});

test('shipping details request is customizable and rides with payment messages', () => {
  const a = auction({ startingBid: 500, claimPrice: 600 });
  e.updateShopSettings(a.shopId, { gcashName: 'Seller', gcashNumber: '09171234567', shippingFee: 80, paymentWindowHours: 4 });
  assert.match(e.getMessageTemplates(a.shopId).info, /^To ship \{item\}, please reply with:\nName:\nContact number:\nAddress:\nPostal code:$/, 'built-in wording asks for the exact delivery fields');
  assert.equal(bid(a, 'alice', 'claim').ok, true);
  const winner = e.getOutbox({ shopId: a.shopId })[0];
  assert.match(winner.text, /\n\nTo ship Vintage jacket, please reply with:\nName:\nContact number:\nAddress:\nPostal code:$/, 'the request is appended to the payment DM');
  const b = auction();
  assert.equal(e.updateMessageTemplates(b.shopId, { messages: { info: 'For delivery of {item} reply: name, contact number, address, postal code.' } }).ok, true);
  bid(b, 'bob', 500);
  e.closeBidding(b.id);
  assert.match(e.getOutbox({ shopId: b.shopId })[0].text, /\n\nFor delivery of Vintage jacket reply: name, contact number, address, postal code\.$/);
  assert.equal(e.updateMessageTemplates(b.shopId, { messages: { info: '' } }).ok, true, 'clearing restores the built-in wording');
  assert.match(e.getMessageTemplates(b.shopId).info, /^To ship \{item\}/);
});

test('payment QR queues as its own image message right after the payment DM', () => {
  const a = auction();
  e.updateShopSettings(a.shopId, { gcashName: 'Seller', gcashNumber: '09171234567', gcashQrUrl: 'https://example.com/gcash-qr.jpg', shippingFee: 80, paymentWindowHours: 4 });
  bid(a, 'alice', 500);
  e.closeBidding(a.id);
  const messages = e.getOutbox({ shopId: a.shopId });
  assert.deepEqual(messages.map(m => m.kind), ['winner', 'qr']);
  assert.deepEqual(messages[1].attachment, { type: 'image', url: 'https://example.com/gcash-qr.jpg' });
  assert.equal(messages[1].commentId, null, 'the QR follows as a regular message, not a second private reply');
  assert.equal(messages[1].recipientId, 'alice');
  assert.equal(messages[1].status, 'pending');
  const plain = auction();
  bid(plain, 'carol', 500);
  e.closeBidding(plain.id);
  assert.deepEqual(e.getOutbox({ shopId: plain.shopId }).map(m => m.kind), ['winner'], 'no QR message is queued without a saved QR image');
});

test('follow-ups blocked by the Instagram 24-hour rule release when the buyer replies', () => {
  const a = auction();
  e.updateShopSettings(a.shopId, { gcashName: 'Seller', gcashNumber: '09171234567', gcashQrUrl: 'https://example.com/gcash-qr.jpg', shippingFee: 80, paymentWindowHours: 4 });
  bid(a, 'alice', 500);
  e.closeBidding(a.id);
  const qr = e.getOutbox({ shopId: a.shopId }).find(m => m.kind === 'qr');
  const winner = e.getOutbox({ shopId: a.shopId }).find(m => m.kind === 'winner');
  e.markDelivery(qr.id, { status: 'sending' });
  assert.equal(e.markDelivery(qr.id, { status: 'failed', error: 'Waiting for the buyer to message the shop (Instagram 24-hour rule).', code: 'MESSAGE_WINDOW_CLOSED' }).ok, true);
  e.markDelivery(winner.id, { status: 'sending' });
  e.markDelivery(winner.id, { status: 'failed', error: 'Meta rejected delivery', code: '10' });
  assert.equal(e.releaseWindowBlocked(a.shopId, 'instagram', 'bob').released, 0, 'another buyer does not release this message');
  assert.equal(e.releaseWindowBlocked(a.shopId, 'instagram', 'alice').released, 1);
  const revived = e.getOutbox({ shopId: a.shopId }).find(m => m.id === qr.id);
  assert.equal(revived.status, 'pending');
  assert.equal(revived.code, null);
  assert.ok(revived.autoRetryAt);
  assert.equal(e.releaseWindowBlocked(a.shopId, 'instagram', 'alice').released, 0, 'nothing is released twice');
  assert.equal(e.getOutbox({ shopId: a.shopId }).find(m => m.id === winner.id).status, 'failed', 'only window-blocked messages release automatically');
});


test('valid bid near deadline extends by three minutes and expired bids are refused', () => {
  const now = Date.now();
  const a = auction({ deadline: new Date(now + 60000).toISOString() });
  const result = bid(a, 'alice', 500, {}, { now });
  assert.equal(result.extended, true);
  assert.equal(Date.parse(result.item.deadline), now + 180000);
  assert.equal(bid(a, 'bob', 550, {}, { now: now + 180001 }).reason, 'BIDDING_CLOSED');
});

test('deadline scheduler closes once, leaves pending messages until a provider confirms delivery', () => {
  const now = Date.now();
  const a = auction({ deadline: new Date(now + 10000).toISOString(), antiSnipingWindowMinutes: 0 });
  bid(a, 'alice', 500);
  const processed = e.processDeadlines(now + 10001);
  assert.ok(processed.results.some(r => r.item.id === a.id && r.status === 'WINNER_SELECTED'));
  const messages = e.getOutbox({ shopId: a.shopId });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'pending');
  assert.equal(messages[0].recipientId, 'alice');
  assert.equal(messages[0].commentId, stateItem(a).highestBidder.commentId);
  assert.equal(e.markDelivery(messages[0].id, { status: 'sending' }).ok, true);
  assert.equal(e.markDelivery(messages[0].id, { status: 'sending' }).reason, 'MESSAGE_ALREADY_SENDING');
  assert.equal(e.getOutbox({ shopId: a.shopId })[0].attempts, 1);
  e.processDeadlines(now + 10002);
  assert.equal(e.getOutbox({ shopId: a.shopId }).length, 1);
  assert.equal(e.markDelivery(messages[0].id, { status: 'sent' }).reason, 'PROVIDER_MESSAGE_ID_REQUIRED');
  assert.equal(e.markDelivery(messages[0].id, { status: 'failed', error: 'Provider denied permission' }).ok, true);
  assert.equal(e.getOutbox({ shopId: a.shopId })[0].status, 'failed');
  assert.equal(e.markDelivery(messages[0].id, { status: 'sent', messageId: 'meta-message-123' }).ok, true);
  assert.equal(e.getOutbox({ shopId: a.shopId })[0].messageId, 'meta-message-123');
  assert.equal(e.markDelivery(messages[0].id, { status: 'sent', messageId: 'duplicate' }).reason, 'MESSAGE_ALREADY_FINAL');
});

test('runner-up cascade excludes every forfeited buyer and invalidates stale pending messages', () => {
  const a = auction();
  bid(a, 'alice', 500);
  bid(a, 'bob', 550);
  bid(a, 'alice', 600);
  bid(a, 'carol', 650);
  bid(a, 'carol', 700);
  e.closeBidding(a.id);
  assert.equal(e.forfeitAndRollToRunnerUp(a.id).newWinner.id, 'alice');
  assert.equal(stateItem(a).currentBid, 600);
  assert.equal(e.forfeitAndRollToRunnerUp(a.id).newWinner.id, 'bob');
  assert.equal(stateItem(a).currentBid, 550);
  assert.equal(e.forfeitAndRollToRunnerUp(a.id).reason, 'NO_RUNNER_UP');
  assert.equal(stateItem(a).status, 'FORFEITED_UNSOLD');
  assert.deepEqual(stateItem(a).forfeitedBidderIds, ['carol', 'alice', 'bob']);
  assert.ok(e.getOutbox({ shopId: a.shopId }).every(m => m.status === 'cancelled'));
});

test('expired payment promotes a distinct runner-up automatically', () => {
  const a = auction();
  bid(a, 'alice', 500); bid(a, 'bob', 550);
  const closed = e.closeBidding(a.id);
  e.processDeadlines(Date.parse(closed.paymentDeadline) + 1);
  assert.equal(stateItem(a).highestBidder.id, 'alice');
  assert.equal(stateItem(a).status, 'PENDING_PAYMENT_RUNNER_UP');
  assert.equal(e.getOutbox({ shopId: a.shopId }).at(-1).kind, 'runner_up');
});

test('payment proof stays in review; wrong buyer/amount/reference cannot confirm payment', () => {
  const a = auction();
  assert.equal(e.updateShopSettings(a.shopId, { gcashName: 'Seller', gcashNumber: '09171234567', gcashQrUrl: 'https://example.com/gcash-qr.jpg', paymentWindowHours: 4, shippingFee: 80 }).ok, true);
  bid(a, 'alice', 500);
  e.closeBidding(a.id);
  assert.equal(stateItem(a).totalDue, 580);
  assert.match(e.getOutbox({ shopId: a.shopId })[0].text, /₱580/);
  assert.match(e.getOutbox({ shopId: a.shopId })[0].text, /https:\/\/example.com\/gcash-qr.jpg/);
  assert.equal(e.confirmPayment(a.id, { buyerId: 'bob', referenceNo: 'REF-1', amount: 580 }).reason, 'WINNER_MISMATCH');
  assert.equal(e.confirmPayment(a.id, { buyerId: 'alice', referenceNo: 'REF-1', amount: 500 }).reason, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(e.confirmPayment(a.id, { buyerId: 'alice', amount: 580 }).reason, 'PAYMENT_REFERENCE_REQUIRED');
  assert.equal(e.recordPaymentClaim(a.id, { buyerId: 'alice', referenceNo: 'REF-1', amount: 580,
    messageId: 'proof-message', attachments: [{ type: 'image', payload: { url: 'https://example.com/gcash-proof.jpg' } }, { url: 'javascript:alert(1)' }] }).verified, false);
  assert.equal(stateItem(a).paymentClaim.messageId, 'proof-message');
  assert.deepEqual(stateItem(a).paymentClaim.attachments, [{ type: 'image', url: 'https://example.com/gcash-proof.jpg' }]);
  assert.equal(stateItem(a).status, 'PAYMENT_REVIEW');
  e.processDeadlines(Date.parse(stateItem(a).paymentDeadline) + 1);
  assert.equal(stateItem(a).status, 'PAYMENT_REVIEW', 'proof awaiting review must not forfeit automatically');
  assert.equal(e.confirmPayment(a.id, { buyerId: 'alice', referenceNo: 'REF-1', amount: 580 }).ok, true);
  assert.equal(stateItem(a).payment.confirmationMethod, 'SELLER_REVIEW');
  assert.equal(stateItem(a).payment.providerVerified, false);
  const receipt = e.getOutbox({ shopId: a.shopId }).at(-1);
  assert.equal(receipt.kind, 'receipt');
  assert.equal(receipt.commentId, null, 'receipt needs a regular reply, not a second private comment reply');
  assert.match(receipt.text, /recipient name, phone number/);
  assert.equal(e.confirmPayment(a.id, { buyerId: 'alice', referenceNo: 'REF-1', amount: 580 }).reason, 'NOT_AWAITING_PAYMENT');
  assert.equal(e.getOutbox({ shopId: a.shopId }).filter(message => message.kind === 'receipt').length, 1);
  assert.equal(e.forfeitAndRollToRunnerUp(a.id).reason, 'NOT_AWAITING_PAYMENT');
});

test('delivery retry requires explicit seller confirmation, preserves attempts, and rejects obsolete notifications', () => {
  const a = auction();
  bid(a, 'alice', 500); bid(a, 'bob', 550); e.closeBidding(a.id);
  const first = e.getOutbox({ shopId: a.shopId })[0];
  assert.equal(e.retryDelivery(first.id, { shopId: a.shopId }).reason, 'SELLER_CONFIRMATION_REQUIRED');
  assert.equal(e.retryDelivery(first.id, { shopId: a.shopId, confirmedNotSent: true }).reason, 'MESSAGE_NOT_RETRYABLE');
  e.markDelivery(first.id, { status: 'sending' });
  assert.equal(e.retryDelivery(first.id, { shopId: 'another-shop', confirmedNotSent: true }).reason, 'MESSAGE_NOT_FOUND');
  const retried = e.retryDelivery(first.id, { shopId: a.shopId, confirmedNotSent: true });
  assert.equal(retried.ok, true); assert.equal(retried.message.status, 'pending');
  assert.equal(retried.message.attempts, 1); assert.ok(retried.message.manualRetryAt);
  e.markDelivery(first.id, { status: 'sending' });
  e.markDelivery(first.id, { status: 'failed', error: 'Provider rejected' });
  const failedRetry = e.retryDelivery(first.id, { shopId: a.shopId, confirmedNotSent: true });
  assert.equal(failedRetry.ok, true); assert.equal(failedRetry.message.attempts, 2);
  assert.equal(failedRetry.message.manualRetryCount, 2); assert.equal(failedRetry.message.error, null);
  e.markDelivery(first.id, { status: 'sending' });
  e.forfeitAndRollToRunnerUp(a.id);
  assert.equal(e.retryDelivery(first.id, { shopId: a.shopId, confirmedNotSent: true }).reason, 'MESSAGE_OBSOLETE');
  const second = e.getOutbox({ shopId: a.shopId }).at(-1);
  e.markDelivery(second.id, { status: 'sent', messageId: 'confirmed-provider-message' });
  assert.equal(e.retryDelivery(second.id, { shopId: a.shopId, confirmedNotSent: true }).reason, 'MESSAGE_NOT_RETRYABLE');
  const demo = auction({ mode: 'demo' });
  bid(demo, 'demo-buyer', 500); e.closeBidding(demo.id);
  const demoMessage = e.getOutbox({ shopId: demo.shopId })[0];
  assert.equal(e.retryDelivery(demoMessage.id, { confirmedNotSent: true }).reason, 'DEMO_NEVER_SENDS');
  const cancelled = auction();
  bid(cancelled, 'cancelled-buyer', 500); e.closeBidding(cancelled.id);
  const cancelledMessage = e.getOutbox({ shopId: cancelled.shopId })[0];
  e.forfeitAndRollToRunnerUp(cancelled.id);
  assert.equal(e.retryDelivery(cancelledMessage.id, { confirmedNotSent: true }).reason, 'MESSAGE_NOT_RETRYABLE');
});

test('fulfillment requires confirmed payment and complete shipping details', () => {
  const a = auction();
  assert.equal(e.updateFulfillment(a.id, { address: 'Manila' }).reason, 'PAYMENT_NOT_CONFIRMED');
  bid(a, 'alice', 500); e.closeBidding(a.id);
  e.confirmPayment(a.id, { buyerId: 'alice', referenceNo: 'SHIP-REF', amount: 500 });
  assert.equal(e.updateFulfillment(a.id, { status: 'SHIPPED' }).reason, 'SHIPPING_DETAILS_REQUIRED');
  const shipped = e.updateFulfillment(a.id, { recipientName: 'Alice', phone: '09171234567', address: 'Manila', carrier: 'J&T', trackingNumber: 'TRACK-1', status: 'SHIPPED' });
  assert.equal(shipped.ok, true);
  assert.equal(e.updateFulfillment(a.id, { status: 'DELIVERED' }).ok, true);
  assert.equal(e.updateFulfillment(a.id, { status: 'SHIPPED' }).reason, 'ALREADY_DELIVERED');
});

test('shop filtering isolates auctions, messages and settings; live sales cannot be reset', () => {
  const a = auction(); const b = auction();
  e.updateShopSettings(a.shopId, { gcashName: 'A only' });
  const view = e.getBidsState({ shopId: a.shopId });
  assert.deepEqual(view.items.map(i => i.id), [a.id]);
  assert.deepEqual(Object.keys(view.shops), [a.shopId]);
  assert.equal(e.getShopSettings(b.shopId).gcashName, '');
  assert.equal(e.closeBidding(a.id, { shopId: b.shopId }).reason, 'ITEM_NOT_FOUND');
  assert.equal(e.resetDrop(a.id).reason, 'ONLY_DEMO_CAN_RESET');
  const demo = e.getBidsState().items[0];
  e.resetDrop(demo.id);
  bid(demo, 'demo-buyer', 500);
  e.closeBidding(demo.id);
  const msg = e.getOutbox({ shopId: demo.shopId }).at(-1);
  assert.equal(msg.status, 'demo');
  assert.equal(e.markDelivery(msg.id, { status: 'sent', messageId: 'should-not-send' }).reason, 'DEMO_NEVER_SENDS');
});

test('auction outcomes, deduplication and queued delivery survive a real process restart', () => {
  const a = auction();
  const accepted = bid(a, 'persistent-buyer', 500);
  e.closeBidding(a.id);
  const source = `const e = await import(${JSON.stringify(engineUrl.href)}); console.log(JSON.stringify({state:e.getBidsState({shopId:${JSON.stringify(a.shopId)}}), retry:e.handleComment(${JSON.stringify({ destinationId: a.destinationId, postId: a.postId, commentId: accepted.bid.commentId, from: { id: 'persistent-buyer' }, text: '900' })})}));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, THRIFT_DATA_DIR: dataDir }, encoding: 'utf8' });
  const restored = JSON.parse(output);
  assert.equal(restored.state.items[0].currentBid, 500);
  assert.equal(restored.state.items[0].status, 'PENDING_PAYMENT');
  assert.equal(restored.state.outbox[0].status, 'pending');
  assert.equal(restored.retry.duplicate, true);
  assert.ok(!fs.readdirSync(dataDir).some(name => name.endsWith('.tmp')));
});

test('buyer inbox preserves proof and shipping text once, isolates tenants, and survives restart', () => {
  const message = { shopId: 'inbox-shop-a', platform: 'instagram', senderId: 'buyer-a', messageId: 'inbox-mid-1',
    text: 'Please ship to Manila. Payment screenshot attached.', timestamp: '2026-09-30T03:00:00.000Z',
    attachments: [{ type: 'image', payload: { url: 'https://example.com/proof.jpg' } }, { type: 'image', url: 'data:text/html,bad' }] };
  const recorded = e.recordInboxMessage(message);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.message.timestamp, message.timestamp);
  assert.deepEqual(recorded.message.attachments, [{ type: 'image', url: 'https://example.com/proof.jpg' }]);
  assert.equal(e.recordInboxMessage({ ...message, text: 'Changed replay content' }).duplicate, true);
  assert.equal(e.recordInboxMessage({ ...message, shopId: 'inbox-shop-b', senderId: 'buyer-b', text: 'B'.repeat(6000) }).ok, true);
  assert.equal(e.getBidsState({ shopId: 'inbox-shop-a' }).inbox.length, 1);
  assert.equal(e.getBidsState({ shopId: 'inbox-shop-a' }).inbox[0].text, message.text);
  assert.equal(e.getBidsState({ shopId: 'inbox-shop-b' }).inbox[0].text.length, 5000);
  assert.equal(e.recordInboxMessage({ shopId: 'inbox-shop-a', platform: 'instagram', text: 'missing sender/id' }).reason, 'MISSING_MESSAGE_CONTEXT');
  const source = `const e = await import(${JSON.stringify(engineUrl.href)}); console.log(JSON.stringify({inbox:e.getBidsState({shopId:'inbox-shop-a'}).inbox,retry:e.recordInboxMessage(${JSON.stringify(message)})}));`;
  const restored = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, THRIFT_DATA_DIR: dataDir }, encoding: 'utf8' }));
  assert.equal(restored.inbox.length, 1);
  assert.equal(restored.inbox[0].attachments[0].url, 'https://example.com/proof.jpg');
  assert.equal(restored.retry.duplicate, true);
});

test('legacy hoodie is demoted to disconnected demo and original records get a backup', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thrift-legacy-test-'));
  const legacy = { items: [{ id: 'item-vintage-nike-hoodie', name: 'Old hoodie', postId: '17890000000000001', startingBid: 500, minIncrement: 50, currentBid: 550, status: 'ACTIVE', deadline: new Date(Date.now() + 3600000).toISOString(), highestBidder: { id: 'old-buyer', username: 'Old buyer' }, bids: [{ bidderId: 'old-buyer', amount: 550, commentId: 'old-comment' }] }], log: [{ event: 'OLD_HISTORY' }] };
  fs.writeFileSync(path.join(legacyDir, 'bids.json'), JSON.stringify(legacy));
  try {
    process.env.THRIFT_DATA_DIR = legacyDir;
    const migrated = await import(`${engineUrl.href}?legacy=${Date.now()}`);
    const old = migrated.getBidsState().items[0];
    assert.equal(old.mode, 'demo'); assert.equal(old.postId, 'demo-hoodie');
    assert.equal(old.bids[0].amount, 550); assert.equal(old.highestBidder.commentId, 'old-comment');
    assert.equal(migrated.getBidsState().log[0].event, 'OLD_HISTORY');
    assert.deepEqual(migrated.getBidsState().inbox, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(legacyDir, 'bids.json.pre-v2-backup'))), legacy);
  } finally { process.env.THRIFT_DATA_DIR = dataDir; fs.rmSync(legacyDir, { recursive: true, force: true }); }
});
