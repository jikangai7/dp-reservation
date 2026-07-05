# エアトリDP：4項目から予約者情報入力画面へ自動到達

エアトリ（skygate.co.jp）の**海外航空券＋ホテル（ダイナミックパッケージ, DP）**予約フローで、
**出発地・目的地・出発日・現地出発日（大人1名固定）の4項目**だけを起点に、
予約者情報入力画面 `/dp/reservation/input` まで自動で到達させるツール一式です。

> 到達＝情報入力画面の**表示まで**。予約確定・決済は一切行いません。

**すぐに使いたい方へ**：
[セットアップ手順書.md](セットアップ手順書.md)（初回導入）→
[操作手順書.md](操作手順書.md)（日常的な使い方）を参照してください。
上司・非エンジニア向けの概要は[説明資料.md](説明資料.md)にまとめています。

---

## 結論：静的URLは作れない。フローを駆動して到達する

`/dp/reservation/input` を開くには2つのトークンが必須です。

| トークン | 役割 | 発行タイミング |
|---|---|---|
| `packageId` | 商品（フライト＋ホテル＋確定価格）の**金庫番号** | `POST /dp/avail` のレスポンス |
| `__tx__` | 予約手続きの**通行証**（ワンタイム） | avail後の匿名SSO遷移ハンドオフ |

どちらも「予約確認へ進む」を押した瞬間にサーバーが発行する**使い捨て**の値で、
4項目から計算・予測はできません。したがって到達手段は
「URLを手組みして直接飛ぶ」ではなく「フローを順に駆動する」方式になります。

---

## 到達フロー

```
4項目入力
  │
  ▼  GET /dp/searching?departure=&arrival=&destination=&fromDate=&toDate=&rooms=1&business=0&searchKind=0&AgentCode=HATOP
  │     （匿名SSO: sso_auth_check → account.airtrip.jp/auth → sso_callback を自動通過）
  ▼
/dp/list に着地  ← おすすめ商品が自動選択済み（selectedItemKey がURLに付与される）
  │     フライト・ホテルの手動選択は不要
  ▼  「予約確認へ進む」<a href="javascript:void(0);"> をクリック
  │     ├─ XHR: POST /dp/avail（在庫確認 availStatus + 価格確定 amountInfo + packageId 発行、約3秒）
  │     └─ 匿名SSO遷移ハンドオフで __tx__ 発行
  ▼
/dp/reservation/input?__tx__=...&packageId=...   ← ゴール（タイトル「旅行者情報入力｜エアトリ」）
```

---

## 前提

- **Node.js**（v18+ 推奨。動作確認は v26）
- 本フォルダで一度だけ依存を導入：

```powershell
# node が PATH にない場合は先に通す（環境に合わせて調整）
$env:Path = "C:\Program Files\nodejs;" + $env:Path

cd "C:\Claude\リベシティ\dp-reservation"
npm install                    # playwright を導入（package.json 済み）
npx playwright install chromium
```

---

## 使い方

サブコマンド方式です（省略時は `run`）。共通オプション：`--headed`（可視実行）/ `--capture-avail`（`POST /dp/avail` の応答を `avail-<時刻>.json` に保存）。

| サブコマンド | 用途 |
|---|---|
| `run <dep> <dest> <from> <to>` | 4項目から `/dp/reservation/input` まで一気通貫（既定） |
| `keys <dep> <dest> <from> <to>` | 検索を1回走らせ、本物の各キーと `/dp/list` URL（おすすめ順・料金が安い順）を出力 |
| `open-list --air <k> --hotel <k> [--sort cheap]` | `/dp/list` を開いて状態確認（自動生成の有無・価格の並び） |
| `proceed --list-url "<url>"` | 指定の `/dp/list` から予約入力画面まで進む |
| `proceed --air <k> --hotel <k> [--item <k>] [--sort cheap]` | キー指定で `/dp/list` を組み立てて進む（`--item` 省略可） |
| `cheapest <dep> <dest> <from> <to>` | **最安フライトを選択**し、**ホテル一覧を価格の安い順**で開いてURLを出力 |

