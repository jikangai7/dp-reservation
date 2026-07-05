#!/usr/bin/env node
/**
 * エアトリDP（海外航空券＋ホテル）予約フロー自動化ツール
 *
 * サブコマンド:
 *   run     <dep> <dest> <fromDate> <toDate>   4項目から /dp/reservation/input まで一気通貫（既定）
 *   keys    <dep> <dest> <fromDate> <toDate>   検索を1回走らせ、本物の各キーをJSON出力
 *   open-list --air <k> --hotel <k>            selectedItemKey 無しで /dp/list を開き自動生成を確認
 *   proceed --list-url "<url>"                 指定の /dp/list から予約入力画面まで進む
 *   proceed --air <k> --hotel <k> [--item <k>] キー指定で /dp/list を組み立てて進む
 *
 * 共通オプション: --headed（可視実行） --capture-avail（/dp/avail 応答を保存）
 *
 * 例:
 *   node reserve.js OSA MNL 2026/10/01 2026/10/10
 *   node reserve.js keys OSA MNL 2026/10/01 2026/10/10
 *   node reserve.js proceed --list-url "https://www.skygate.co.jp/dp/list?...#tab/air"
 *
 * キー構造（実測）:
 *   hotelCacheKey  = 20_1_{fromYmd}_{toYmd}____{dest}__2__1__1___0_0_0_   （完全に入力由来＝生成可）
 *   airCacheKey    = 0_{GUID}{ts}_1,25_{dep}_{arr}_{fromYmd}_{toYmd}_1__0_,,,0,0,0_{dest}_0_0
 *                    {GUID} はサーバーがフライト検索時に発番するキャッシュハンドル（入力から計算不可）
 *   selectedItemKey= 選択商品のコンテンツハッシュ（例 7bd80d4f…_dpci、サーバー発番）
 *   → よって airCacheKey/selectedItemKey は「検索を走らせて本物を抽出」する必要がある。
 *
 * 注意: ゴールは情報入力画面の表示到達まで。予約確定・決済は行わない。
 */

'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://www.skygate.co.jp';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
const OUT_DIR = __dirname;
const SUBCOMMANDS = new Set(['run', 'keys', 'open-list', 'proceed', 'cheapest', 'hotel-plans', 'avail-check']);

/** サイト別プロファイル（AgentCode / meta / metaLandingInit）。既定は sg（現状動作） */
const SITE_PROFILES = {
  sg: { agentCode: 'HATOP', meta: '0', metaLandingInit: null },
  travelko: { agentCode: 'HACTB', meta: '1', metaLandingInit: '1' },
};

/** --site の値からサイトプロファイルを解決する（未指定は sg） */
function resolveSite(value) {
  const key = (value || 'sg').toLowerCase();
  if (!SITE_PROFILES[key]) {
    console.error(`--site は sg または travelko を指定してください（指定値: ${value}）`);
    process.exit(2);
  }
  return { key, ...SITE_PROFILES[key] };
}

// ---- 引数パース ------------------------------------------------------------

function parseArgs(argv) {
  const valueFlags = new Set(['--air', '--hotel', '--item', '--list-url', '--sort', '--top-cheap', '--top-rank', '--out', '--site', '--max-flights', '--carrier']);
  const positional = [];
  const flags = new Set();
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valueFlags.has(a)) opts[a] = argv[++i];
    else if (a.startsWith('--')) flags.add(a);
    else positional.push(a);
  }
  return { positional, flags, opts };
}

function usageAndExit() {
  console.error(
    'Usage:\n' +
    '  node reserve.js [run] <dep> <dest> <fromDate> <toDate>\n' +
    '  node reserve.js keys <dep> <dest> <fromDate> <toDate>\n' +
    '  node reserve.js open-list --air <k> --hotel <k> [--sort cheap|recommend]\n' +
    '  node reserve.js proceed --list-url "<url>"\n' +
    '  node reserve.js proceed --air <k> --hotel <k> [--item <k>] [--sort cheap|recommend]\n' +
    '  node reserve.js cheapest <dep> <dest> <fromDate> <toDate>\n' +
    '      … 最安フライトを選択し、ホテル一覧を価格の安い順で開いてURLを出力\n' +
    '  node reserve.js hotel-plans <dep> <dest> <fromDate> <toDate>\n' +
    '      [--top-cheap 0-3（既定1）] [--top-rank 0-3（既定1）] [--out plans.json] [--max-flights N]\n' +
    '      [--carrier XX（キャリア2レター指定。指定時は検索自体をそのキャリアに絞り込む）]\n' +
    '      … 安い順1ページ目のフライトをキャリアルール（直前と同キャリアは読み飛ばし・\n' +
    '        同キャリア合計2つまで）で巡回し、各フライトで「価格の安い順」上位--top-cheap件、\n' +
    '        「ホテルランクの高い順」上位--top-rank件のホテルの先頭プランを選択して\n' +
    '        /dp/avail 用情報リストを作成（--max-flights で対象フライト数を制限可能）。\n' +
    '        --carrier 指定時は結果が単一キャリアになるため、代わりに商品ID末尾1桁が\n' +
    '        同じものを合計2つまでとする巡回ルールに切り替わる\n' +
    '  node reserve.js avail-check --item <k> --air <k> --hotel <k>\n' +
    '      … 1件を実行して /dp/reservation/input 到達を判定（RESULT: OK/NG）\n' +
    '  共通: --headed --capture-avail --site sg|travelko（既定 sg）\n' +
    '  例: node reserve.js keys OSA MNL 2026/10/01 2026/10/10'
  );
  process.exit(2);
}

/** YYYY/MM/DD 形式の簡易バリデーション（実在日までは検査しない） */
function isValidDate(s) {
  return /^\d{4}\/\d{2}\/\d{2}$/.test(s);
}

