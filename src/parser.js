/**
 * Automatically parses a thrift drop post caption to extract:
 * - itemName
 * - startingBid (SB)
 * - minIncrement (raise / increment)
 * - minePrice (BIN / buy it now / mine)
 * - stealPrice (steal / grab)
 * - claimPrice
 * - deadline (closing time / date)
 */
export function parseCaptionRules(caption = '') {
  if (typeof caption !== 'string' || !caption.trim()) {
    return {
      name: 'Instagram Thrift Drop',
      startingBid: 300,
      minIncrement: 50,
      minePrice: null,
      stealPrice: null,
      claimPrice: null,
      deadlineMinutes: 24 * 60
    };
  }

  const lines = caption.split('\n').map(l => l.trim()).filter(Boolean);
  const name = lines[0]?.slice(0, 120) || 'Instagram Thrift Drop';

  // Money extraction helper
  const extractAmount = (pattern) => {
    const match = caption.match(pattern);
    if (!match) return null;
    const num = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(num) && num > 0 ? num : null;
  };

  // 1. Mine Price (Buy It Now / Mine / Direct) - the first rung of the caption ladder.
  const minePrice = extractAmount(/(?:mine|bin|buy\s*it\s*now|claim|direct)[\s:₱pPhp]*([\d,]+)/i);

  // 2. Steal Price
  const stealPrice = extractAmount(/(?:steal)[\s:₱pPhp]*([\d,]+)/i);

  // 3. Grab Price (the rung between steal and claim, when the caption carries one)
  const grabPrice = extractAmount(/(?:grab)[\s:₱pPhp]*([\d,]+)/i);

  // 4. Claim Price
  const claimPrice = extractAmount(/(?:claim\s*(?:price|now)?)[\s:₱pPhp]*([\d,]+)/i);

  // 5. Starting Bid: an explicit SB keyword wins. Otherwise the drop opens at the mine price,
  //    because the first move a buyer makes in the caption's game is to "mine" it at that price.
  const startingBid = extractAmount(/(?:sb|starting\s*bid|start(?:ing)?|start\s*price|initial\s*bid)[\s:₱pPhp]*([\d,]+)/i)
    || extractAmount(/(?:price|lp|low\s*price)[\s:₱pPhp]*([\d,]+)/i)
    || minePrice
    || 300;

  // 6. Minimum Raise (Min / Inc / Raise)
  const minIncrement = extractAmount(/(?:min(?:imum)?\s*(?:raise|bid|inc(?:rement)?)|inc(?:rement)?|raise|step)[\s:₱pPhp]*([\d,]+)/i)
    || 50;

  // 6. Deadline estimation
  let deadlineMinutes = 24 * 60; // default 24 hours
  const hoursMatch = caption.match(/(\d+)\s*(?:hrs?|hours?)/i);
  const daysMatch = caption.match(/(\d+)\s*(?:days?)/i);
  if (hoursMatch) deadlineMinutes = Number(hoursMatch[1]) * 60;
  else if (daysMatch) deadlineMinutes = Number(daysMatch[1]) * 24 * 60;

  return {
    name,
    startingBid,
    minIncrement,
    minePrice,
    stealPrice,
    grabPrice,
    claimPrice,
    deadlineMinutes
  };
}
