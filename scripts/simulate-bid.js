// Uses global fetch built into Node.js 18+

const BASE = process.env.THRIFT_API || 'http://127.0.0.1:4331';

async function getWorkspace() {
  const res = await fetch(`${BASE}/api/workspace`);
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
  return await res.json();
}

async function getActiveDrop() {
  const ws = await getWorkspace();
  const drop = (ws.items || []).find(i => i.status === 'ACTIVE') || (ws.items || [])[0];
  if (!drop) throw new Error('No drops found in workspace.');
  return { ws, drop };
}

async function main() {
  const [,, cmd, arg1, arg2] = process.argv;

  if (!cmd || cmd === 'status' || cmd === 'info') {
    const ws = await getWorkspace();
    console.log('\n--- THRIFTSHIP1 WORKSPACE STATUS ---');
    console.log(`Connected Account: ${ws.accounts?.[0]?.name || 'None'} (@${ws.accounts?.[0]?.igUsername || ''})`);
    console.log(`GCash Receiver:   ${ws.settings?.[ws.accounts?.[0]?.id]?.gcashName || 'Not configured'} (${ws.settings?.[ws.accounts?.[0]?.id]?.gcashNumber || ''})`);
    console.log(`Total Drops:      ${ws.items?.length || 0}\n`);

    for (const item of (ws.items || [])) {
      console.log(`[${item.status}] ${item.name}`);
      console.log(`   ID:            ${item.id}`);
      console.log(`   Current Bid:   ₱${item.currentBid} (Total Due: ₱${item.totalDue})`);
      console.log(`   Highest Bidder: ${item.highestBidder ? '@' + item.highestBidder.username + ' (' + item.highestBidder.id + ')' : 'None'}`);
      console.log(`   Bids Count:    ${item.bids?.length || 0}`);
      if (item.fulfillment?.status) {
        console.log(`   Fulfillment:   ${item.fulfillment.status} (Carrier: ${item.fulfillment.carrier || '-'}, Tracking: ${item.fulfillment.trackingNumber || '-'})`);
      }
      console.log('');
    }
    return;
  }

  if (cmd === 'bid') {
    const amount = Number(arg1);
    const username = arg2 || 'buyer_test';
    if (!amount || amount <= 0) {
      console.error('Usage: node scripts/simulate-bid.js bid <amount> [username]');
      process.exit(1);
    }
    const { drop } = await getActiveDrop();
    console.log(`Placing bid of ₱${amount} from @${username} on "${drop.name}"...`);

    const res = await fetch(`${BASE}/bids/api/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemId: drop.id,
        commentId: `c_${Date.now()}`,
        text: String(amount),
        from: { id: `user_${username}`, username }
      })
    });

    const body = await res.json();
    if (!res.ok || !body.ok) {
      console.error('Bid Rejected:', body.reason || body.error, body);
    } else {
      console.log('Bid Accepted! New Highest Bidder:', body.bid.username, `at ₱${body.bid.amount}`);
      console.log('Current Total Due (incl. shipping): ₱' + body.item.totalDue);
    }
    return;
  }

  if (cmd === 'close') {
    const { drop } = await getActiveDrop();
    console.log(`Closing bidding on "${drop.name}"...`);
    const res = await fetch(`${BASE}/bids/api/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ itemId: drop.id })
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      console.error('Close failed:', body);
    } else {
      console.log(`Auction Closed! Winner: @${body.winner?.username || 'No winner'} at ₱${body.amount}`);
      console.log(`Status: ${body.status}`);
      console.log(`Payment Deadline: ${body.paymentDeadline}`);
    }
    return;
  }

  if (cmd === 'pay') {
    const ws = await getWorkspace();
    const drop = (ws.items || []).find(i => ['PENDING_PAYMENT', 'PENDING_PAYMENT_RUNNER_UP', 'PAYMENT_REVIEW'].includes(i.status));
    if (!drop) {
      console.error('No drop currently pending payment.');
      process.exit(1);
    }
    const refNo = arg1 || `GCASH-${Math.floor(100000000000 + Math.random() * 900000000000)}`;
    console.log(`Submitting buyer payment claim for "${drop.name}" with ref ${refNo}...`);

    await fetch(`${BASE}/bids/api/payment-proof`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemId: drop.id,
        buyerId: drop.highestBidder.id,
        referenceNo: refNo,
        amount: drop.totalDue
      })
    });

    console.log(`Seller verifying receipt in GCash and confirming...`);
    const res = await fetch(`${BASE}/bids/api/pay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemId: drop.id,
        buyerId: drop.highestBidder.id,
        referenceNo: refNo,
        amount: drop.totalDue
      })
    });

    const body = await res.json();
    if (body.ok) {
      console.log(`Payment Confirmed! Drop status: ${body.item.status}`);
      console.log(`Fulfillment status: ${body.item.fulfillment?.status}`);
    } else {
      console.error('Payment confirmation error:', body);
    }
    return;
  }

  if (cmd === 'ship') {
    const ws = await getWorkspace();
    const drop = (ws.items || []).find(i => i.status === 'PAID_CONFIRMED');
    if (!drop) {
      console.error('No drop currently in PAID_CONFIRMED status ready to ship.');
      process.exit(1);
    }
    const tracking = arg1 || `JT${Math.floor(1000000000 + Math.random() * 9000000000)}PH`;
    console.log(`Fulfilling shipment for "${drop.name}" with tracking ${tracking}...`);

    const res = await fetch(`${BASE}/bids/api/fulfillment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        itemId: drop.id,
        recipientName: 'Arvo Customer',
        phone: '09171112233',
        address: 'Surigao Del Norte, Philippines',
        carrier: 'J&T Express',
        trackingNumber: tracking,
        status: 'SHIPPED'
      })
    });

    const body = await res.json();
    if (body.ok) {
      console.log(`Shipped! Tracking: ${tracking}`);
    } else {
      console.error('Fulfillment error:', body);
    }
    return;
  }

  console.log(`
Available commands:
  node scripts/simulate-bid.js status
  node scripts/simulate-bid.js bid <amount> [username]
  node scripts/simulate-bid.js close
  node scripts/simulate-bid.js pay [referenceNo]
  node scripts/simulate-bid.js ship [trackingNumber]
`);
}

main().catch(err => {
  console.error('Simulation error:', err.message);
  process.exit(1);
});
