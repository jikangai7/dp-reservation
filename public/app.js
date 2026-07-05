'use strict';

const cardsEl = document.getElementById('cards');
const cardTemplate = document.getElementById('cardTemplate');
const searchForm = document.getElementById('searchForm');
const collectBtn = document.getElementById('collectBtn');
const runAllBtn = document.getElementById('runAllBtn');
const collectError = document.getElementById('collectError');
const expiryTimerEl = document.getElementById('expiryTimer');
const expiryTimerValueEl = expiryTimerEl.querySelector('.expiry-timer-value');
const stopServerBtn = document.getElementById('stopServerBtn');
const serverStoppedBanner = document.getElementById('serverStoppedBanner');
const collectElapsedEl = document.getElementById('collectElapsed');

/** entries[i] = { entry: <hotel-plansの1件>, state: {status, finalUrl, packageId, tx, message} } */
let entries = [];
let expiryIntervalId = null;
let collectStartTime = null;
let collectElapsedIntervalId = null;

function formatMMSS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** URL取得ボタン押下時点から経過時間の表示を開始する（ボタンの下・1秒ごと更新） */
function startCollectElapsed() {
  collectStartTime = Date.now();
  if (collectElapsedIntervalId) clearInterval(collectElapsedIntervalId);
  collectElapsedEl.hidden = false;
  collectElapsedEl.classList.remove('collect-elapsed-done');
  collectElapsedEl.textContent = `取得中… ${formatMMSS(0)}`;
  collectElapsedIntervalId = setInterval(() => {
    const sec = Math.floor((Date.now() - collectStartTime) / 1000);
    collectElapsedEl.textContent = `取得中… ${formatMMSS(sec)}`;
  }, 1000);
}

/** カード表示が完了した時点で経過時間を確定表示する */
function stopCollectElapsed() {
  if (collectElapsedIntervalId) { clearInterval(collectElapsedIntervalId); collectElapsedIntervalId = null; }
  if (collectStartTime) {
    const sec = Math.floor((Date.now() - collectStartTime) / 1000);
    collectElapsedEl.textContent = `取得時間 ${formatMMSS(sec)}`;
    collectElapsedEl.classList.add('collect-elapsed-done');
  }
}

stopServerBtn.addEventListener('click', async () => {
  if (!confirm('サーバーを停止しますか？\n再開するには start-server.bat をダブルクリックする必要があります。')) return;
  stopServerBtn.disabled = true;
  stopServerBtn.textContent = '停止中…';
  try {
    await fetch('/api/server/stop', { method: 'POST' });
  } catch (e) {
    // プロセス終了に伴い接続が切れて fetch がエラーになるのは正常な挙動
  }
  stopServerBtn.textContent = '停止済み';
  serverStoppedBanner.hidden = false;
  document.querySelectorAll('#searchForm input, #searchForm button, #runAllBtn, .btn-avail')
    .forEach((el) => { el.disabled = true; });
});