`--sort cheap`＝料金が安い順 / `--sort recommend`＝おすすめ順。ソートに必要な検索条件は
`airCacheKey` 自体に埋まっているため追加引数は不要です。

```powershell
node reserve.js [run] <departure> <destination> <fromDate> <toDate> [--headed] [--capture-avail]
```

| 引数 | 説明 | 例 |
|---|---|---|
| `departure` | 出発地の都市コード（帰着地も同値＝往復） | `OSA` |
| `destination` | 目的地の都市コード | `MNL` |
| `fromDate` | 出発日 `YYYY/MM/DD` | `2026/10/01` |
| `toDate` | 現地出発日 `YYYY/MM/DD` | `2026/10/10` |
| `--headed` | ブラウザを可視表示で実行（既定は非表示） | |
| `--capture-avail` | `POST /dp/avail` のレスポンスJSONを `avail-<時刻>.json` に保存 | |
| `--site` | `sg`（既定）または `travelko`。`sg`=`AgentCode=HATOP`、`travelko`=`AgentCode=HACTB`＋`meta=1`＋`metaLandingInit=1` | `--site travelko` |

いずれのサブコマンド（`run`/`keys`/`open-list`/`proceed`/`cheapest`/`hotel-plans`/`avail-check`）でも
`--site` を指定可能。省略時は `sg`（従来通りの動作）。

### 実行例

```powershell
node reserve.js OSA MNL 2026/10/01 2026/10/10
```

### 出力例

```
SEARCH: https://www.skygate.co.jp/dp/searching?departure=OSA&arrival=OSA&destination=MNL&fromDate=2026%2F10%2F01&toDate=2026%2F10%2F10&AgentCode=HATOP&business=0&rooms=1&searchKind=0
LIST:   https://www.skygate.co.jp/dp/list?...&selectedItemKey=7f708fb3...c8514930_dpci...
REACHED: https://www.skygate.co.jp/dp/reservation/input?__tx__=3dcf3dd3...&packageId=packageId_643042f9-cf31-4a04-b80a-221fd183cf4d
  title    : 旅行者情報入力｜エアトリ
  packageId: packageId_643042f9-cf31-4a04-b80a-221fd183cf4d
  __tx__   : 3dcf3dd3...
```

`REACHED:` 行が出て終了コード0なら成功。失敗時は現在URLと `error-<時刻>.png`（スクリーンショット）を残して終了コード1で終わります。

### 都市コード早見（例）

`TYO`=東京 / `OSA`=大阪 / `TPE`=台北 / `SEL`=ソウル / `MNL`=マニラ / `HNL`=ホノルル / `BKK`=バンコク / `SIN`=シンガポール / `HKG`=香港

---

## /dp/list で作業を挟む使い方（キー抽出 → 一覧作業 → 予約入力）

`/dp/list`（検索結果一覧）で独自の確認・操作をしてから予約入力へ進みたい場合の流れです。

1. **本物のキーを取得**（検索を1回だけ実行）:
   ```powershell
   node reserve.js keys OSA MNL 2026/10/01 2026/10/10
   ```
   出力（JSON）に `airCacheKey` / `hotelCacheKey` / `selectedItemKey` / `listUrl` が入ります。

2. **一覧で作業**：`listUrl` をブラウザで開いて確認・操作する。
   （`--item` を付けずに `open-list` / `proceed` で開くと、サーバーがおすすめ商品を自動選択します）

3. **予約入力へ進む**：作業に使った `/dp/list` の状態から先へ。
   ```powershell
   node reserve.js proceed --list-url "<手順1のlistUrl>"
   # もしくはキー指定（itemは省略可＝サーバー自動選択に委ねる）
   node reserve.js proceed --air "<airCacheKey>" --hotel "<hotelCacheKey>"
   ```