/** YYYY/MM/DD → YYYYMMDD */
function ymd(d) {
  return d.replace(/\//g, '');
}

// ---- URL / キー 組み立て・抽出 --------------------------------------------

/**
 * 4項目から /dp/searching のURLを組み立てる（大人1名・往復・1室固定）。
 * carrier（キャリア2レター、例 NH）を指定すると carriers パラメータで検索自体を
 * そのキャリアに絞り込む（実測：例 carriers=NH でANA便のみがヒットする）。
 */
function buildSearchingUrl(departure, destination, fromDate, toDate, site, carrier) {
  const s = site || resolveSite();
  const p = new URLSearchParams({
    departure,
    arrival: departure, // 往復: 帰着地は出発地と同一
    destination,
    fromDate,
    toDate,
    AgentCode: s.agentCode,
    business: '0',
    rooms: '1',
    searchKind: '0',
    meta: s.meta,
  });
  if (s.metaLandingInit) p.set('metaLandingInit', s.metaLandingInit);
  if (carrier) p.set('carriers', carrier);
  return `${BASE}/dp/searching?${p.toString()}`;
}

/** --carrier の値をキャリア2レターとして正規化・検証する（未指定は null） */
function normalizeCarrier(value) {
  if (!value) return null;
  const c = String(value).trim().toUpperCase();
  if (!/^[A-Z0-9]{2}$/.test(c)) {
    console.error(`--carrier はキャリア2レターで指定してください（指定値: ${value}）`);
    process.exit(2);
  }
  return c;
}

/** hotelCacheKey は完全に入力由来のため生成できる（GUID/timestamp を含まない） */
function buildHotelCacheKey(fromDate, toDate, destination) {
  return `20_1_${ymd(fromDate)}_${ymd(toDate)}____${destination}__2__1__1___0_0_0_`;
}

/** 各キーから /dp/list のURLを組み立てる（selectedItemKey は任意） */
function buildListUrl({ airCacheKey, hotelCacheKey, selectedItemKey, site }) {
  const s = site || resolveSite();
  const p = new URLSearchParams({
    AgentCode: s.agentCode,
    airCacheKey,
    hotelCacheKey,
    tab: 'air',
    differentDate: '0',
    differentRegion: '0',
    meta: s.meta,
    business: '0',
    showtimeinfo: '1',
  });
  if (s.metaLandingInit) p.set('metaLandingInit', s.metaLandingInit);
  if (selectedItemKey) p.set('selectedItemKey', selectedItemKey);
  return `${BASE}/dp/list?${p.toString()}#tab/air`;
}

/** /dp/list のURLから3キーを取り出す */
function extractKeysFromListUrl(listUrl) {
  const u = new URL(listUrl);
  return {
    airCacheKey: u.searchParams.get('airCacheKey'),
    hotelCacheKey: u.searchParams.get('hotelCacheKey'),
    selectedItemKey: u.searchParams.get('selectedItemKey'),
    listUrl,
  };
}

/** 表示・保存用のURLに showtimeinfo=1 を確実に付与する（実URLはクリック遷移後の実測値のため付いていないことがある） */
function withShowtimeinfo(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('showtimeinfo', '1');
    return u.toString();
  } catch (_) {
    return url;
  }
}

/**
 * airCacheKey を分解する。検索条件はキー自体に埋まっている：
 *   0_{cacheKeyCode}_1,25_{dep}_{arr}_{fromYmd}_{toYmd}_{adult}__0_,,,0,0,0_{dest}_0_0
 * cacheKeyCode = GUID+タイムスタンプ（サーバー発番。ソートURLはこちらを使う）
 */
function parseAirCacheKey(airCacheKey) {
  // adult直後のフラグはソート等で変化する（例 __0_ → __1_）ため固定しない
  const m = /^0_(.+?)_1,25_([A-Z]{3})_([A-Z]{3})_(\d{8})_(\d{8})_(\d+)__(\d+)_.*_([A-Z]{3})_0_0$/
    .exec(airCacheKey);
  if (!m) return null;
  return {
    cacheKeyCode: m[1],
    departure: m[2],
    arrival: m[3],
    fromYmd: m[4],
    toYmd: m[5],
    adult: m[6],
    airOrderFlag: m[7],
    destination: m[8],
  };
}

/**
 * ソート付き /dp/list URLを組み立てる（実測：一覧のソートリンクと同形式）。
 * airOrder: 1=料金が安い順, 2=おすすめ順
 */
function buildSortedListUrl({ airCacheKey, hotelCacheKey, selectedItemKey, airOrder, site }) {
  const c = parseAirCacheKey(airCacheKey);
  if (!c) throw new Error(`airCacheKey を解析できません: ${airCacheKey}`);
  const s = site || resolveSite();
  const p = new URLSearchParams({
    AgentCode: s.agentCode,
    rooms: '1',
    business: '0',
    fromDate: c.fromYmd,
    toDate: c.toYmd,
    departure: c.departure,
    destination: c.destination,
    arrival: c.arrival,
    cacheKeyCode: c.cacheKeyCode,
    airPage: '1',
    airOrder: String(airOrder),
    form: 'sortAir',
    tab: 'air',
    hotelCacheKey,
    meta: s.meta,
    showtimeinfo: '1',
  });
  if (s.metaLandingInit) p.set('metaLandingInit', s.metaLandingInit);
  if (selectedItemKey) p.set('selectedItemKey', selectedItemKey);
  return `${BASE}/dp/list?${p.toString()}#tab/air`;
}

/**
 * ホテル一覧（tab=hotel）のソート付きURLを組み立てる（実測：ホテルタブのソートリンクと同形式）。
 * hotelSort: 1=オススメ順, 2=価格の安い順, 3=価格の高い順, 4=ホテルランクの高い順
 * checkin/checkout/destination は airCacheKey から導出する。
 */
function buildHotelListUrl({ airCacheKey, selectedItemKey, hotelSort = 2, site }) {
  const c = parseAirCacheKey(airCacheKey);
  if (!c) throw new Error(`airCacheKey を解析できません: ${airCacheKey}`);
  const s = site || resolveSite();
  const p = new URLSearchParams({
    AgentCode: s.agentCode,
    selectedItemKey,
    rooms: '1',
    business: '0',
    checkin: c.fromYmd,
    checkout: c.toYmd,
    destination: c.destination,
    filterCategoryId: '1',
    diseasePreventionOnly: '0',
    freeCancellationOnly: '0',
    hotelPage: '1',
    hotelSort: String(hotelSort),
    meta: s.meta,
    preAgentCode: s.agentCode,
    form: 'sortHotel',
    tab: 'hotel',
    airCacheKey,
    showtimeinfo: '1',
  });
  if (s.metaLandingInit) p.set('metaLandingInit', s.metaLandingInit);
  return `${BASE}/dp/list?${p.toString()}`;
}

