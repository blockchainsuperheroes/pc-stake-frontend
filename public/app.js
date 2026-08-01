/* $PC Commitment Rewards — frontend logic (DRAFT; read-only until contracts deploy).
   Lessons from bridge2 baked in: never block the UI on tx.wait() — send, then
   poll chain state directly until it reflects the change. */
const CFG = window.PCSTAKE_CONFIG;

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const VAULT = [
  'function stake(uint256 amount, uint32 termDays) returns (uint256)',
  'function withdraw(uint256 positionId)',
  'function positionsOf(address) view returns (tuple(uint256 amount,uint64 start,uint64 lockEnd,uint32 termDays,uint16 rewardRateBps,bool withdrawn)[])',
  'function rateFor(uint32 termDays) view returns (uint16)',
  'function activeTranche() view returns (bool open, uint256 idx)',
  'function trancheSchedule() view returns (uint256[] ceilings, uint16[4][] rates, uint256 staked)',
  'function stakedByStaker(address) view returns (uint256)',
  'function maxStakePerStaker() view returns (uint256)',
];
const LEDGER = [
  'function pending(bytes32) view returns (uint256)',
  'function nextClaimAt(bytes32) view returns (uint256)',
  'function claim(bytes32)',
  'function positions(bytes32) view returns (address staker,uint256 amount,uint64 start,uint64 lockEnd,uint16 rewardRateBps,uint256 lastClaim,bool open)',
];

const $ = (id) => document.getElementById(id);
const status = (m, k = '') => { const e = $('status'); if (e) { e.textContent = m; e.className = k; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtPC = (v) => (+ethers.formatUnits(v, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 });
const notDeployed = () => CFG.stakeVaultAddress === '0x0000000000000000000000000000000000000000';

let provider, signer, account, vault, pcToken;
const ledgerIface = new ethers.Interface(LEDGER);

/* ---------- ledger reads via same-origin proxy (PC chain has no CORS) ---------- */
async function ledgerRead(fn, args) {
  const data = ledgerIface.encodeFunctionData(fn, args);
  const r = await fetch(CFG.ledgerRpcProxy, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: CFG.ledgerAddress, data }),
  });
  const j = await r.json();
  if (!j.result) throw new Error(j.error || 'ledger read failed');
  return ledgerIface.decodeFunctionResult(fn, j.result);
}
const stakeIdOf = (staker, posId) => ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'address', 'uint256'],
    [BigInt(parseInt(CFG.ethChainIdHex, 16)), CFG.stakeVaultAddress, staker, BigInt(posId)],
  ));

/* ---------------- tranche display ---------------- */
function renderSchedule(ceilings, rates, staked) {
  // active tranche
  let idx = ceilings.length, open = false;
  for (let i = 0; i < ceilings.length; i++) if (staked < ceilings[i]) { idx = i; open = true; break; }
  const names = ['A', 'B', 'C', 'D'];
  if (open) {
    const floor = idx === 0 ? 0n : ceilings[idx - 1];
    const size = ceilings[idx] - floor, used = staked - floor;
    $('trTitle').textContent = `🏆 Tranche ${names[idx]}${idx === 0 ? ' — Founder rates' : ''} ACTIVE`;
    $('trRemain').innerHTML = `<b>${fmtPC(size - used)}</b> of ${fmtPC(size)} $PC capacity remaining`;
    $('trBar').style.width = Math.min(100, Number(used * 10000n / size) / 100) + '%';
    $('trSub').textContent = `${fmtPC(staked)} $PC committed program-wide · once tranche ${names[idx]} fills, its rates are gone for good.`;
  } else {
    $('trTitle').textContent = '⛔ Program full';
    $('trRemain').textContent = 'new commitments are closed';
    $('trBar').style.width = '100%';
  }
  // tier table
  const tbl = $('tierTable');
  [...tbl.querySelectorAll('tr:not(:first-child)')].forEach((r) => r.remove());
  CFG.terms.forEach((t, ti) => {
    const tr = document.createElement('tr');
    let cells = `<td>${t.label}</td>`;
    rates.forEach((row, ri) => {
      const pct = (Number(row[ti]) / 100).toFixed(row[ti] % 100 ? 1 : 0);
      cells += ri === idx
        ? `<td><b>${pct}%</b>${ti === 3 ? ' <span class="tag">MAX</span>' : ''}</td>`
        : `<td class="dimcol">${pct}%</td>`;
    });
    tr.innerHTML = cells;
    tbl.appendChild(tr);
  });
  return { open, idx };
}