### キーの構造と「作れる／作れない」

| キー | 構造 | 入力から生成できるか |
|---|---|---|
| `hotelCacheKey` | `20_1_{fromYmd}_{toYmd}____{dest}__2__1__1___0_0_0_` | **できる**（完全に入力由来。`keys` 実行時にサーバー値と一致を自己照合） |
| `airCacheKey` | `0_{GUID}{ts}_1,25_{dep}_{arr}_{fromYmd}_{toYmd}_1__0_,,,0,0,0_{dest}_0_0` | **できない**（`{GUID}` はサーバーがフライト検索時に発番。`keys` で抽出する） |
| `selectedItemKey` | 例 `…_dpci`（32桁hash＋接尾辞） | **できない**（サーバー発番。`--item` 省略時は一覧表示時に自動生成される） |

### 実測でわかったこと

- `hotelCacheKey` は入力だけで生成でき、サーバー値と一致する。
- `airCacheKey` は**検索セッションのクッキーに紐づかない**：別の（クッキー無しの）ブラウザでも
  キー値だけで `/dp/list` → 予約入力まで通る。抽出したキーは持ち運べる。
- `selectedItemKey` を付けずに `/dp/list` を開くと、サーバーがおすすめ商品を自動選択して
  `selectedItemKey` を生成する（`proceed` で `--item` を省略しても到達できる）。
- ただし `airCacheKey` は avail 時点のスナップショットで、時間経過や在庫変動で失効しうる。
  失効したら `keys` で取り直す。

### 航空券の並び替え（料金が安い順）

一覧のソートは**URLパラメータだけ**で表現できる（一覧のソートリンクと同形式）：

```
/dp/list?AgentCode=HATOP&rooms=1&business=0
  &fromDate={YYYYMMDD}&toDate={YYYYMMDD}&departure={dep}&destination={dest}&arrival={arr}
  &cacheKeyCode={GUID+ts}&airPage=1&airOrder=1&form=sortAir&tab=air&hotelCacheKey={hotel}#tab/air
```

- `airOrder=1`＝料金が安い順 / `airOrder=2`＝おすすめ順
- `cacheKeyCode` は `airCacheKey`（`0_{cacheKeyCode}_1,25_…`）から抽出した GUID+タイムスタンプ部分
- 検索条件（dep/arr/from/to/dest）も `airCacheKey` に埋まっているものを流用

使い方：`keys` の出力に含まれる `listUrlCheapest`（安い順URL）をそのままブラウザで開くか、
`open-list`/`proceed` に `--sort cheap` を付ける。実測で一覧の合計金額が
`¥65,688 → ¥84,828 → ¥94,768 → …` と昇順になることを確認済み。

※ソートは**表示順の変更のみ**。選択中の商品（`selectedItemKey`）は変わらないため、
最安のフライトで予約したい場合は一覧上でそのフライトを選択し直す操作が別途必要
（→ 下記 `cheapest` サブコマンドが自動でやる）。

### 最安フライト選択 → ホテル一覧（価格の安い順）：`cheapest`

「安い順で最安のフライトを選び、ホテルを変更するでホテル一覧を安い順に見る」までを自動化：

```powershell
node reserve.js cheapest OSA MNL 2026/10/01 2026/10/10
```

内部の流れ：
1. 検索 → `/dp/list` 着地 → 料金が安い順（`airOrder=1`）へ
2. 先頭（最安）商品の「この商品のフライトを見る」→「このフライトを選択する」をクリック
   （**フライト選択はURL不可・クリック必須**。`form=reload_air` で `selectedItemKey` が更新される）
3. ホテル一覧を価格の安い順で開く（「ホテルを変更する」の実体はホテルタブ切替。URLで直行可能）