/** --sort の値を airOrder に変換（未指定は null） */
function sortToAirOrder(sortValue) {
  if (!sortValue) return null;
  if (sortValue === 'cheap') return 1;
  if (sortValue === 'recommend') return 2;
  console.error(`--sort は cheap または recommend を指定してください（指定値: ${sortValue}）`);
  process.exit(2);
}

// ---- ブラウザ操作の共通部品 ------------------------------------------------

/** --capture-avail: /dp/avail のレスポンスを遷移前に確定させて保存する */
async function applyAvailCapture(context) {
  await context.route('**/dp/avail', async (route) => {
    try {
      const apiResponse = await route.fetch();
      const body = await apiResponse.text();
      const f = path.join(OUT_DIR, `avail-${Date.now()}.json`);
      fs.writeFileSync(f, body, 'utf8');
      console.log(`AVAIL SAVED: ${f} (${body.length} bytes)`);
      await route.fulfill({ response: apiResponse });
    } catch (e) {
      console.error(`AVAIL CAPTURE ERROR: ${e && e.message ? e.message : e}`);
      await route.continue();
    }
  });
}

/** ブラウザ起動＋新規コンテキスト（クッキー無しのコールドセッション） */
async function launch(headed, captureAvail) {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({ userAgent: UA });
  if (captureAvail) await applyAvailCapture(context);
  const page = await context.newPage();
  return { browser, page };
}

/** ブラウザ処理を try/catch で包み、失敗時はスクショを残して非0終了 */
async function withBrowser(headed, captureAvail, fn) {
  const { browser, page } = await launch(headed, captureAvail);
  try {
    await fn(page);
    await browser.close();
    process.exit(0);
  } catch (err) {
    const failUrl = (() => { try { return page.url(); } catch { return '(unknown)'; } })();
    const shot = path.join(OUT_DIR, `error-${Date.now()}.png`);
    try { await page.screenshot({ path: shot, fullPage: true }); } catch (_) {}
    console.error(`FAILED at URL: ${failUrl}`);
    console.error(`  reason: ${err && err.message ? err.message : err}`);
    console.error(`  screenshot: ${shot}`);
    try { await browser.close(); } catch (_) {}
    process.exit(1);
  }
}

/** 検索URLを開き、匿名SSOを通過して /dp/list 着地・一覧描画まで待つ。着地URLを返す */
async function runSearchToList(page, searchingUrl) {
  await page.goto(searchingUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForURL('**/dp/list**', { timeout: 60000 });
  // 「予約確認へ進む」の出現＝検索結果が整った合図
  const proceed = page.locator('a:has-text("予約確認へ進む"):visible').first();
  await proceed.waitFor({ state: 'visible', timeout: 60000 });
  return page.url();
}

/** /dp/list 上で「予約確認へ進む」を押し、/dp/reservation/input 到達まで進む */
async function clickProceedToReservation(page) {
  const proceed = page.locator('a:has-text("予約確認へ進む"):visible').first();
  await proceed.waitFor({ state: 'visible', timeout: 60000 });
  await proceed.click();
  await page.waitForURL('**/dp/reservation/input**', { timeout: 60000 });
  const finalUrl = page.url();
  const u = new URL(finalUrl);
  let title = '';
  try { title = await page.title(); } catch (_) {}
  return {
    finalUrl,
    tx: u.searchParams.get('__tx__'),
    packageId: u.searchParams.get('packageId'),
    title,
  };
}

/**
 * 安い順一覧の先頭商品（最安）のフライトを選択する。
 * フライト選択はURLで表現できないためクリック必須：
 * 「この商品のフライトを見る」→展開→「このフライトを選択する」(a.choiceThisFlight)
 * → form=reload_air で再読込され selectedItemKey が更新される（裏でPOST /dp/choice）。
 * 選択後のURLを返す。
 */
async function selectCheapestFlight(page) {
  const see = page.locator('a:has-text("この商品のフライトを見る"):visible').first();
  await see.waitFor({ state: 'visible', timeout: 60000 });
  await see.click();
  const choice = page.locator('a.choiceThisFlight:visible').first();
  await choice.waitFor({ state: 'visible', timeout: 30000 });
  await choice.click();
  await page.waitForURL('**form=reload_air**', { timeout: 60000 });
  // 再読込後の一覧描画を待つ
  await page.locator('a:has-text("予約確認へ進む"):visible').first()
    .waitFor({ state: 'visible', timeout: 60000 });
  return page.url();
}

/**
 * 安い順一覧（1ページ目・最大25件）の全フライトカードから
 * キャリア名と商品番号を上から順に収集する。
 * キャリア名は h2.hdg-airline-info 内の span.airline-name（実測）。
 * 全角スペース等の表記ゆれで同一キャリアの比較がぶれないよう空白は正規化して除去する。
 */
async function listFlightsOnPage(page) {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('.item-box.airItemBox');
    return [...cards].map((c) => {
      const nameEl = c.querySelector('h2 .airline-name');
      const carrier = nameEl
        ? nameEl.textContent.replace(/[\s　]+/g, '').trim() || null
        : null;
      const li = c.querySelector('li.item-number');
      let productId = null;
      if (li) {
        const m = li.textContent.match(/商品番号[：:]\s*(\S+)/);
        productId = m ? m[1] : li.textContent.trim();
      }
      return { carrier, productId };
    });
  });
}

/**
 * 安い順一覧で n 番目（1始まり）のフライトを選択する。
 * カード内の「この商品のフライトを見る」→展開→「このフライトを選択する」の順にクリックし、
 * form=reload_air の再読込を待つ。選択後URLを返す。
 */