async function refreshTranche() {
  if (!notDeployed() && provider) {
    try {
      const v = new ethers.Contract(CFG.stakeVaultAddress, VAULT, provider);
      const [ceil, rates, staked] = await v.trancheSchedule();
      return renderSchedule([...ceil], rates.map((r) => [...r].map(Number)), staked);
    } catch (e) { console.warn('live schedule unavailable', e); }
  }
  // fallback: config display values
  const ceil = CFG.fallbackSchedule.ceilings.map((c) => ethers.parseUnits(c, 18));
  const rates = CFG.fallbackSchedule.rates.map((r) => r.map((x) => x * 100));
  return renderSchedule(ceil, rates, 0n);
}

async function refreshTermRates() {
  const sel = $('term');
  sel.innerHTML = '';
  for (const t of CFG.terms) {
    let bps = null;
    if (!notDeployed() && provider) {
      try { bps = Number(await new ethers.Contract(CFG.stakeVaultAddress, VAULT, provider).rateFor(t.days)); } catch {}
    }
    const o = document.createElement('option');
    o.value = t.days;
    o.textContent = bps != null ? `${t.label} — ${(bps / 100).toFixed(bps % 100 ? 1 : 0)}% loyalty rate` : t.label;
    o.dataset.bps = bps ?? '';
    sel.appendChild(o);
  }
  quote();
}

function quote() {
  const q = $('quote');
  const amt = parseFloat($('amount').value) || 0;
  const o = $('term').selectedOptions[0];
  const bps = o ? Number(o.dataset.bps || 0) : 0;
  if (!amt || !bps) { q.style.display = 'none'; return; }
  const t = CFG.terms.find((x) => x.days === Number(o.value));
  const yrs = t.days / 365;
  const total = amt * bps / 10000 * yrs, weekly = amt * bps / 10000 / 52;
  q.style.display = 'block';
  q.innerHTML = `≈ <b>${weekly.toFixed(4)} $PC points/week</b> → <b>${total.toFixed(2)} points</b> over ${t.label}, claimable weekly on ${CFG.pcChainName}. Principal returns at term end. <span style="color:#7fae95">(Points are in-ecosystem credit — no cash value, not withdrawable.)</span>`;
}

/* ---------------- wallet ---------------- */
async function connect() {
  if (!window.ethereum) return status('No wallet found. Install MetaMask.', 'err');
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CFG.ethChainIdHex) {
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.ethChainIdHex }] });
      provider = new ethers.BrowserProvider(window.ethereum);
    } catch { return status(`Switch your wallet to ${CFG.ethChainName}.`, 'err'); }
  }
  signer = await provider.getSigner();
  account = await signer.getAddress();
  $('connect').textContent = account.slice(0, 6) + '…' + account.slice(-4);
  pcToken = new ethers.Contract(CFG.pcTokenAddress, ERC20, signer);
  vault = notDeployed() ? null : new ethers.Contract(CFG.stakeVaultAddress, VAULT, signer);
  $('form').classList.remove('hidden');
  $('posCard').classList.remove('hidden');
  if (notDeployed()) { $('submit').disabled = true; status('Preview build — committing opens at launch.', ''); }
  await Promise.all([refreshBalances(), refreshTranche(), refreshTermRates(), refreshPositions()]);
}