出力される `HOTEL LIST URL（価格の安い順）` をブラウザで開けばホテル選択を続行できる。
そのまま予約入力へ進む場合は出力される `proceed --list-url "..."` コマンドを実行する。

**ホテルのソートもURLだけで可能**（`form=sortHotel&tab=hotel`）。`hotelSort` の値：

| hotelSort | 並び順 |
|---|---|
| 1 | オススメ順 |
| **2** | **価格の安い順**（ホテルタブの既定） |
| 3 | 価格の高い順 |
| 4 | ホテルランクの高い順 |

ホテルタブURLに必要な `checkin`/`checkout`/`destination` も `airCacheKey` から導出される。
実測：各ホテルカードは「選択済みの最安フライト（固定額）＋ホテル代」で表示され、
ホテル代が 15,210 → 23,355 → … と昇順になることを確認済み。

---

## ホテルプラン選択 → /dp/avail 検証：`hotel-plans` / `avail-check`

安い順1ページ目（最大25件）のフライトを**キャリアルール**で巡回し、対象フライトごとに
ホテルを**「価格の安い順」**と**「ホテルランクの高い順」**の2グループそれぞれで
**上位N件**（グループ別に `--top-cheap` / `--top-rank` で0〜3件を指定、既定は各1件）を対象に
「この商品のプランを見る」→最初に表示されたプランの「このプランを選択する」を自動実行し、
`/dp/avail` に渡す情報を作成する（対象フライト数×(top-cheap+top-rank)件、JSON＋手動実行コマンド）。

**キャリアルール**（フライトの処理対象の決め方。`--carrier` 未指定時）：
1. 1位（最安）は常に処理する
2. 直前に処理したフライトと同じキャリアなら読み飛ばす
3. 同じキャリアは合計2つまで（3つ目以降は読み飛ばす）
4. 1ページ目の最後（25位）まで確認する

**`--carrier` でキャリアを2レター指定した場合**：検索自体をそのキャリアに絞り込む
（`carriers=XX` パラメータを `/dp/searching` に付与。実測：例 `carriers=NH` でANA便のみがヒット）。
結果が単一キャリアになりキャリア名でのグルーピングが無意味になるため、代わりに
**商品ID末尾1桁が同じものは合計2つまで**とする同じ巡回ルールに自動的に切り替わる
（1位は常に処理／直前と同じ末尾1桁なら読み飛ばし／同じ末尾1桁は合計2つまで）。

```powershell
# 既定（安い順1件＋ランク順1件）
node reserve.js hotel-plans OSA MNL 2026/10/01 2026/10/10
# 件数を変える（各0〜3。両方0は不可）
node reserve.js hotel-plans OSA MNL 2026/10/01 2026/10/10 --top-cheap 3 --top-rank 2
# 対象フライト数を制限したいとき（動作確認・短時間実行用）
node reserve.js hotel-plans OSA MNL 2026/10/01 2026/10/10 --top-cheap 1 --top-rank 0 --max-flights 2
# キャリアを絞り込む（ANAのみ・商品ID末尾ルールで巡回）
node reserve.js hotel-plans OSA MNL 2026/10/01 2026/10/10 --carrier NH
```

処理時間の目安（実測）：固定コスト約24秒＋カード1枚あたり約7秒＋フライト切替ごとの
オーバーヘッド。既定設定（各1件）なら1フライト約40秒、6件フル（各3件）なら1フライト約70秒。
ページ1のキャリア構成によっては対象フライトが10件前後になり、合計20〜30分かかることがある。