async function selectFlightAt(page, n) {
  const card = page.locator('.item-box.airItemBox').nth(n - 1);
  const see = card.locator('a:has-text("この商品のフライトを見る")').first();
  await see.waitFor({ state: 'visible', timeout: 60000 });
  await see.click();
  const choice = card.locator('a.choiceThisFlight').first();
  await choice.waitFor({ state: 'visible', timeout: 30000 });
  await choice.click();
  await page.waitForURL('**form=reload_air**', { timeout: 60000 });
  await page.locator('a:has-text("予約確認へ進む"):visible').first()
    .waitFor({ state: 'visible', timeout: 60000 });
  return page.url();
}

/**
 * ページ1のフライト一覧から処理対象の位置（0始まり）を決める：
 *   - 1件目（最安）は常に対象
 *   - 直前に処理したグループキーと同じなら読み飛ばす
 *   - 同じグループキーは合計2つまで（3つ目以降は読み飛ばす）
 *
 * グループキーは通常キャリア名。ただし --carrier でキャリアを1社に絞り込んだ検索の
 * 場合は全件が同一キャリアになるため無意味になる。その場合は carrierFilterActive を
 * 立てて、代わりに商品ID末尾1桁をグループキーとして同じルールを適用する。
 */
function pickFlightTargets(flightList, carrierFilterActive) {
  const groupKeyOf = carrierFilterActive
    ? (f) => (f.productId ? f.productId.slice(-1) : '(不明)')
    : (f) => f.carrier || '(不明)';
  const targets = [];
  const counts = {};
  let lastKey = null;
  for (let i = 0; i < flightList.length; i++) {
    const key = groupKeyOf(flightList[i]);
    if (i > 0) {
      if (key === lastKey) continue;
      if ((counts[key] || 0) >= 2) continue;
    }
    targets.push(i);
    counts[key] = (counts[key] || 0) + 1;
    lastKey = key;
  }
  return targets;
}

/**
 * /dp/avail に渡すリクエストボディ（実測形式）を作る。価格は含めない（改ざん不可設計）。
 */
function buildAvailBody(selectedItemKey, site) {
  const s = site || resolveSite();
  return {
    controlKeys: { AgentCode: s.agentCode },
    condition: { selectedItemKey },
    localCondition: { differentDate: 0 },
    additionalInfo: '',
    memberOnlyDealsFlag: false,
  };
}

/**
 * 手動実行用コマンド（1件1行）を作る。
 * curl はボディをファイル参照（--data-binary @file）にする。JSONを引数に直接埋めると
 * シェルごとの引用符エスケープ差（特にPowerShell 5.1）で壊れやすいため。
 */
function buildCommands(entryIndex, keys, site) {
  const bodyFile = `avail-body-${entryIndex}.json`;
  const reserveCmd =
    `node reserve.js avail-check --item "${keys.selectedItemKey}" ` +
    `--air "${keys.airCacheKey}" --hotel "${keys.hotelCacheKey}" --site ${site.key}`;
  const curlCmd =
    `curl.exe -s -X POST ${BASE}/dp/avail ` +
    `-H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" ` +
    `--data-binary "@${bodyFile}"`;
  return { reserveCmd, curlCmd, bodyFile };
}

/**
 * フライト選択後のページ（tab=air）から選択済みフライトの表示情報を収集する。
 * 便名は選択済みフライトの「フライト詳細を見る」を展開して #flightDetailOfSelectedItem の
 * .flight-number から取得する（ページ全体の正規表現検索だと他カードの便名を誤って拾うため）。
 * 取れない項目は null（サイト構造変更に対する保険）。
 */
