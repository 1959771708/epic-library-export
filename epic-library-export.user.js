// ==UserScript==
// @name         Epic 库存导出
// @name:en      Epic Library Export
// @namespace    https://github.com/1959771708/epic-library-export
// @version      1.1.0
// @description  导出 Epic 账号的完整游戏库存（含从未产生订单的入库记录），输出 JSON / CSV 供第三方工具导入
// @description:en  Export your complete Epic Games library, including titles that never produced an order.
// @author       1959771708
// @license      MIT
// @homepageURL  https://github.com/1959771708/epic-library-export
// @supportURL   https://github.com/1959771708/epic-library-export/issues
// @updateURL    https://raw.githubusercontent.com/1959771708/epic-library-export/main/epic-library-export.user.js
// @downloadURL  https://raw.githubusercontent.com/1959771708/epic-library-export/main/epic-library-export.user.js
// @match        https://www.epicgames.com/*
// @match        https://store.epicgames.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      www.epicgames.com
// @connect      account-public-service-prod03.ol.epicgames.com
// @connect      library-service.live.use1a.on.epicgames.com
// @connect      entitlement-public-service-prod08.ol.epicgames.com
// @connect      catalog-public-service-prod06.ol.epicgames.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // ── 配置 ────────────────────────────────────────────────────────────────
    // 公开的 EGS 启动器客户端凭据（与 legendary 等项目使用的同一组，非私人密钥）
    const CLIENT_ID = '34a02cf8f4414e29b15921876da36f9a';
    const CLIENT_SECRET = 'daafbccc737745039dffe53d94fc76cf';

    const OAUTH_HOST = 'https://account-public-service-prod03.ol.epicgames.com';
    const LIBRARY_HOST = 'https://library-service.live.use1a.on.epicgames.com';
    const ENTITLEMENT_HOST = 'https://entitlement-public-service-prod08.ol.epicgames.com';
    const CATALOG_HOST = 'https://catalog-public-service-prod06.ol.epicgames.com';

    // 实测：catalog 接口在 40 并发内不触发限速，24 并发比 6 并发吞吐高约一倍
    const CONCURRENCY = 24;
    const SCHEMA_VERSION = 1;

    const state = { running: false, result: null, startedAt: 0, label: '', ticker: null };

    // ── 网络层 ──────────────────────────────────────────────────────────────
    function shortUrl(u) {
        return String(u).replace(/^https?:\/\//, '').slice(0, 60);
    }

    // 单次请求（不带重试）
    function httpOnce(cfg, url) {
        if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
            return GM.xmlHttpRequest(cfg).then(function (res) {
                if (!res || res.status < 200 || res.status >= 300) {
                    const err = new Error('HTTP ' + (res && res.status) + ' · ' + shortUrl(url));
                    err.status = res && res.status;
                    throw err;
                }
                return res.responseText;
            });
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
            throw new Error('未检测到 GM_xmlhttpRequest，请确认脚本由 Tampermonkey 运行');
        }
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest(Object.assign({}, cfg, {
                onload: function (r) {
                    if (r.status >= 200 && r.status < 300) return resolve(r.responseText);
                    const err = new Error('HTTP ' + r.status + ' · ' + shortUrl(url));
                    err.status = r.status;
                    reject(err);
                },
                onerror: function () { reject(new Error('网络错误 · ' + shortUrl(url))); },
                ontimeout: function () { reject(new Error('请求超时 · ' + shortUrl(url))); }
            }));
        });
    }

    function sleep(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    // 统一请求：对 429 / 5xx / 网络抖动做指数退避重试。
    // catalog 有 400+ 次请求，偶发限速若被静默吞掉，游戏名会悄悄退回代号。
    async function httpText(url, opts) {
        const RETRIES = (opts && opts.retries !== undefined) ? opts.retries : 2;
        const cfg = Object.assign({ method: 'GET', timeout: 30000, url: url }, opts || {});
        delete cfg.retries;

        let lastErr;
        for (let attempt = 0; attempt <= RETRIES; attempt++) {
            try {
                return await httpOnce(cfg, url);
            } catch (e) {
                lastErr = e;
                const st = e && e.status;
                const retryable = st === 429 || st === 500 || st === 502 ||
                    st === 503 || st === 504 || st === undefined;
                if (attempt === RETRIES || !retryable) break;
                // 429 稍等更久，其余 300ms / 600ms
                const backoff = (st === 429 ? 1200 : 300) * Math.pow(2, attempt);
                await sleep(backoff + Math.random() * 150);
            }
        }
        throw lastErr;
    }

    function parseJson(text, what) {
        try { return JSON.parse(text); }
        catch (e) { throw new Error(what + ' 返回非 JSON（可能被反爬拦截，请刷新页面重试）'); }
    }

    // ── Epic 接口 ───────────────────────────────────────────────────────────
    // 第 1 步：取一次性授权码。本站同源时直接 fetch，跨站时交给 GM。
    // 注意：这个接口会校验参数白名单，任何多余参数（含常见的防缓存 `_=`）都会返回
    // HTTP 400 "`_` is not allowed"，所以 URL 必须严格只有 clientId 和 responseType。
    async function fetchAuthCode() {
        const url = 'https://www.epicgames.com/id/api/redirect'
            + '?clientId=' + CLIENT_ID
            + '&responseType=code';

        let text;
        if (location.hostname === 'www.epicgames.com') {
            const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
            if (!r.ok) throw new Error('取授权码失败 HTTP ' + r.status);
            text = await r.text();
        } else {
            // 跨站时只能交给 GM；anonymous:false 表示带上目标域的 cookie
            text = await httpText(url, {
                headers: { Accept: 'application/json' },
                anonymous: false
            });
        }

        const data = parseJson(text, '授权码接口');
        if (!data.authorizationCode) {
            throw new Error('未登录。请先在 Epic 官网登录，再回到本页重试');
        }
        return data.authorizationCode;
    }

    // 第 2 步：用授权码换访问令牌（授权码一次性，每次导出都重新取）
    async function exchangeToken(code) {
        const body = 'grant_type=authorization_code'
            + '&code=' + encodeURIComponent(code)
            + '&token_type=eg1';

        const text = await httpText(OAUTH_HOST + '/account/api/oauth/token', {
            method: 'POST',
            headers: {
                'Authorization': 'basic ' + btoa(CLIENT_ID + ':' + CLIENT_SECRET),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            data: body
        });

        const j = parseJson(text, '令牌接口');
        if (!j.access_token) throw new Error('换取令牌失败：' + (j.errorCode || '未知原因'));
        return j;
    }

    // 第 3 步：游戏库（真正的库存，与是否下过单无关）
    // 翻页优化：nextCursor 是 base64 的 {"offset":N}，且 N 每次固定递增同一个步长。
    // 因此拿到第一页后可以按步长派生后续 cursor 并发拉取，实测 6 页 14s → 4.5s。
    // 安全性已验证：越界 offset 返回 0 条而不是报错；并发结果与串行逐条比对零重复零遗漏。
    function decodeCursorOffset(cursor) {
        try {
            const json = JSON.parse(atob(cursor));
            return (json && typeof json.offset === 'number') ? json.offset : null;
        } catch (e) {
            return null;
        }
    }

    function makeCursor(offset) {
        return btoa(JSON.stringify({ offset: offset }));
    }

    async function fetchLibraryPage(token, cursor, onNote) {
        let url = LIBRARY_HOST + '/library/api/public/items?includeMetadata=true';
        if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
        const j = parseJson(await httpText(url, {
            headers: { Authorization: 'bearer ' + token }
        }), '游戏库接口');
        if (onNote) onNote(j);
        return j;
    }

    async function fetchLibrary(token) {
        const first = await fetchLibraryPage(token, null);
        const records = (first.records || []).slice();
        const firstCursor = (first.responseMetadata && first.responseMetadata.nextCursor) || null;
        if (!firstCursor) return records;

        // 只有能解出 offset 才并发；解不出就走原来的串行，避免把接口语义猜错
        const step = decodeCursorOffset(firstCursor);
        if (!step || step <= 0) {
            let cursor = firstCursor;
            for (let page = 0; page < 200; page++) {
                const j = await fetchLibraryPage(token, cursor);
                const batch = j.records || [];
                records.push.apply(records, batch);
                const next = (j.responseMetadata && j.responseMetadata.nextCursor) || null;
                if (!next || batch.length === 0) break;
                cursor = next;
            }
            return records;
        }

        // 并发：按步长分批拉，某一批最后一页为空即说明到底了
        const BATCH = 6;
        let base = step;
        for (let wave = 0; wave < 40; wave++) {
            const offsets = [];
            for (let k = 0; k < BATCH; k++) offsets.push(base + k * step);

            // pool() 只负责调度、不收集返回值，所以在这里自己攒结果
            const got = [];
            await pool(offsets, BATCH, async function (off) {
                const j = await fetchLibraryPage(token, makeCursor(off));
                got.push({ off: off, batch: j.records || [] });
            });

            for (const r of got) {
                if (r.batch.length) records.push.apply(records, r.batch);
            }
            // 只要这一批里有任何一页是空的，就说明已经越过末尾
            if (got.some(function (r) { return r.batch.length === 0; })) break;
            base += BATCH * step;
        }
        return records;
    }

    // 第 4 步：权益记录（用来确认条目确实在账号里且为 ACTIVE）
    async function fetchEntitlements(token, accountId) {
        // 实测 count=1000 能一次返回全部 559 条（耗时与 500 相近），省掉一次往返
        const COUNT = 1000;
        const out = [];

        for (let start = 0; start < 20000; start += COUNT) {
            const url = ENTITLEMENT_HOST + '/entitlement/api/account/'
                + encodeURIComponent(accountId)
                + '/entitlements?start=' + start + '&count=' + COUNT;

            const j = parseJson(await httpText(url, {
                headers: { Authorization: 'bearer ' + token }
            }), '权益接口');

            const batch = Array.isArray(j) ? j : [];
            out.push.apply(out, batch);
            // 实测接口会按需返回、不受 count 上限硬截断：count=1000 时 559 条一次给全。
            // 所以只有"恰好等于 COUNT"才可能还有下一页，否则就是到底了。
            if (batch.length < COUNT) break;
        }
        return out;
    }

    // 第 5 步：把 catalogItemId 解析成真实游戏名（库里的 sandboxName 常是代号）
    async function resolveTitle(token, ns, catalogItemId) {
        const url = CATALOG_HOST + '/catalog/api/shared/namespace/' + encodeURIComponent(ns)
            + '/bulk/items?id=' + encodeURIComponent(catalogItemId)
            + '&country=US&locale=zh-CN&includeDLCDetails=true';

        try {
            const j = parseJson(await httpText(url, {
                headers: { Authorization: 'bearer ' + token }
            }), '目录接口');
            const item = j[catalogItemId];
            if (!item) return null;
            return item.title
                || (item.mainGameItem && item.mainGameItem.title)
                || null;
        } catch (e) {
            return null;
        }
    }

    // ── 并发池 ──────────────────────────────────────────────────────────────
    async function pool(items, limit, worker) {
        let idx = 0;
        const runners = [];
        const n = Math.min(limit, items.length);
        for (let k = 0; k < n; k++) {
            runners.push((async function () {
                while (true) {
                    const i = idx++;
                    if (i >= items.length) return;
                    await worker(items[i], i);
                }
            })());
        }
        await Promise.all(runners);
    }

    // ── 主流程 ──────────────────────────────────────────────────────────────
    async function runExport() {
        state.running = true;
        state.result = null;
        enableDownloads(false);
        startTicker();

        try {
            ui.log('获取授权码…');
            ui.progress(2, '获取授权码');
            const code = await fetchAuthCode();

            ui.log('换取访问令牌…');
            ui.progress(6, '换取令牌');
            const tok = await exchangeToken(code);
            const token = tok.access_token;
            const accountId = tok.account_id;

            ui.log('读取游戏库…');
            ui.progress(10, '读取游戏库');
            const lib = await fetchLibrary(token);

            ui.log('读取权益记录…');
            ui.progress(22, '读取权益');
            const ents = await fetchEntitlements(token, accountId);

            // 按 namespace 归组：同一游戏的多个条目（多平台 / 多 cid）合并为一条
            const groups = new Map();
            for (const r of lib) {
                if (!r || !r.namespace) continue;
                if (!groups.has(r.namespace)) groups.set(r.namespace, []);
                groups.get(r.namespace).push(r);
            }

            const list = Array.from(groups.keys());
            ui.log('解析游戏名（共 ' + list.length + ' 个）…');

            const entByNs = new Map();
            for (const e of ents) {
                if (!e || !e.namespace) continue;
                entByNs.set(e.namespace, (entByNs.get(e.namespace) || 0) + 1);
            }

            const games = [];
            let done = 0;
            const parseStart = Date.now();

            await pool(list, CONCURRENCY, async function (ns) {
                const rows = groups.get(ns);
                const first = rows[0];
                const cid = (rows.find(function (r) { return r.catalogItemId; }) || {}).catalogItemId || null;

                let title = null;
                if (cid) title = await resolveTitle(token, ns, cid);

                const dates = rows.map(function (r) { return r.acquisitionDate; })
                    .filter(Boolean).sort();
                const platforms = new Set();
                for (const r of rows) {
                    for (const p of (r.platform || [])) platforms.add(p);
                }

                games.push({
                    name: title || first.sandboxName || ns,
                    namespace: ns,
                    catalogItemId: cid,
                    productId: first.productId || null,
                    sandboxName: first.sandboxName || null,
                    platforms: Array.from(platforms).sort(),
                    acquiredAt: dates[0] || null,
                    recordCount: rows.length,
                    entitled: entByNs.has(ns),
                    resolved: !!title
                });

                done++;
                // 每个都推一次：426 个任务下若每 10 个才更新，界面会静默两秒以上
                ui.progress(22 + Math.round(done / list.length * 76),
                    '解析游戏名 ' + done + '/' + list.length);
                if (done % 20 === 0 || done === list.length) {
                    // 速率只算解析阶段本身，不要把取码/读库/读权益的时间摊进来
                    const sec = (Date.now() - parseStart) / 1000;
                    ui.log('  已解析 ' + done + '/' + list.length
                        + '，用时 ' + sec.toFixed(1) + 's'
                        + (done >= 20 && sec > 0.2 ? '（约 ' + (done / sec).toFixed(1) + ' 个/秒）' : ''));
                }
            });

            games.sort(function (a, b) {
                return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
            });

            const stamps = games.map(function (g) { return g.acquiredAt; })
                .filter(Boolean).sort();

            state.result = {
                schemaVersion: SCHEMA_VERSION,
                source: 'epic-library-service',
                generatedAt: new Date().toISOString(),
                account: {
                    accountId: accountId || null,
                    displayName: tok.displayName || null
                },
                summary: {
                    gameCount: games.length,
                    recordCount: lib.length,
                    entitlementCount: ents.length,
                    unresolvedCount: games.filter(function (g) { return !g.resolved; }).length,
                    firstAcquiredAt: stamps[0] || null,
                    lastAcquiredAt: stamps[stamps.length - 1] || null
                },
                games: games
            };

            ui.progress(100, '完成');
            const totalSec = ((Date.now() - state.startedAt) / 1000).toFixed(1);
            stopTicker();
            ui.elapsed(Number(totalSec));
            ui.log('✓ 导出完成：' + games.length + ' 款游戏，共 ' + totalSec + 's');
            enableDownloads(true);
        } catch (err) {
            const msg = (err && err.message) ? err.message : String(err);
            stopTicker();
            ui.log('✗ 失败：' + msg);
            ui.progress(0, '失败');
        } finally {
            state.running = false;
            stopTicker();
        }
    }

    // ── 输出 ────────────────────────────────────────────────────────────────
    function download(filename, text, mime) {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    function baseName() {
        const r = state.result;
        const who = (r && r.account && r.account.displayName) ? r.account.displayName : 'epic';
        const day = new Date().toISOString().slice(0, 10);
        return 'epic-library-' + who.replace(/[^\w\u4e00-\u9fa5-]+/g, '_') + '-' + day;
    }

    function exportJson() {
        if (!state.result) return;
        download(baseName() + '.json', JSON.stringify(state.result, null, 2), 'application/json');
    }

    function csvCell(v) {
        const s = (v === null || v === undefined) ? '' : String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function exportCsv() {
        if (!state.result) return;
        const head = ['gameName', 'platforms', 'acquiredAt', 'namespace',
            'catalogItemId', 'productId', 'sandboxName', 'inLibraryRecords', 'entitled'];
        const lines = [head.join(',')];
        for (const g of state.result.games) {
            lines.push([
                g.name,
                (g.platforms || []).join('|'),
                g.acquiredAt || '',
                g.namespace,
                g.catalogItemId || '',
                g.productId || '',
                g.sandboxName || '',
                g.recordCount,
                g.entitled ? 'yes' : 'no'
            ].map(csvCell).join(','));
        }
        // BOM 让 Excel 正确识别 UTF-8
        download(baseName() + '.csv', '\uFEFF' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    }

    // ── 界面 ────────────────────────────────────────────────────────────────
    const ui = (function () {
        let root, panel, statusEl, elapsedEl, barEl, logEl, btnRun, btnJson, btnCsv;

        function inject() {
            root = document.createElement('div');
            root.id = 'epic-export-root';
            root.style.cssText = 'position:fixed;inset:auto 0 0 auto;z-index:2147483647;';

            root.innerHTML = ''
                + '<style>'
                + '#epic-export-root *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}'
                + '#epic-export-fab{position:fixed;right:18px;bottom:18px;padding:10px 16px;border:0;border-radius:22px;'
                + 'background:#0074e4;color:#fff;font-size:13px;font-weight:600;cursor:pointer;'
                + 'box-shadow:0 4px 16px rgba(0,0,0,.35);transition:transform .12s}'
                + '#epic-export-fab:hover{transform:translateY(-1px)}'
                + '#epic-export-panel{position:fixed;right:18px;bottom:68px;width:340px;display:none;'
                + 'background:#12161c;color:#e6e9ee;border-radius:12px;padding:16px;'
                + 'box-shadow:0 12px 40px rgba(0,0,0,.55);border:1px solid #232a33}'
                + '#epic-export-panel h3{margin:0 0 4px;font-size:15px;font-weight:700}'
                + '#epic-export-panel .sub{font-size:11px;color:#7d8896;margin-bottom:12px;line-height:1.5}'
                + '#epic-export-statusrow{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}'
                + '#epic-export-status{font-size:12px;color:#9aa5b1;flex:1;min-height:16px;'
                + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
                + '#epic-export-elapsed{font-size:12px;color:#5d6875;font-variant-numeric:tabular-nums;'
                + 'min-width:46px;text-align:right}'
                + '#epic-export-track{height:4px;background:#232a33;border-radius:2px;overflow:hidden;margin-bottom:12px}'
                + '#epic-export-bar{height:100%;width:0;background:#0074e4;transition:width .25s}'
                + '#epic-export-log{font-size:11px;color:#6f7b89;line-height:1.6;max-height:96px;overflow:auto;'
                + 'margin-bottom:12px;white-space:pre-wrap;word-break:break-all}'
                + '#epic-export-root button.act{width:100%;padding:9px;border:0;border-radius:7px;'
                + 'font-size:13px;font-weight:600;cursor:pointer;margin-bottom:8px}'
                + '#epic-export-run{background:#0074e4;color:#fff}'
                + '#epic-export-run:disabled{background:#2a3340;color:#5d6875;cursor:not-allowed}'
                + '#epic-export-row{display:flex;gap:8px}'
                + '#epic-export-row button{flex:1;padding:9px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:#1a212a;color:#cfd6df;font-size:12px;font-weight:600;cursor:pointer}'
                + '#epic-export-row button:disabled{opacity:.35;cursor:not-allowed}'
                + '</style>'
                + '<button id="epic-export-fab">Epic 库存导出</button>'
                + '<div id="epic-export-panel">'
                + '  <h3>Epic 库存导出</h3>'
                + '  <div class="sub">读取真实游戏库存（含从未产生订单的入库记录），不上传任何数据。</div>'
                + '  <div id="epic-export-statusrow">'
                + '    <div id="epic-export-status">就绪</div>'
                + '    <div id="epic-export-elapsed"></div>'
                + '  </div>'
                + '  <div id="epic-export-track"><div id="epic-export-bar"></div></div>'
                + '  <div id="epic-export-log"></div>'
                + '  <button id="epic-export-run" class="act">开始导出</button>'
                + '  <div id="epic-export-row">'
                + '    <button id="epic-export-json" disabled>下载 JSON</button>'
                + '    <button id="epic-export-csv" disabled>下载 CSV</button>'
                + '  </div>'
                + '</div>';

            document.body.appendChild(root);

            panel = root.querySelector('#epic-export-panel');
            statusEl = root.querySelector('#epic-export-status');
            elapsedEl = root.querySelector('#epic-export-elapsed');
            barEl = root.querySelector('#epic-export-bar');
            logEl = root.querySelector('#epic-export-log');
            btnRun = root.querySelector('#epic-export-run');
            btnJson = root.querySelector('#epic-export-json');
            btnCsv = root.querySelector('#epic-export-csv');

            root.querySelector('#epic-export-fab').addEventListener('click', function () {
                panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
            });
            btnRun.addEventListener('click', function () {
                if (state.running) return;
                btnRun.disabled = true;
                runExport().then(function () { btnRun.disabled = false; });
            });
            btnJson.addEventListener('click', exportJson);
            btnCsv.addEventListener('click', exportCsv);
        }

        return {
            mount: inject,
            progress: function (pct, label) {
                if (barEl) barEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
                if (statusEl && label) statusEl.textContent = label;
            },
            elapsed: function (sec) {
                if (elapsedEl) elapsedEl.textContent = sec >= 0 ? sec.toFixed(1) + 's' : '';
            },
            log: function (line) {
                if (!logEl) return;
                logEl.textContent = line + '\n' + logEl.textContent;
                logEl.scrollTop = 0;
            },
            setDownloads: function (on) {
                if (btnJson) btnJson.disabled = !on;
                if (btnCsv) btnCsv.disabled = !on;
            }
        };
    })();

    function enableDownloads(on) { ui.setDownloads(on); }

    // 计时器：独立于请求进度，每 100ms 刷新一次已用秒数。
    // 目的不是精确计时，而是让用户看到界面在动——网络慢时秒数仍在走，不会误以为卡死。
    function startTicker() {
        stopTicker();
        state.startedAt = Date.now();
        ui.elapsed(0);
        state.ticker = setInterval(function () {
            ui.elapsed((Date.now() - state.startedAt) / 1000);
        }, 100);
    }

    function stopTicker() {
        if (state.ticker) {
            clearInterval(state.ticker);
            state.ticker = null;
        }
    }

    // ── 启动 ────────────────────────────────────────────────────────────────
    function boot() {
        if (document.getElementById('epic-export-root')) return;
        ui.mount();
        ui.progress(0, '就绪');
        ui.log('已就绪。确认已登录 Epic 后点「开始导出」。');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