async function refreshBalances() {
  if (!account) return;
  try { $('balance').textContent = fmtPC(await pcToken.balanceOf(account)) + ' $PC'; } catch {}
  if (vault) {
    try {
      const [mine, cap] = await Promise.all([vault.stakedByStaker(account), vault.maxStakePerStaker()]);
      $('committed').textContent = `${fmtPC(mine)} / ${fmtPC(cap)} $PC`;
      $('maxCap').textContent = fmtPC(cap);
    } catch {}
  }
}

/* ---------------- commit (approve -> stake, state-polled) ---------------- */
async function submit(e) {
  e.preventDefault();
  try {
    if (!account) return status('Connect your wallet first.', 'err');
    if (notDeployed()) return status('Not launched yet.', 'err');
    const amtStr = $('amount').value.trim();
    if (!amtStr || Number(amtStr) <= 0) return status('Enter an amount.', 'err');
    const amount = ethers.parseUnits(amtStr, 18);
    const termDays = Number($('term').value);
    $('submit').disabled = true;

    // 1) allowance (poll state, don't trust tx.wait)
    if ((await pcToken.allowance(account, CFG.stakeVaultAddress)) < amount) {
      status('Step 1/2 — approve $PC in your wallet…');
      await pcToken.approve(CFG.stakeVaultAddress, amount);
      status('Approval sent — confirming on-chain…');
      let ok = false;
      for (let i = 0; i < 60; i++) { if ((await pcToken.allowance(account, CFG.stakeVaultAddress)) >= amount) { ok = true; break; } await sleep(3000); }
      if (!ok) throw new Error('Approval not confirmed yet — check your wallet and retry.');
    }

    // 2) stake (poll position count)
    const beforeN = (await vault.positionsOf(account)).length;
    status('Step 2/2 — confirm the commitment in your wallet…');
    await vault.stake(amount, termDays);
    status('Commitment sent — confirming on-chain…');
    let done = false;
    for (let i = 0; i < 60; i++) { if ((await vault.positionsOf(account)).length > beforeN) { done = true; break; } await sleep(3000); }
    if (!done) throw new Error('Not confirmed yet — it may still be mining. Refresh in a minute; do NOT re-send.');

    status(`Committed ${amtStr} $PC for ${termDays} days. Your rewards position opens on ${CFG.pcChainName} automatically (2-of-2 signed) — usually within minutes. 🎉`, 'ok');
    await Promise.all([refreshBalances(), refreshTranche(), refreshTermRates(), refreshPositions()]);
  } catch (err) {
    console.error(err);
    status(err?.shortMessage || err?.reason || err?.message || 'Failed.', 'err');
  } finally { $('submit').disabled = notDeployed(); }
}

/* ---------------- positions ---------------- */
async function refreshPositions() {
  const el = $('posList');
  if (!account || !vault) { el.innerHTML = '<p class="sub">Positions appear here after launch.</p>'; return; }
  let list = [];
  try { list = await vault.positionsOf(account); } catch { el.innerHTML = '<p class="sub">Could not load positions.</p>'; return; }
  if (!list.length) { el.innerHTML = '<p class="sub">No commitments yet.</p>'; return; }
  el.innerHTML = '';
  const now = Math.floor(Date.now() / 1000);
  list.forEach(async (p, i) => {
    const d = document.createElement('div');
    d.className = 'pos';
    const endTxt = new Date(Number(p.lockEnd) * 1000).toLocaleDateString();
    const rate = (Number(p.rewardRateBps) / 100).toFixed(Number(p.rewardRateBps) % 100 ? 1 : 0);
    const stateTxt = p.withdrawn ? 'principal withdrawn' : (now >= Number(p.lockEnd) ? 'term complete — principal withdrawable' : `locked until ${endTxt}`);
    d.innerHTML =
      `<div class="r1"><span>#${i} · <b>${fmtPC(p.amount)} $PC</b> @ ${rate}%</span><span>${Number(p.termDays)}d</span></div>` +
      `<div class="r2">${stateTxt}</div>` +
      `<div class="r2" id="pend${i}">points: checking…</div>` +
      `<div class="r3">` +
      `<button type="button" id="claim${i}" disabled>Claim points on ${CFG.pcChainName}</button>` +
      (!p.withdrawn && now >= Number(p.lockEnd) ? `<button type="button" class="w" id="wd${i}">Withdraw principal</button>` : '') +
      `</div>`;
    el.appendChild(d);
    const wd = $('wd' + i);
    if (wd) wd.onclick = () => withdrawPos(i);
    // ledger side (via proxy)
    try {
      const id = stakeIdOf(account, i);
      const [pend] = await ledgerRead('pending', [id]);
      const [nca] = await ledgerRead('nextClaimAt', [id]);
      const ready = pend > 0n && now >= Number(nca);
      $('pend' + i).textContent = `points accrued: ${fmtPC(pend)} $PC` + (pend > 0n && !ready ? ` · next claim ${new Date(Number(nca) * 1000).toLocaleString()}` : '');
      const btn = $('claim' + i);
      btn.disabled = !ready;
      btn.onclick = () => claimPos(i);
    } catch { $('pend' + i).textContent = 'points: rewards position not open yet (or ledger unreachable)'; }
  });
}