async function collectSelectedFlight(page) {
  // 便名の正確な値はフライト詳細パネルにのみ存在するため先に展開する
  try {
    const detail = page.locator('#selectedAir a.showFlightDetail').first();
    if (await detail.count()) {
      await detail.click();
      await page.locator('#flightDetailOfSelectedItem .flight-number').first()
        .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    }
  } catch (_) { /* 詳細が開けなくても他項目は収集する */ }
  return page.evaluate(() => {
    // 選択済みフライト表示枠は #selectedAir（見出し h3.air-name、往路 dl.out-box、復路 dl.home-box）
    const box = document.querySelector('#selectedAir') || document.querySelector('.hpa-box-tab');
    const readLeg = (dl) => {
      if (!dl) return null;
      const go = dl.querySelector('dd p.go');
      const inn = dl.querySelector('dd p.in');
      const parse = (p) => {
        if (!p) return null;
        const time = (p.textContent.match(/(\d{2}:\d{2})/) || [])[1] || null;
        const place = (p.querySelector('.data') || {}).textContent || null;
        return { time, place: place ? place.trim() : null };
      };
      return { dep: parse(go), arr: parse(inn) };
    };
    // キャリア名は h3.air-name の直下テキストのみ（「○○加盟」等の子要素ラベルを除く）
    const airlineEl = box ? box.querySelector('h3.air-name') : null;
    let airline = null;
    if (airlineEl) {
      airline = [...airlineEl.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim() || null;
      if (!airline) airline = airlineEl.textContent.trim().replace(/\s+/g, ' ') || null;
    }
    const outbound = readLeg(box ? box.querySelector('dl.out-box') : null);
    const inbound = readLeg(box ? box.querySelector('dl.home-box') : null);

    const fare = (document.body.textContent.match(/航空券代金[^\d]*([\d,]+)/) || [])[1] || null;
    // 便名：選択済みフライトの詳細パネル（経由便は4便以上になることもある）
    const flightNos = [...document.querySelectorAll('#flightDetailOfSelectedItem .flight-number')]
      .map((el) => (el.textContent.match(/([0-9A-Z]{2}\s?\d{2,4})/) || [])[1])
      .filter(Boolean)
      .map((s) => s.replace(/\s/g, ''));

    return {
      airline,
      flightNumbers: [...new Set(flightNos)],
      airFare: fare ? `¥${fare}` : null,
      outbound,
      inbound,
    };
  });
}

/**
 * ホテル一覧（tab=hotel）で n 番目（1始まり）のホテルカードの表示情報を収集する。
 * カードの基準は a.showHotelPlanList（各ホテルに1つ、data-hotel_code つき）。
 */
async function collectHotelCardInfo(page, n) {
  return page.evaluate((idx) => {
    const btns = document.querySelectorAll('a.showHotelPlanList');
    const btn = btns[idx - 1];
    if (!btn) return null;
    // カードの境界は div.boxSearchGeneric01（ホテルランクと料金明細を両方含む単位）
    const card = btn.closest('div.boxSearchGeneric01') || btn.closest('[class*="boxSearch"]');
    const hotelCode = btn.dataset.hotel_code || null;
    if (!card) return { hotelCode, name: null, hotelFare: null, total: null, stay: null };

    // ホテル名は可視テキストになく、周辺MAPリンクの data-hotel_info JSON にのみ含まれる
    let name = null;
    const mapLink = card.querySelector('a.openHotelMap[data-hotel_info]');
    if (mapLink) {
      try { name = JSON.parse(mapLink.dataset.hotel_info).name.jp; } catch (_) { /* ignore */ }
    }

    // 料金明細は li.origin（col-l見出し + col-r金額）、合計は li.total
    let hotelFare = null;
    card.querySelectorAll('li.origin').forEach((li) => {
      const label = (li.querySelector('.col-l') || {}).textContent || '';
      if (label.includes('ホテル代金')) {
        hotelFare = (li.querySelector('.col-r') || {}).textContent || null;
      }
    });
    const totalLi = card.querySelector('li.total');
    const total = totalLi ? (totalLi.querySelector('.col-r') || {}).textContent || null : null;
    const stay = totalLi ? (totalLi.querySelector('.sub') || {}).textContent || null : null;

    return {
      hotelCode,
      name: name ? name.trim().replace(/\s+/g, ' ') : null,
      hotelFare: hotelFare ? hotelFare.trim() : null,
      total: total ? total.trim() : null,
      stay: stay ? stay.trim() : null,
    };
  }, n);
}

/**
 * ホテル一覧で n 番目のホテルの「この商品のプランを見る」を開き、
 * 最初の「このプランを選択する」(a.choiceThisPlan) をクリックする。
 * form=reload_hotel で再読込され selectedItemKey が更新される。選択後URLを返す。
 */
async function selectFirstPlanOfHotel(page, n) {
  const see = page.locator(`:nth-match(a.showHotelPlanList, ${n})`);
  await see.waitFor({ state: 'visible', timeout: 60000 });
  await see.click();
  const choice = page.locator('a.choiceThisPlan:visible').first();
  await choice.waitFor({ state: 'visible', timeout: 30000 });
  // キャンセル無料判定は展開直後・選択クリック前に取得する（選択後は再読込されこの表示が消えるため）。
  // 境界は a.choiceThisPlan の祖先 div.price-box（実測）。同box内の li.cancel の有無で判定。
  const cancelInfo = await choice.evaluate((el) => {
    const box = el.closest('div.price-box');
    const li = box ? box.querySelector('li.cancel') : null;
    return li ? li.textContent.trim().replace(/\s+/g, ' ') : null;
  });
  await choice.click();
  await page.waitForURL('**form=reload_hotel**', { timeout: 60000 });
  await page.locator('a:has-text("予約確認へ進む"):visible').first()
    .waitFor({ state: 'visible', timeout: 60000 });
  return { url: page.url(), cancelInfo };
}

/** ホテルタブで見えているホテル価格を上から収集し、昇順判定つきで返す */
async function sampleVisiblePrices(page) {
  return page.evaluate(() => {
    const prices = [];
    document.querySelectorAll('*').forEach((e) => {
      if (e.children.length === 0 && e.offsetParent && /^[¥￥][\d,]+$/.test(e.textContent.trim())) {
        prices.push(e.textContent.trim());
      }
    });
    return prices.slice(0, 10);
  });
}

function reportReached(r) {
  console.log(`REACHED: ${r.finalUrl}`);
  console.log(`  title    : ${r.title}`);
  console.log(`  packageId: ${r.packageId}`);
  console.log(`  __tx__   : ${r.tx}`);
}

// ---- サブコマンド ----------------------------------------------------------

/** run: 4項目から予約入力画面まで一気通貫 */
async function cmdRun(positional, flags, opts) {
  if (positional.length < 4) usageAndExit();
  const [dep, dest, from, to] = positional;
  if (!isValidDate(from) || !isValidDate(to)) {
    console.error('日付は YYYY/MM/DD 形式で指定してください（例 2026/10/01）。');
    process.exit(2);
  }
  const site = resolveSite(opts['--site']);
  const searchingUrl = buildSearchingUrl(dep, dest, from, to, site);
  console.log(`SEARCH: ${searchingUrl}`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    const listUrl = await runSearchToList(page, searchingUrl);
    console.log(`LIST:   ${listUrl}`);
    reportReached(await clickProceedToReservation(page));
  });
}

/** keys: 検索を走らせ、本物の各キーをJSON出力（hotelCacheKey は生成値と照合） */
async function cmdKeys(positional, flags, opts) {
  if (positional.length < 4) usageAndExit();
  const [dep, dest, from, to] = positional;
  if (!isValidDate(from) || !isValidDate(to)) {
    console.error('日付は YYYY/MM/DD 形式で指定してください（例 2026/10/01）。');
    process.exit(2);
  }
  const site = resolveSite(opts['--site']);
  const searchingUrl = buildSearchingUrl(dep, dest, from, to, site);
  console.log(`SEARCH: ${searchingUrl}`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    const listUrl = await runSearchToList(page, searchingUrl);
    const keys = extractKeysFromListUrl(listUrl);
    const parsed = parseAirCacheKey(keys.airCacheKey);
    keys.cacheKeyCode = parsed ? parsed.cacheKeyCode : null;
    keys.listUrlCheapest = buildSortedListUrl({ ...keys, airOrder: 1, site });
    const generatedHotel = buildHotelCacheKey(from, to, dest);
    const hotelMatch = generatedHotel === keys.hotelCacheKey;
    console.log(JSON.stringify(keys, null, 2));
    console.log(`hotelCacheKey(generated): ${generatedHotel}`);
    console.log(`hotelCacheKey MATCH     : ${hotelMatch ? 'YES' : 'NO'}`);
    console.log('');
    console.log(`LIST URL（おすすめ順）    : ${keys.listUrl}`);
    console.log(`LIST URL（料金が安い順）  : ${keys.listUrlCheapest}`);
  });
}