/** カード表示時点から15分のカウントダウンを開始する（秒まで表示・常時固定表示） */
function startExpiryTimer(totalSeconds = 15 * 60) {
  if (expiryIntervalId) clearInterval(expiryIntervalId);
  let remaining = totalSeconds;
  expiryTimerEl.classList.remove('expiry-timer-expired');
  expiryTimerEl.hidden = false;

  const render = () => {
    const m = Math.floor(Math.max(remaining, 0) / 60);
    const s = Math.max(remaining, 0) % 60;
    expiryTimerValueEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  render();

  expiryIntervalId = setInterval(() => {
    remaining -= 1;
    render();
    if (remaining <= 0) {
      clearInterval(expiryIntervalId);
      expiryIntervalId = null;
      expiryTimerEl.classList.add('expiry-timer-expired');
    }
  }, 1000);
}

function shorten(s, head = 22, tail = 8) {
  if (!s) return '';
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'コピー済み';
    setTimeout(() => { btn.textContent = old; }, 1200);
  } catch (e) {
    // クリップボードAPI不可時は選択でフォールバック
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

function makeCopyButton(text) {
  const btn = document.createElement('button');
  btn.className = 'copy-btn';
  btn.type = 'button';
  btn.textContent = 'コピー';
  btn.addEventListener('click', () => copyToClipboard(text, btn));
  return btn;
}

function renderKeyRow(container, label, value) {
  const l = document.createElement('span');
  l.className = 'key-label';
  l.textContent = label;
  container.appendChild(l);

  if (value) {
    const code = document.createElement('code');
    code.textContent = shorten(value, 34, 10);
    code.title = value;
    container.appendChild(code);
    container.appendChild(makeCopyButton(value));
  } else {
    const empty = document.createElement('span');
    empty.className = 'key-empty';
    empty.textContent = '未取得';
    container.appendChild(empty);
    container.appendChild(document.createElement('span'));
  }
}

function renderCmdRow(container, tag, text) {
  const row = document.createElement('div');
  row.className = 'cmd-row';
  const tagEl = document.createElement('span');
  tagEl.className = 'cmd-tag';
  tagEl.textContent = tag;
  const code = document.createElement('code');
  code.textContent = text;
  code.title = text;
  row.appendChild(tagEl);
  row.appendChild(code);
  row.appendChild(makeCopyButton(text));
  container.appendChild(row);
}

function buildCard(entry, index) {
  const node = cardTemplate.content.cloneNode(true);
  const card = node.querySelector('.card');
  card.dataset.index = String(index);

  // AIR情報（3件共通・最安フライト）
  const airContent = card.querySelector('.info-air-content');
  const f = entry.flight || {};
  airContent.innerHTML = '';
  const airline = document.createElement('div');
  airline.className = 'airline';
  airline.textContent = [f.airline, (f.flightNumbers || []).join('/')].filter(Boolean).join(' ');
  airContent.appendChild(airline);
  if (f.productId) {
    const productId = document.createElement('div');
    productId.className = 'product-id';
    productId.textContent = `商品ID ${f.productId}`;
    airContent.appendChild(productId);
  }
  if (f.outbound || f.inbound) {
    const legs = document.createElement('div');
    legs.className = 'legs';
    const legLine = (label, leg) => leg ? `${label} ${leg.dep ? leg.dep.time : ''} → ${leg.arr ? leg.arr.time : ''}` : '';
    legs.innerHTML = [legLine('往路', f.outbound), legLine('復路', f.inbound)].filter(Boolean).join('<br>');
    airContent.appendChild(legs);
  }
  if (f.airFare) {
    const fare = document.createElement('div');
    fare.className = 'fare';
    fare.textContent = `航空券代 ${f.airFare}`;
    airContent.appendChild(fare);
  }
  card.querySelector('.info-air .rank-badge').textContent = '1位';

  // ホテル情報
  const hotelContent = card.querySelector('.info-hotel-content');
  const h = entry.hotel || {};
  hotelContent.innerHTML = '';
  const name = document.createElement('div');
  name.className = 'hotel-name';
  name.textContent = h.name || '（ホテル名不明）';
  hotelContent.appendChild(name);
  if (h.hotelCode) {
    const hotelId = document.createElement('div');
    hotelId.className = 'hotel-id';
    hotelId.textContent = `ホテルID ${h.hotelCode}`;
    hotelContent.appendChild(hotelId);
  }
  const fareLine = document.createElement('div');
  fareLine.className = 'hotel-fare';
  fareLine.textContent = [h.hotelFare ? `ホテル代 ${h.hotelFare}` : null, h.stay ? h.stay.replace('航空券1名+', '') : null]
    .filter(Boolean).join(' ・ ');
  hotelContent.appendChild(fareLine);
  if (h.total) {
    const total = document.createElement('div');
    total.className = 'hotel-total';
    total.textContent = `合計 ${h.total}`;
    hotelContent.appendChild(total);
  }
  if (h.cancelInfo) {
    const cancel = document.createElement('div');
    cancel.className = 'hotel-cancel';
    cancel.textContent = h.cancelInfo;
    hotelContent.appendChild(cancel);
  }
  card.querySelector('.info-hotel .sort-label').textContent = entry.sortLabel || '価格の安い順';
  card.querySelector('.info-hotel .rank-badge').textContent = `${entry.rank}位`;

  // キー表（/dp/list）
  renderKeyRow(card.querySelector('.key-rows-list'), 'airCacheKey', entry.keys.airCacheKey);
  renderKeyRow(card.querySelector('.key-rows-list'), 'hotelCacheKey', entry.keys.hotelCacheKey);
  renderKeyRow(card.querySelector('.key-rows-list'), 'selectedItemKey', entry.keys.selectedItemKey);
  // packageId / __tx__ は実行後に埋める（updateCardState 側で再描画）
  renderKeyRow(card.querySelector('.key-rows-avail'), 'packageId', null);
  renderKeyRow(card.querySelector('.key-rows-reservation'), 'packageId', null);
  renderKeyRow(card.querySelector('.key-rows-reservation'), '__tx__', null);

  // コマンド
  renderCmdRow(card.querySelector('.cmd-rows'), 'reserve.js', entry.commands.reserve);
  renderCmdRow(card.querySelector('.cmd-rows'), 'curl', entry.commands.curl);

  const availBtn = card.querySelector('.btn-avail');
  availBtn.addEventListener('click', () => runAvailCheck(index));

  return node;
}

function setCardStatus(card, status, message) {
  const badge = card.querySelector('.badge');
  badge.className = 'badge';
  const map = { idle: ['badge-idle', '未実行'], running: ['badge-running', '実行中'], ok: ['badge-ok', 'OK'], ng: ['badge-ng', 'NG'] };
  const [cls, label] = map[status] || map.idle;
  badge.classList.add(cls);
  badge.textContent = label;
  card.querySelector('.status-message').textContent = message || '';
  card.querySelector('.btn-avail').disabled = status === 'running';
}

function updateCardAfterResult(card, index, result) {
  const state = entries[index].state;
  state.status = result.ok ? 'ok' : 'ng';
  state.finalUrl = result.finalUrl;
  state.packageId = result.packageId;
  state.tx = result.tx;
  state.message = result.message;

  setCardStatus(card, state.status, result.message);

  const openBtn = card.querySelector('.btn-open');
  if (result.ok && result.finalUrl) {
    openBtn.hidden = false;
    openBtn.href = result.finalUrl;
  } else {
    openBtn.hidden = true;
  }

  // 到達URL表示（ステータス行の下・AIR/HTL情報の上）
  const urlRow = card.querySelector('.input-url-row');
  const urlValue = card.querySelector('.input-url-value');
  urlRow.querySelectorAll('.copy-btn').forEach((b) => b.remove());
  if (result.ok && result.finalUrl) {
    urlRow.hidden = false;
    urlValue.textContent = result.finalUrl;
    urlValue.title = result.finalUrl;
    urlRow.appendChild(makeCopyButton(result.finalUrl));
  } else {
    urlRow.hidden = true;
    urlValue.textContent = '';
    urlValue.title = '';
  }

  // packageId / __tx__ を下部キー表に反映
  const availRow = card.querySelector('.key-rows-avail');
  availRow.innerHTML = '';
  renderKeyRow(availRow, 'packageId', result.packageId);
  const resRow = card.querySelector('.key-rows-reservation');
  resRow.innerHTML = '';
  renderKeyRow(resRow, 'packageId', result.packageId);
  renderKeyRow(resRow, '__tx__', result.tx);
}

async function runAvailCheck(index) {
  const card = entries[index].card;
  const entry = entries[index].entry;
  entries[index].state.status = 'running';
  setCardStatus(card, 'running', '実行中…（5〜15秒ほどかかります）');

  try {
    const res = await fetch('/api/avail-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        item: entry.keys.selectedItemKey,
        air: entry.keys.airCacheKey,
        hotel: entry.keys.hotelCacheKey,
        site: entry.site,
      }),
    });
    const result = await res.json();
    updateCardAfterResult(card, index, result);
  } catch (e) {
    entries[index].state.status = 'ng';
    setCardStatus(card, 'ng', `通信エラー: ${e.message}`);
  }
}