出力：
- `plans.json` — 情報リスト。`condition.carrier` が指定したキャリア（未指定時は `null`）。
  `flightRank` がフライトの順位、`sortLabel` が
  「価格の安い順」／「ホテルランクの高い順」を示す。フライト情報・ホテル情報・キー・
  avail送信ボディを含む。直下の `flights` 配列に対象フライトの順位・キャリア・商品番号の一覧）
  - `flight.productId` — フライトの商品番号（`/dp/list` に付与している `showtimeinfo=1` により
    一覧カードの `li.item-number` から取得。項目自体が無いフライトでは `null`）
  - `hotel.hotelCode` — ホテルID（一覧カードの `data-hotel_code`。表示上の「ホテルID：nnnnn」と同一）
  - `hotel.cancelInfo` — プラン展開時の無料キャンセル表示テキスト（例
    「ホテルキャンセル料無料2026年9月27日(日)まで」）。無料キャンセルでないプランでは `null`
- `avail-body-N.json` — 各件の `/dp/avail` リクエストボディ（フライト・グループを跨いだ通し番号）
- `commands-node.txt` / `commands-curl.txt` — 1件1行の手動実行コマンド（reserve.js版／curl版）
- 標準出力にも同じコマンド一覧を表示

各件のreserve.jsコマンド例：
```
node reserve.js avail-check --item "<selectedItemKey>" --air "<airCacheKey>" --hotel "<hotelCacheKey>"
```
curlコマンド例（ボディは同ディレクトリの `avail-body-N.json` を参照）：
```
curl.exe -s -X POST https://www.skygate.co.jp/dp/avail -H "Content-Type: application/json" -H "X-Requested-With: XMLHttpRequest" --data-binary "@avail-body-1.json"
```

`avail-check` は1件を実際にブラウザで実行し、`/dp/reservation/input` への到達を判定する：

```powershell
node reserve.js avail-check --item "<k>" --air "<k>" --hotel "<k>"
```
成功時 `RESULT: OK` と `FINAL_URL` / `PACKAGE_ID` / `TX` / `MESSAGE` を出力。失敗時は `RESULT: NG`。

**実測でわかった注意点**：
- カード概要（一覧の安い順ソート結果）のホテル代・合計は「そのホテルの代表プラン（多くは最安プラン）」の金額。
  一方 `avail-check` が検証するのは「最初に表示されたプランを選んだ結果」なので、
  **両者の金額が一致しない場合がある**（ホテルによって代表プランと先頭表示プランが異なるため）。
  実際の金額は `avail-check` 実行後の `packageId` 発行時点のものが正。
- `selectedItemKey` に無効値を渡しても、サーバーは自動的に別の有効な商品へフォールバックし
  **OKになることがある**（＝一覧ページが常に何らかの商品を自動選択する仕組みのため）。
  一方で `airCacheKey`/`hotelCacheKey` 自体が構造的に無効な場合は `/dp/list` が描画できず、
  60秒タイムアウトで **NG** になる。つまり「NG」は主に通信・タイムアウト・完全に不正なURLを
  検出するものであり、「その商品が個別に売り切れ」を単体で検出するものではない。
- `curl` で `/dp/avail` を直接叩くと**Cookie無しでも200 OKでpackageIdが返る**ことを確認済み
  （検証セクション参照）。ただし `/dp/reservation/input` への到達確認（`__tx__`発行を含む）は
  ブラウザでのSSO遷移が必須なため、**OK/NG判定は必ず `avail-check`（reserve.js）側で行う**。
  curlコマンドは「avail応答の生データ確認用」として併記している。
- `packageId`/`__tx__` は**別の完全に新しいブラウザセッションでも再利用できる**ことを確認済み
  （少なくとも発行直後は）。つまり一度到達したカードの `input画面を開く` は後から何度でも
  試せる。長時間経過して失効した場合のみ、そのカードを再実行（`avail実行`）して新しいトークンを
  取り直す。

---

## ローカルWeb UI：avail 検証ランナー

CLIの代わりにブラウザ操作でhotel-plans/avail-checkを扱えるローカルWebアプリ。

```powershell
node server.js
```

起動後 `http://localhost:5178/` を開く。画面構成：