async function withdrawPos(i) {
  try {
    status(`Withdrawing position #${i} principal…`);
    await vault.withdraw(i);
    for (let k = 0; k < 60; k++) { const p = (await vault.positionsOf(account))[i]; if (p.withdrawn) break; await sleep(3000); }
    status('Principal returned to your wallet. ✅', 'ok');
    await Promise.all([refreshBalances(), refreshPositions()]);
  } catch (err) { status(err?.shortMessage || err?.reason || err?.message || 'Withdraw failed.', 'err'); }
}

/* Claim on Pentagon Chain: switch network, claim, switch back. */
async function claimPos(i) {
  try {
    if (CFG.pcChainIdHex === '0x0') return status('Pentagon Chain network config pending.', 'err');
    status(`Switching wallet to ${CFG.pcChainName}…`);
    try {
      await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CFG.pcChainIdHex }] });
    } catch (e) {
      if (e.code === 4902) {
        await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: CFG.pcChainIdHex, chainName: CFG.pcChainName,
          nativeCurrency: { name: 'PC', symbol: 'PC', decimals: 18 },
          rpcUrls: [CFG.pcRpcUrl], blockExplorerUrls: [CFG.pcExplorerBase],
        }] });
      } else throw e;
    }
    const pcProvider = new ethers.BrowserProvider(window.ethereum);
    const pcSigner = await pcProvider.getSigner();
    const ledger = new ethers.Contract(CFG.ledgerAddress, LEDGER, pcSigner);
    const id = stakeIdOf(account, i);
    status('Confirm the claim in your wallet…');
    await ledger.claim(id);
    status('Claim sent — your $PC points arrive on Pentagon Chain shortly. You can switch your wallet back to Ethereum. 🎉', 'ok');
    await sleep(8000);
    refreshPositions();
  } catch (err) { status(err?.shortMessage || err?.reason || err?.message || 'Claim failed.', 'err'); }
}

/* ---------------- wiring ---------------- */
window.addEventListener('DOMContentLoaded', async () => {
  $('connect').addEventListener('click', connect);
  $('form').addEventListener('submit', submit);
  $('amount').addEventListener('input', quote);
  $('term').addEventListener('change', quote);
  $('max').addEventListener('click', async () => {
    if (!account) return;
    let b = await pcToken.balanceOf(account);
    if (vault) {
      try {
        const [mine, cap] = await Promise.all([vault.stakedByStaker(account), vault.maxStakePerStaker()]);
        const room = cap > mine ? cap - mine : 0n;
        if (b > room) b = room;
      } catch {}
    } else {
      const cap = ethers.parseUnits(CFG.maxPerWallet, 18);
      if (b > cap) b = cap;
    }
    $('amount').value = ethers.formatUnits(b, 18);
    quote();
  });
  if (window.ethereum) {
    window.ethereum.on?.('accountsChanged', () => location.reload());
  }
  await refreshTranche();       // works pre-wallet via fallback/public read
  await refreshTermRates();
});