async function runAllChecks() {
  runAllBtn.disabled = true;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].state.status !== 'idle') continue; // 実行済み（OK/NG）はスキップ
    const { hotel } = entries[i].entry;
    if (!hotel || !hotel.cancelInfo) continue; // ホテルキャンセル料無料のカードのみ対象
    await runAvailCheck(i);
  }
  runAllBtn.disabled = false;
}

function renderListUrlRow(listUrl) {
  const row = document.createElement('div');
  row.className = 'list-url-row';
  const label = document.createElement('span');
  label.className = 'list-url-label';
  label.textContent = '/dp/list';
  const code = document.createElement('code');
  code.className = 'list-url-value';
  code.textContent = listUrl;
  code.title = listUrl;
  row.appendChild(label);
  row.appendChild(code);
  row.appendChild(makeCopyButton(listUrl));
  const openBtn = document.createElement('a');
  openBtn.className = 'btn list-url-open';
  openBtn.textContent = '開く';
  openBtn.href = listUrl;
  openBtn.target = '_blank';
  openBtn.rel = 'noopener';
  row.appendChild(openBtn);
  return row;
}

function renderCards(plans) {
  cardsEl.innerHTML = '';
  entries = plans.entries.map((entry) => ({ entry, state: { status: 'idle' } }));
  if (entries.length && entries[0].entry.listUrl) {
    cardsEl.appendChild(renderListUrlRow(entries[0].entry.listUrl));
    startExpiryTimer(15 * 60); // 起点：1件目のURL取得時点
  }
  let lastFlightRank = null;
  let lastLabel = null;
  entries.forEach((item, i) => {
    const { entry } = item;
    if (entry.flightRank !== lastFlightRank) {
      lastFlightRank = entry.flightRank;
      lastLabel = null; // フライトが変わったらソート見出しも仕切り直す
      const fh = document.createElement('h2');
      fh.className = 'flight-heading';
      const f = entry.flight || {};
      fh.textContent = [
        `フライト${entry.flightRank || '?'}位`,
        f.airline,
        f.productId ? `商品ID ${f.productId}` : null,
        f.airFare ? `航空券代 ${f.airFare}` : null,
      ].filter(Boolean).join('　');
      cardsEl.appendChild(fh);
    }
    if (entry.sortLabel !== lastLabel) {
      lastLabel = entry.sortLabel;
      const heading = document.createElement('h3');
      heading.className = 'group-heading';
      heading.textContent = entry.sortLabel || '';
      cardsEl.appendChild(heading);
    }
    cardsEl.appendChild(buildCard(entry, i));
    item.card = cardsEl.querySelector(`.card[data-index="${i}"]`);
  });
  runAllBtn.disabled = entries.length === 0;
}

searchForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  collectError.hidden = true;
  collectBtn.disabled = true;
  collectBtn.querySelector('.btn-label').textContent = '取得中…';
  startCollectElapsed();
  const fd = new FormData(searchForm);
  try {
    const res = await fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dep: fd.get('dep').trim().toUpperCase(),
        dest: fd.get('dest').trim().toUpperCase(),
        from: fd.get('from').trim().replace(/-/g, '/'),
        to: fd.get('to').trim().replace(/-/g, '/'),
        site: fd.get('site') || 'sg',
        topCheap: Number(fd.get('topCheap')),
        topRank: Number(fd.get('topRank')),
        carrier: (fd.get('carrier') || '').trim().toUpperCase(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '取得に失敗しました');
    renderCards(data);
    stopCollectElapsed(); // カード表示が完了した時点で確定
  } catch (e) {
    collectError.textContent = e.message;
    collectError.hidden = false;
    if (collectElapsedIntervalId) { clearInterval(collectElapsedIntervalId); collectElapsedIntervalId = null; }
    collectElapsedEl.hidden = true; // カードが表示されなかった場合は非表示に戻す
  } finally {
    collectBtn.disabled = false;
    collectBtn.querySelector('.btn-label').textContent = 'URL取得';
  }
});

runAllBtn.addEventListener('click', runAllChecks);
