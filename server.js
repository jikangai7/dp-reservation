#!/usr/bin/env node
/**
 * エアトリDP avail検証ランナー ローカルWeb UI
 *
 * 依存追加なし（Node標準 http のみ）。reserve.js のロジックを再利用するため、
 * 各APIは子プロセスで `node reserve.js <sub>` を起動し、標準出力をパースして返す。
 *
 * 起動: node server.js [port]（既定 5178）
 * 画面: http://localhost:5178/
 *
 * API:
 *   POST /api/collect      { dep, dest, from, to, site, topCheap, topRank, carrier }
 *                          → hotel-plans を実行し情報リストのJSONを返す
 *                          （topCheap/topRankは0〜3の整数、省略時は各1。両方0は不可）
 *                          （carrierはキャリア2レター、省略可。指定時は検索自体をそのキャリアに
 *                            絞り込み、フライト巡回は商品ID末尾1桁ルールに切り替わる）
 *   POST /api/avail-check  { item, air, hotel, site }      → avail-check を実行しOK/NGを返す
 *   POST /api/server/stop  {}                              → レスポンス後にこのサーバー自身を終了する
 *   site は 'sg'（既定, AgentCode=HATOP）または 'travelko'（AgentCode=HACTB, meta=1, metaLandingInit=1）
 *
 * 注意: 停止後の再起動はUIからは行えない（このサーバーがUIを配信しているため）。
 *       再起動は start-server.bat のダブルクリック、または `node server.js` を再実行する。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = Number(process.argv[2]) || 5178;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const NODE_BIN = process.execPath;
const RESERVE_JS = path.join(ROOT, 'reserve.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/** リクエストボディをJSONとして読み取る（上限256KB） */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/** 日付 YYYY/MM/DD の簡易検証（子プロセスへの引数注入対策：許可パターン以外は拒否） */
function isValidDate(s) { return typeof s === 'string' && /^\d{4}\/\d{2}\/\d{2}$/.test(s); }
function isValidCity(s) { return typeof s === 'string' && /^[A-Z]{3}$/.test(s); }
function isValidSite(s) { return s === 'sg' || s === 'travelko'; }
/** 安い順／ランク順の取得件数（0〜3の整数）の検証 */
function isValidTopCount(n) { return Number.isInteger(n) && n >= 0 && n <= 3; }
/** キャリア2レター（英数字2文字）の検証。未入力は許容（空文字/undefined） */
function isValidCarrier(s) { return s === '' || s === undefined || s === null || /^[A-Za-z0-9]{2}$/.test(s); }
/** キー類は execFile（シェル非経由）で渡すため注入リスクは低いが、型と長さだけ軽く検査する */
function isPlausibleKey(s) { return typeof s === 'string' && s.length > 0 && s.length < 400; }

/** 子プロセスで reserve.js を実行し、stdout/stderr/exitCode を返す */
function runReserve(args, timeoutMs = 90000) {
  return new Promise((resolve) => {
    execFile(NODE_BIN, [RESERVE_JS, ...args], { cwd: ROOT, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0), stdout, stderr, err });
      });
  });
}

/** hotel-plans の標準出力から PLANS_JSON_BEGIN...END の内側を取り出す */
function extractPlansJson(stdout) {
  const m = /PLANS_JSON_BEGIN\n([\s\S]*?)\nPLANS_JSON_END/.exec(stdout);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}

/** avail-check の標準出力から RESULT/FINAL_URL/PACKAGE_ID/TX/MESSAGE を取り出す */
function parseAvailCheckOutput(stdout) {
  const get = (label) => {
    const m = new RegExp(`^${label}: (.*)$`, 'm').exec(stdout);
    return m ? m[1].trim() : null;
  };
  const result = get('RESULT');
  return {
    ok: result === 'OK',
    finalUrl: get('FINAL_URL'),
    packageId: get('PACKAGE_ID'),
    tx: get('TX'),
    message: get('MESSAGE'),
  };
}

async function handleCollect(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON body' }); }
  const { dep, dest, from, to } = body || {};
  const site = body && body.site ? body.site : 'sg';
  const topCheap = body && body.topCheap !== undefined ? Number(body.topCheap) : 1;
  const topRank = body && body.topRank !== undefined ? Number(body.topRank) : 1;
  const carrierRaw = body && body.carrier ? String(body.carrier).trim().toUpperCase() : '';
  if (!isValidCity(dep) || !isValidCity(dest) || !isValidDate(from) || !isValidDate(to)) {
    return sendJson(res, 400, { error: '出発地/目的地は3文字コード、日付は YYYY/MM/DD 形式で指定してください。' });
  }
  if (!isValidSite(site)) {
    return sendJson(res, 400, { error: 'site は sg または travelko を指定してください。' });
  }
  if (!isValidTopCount(topCheap) || !isValidTopCount(topRank)) {
    return sendJson(res, 400, { error: '安い順・ランク順の取得数は 0〜3 の整数で指定してください。' });
  }
  if (topCheap === 0 && topRank === 0) {
    return sendJson(res, 400, { error: '安い順・ランク順の両方を0にはできません。' });
  }
  if (!isValidCarrier(carrierRaw)) {
    return sendJson(res, 400, { error: 'キャリアは2レター（英数字2文字）で指定してください。' });
  }
  const args = ['hotel-plans', dep, dest, from, to,
    '--top-cheap', String(topCheap), '--top-rank', String(topRank), '--site', site];
  if (carrierRaw) args.push('--carrier', carrierRaw);
  // フライト巡回（1ページ目・キャリアルール／carrier指定時は商品ID末尾ルール）で
  // 対象が最大10数便になり得るため長めに取る
  const r = await runReserve(args, 1800000);
  const plans = extractPlansJson(r.stdout);
  if (!plans) {
    return sendJson(res, 502, { error: '情報の取得に失敗しました。', stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) });
  }
  sendJson(res, 200, plans);
}

async function handleAvailCheck(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch (e) { return sendJson(res, 400, { error: 'invalid JSON body' }); }
  const { item, air, hotel } = body || {};
  const site = body && body.site ? body.site : 'sg';
  if (![item, air, hotel].every(isPlausibleKey)) {
    return sendJson(res, 400, { error: 'item / air / hotel キーが不正です。' });
  }
  if (!isValidSite(site)) {
    return sendJson(res, 400, { error: 'site は sg または travelko を指定してください。' });
  }
  const r = await runReserve(
    ['avail-check', '--item', item, '--air', air, '--hotel', hotel, '--site', site], 90000);
  const parsed = parseAvailCheckOutput(r.stdout);
  if (!parsed.message) parsed.message = r.stderr.slice(-500) || '不明なエラー';
  sendJson(res, 200, parsed);
}

/** レスポンスをクライアントに送り切ってからサーバープロセスを終了する */
function handleServerStop(req, res) {
  const body = JSON.stringify({ ok: true, message: 'サーバーを停止します' });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body, () => {
    process.exit(0);
  });
}

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/collect') return handleCollect(req, res);
  if (req.method === 'POST' && req.url === '/api/avail-check') return handleAvailCheck(req, res);
  if (req.method === 'POST' && req.url === '/api/server/stop') return handleServerStop(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
});

server.listen(PORT, () => {
  console.log(`avail 検証ランナー起動: http://localhost:${PORT}/`);
});