/** open-list: /dp/list を開いて状態を確認（selectedItemKey 自動生成の有無・価格の並び） */
async function cmdOpenList(opts, flags) {
  if (!opts['--air'] || !opts['--hotel']) {
    console.error('open-list には --air と --hotel が必要です。');
    process.exit(2);
  }
  const airOrder = sortToAirOrder(opts['--sort']);
  const site = resolveSite(opts['--site']);
  const listUrl = airOrder
    ? buildSortedListUrl({
        airCacheKey: opts['--air'], hotelCacheKey: opts['--hotel'],
        selectedItemKey: opts['--item'], airOrder, site,
      })
    : buildListUrl({ airCacheKey: opts['--air'], hotelCacheKey: opts['--hotel'], site });
  console.log(`OPEN: ${listUrl}`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    await page.goto(listUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**/dp/list**', { timeout: 60000 });
    // 一覧が描画されるか（＝商品が選択されたか）を待つ。出なくても後段で判定する。
    const proceed = page.locator('a:has-text("予約確認へ進む"):visible').first();
    try { await proceed.waitFor({ state: 'visible', timeout: 30000 }); } catch (_) {}

    const found = await page.evaluate(() => {
      const fromUrl = new URLSearchParams(location.search).get('selectedItemKey');
      const m = document.documentElement.innerHTML.match(/[0-9a-f]{32}_dpci/);
      // 各商品カードの「合計金額」を上から収集（並び順の確認用）
      const totals = [];
      document.querySelectorAll('*').forEach((e) => {
        if (e.children.length === 0 && e.textContent.trim() === '合計金額') {
          let row = e; // 近い祖先から金額を拾う
          for (let i = 0; i < 4 && row; i++) {
            const t = (row.parentElement || {}).textContent || '';
            const mm = t.match(/[¥￥][\d,]+/);
            if (mm) { totals.push(mm[0]); break; }
            row = row.parentElement;
          }
        }
      });
      return { fromUrl, dom: m ? m[0] : null, url: location.href, totals: totals.slice(0, 8) };
    });
    const auto = found.fromUrl || found.dom || null;
    console.log(`FINAL URL         : ${found.url}`);
    console.log(`selectedItemKey(URL): ${found.fromUrl || '(なし)'}`);
    console.log(`selectedItemKey(DOM): ${found.dom || '(なし)'}`);
    console.log(`AUTO-GENERATED    : ${auto ? 'YES → ' + auto : 'NO'}`);
    if (found.totals.length) {
      const nums = found.totals.map((s) => Number(s.replace(/[^\d]/g, '')));
      const asc = nums.every((v, i) => i === 0 || nums[i - 1] <= v);
      console.log(`合計金額（上から）: ${found.totals.join(' → ')}`);
      console.log(`昇順か            : ${asc ? 'YES' : 'NO'}`);
    }
  });
}

/** proceed: 指定の /dp/list（URL or キー）から予約入力画面まで進む */
async function cmdProceed(opts, flags) {
  const airOrder = sortToAirOrder(opts['--sort']);
  const site = resolveSite(opts['--site']);
  let listUrl;
  if (opts['--list-url']) {
    listUrl = opts['--list-url'];
  } else if (opts['--air'] && opts['--hotel']) {
    listUrl = airOrder
      ? buildSortedListUrl({
          airCacheKey: opts['--air'], hotelCacheKey: opts['--hotel'],
          selectedItemKey: opts['--item'], airOrder, site,
        })
      : buildListUrl({
          airCacheKey: opts['--air'],
          hotelCacheKey: opts['--hotel'],
          selectedItemKey: opts['--item'],
          site,
        });
  } else {
    console.error('proceed には --list-url、または --air と --hotel（任意で --item）が必要です。');
    process.exit(2);
  }
  console.log(`LIST:   ${listUrl}`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    await page.goto(listUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**/dp/list**', { timeout: 60000 });
    reportReached(await clickProceedToReservation(page));
  });
}