1. 検索フォーム（出発地・目的地・出発日（カレンダー選択）・現地出発日・
   **キャリア（任意・2レター。例 NH）**・
   **サイト（SG／Travelko）ラジオボタン、既定はSG**・
   **ホテル取得数プルダウン（安い順0〜3・ランク順0〜3、既定は各1。両方0は不可）**）＋
   「URL取得」ボタン。ボタンの下に**取得経過時間**（押下からカード表示完了までを1秒ごとに更新、
   完了時に「取得時間 MM:SS」で確定・緑表示）。
   キャリアを指定すると検索自体がそのキャリアに絞り込まれ、フライト巡回ルールが
   商品ID末尾1桁ルール（同じ末尾1桁は合計2つまで）に切り替わる
2. 「**CXL無料をすべて実行**」ボタン — **ホテルキャンセル料無料のカードのみ**を対象に
   順次avail実行する（実行済み（OK/NG）カードはスキップ）
3. カード一覧の一番上に**1件目の `/dp/list` URL**（コピー・開くボタン付き。`showtimeinfo=1` 付与済み）。
   このURL行が表示された時点から**15分カウントダウンタイマー**（画面上部中央に固定表示・
   スクロール追従・期限切れで赤表示）が始まる
4. **フライトごと**に「フライトN位 キャリア名 商品ID 航空券代」見出し、その下に
   「価格の安い順」「ホテルランクの高い順」のソート見出し＋カード（各カードは上→下の4層構成）：
   - **上部**：結果バッジ（未実行=グレー／実行中=アンバー／OK=緑／NG=赤）＋メッセージ＋
     「avail実行」ボタン。OK時は「input画面を開く」ボタンが追加表示される
     （到達済みURLを新しいタブで開く。別ブラウザ・別タブでも動作する）。
   - **到達URL行**（OK時のみ）：`/dp/reservation/input` の到達済みURLをコピーボタン付きで表示
   - **中央**：AIR（航空会社/**商品ID**/便名/往復時刻/航空券代。経由便は4便以上のことも）と
     HTL（ホテル名/**ホテルID**/ホテル代/泊数/合計/**キャンセル無料表示**）の2カラム。
     HTL側はカードが属するグループのソート順を表示。
   - **下部**（折りたたみ）：キー・トークンを**画面/APIの用途別**に整理して表示：
     - `/dp/list`（一覧画面）で必要：airCacheKey / hotelCacheKey / selectedItemKey
     - `POST /dp/avail`（在庫確認API）：送信 selectedItemKey → 応答 packageId
     - `/dp/reservation/input`（予約入力画面）で必要：packageId / __tx__（avail実行後に反映）
     - reserve.js コマンド／curl コマンド（各コピーボタン付き）

APIは3つ（`server.js` が子プロセスで `reserve.js` を実行し結果をJSONで返す）：
- `POST /api/collect` `{dep,dest,from,to,site,topCheap,topRank,carrier}` → `hotel-plans` を実行し
  対象フライト数×(topCheap+topRank)件のJSONを返す（タイムアウト30分。topCheap/topRankは0〜3、省略時各1。
  carrierはキャリア2レター・省略可）
- `POST /api/avail-check` `{item,air,hotel,site}` → `avail-check` を実行しOK/NGを返す
- `POST /api/server/stop` `{}` → レスポンス送信後にサーバープロセス自身を終了する

`site` は `sg`（既定）または `travelko`。収集時に選んだサイトは各エントリに保存され、
そのカードの「avail実行」は自動的に同じサイトで実行される。

### サーバーの停止・起動

- **停止**：画面右上の「サーバー停止」ボタン（確認ダイアログあり）。または [stop-server.bat](stop-server.bat) をダブルクリック。
- **起動**：[start-server.bat](start-server.bat) をダブルクリック、または `node server.js`。
  ※UIはこのサーバー自身が配信しているため、停止後に画面から再起動することはできない
  （「起動」ボタンをUIに置けないのはこのため）。

「avail実行」ボタンを押したときの詳細な動作仕様は [仕様書.md](仕様書.md) を参照。

---

## 手動でたどる場合（スクリプトを使わない読者向け）

1. ブラウザで検索URLを開く（`YYYY/MM/DD` はそのままでよい。ブラウザがエンコードする）：
   `https://www.skygate.co.jp/dp/searching?departure=OSA&arrival=OSA&destination=MNL&fromDate=2026/10/01&toDate=2026/10/10&AgentCode=HATOP&business=0&rooms=1&searchKind=0`
   もしくはトップ `https://www.skygate.co.jp/dp/` の検索フォームに4項目を入力して「最安値を検索」。
2. `/dp/list`（検索結果）に着地。おすすめの航空券＋ホテルが自動選択されている。
3. 右側「合計」枠の赤い **「予約確認へ進む」** を押す。
4. 数秒後、`/dp/reservation/input`（旅行者情報入力）に遷移すれば到達。

---

## 制約・注意

- **大人1名前提**。2名以上・子供/幼児、部屋数>1、周遊/オープンジョーは非対応。
  （DP版 `/dp/searching` に人数を渡すパラメータ名は未確認のため。人数を変える場合は
  トップの検索フォームで搭乗人数欄を操作する方式が確実。）
- `packageId`・`__tx__` は avail 実行時点の**スナップショット**。在庫・価格は時間経過で失効しうる。
- 到達後の**予約確定・決済は行わない**。本ツールのゴールは情報入力画面の表示まで。
- サイト側の仕様変更（セレクタ・URLパラメータ・SSOの挙動）で動かなくなる可能性がある。
  その場合は `--headed` で可視実行し、`error-*.png` と現在URLから原因箇所を特定する。

---

## 動作確認済み条件

| 条件 | 結果 |
|---|---|
| `OSA MNL 2026/10/01 2026/10/10` | REACHED（終了コード0） |
| `TYO SEL 2026/09/01 2026/09/03` | REACHED（終了コード0） |
| `hotel-plans OSA MNL 2026/10/01 2026/10/10`（旧 --top 3 相当時代を含む） | 6件収集（安い順3＋ランク順3、bodyファイル重複なし）・reserve.js/curlコマンド出力 |
| `avail-check`（上記6件、CLIで個別実行） | 6件ともOK（`/dp/reservation/input` 到達、10〜16秒） |
| `avail-check`（完全に不正なkey） | NG（60秒タイムアウト） |
| Web UI（URL取得） | フライト見出し＋ソート見出し＋カードを正しく表示（HTL側の見出しラベルもグループごとに切替） |
| `hotel-plans --max-flights 2`（キャリアルール） | 1位セブ→2位中国国際を処理、4位の連続同キャリア（マレーシア）をスキップ。2位以降の便名も正確（CA162等） |
| `hotel-plans --top-cheap 0 --top-rank 2` | 安い順グループをスキップしランク順2件のみ収集 |
| Web UI（CXL無料をすべて実行） | キャンセル無料でないカードのみ「未実行」のまま正しくスキップ |
| `hotel-plans --carrier NH`（商品ID末尾ルール） | `carriers=NH` で25件全てANAに絞り込み。末尾1桁ルールで1・2・3・13位を選出（末尾T×2・S×1が既に上限のためスキップを継続、末尾Sの13位で再度2つ目を採用） |
| Web UI（キャリア指定でURL取得） | フォームのキャリア欄→JSON送信→`condition.carrier`まで正しく伝播し、指定キャリアのみのカードを表示することを確認 |
| `/dp/searching` に `carriers=NH` 付与 | 一覧が最初からANAのみ（23件全件ANA）になることを確認（キャリア事前絞り込みが可能） |

いずれもクッキー無しの新規（コールド）ブラウザセッションで、匿名SSOを自動通過して到達。