/** cheapest: 最安フライトを選択し、ホテル一覧を価格の安い順で開く */
async function cmdCheapest(positional, flags, opts) {
  if (positional.length < 4) usageAndExit();
  const [dep, dest, from, to] = positional;
  if (!isValidDate(from) || !isValidDate(to)) {
    console.error('日付は YYYY/MM/DD 形式で指定してください（例 2026/10/01）。');
    process.exit(2);
  }
  const site = resolveSite(opts && opts['--site']);
  const searchingUrl = buildSearchingUrl(dep, dest, from, to, site);
  console.log(`SEARCH: ${searchingUrl}`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    // (1) 検索 → /dp/list 着地
    const listUrl = await runSearchToList(page, searchingUrl);
    const keys = extractKeysFromListUrl(listUrl);

    // (2) 料金が安い順へ並び替え
    const cheapUrl = buildSortedListUrl({ ...keys, airOrder: 1, site });
    console.log(`SORT AIR (安い順): ${cheapUrl}`);
    await page.goto(cheapUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**/dp/list**', { timeout: 60000 });

    // (3) 最安フライト（先頭商品）を選択 → selectedItemKey が更新される
    const afterSelectUrl = await selectCheapestFlight(page);
    const newKeys = extractKeysFromListUrl(afterSelectUrl);
    console.log(`FLIGHT SELECTED: selectedItemKey ${keys.selectedItemKey} → ${newKeys.selectedItemKey}`);

    // (4) ホテル一覧を価格の安い順で開く（「ホテルを変更する」＝ホテルタブ切替をURLで実行）
    const hotelUrl = buildHotelListUrl({
      airCacheKey: newKeys.airCacheKey,
      selectedItemKey: newKeys.selectedItemKey,
      hotelSort: 2,
      site,
    });
    console.log('');
    console.log(`HOTEL LIST URL（価格の安い順）: ${hotelUrl}`);
    await page.goto(hotelUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**tab=hotel**', { timeout: 60000 });
    await page.locator('a:has-text("予約確認へ進む"):visible').first()
      .waitFor({ state: 'visible', timeout: 60000 }).catch(() => {});

    // (5) 状態出力：現在ソート（安い順はリンクに出ない＝消去法）と価格サンプル
    const state = await page.evaluate(() => {
      const sortLinks = [...document.querySelectorAll('a[class*="HtlSort"]')]
        .filter((a) => a.offsetParent).map((a) => a.textContent.trim());
      const hotelCount = (document.body.textContent.match(/（(\d+)ホテルから選択可）/) || [])[1] || null;
      return { url: location.href, sortLinks, hotelCount };
    });
    const cheapActive = !state.sortLinks.some((t) => t.includes('安い順'));
    console.log(`FINAL URL       : ${state.url}`);
    console.log(`ホテル数         : ${state.hotelCount || '(不明)'}`);
    console.log(`表示中ソートリンク: ${state.sortLinks.join(' / ') || '(なし)'}`);
    console.log(`安い順が現在ソート: ${cheapActive ? 'YES（安い順リンクが消えている）' : 'NO'}`);
    const prices = await sampleVisiblePrices(page);
    if (prices.length) console.log(`表示価格（上から）: ${prices.join(' → ')}`);
    console.log('');
    console.log('このURLをブラウザで開けばホテル選択を続行できます。予約入力へ進むには:');
    console.log(`  node reserve.js proceed --list-url "${state.url}"`);
  });
}

/**
 * hotel-plans: 安い順1ページ目のフライトをキャリアルールで巡回し、対象フライトごとに
 * ホテルを「価格の安い順」「ホテルランクの高い順」でそれぞれ上位N件（グループ別に
 * --top-cheap / --top-rank で指定、既定は各1件・0〜3の範囲）先頭プランを選択し、
 * /dp/avail 用の情報リスト（JSON＋手動実行コマンド）を作成する。
 */
async function cmdHotelPlans(positional, flags, opts) {
  if (positional.length < 4) usageAndExit();
  const [dep, dest, from, to] = positional;
  if (!isValidDate(from) || !isValidDate(to)) {
    console.error('日付は YYYY/MM/DD 形式で指定してください（例 2026/10/01）。');
    process.exit(2);
  }
  const clampTopCount = (value, def) => {
    if (value === undefined) return def;
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.max(0, Math.min(3, Math.round(n)));
  };
  const topCheap = clampTopCount(opts['--top-cheap'], 1);
  const topRank = clampTopCount(opts['--top-rank'], 1);
  if (topCheap === 0 && topRank === 0) {
    console.error('--top-cheap と --top-rank の両方を0にはできません（少なくとも一方は1以上）。');
    process.exit(2);
  }
  const outFile = path.join(OUT_DIR, opts['--out'] || 'plans.json');
  const site = resolveSite(opts['--site']);
  const carrier = normalizeCarrier(opts['--carrier']);

  const maxFlights = opts['--max-flights']
    ? Math.max(1, Number(opts['--max-flights'])) : Infinity;

  // 過去の実行で残った avail-body-N.json を削除してから今回分を生成する
  // （件数が前回より少ないと古い番号のファイルが消えずに蓄積するため）
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (/^avail-body-\d+\.json$/.test(f)) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const searchingUrl = buildSearchingUrl(dep, dest, from, to, site, carrier);
  console.log(`SEARCH: ${searchingUrl}`);
  if (carrier) console.log(`CARRIER FILTER: ${carrier}（商品ID末尾1桁ルールで巡回）`);
  await withBrowser(flags.has('--headed'), flags.has('--capture-avail'), async (page) => {
    // (1) 検索 → 安い順 → 1ページ目のフライト一覧（キャリア・商品番号）を収集
    const listUrl = await runSearchToList(page, searchingUrl);
    const keys = extractKeysFromListUrl(listUrl);
    const cheapUrl = buildSortedListUrl({ ...keys, airOrder: 1, site });
    await page.goto(cheapUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**/dp/list**', { timeout: 60000 });
    const flightList = await listFlightsOnPage(page);
    console.log(`FLIGHTS ON PAGE1: ${flightList.length}件`);
    flightList.forEach((f, i) => console.log(`  ${i + 1}位: ${f.carrier || '(不明)'}${f.productId ? ' / ' + f.productId : ''}`));

    // (2) 処理対象フライトを決定
    //     1位は常に対象／直前処理と同グループキーは読み飛ばし／同グループキーは合計2つまで
    //     （--carrier 未指定＝キャリア名でグルーピング／--carrier 指定＝商品ID末尾1桁でグルーピング）
    const targets = pickFlightTargets(flightList, !!carrier)
      .slice(0, maxFlights === Infinity ? undefined : maxFlights);
    console.log(`TARGET FLIGHTS: ${targets.map((i) => `${i + 1}位(${flightList[i].carrier || '不明'})`).join(', ')}`);

    // (3) 各対象フライトについて：選択 → ホテル2グループ×上位N（グループ別に指定可）でプラン選択・キー収集
    const groups = [
      { hotelSort: 2, sortLabel: '価格の安い順', top: topCheap },
      { hotelSort: 4, sortLabel: 'ホテルランクの高い順', top: topRank },
    ].filter((g) => g.top > 0);
    const entries = [];
    const baseHotelUrls = {};
    let globalIndex = 0;

    for (const fi of targets) {
      const flightRank = fi + 1;
      await page.goto(cheapUrl, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForURL('**/dp/list**', { timeout: 60000 });
      await page.locator('.item-box.airItemBox').first()
        .waitFor({ state: 'attached', timeout: 60000 });
      const afterSelectUrl = await selectFlightAt(page, flightRank);
      const flightKeys = extractKeysFromListUrl(afterSelectUrl);
      const flight = await collectSelectedFlight(page);
      flight.productId = flightList[fi].productId;
      flight.rank = flightRank;
      console.log(`FLIGHT ${flightRank}位 SELECTED: ${flight.airline || '(不明)'} ${
        (flight.flightNumbers || []).join('/')} 航空券代 ${flight.airFare || '(不明)'} 商品ID ${flight.productId || '(不明)'}`);

      for (const g of groups) {
        const baseHotelUrl = buildHotelListUrl({
          airCacheKey: flightKeys.airCacheKey,
          selectedItemKey: flightKeys.selectedItemKey,
          hotelSort: g.hotelSort,
          site,
        });
        if (flightRank === targets[0] + 1) {
          baseHotelUrls[g.hotelSort === 2 ? 'cheap' : 'rank'] = baseHotelUrl;
        }

        for (let n = 1; n <= g.top; n++) {
          globalIndex++;
          await page.goto(baseHotelUrl, { waitUntil: 'commit', timeout: 60000 });
          await page.waitForURL('**tab=hotel**', { timeout: 60000 });
          await page.locator('a.showHotelPlanList').first()
            .waitFor({ state: 'attached', timeout: 60000 });
          const hotel = await collectHotelCardInfo(page, n);
          const { url: selectedUrl, cancelInfo } = await selectFirstPlanOfHotel(page, n);
          hotel.cancelInfo = cancelInfo;
          const k = extractKeysFromListUrl(selectedUrl);
          const cmds = buildCommands(globalIndex, k, site);
          const availBody = buildAvailBody(k.selectedItemKey, site);
          fs.writeFileSync(path.join(OUT_DIR, cmds.bodyFile), JSON.stringify(availBody), 'utf8');
          entries.push({
            rank: n,
            sortLabel: g.sortLabel,
            flightRank,
            site: site.key,
            flight,
            hotel,
            keys: {
              selectedItemKey: k.selectedItemKey,
              airCacheKey: k.airCacheKey,
              hotelCacheKey: k.hotelCacheKey,
            },
            listUrl: withShowtimeinfo(k.listUrl),
            availBody,
            commands: { reserve: cmds.reserveCmd, curl: cmds.curlCmd },
          });
          console.log(`HOTEL [F${flightRank} ${g.sortLabel}] ${n}: ${hotel && hotel.name ? hotel.name : '(名称不明)'} → item ${k.selectedItemKey}`);
        }
      }
    }

    // (4) 出力：JSON＋コマンド一覧（1件1行）
    const result = {
      generatedAt: new Date().toISOString(),
      condition: { dep, dest, from, to, adults: 1, rooms: 1, carrier: carrier || null },
      flights: targets.map((i) => ({ rank: i + 1, carrier: flightList[i].carrier, productId: flightList[i].productId })),
      baseHotelUrls,
      entries,
    };
    fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'commands-node.txt'),
      entries.map((e) => e.commands.reserve).join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT_DIR, 'commands-curl.txt'),
      entries.map((e) => e.commands.curl).join('\n') + '\n', 'utf8');

    console.log('');
    console.log(`PLANS JSON: ${outFile}`);
    console.log('');
    console.log('=== reserve.js コマンド（1件1行） ===');
    entries.forEach((e) => console.log(e.commands.reserve));
    console.log('');
    console.log('=== curl コマンド（1件1行・ボディは avail-body-N.json） ===');
    entries.forEach((e) => console.log(e.commands.curl));
    console.log('');
    console.log('PLANS_JSON_BEGIN');
    console.log(JSON.stringify(result));
    console.log('PLANS_JSON_END');
  });
}

/**
 * avail-check: 1件（selectedItemKey + キー）について実際にブラウザで
 * 「予約確認へ進む」→ /dp/avail → /dp/reservation/input 到達を検証し OK/NG を返す。
 * 出力はサーバー（server.js）がパースする前提の行形式。
 */
async function cmdAvailCheck(opts, flags) {
  const site = resolveSite(opts['--site']);
  let listUrl;
  if (opts['--list-url']) {
    listUrl = opts['--list-url'];
  } else if (opts['--item'] && opts['--air'] && opts['--hotel']) {
    listUrl = buildListUrl({
      airCacheKey: opts['--air'],
      hotelCacheKey: opts['--hotel'],
      selectedItemKey: opts['--item'],
      site,
    });
  } else {
    console.error('avail-check には --item と --air と --hotel（または --list-url）が必要です。');
    process.exit(2);
  }
  const { browser, page } = await launch(flags.has('--headed'), flags.has('--capture-avail'));
  const started = Date.now();
  try {
    await page.goto(listUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForURL('**/dp/list**', { timeout: 60000 });
    const r = await clickProceedToReservation(page);
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log('RESULT: OK');
    console.log(`FINAL_URL: ${r.finalUrl}`);
    console.log(`PACKAGE_ID: ${r.packageId}`);
    console.log(`TX: ${r.tx}`);
    console.log(`MESSAGE: /dp/reservation/input に到達（${sec}秒）`);
    // --headed のときは画面を残す（input画面をそのまま確認できる）
    if (flags.has('--headed')) {
      console.log('HEADED: ブラウザを開いたままにします。閉じると終了します。');
      await new Promise((resolve) => browser.on('disconnected', resolve));
    } else {
      await browser.close();
    }
    process.exit(0);
  } catch (err) {
    const failUrl = (() => { try { return page.url(); } catch { return '(unknown)'; } })();
    const sec = ((Date.now() - started) / 1000).toFixed(1);
    console.log('RESULT: NG');
    console.log(`FINAL_URL: ${failUrl}`);
    console.log(`MESSAGE: 到達できず（${sec}秒）: ${err && err.message ? err.message.split('\n')[0] : err}`);
    try { await browser.close(); } catch (_) {}
    process.exit(1);
  }
}

// ---- エントリポイント ------------------------------------------------------

async function main() {
  const { positional, flags, opts } = parseArgs(process.argv.slice(2));
  let sub = 'run';
  if (positional.length && SUBCOMMANDS.has(positional[0])) sub = positional.shift();

  switch (sub) {
    case 'run':       return cmdRun(positional, flags, opts);
    case 'keys':      return cmdKeys(positional, flags, opts);
    case 'open-list': return cmdOpenList(opts, flags);
    case 'proceed':   return cmdProceed(opts, flags);
    case 'cheapest':  return cmdCheapest(positional, flags, opts);
    case 'hotel-plans': return cmdHotelPlans(positional, flags, opts);
    case 'avail-check': return cmdAvailCheck(opts, flags);
    default:          return usageAndExit();
  }
}

main().catch((e) => {
  console.error('UNEXPECTED:', e);
  process.exit(1);
});
