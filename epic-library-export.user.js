// ==UserScript==
// @name         Epic 库存导出
// @name:en      Epic Library Export
// @namespace    https://github.com/1959771708/epic-library-export
// @version      1.5.2
// @description  导出 Epic 账号的完整游戏库存（含从未产生订单的入库记录），输出 JSON 供第三方工具导入
// @description:en  Export your complete Epic Games library, including titles that never produced an order.
// @author       1959771708
// @license      CC-BY-4.0
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

    // 实测（真实账号 426 款 / 559 条权益 / 532 条库记录），浏览器里 GM 请求的形态
    // 与 Node 直连完全不同，不能照搬 Node 调参结果：
    //   1) Node 直连 catalog 单请求 0.27s，页面内 fetch 打同一主机 0.28s，
    //      但脚本里的 GM 请求单次要 6~7s——固定开销在 GM 这条链路上，不在 Epic。
    //   2) 曾以为「波数 × 单次延迟」是模型，于是把读库压成单波、并把读库与读权益并行。
    //      浏览器实测证伪：该版总 41.9s，比原 40.4s 还慢。并行后读权益从 9.1s 涨到 24.0s，
    //      并行没省任何时间——GM 是一条总容量固定的管道，切开只是换了个分配方式。
    //   3) 各阶段的瓶颈并不相同，不能用单一模型套：
    //      · 权益：6 请求 334KB / 9.1s ≈ 37KB/s —— 字节量主导，压请求数没用；
    //      · 目录：15 请求仅 155KB / 12.5s ≈ 0.85s/请求 —— 请求数主导，与字节无关。
    //      所以只有目录这一段的请求数值得压，读库与权益保持串行不动。
    const CATALOG_BATCH = 30;
    const CATALOG_WAVE = 20;
    const ENT_PAGE = 100;
    const ENT_WAVE = 6;
    const SCHEMA_VERSION = 1;

    const state = { running: false, result: null, startedAt: 0, label: '', ticker: null };

    // ── 网络层 ──────────────────────────────────────────────────────────────
    function shortUrl(u) {
        return String(u).replace(/^https?:\/\//, '').slice(0, 60);
    }

    // 只有「数字且在 2xx」才算成功。这里必须显式判断 typeof：
    // 残缺的脚本管理器（部分浏览器自带的「油猴」实现）会立刻回一个没有 status 字段的
    // 响应对象，而 `undefined < 200` 与 `undefined >= 300` 同时为 false，旧写法会放行，
    // 最终报成「返回非 JSON（可能被反爬拦截）」——把用户引到反爬这个错误方向上排查。
    function okStatus(st) {
        return typeof st === 'number' && st >= 200 && st < 300;
    }

    function httpFailure(res, url) {
        const st = res && res.status;
        if (typeof st === 'number' && st >= 100 && st <= 599) {
            const err = new Error('HTTP ' + st + ' · ' + shortUrl(url));
            err.status = st;
            return err;
        }
        if (typeof st === 'number' && st <= 0) {
            return networkError('网络请求失败（status ' + st + '）', url);
        }
        // 环境性失败：同一次点击里连发几次结果完全相同，重试只是白等，故标记为不可重试
        const err = new Error('没拿到 HTTP 响应（响应对象里没有 status）· ' + shortUrl(url)
            + ' · 两条 GM 通道都拿不到响应，点面板里的「环境自检」看详情');
        err.status = undefined;
        err.envProblem = true;
        return err;
    }

    // GM4 是否「真的」能用。XMonkey 1.2.7 实测：GM.xmlHttpRequest 是函数、调用也不抛，
    // 但返回的 Promise 解出来是 undefined —— 存在不等于可用，只能靠一次真实请求证明。
    // 探测失败后记在这里，后续请求直接走旧版接口，不再每次白试一遍。
    let gm4Broken = false;

    function hasGm4() {
        try {
            return typeof GM !== 'undefined' && !!GM && typeof GM.xmlHttpRequest === 'function';
        } catch (e) { return false; }
    }

    function hasLegacy() {
        return typeof GM_xmlhttpRequest === 'function';
    }

    // 网络层失败：请求发出去了但没拿到响应。这类错误不标 envProblem ——
    // 换通道重打会走同一条网络，重试本身交给 httpText 判断。
    function networkError(what, url) {
        const err = new Error(what + ' · ' + shortUrl(url));
        err.status = undefined;
        return err;
    }

    // GM4 名义上回 Promise，但不是所有管理器都真实现了 Promise 通道：
    // XMonkey 1.2.7 实测就是「函数在、调用不抛、Promise 解出来是 undefined」。
    // 所以这里同时挂回调和等 Promise，谁先拿到真响应就用谁 —— 少赌一种实现方式。
    function gm4Request(cfg, url) {
        return new Promise(function (resolve, reject) {
            let settled = false;
            let graceTimer = null;
            let finalTimer = null;

            function clearTimers() {
                if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
                if (finalTimer) { clearTimeout(finalTimer); finalTimer = null; }
            }
            function finish(fn, v) {
                if (settled) return;
                settled = true;
                clearTimers();
                fn(v);
            }
            function settle(r) {
                if (!okStatus(r && r.status)) return finish(reject, httpFailure(r, url));
                finish(resolve, r.responseText);
            }

            const timeoutMs = cfg.timeout || 15000;
            // 最后一道保险：不管管理器怎么实现，都不让 Promise 永远悬着。
            finalTimer = setTimeout(function () {
                finish(reject, networkError('请求超时', url));
            }, timeoutMs + 1000);

            let p;
            try {
                p = GM.xmlHttpRequest(Object.assign({}, cfg, {
                    onload: function (r) { settle(r); },
                    onerror: function () { finish(reject, networkError('网络错误', url)); },
                    ontimeout: function () { finish(reject, networkError('请求超时', url)); }
                }));
            } catch (e) {
                finish(reject, e);
                return;
            }

            if (p && typeof p.then === 'function') {
                p.then(function (r) {
                    if (okStatus(r && r.status)) return finish(resolve, r.responseText);
                    if (settled) return;
                    // Promise 解出一个没有 status 的东西（XMonkey 就是这个行为）。
                    // 注意这里不能等太久：Promise 已经 resolve，说明管理器认为请求结束了，
                    // 它不会在若干秒后再补一个响应。给个短宽限只是防「先 resolve、回调紧随其后」
                    // 的实现顺序，等不到就是真没拿到响应 —— 判成环境问题，好让上层换通道。
                    // （GM 链路 6~7s 的固定开销发生在 resolve 之前，由下面的 finalTimer 兜底。）
                    graceTimer = setTimeout(function () { settle(r); }, 500);
                }, function (e) { finish(reject, e); });
            }
        });
    }

    function legacyRequest(cfg, url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest(Object.assign({}, cfg, {
                onload: function (r) {
                    if (okStatus(r.status)) return resolve(r.responseText);
                    reject(httpFailure(r, url));
                },
                onerror: function () { reject(networkError('网络错误', url)); },
                ontimeout: function () { reject(networkError('请求超时', url)); }
            }));
        });
    }

    // 单次请求（不带重试）
    function httpOnce(cfg, url) {
        const canGm4 = hasGm4() && !gm4Broken;
        const canLegacy = hasLegacy();

        if (canGm4) {
            let p;
            try {
                p = gm4Request(cfg, url);
            } catch (e) {
                // 调用即抛（同步失败）：有旧版接口就走兜底，否则原样抛
                if (!canLegacy) throw e;
                p = Promise.reject(e);
            }
            if (!canLegacy) return p;
            return p.catch(function (e) {
                // 只有「一个 status 都没拿到」才换通道。真实状态码（401/500…）是服务端答复，
                // 换接口重打只会重复请求，不该发生。
                if (!(e && e.envProblem)) throw e;
                gm4Broken = true;   // 记住：这台机器的 GM4 不能用
                return legacyRequest(cfg, url);
            });
        }

        if (canLegacy) return legacyRequest(cfg, url);

        const err = new Error('未检测到 GM_xmlhttpRequest，请确认脚本由 Tampermonkey 运行');
        err.envProblem = true;   // 同样是环境问题，重试无意义
        throw err;
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
                // envProblem（响应对象里根本没有 status）是脚本管理器能力问题，不是网络抖动：
                // 同一环境下每次结果完全一样，重试只会让用户多等 900ms 左右，直接抛出。
                const retryable = !(e && e.envProblem) && (st === 429 || st === 500 || st === 502 ||
                    st === 503 || st === 504 || st === undefined);
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

    // 剥掉目录标题里的书名号。Epic 中文目录会给一部分游戏名套上《》（实测 426 款里 43 条），
    // 这是服务端返回的原文，不是脚本加的；原样写进 JSON 会让按名字对账的第三方工具多一层噪音。
    // 不含书名号的标题原样返回，一个字都不动。
    function stripBookTitle(value) {
        if (typeof value !== 'string') return value;
        if (value.indexOf('\u300A') === -1 && value.indexOf('\u300B') === -1) return value;

        // 1) 书名号整对从开头包住主标题、版本后缀落在外面时，补一个空格（《X》年度版 → X 年度版）。
        //    否则会黏成「X年度版」，与「art of rally Standard Edition」风格不一致。
        // 2) 其余情况（行内书名号、只有半边）只删字符不补空格，避免插出「左中 右」。
        // 两边都保留一个兜底：剥完变空就用只删不补的结果，再空就退回原文。
        const spaced = value.replace(/\u300B/g, ' ').replace(/\u300A/g, ' ').replace(/\s+/g, ' ').trim();
        const bare = value.replace(/[\u300A\u300B]/g, '').replace(/\s+/g, ' ').trim();
        const looksWrapped = /^\s*\u300A/.test(value);
        return (looksWrapped ? spaced : bare) || bare || value;
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
            try {
                const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
                if (!r.ok) throw new Error('取授权码失败 HTTP ' + r.status);
                text = await r.text();
            } catch (fetchErr) {
                // 同源 fetch 抛出网络异常（如 Failed to fetch）时，尝试走 GM 通道兜底；
                // 若两条路都连不上，则明确提示检查网络/代理或浏览器拦截规则。
                if (fetchErr && /^取授权码失败 HTTP /.test(fetchErr.message || '')) throw fetchErr;
                try {
                    text = await httpText(url, {
                        headers: { Accept: 'application/json' },
                        anonymous: false
                    });
                } catch (gmErr) {
                    if (gmErr && gmErr.envProblem) throw gmErr;
                    const fMsg = (fetchErr && fetchErr.message) || String(fetchErr);
                    const gMsg = (gmErr && gmErr.message) || String(gmErr);
                    throw new Error('无法连接 Epic 授权接口（' + fMsg + '；' + gMsg + '），请检查网络/代理或关闭浏览器广告拦截');
                }
            }
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
        // 首屏与推测页同波发出。cursor 只是 base64({"offset":N})，而实测分页步长恒为 100
        // （真实账号 6 页的 nextCursor 依次是 100/200/300/400/500），所以不必等首屏回来
        // 就能把后续页先发出去——这一改把读库从「首屏一波 + 并发一波」压成单波。
        // 首屏回来后必须校验步长：不等 100 说明推测无效，丢弃在途结果走派生式翻页。
        const PREDICT_STEP = 100;
        const PREDICT_PAGES = 6;

        // 每页都包成 { ok, off, records }：失败与「越界」必须区分。
        // 实测越界页（off=600/700/1000/5000）都是 HTTP 200 + 空数组（87B），
        // 所以只有 ok=false 才是真失败，绝不能让失败冒充「到底了」把后面的数据截断。
        function pageAt(off) {
            return fetchLibraryPage(token, makeCursor(off)).then(function (j) {
                return { ok: true, off: off, records: j.records || [] };
            }, function () {
                return { ok: false, off: off, records: [] };
            });
        }

        const predicted = [];
        for (let k = 1; k <= PREDICT_PAGES; k++) predicted.push(pageAt(k * PREDICT_STEP));

        const first = await fetchLibraryPage(token, null);
        const records = (first.records || []).slice();
        const firstCursor = (first.responseMetadata && first.responseMetadata.nextCursor) || null;

        if (!firstCursor) {
            await Promise.all(predicted);   // 收掉在途请求，不留悬空
            return records;
        }

        const step = decodeCursorOffset(firstCursor);

        function collect(settled) {
            // 逐页按 offset 升序追加；越界页是 200 + 空数组，天然终止。
            // 失败页不能当成终止信号：记录下来，由调用方补一次串行重试。
            let lastCount = null;
            for (let k = 0; k < settled.length; k++) {
                const r = settled[k];
                if (!r) continue;
                if (!r.ok) { failed.push(r.off); continue; }
                if (r.records.length) records.push.apply(records, r.records);
                lastCount = r.records.length;
            }
            return lastCount;
        }

        const failed = [];

        // 失败的页按 offset 升序串行补一次：量少（正常为 0），失败时宁可慢也不能丢数据
        async function fillFailed() {
            if (!failed.length) return;
            failed.sort(function (a, b) { return a - b; });
            const retry = failed.splice(0, failed.length);
            let capped = null;      // 补页时发现的长库尾部
            for (const off of retry) {
                try {
                    const j = await fetchLibraryPage(token, makeCursor(off));
                    const batch = j.records || [];
                    if (batch.length) records.push.apply(records, batch);
                    if (batch.length >= PREDICT_STEP) capped = off;
                } catch (e) {
                    // 二次失败：把缺页如实报出来，不静默吞掉
                    ui.log('  ⚠ 游戏库第 ' + (off / PREDICT_STEP + 1) + ' 页两次失败，该页条目缺失');
                }
            }
            return capped;
        }

        // 推测成立：推测页已经在途，直接收回来
        if (step === PREDICT_STEP) {
            const settled = await Promise.all(predicted);
            let lastCount = collect(settled);

            // 补页时若补回一页满页，说明库比预测的更长，仍要走追加翻页
            const capped = await fillFailed();
            if (capped !== null && capped !== undefined) lastCount = PREDICT_STEP;

            // 预测的最后一页仍是满页 → 账号库比预测的更长，继续派生式往下翻（少见）
            if (lastCount !== null && lastCount >= PREDICT_STEP) {
                let base = (PREDICT_PAGES + 1) * PREDICT_STEP;
                for (let wave = 0; wave < 40; wave++) {
                    const offsets = [];
                    for (let k = 0; k < 6; k++) offsets.push(base + k * PREDICT_STEP);
                    const got = await Promise.all(offsets.map(pageAt));
                    got.sort(function (a, b) { return a.off - b.off; });
                    for (const r of got) {
                        if (!r.ok) { failed.push(r.off); continue; }
                        if (r.records.length) records.push.apply(records, r.records);
                    }
                    // 只有「成功且为空」才算越界到底；失败页不构成终止条件
                    const emptyHit = got.some(function (r) { return r.ok && r.records.length === 0; });
                    if (emptyHit) break;
                    base += 6 * PREDICT_STEP;
                }
                await fillFailed();
            }
            return records;
        }

        // 推测不成立：丢弃在途结果，按首屏给出的真实步长派生
        await Promise.all(predicted);

        // 步长解不出就走串行，避免把接口语义猜错
        if (!step || step <= 0) {
            let cursor = firstCursor;
            for (let page = 0; page < 200; page++) {
                let j = null;
                try {
                    j = await fetchLibraryPage(token, cursor);
                } catch (e) {
                    // 串行是兜底路径，失败就如实报出来，不假装到底
                    ui.log('  ⚠ 游戏库翻页在第 ' + (page + 1) + ' 页失败，后续条目缺失');
                    break;
                }
                const batch = j.records || [];
                records.push.apply(records, batch);
                const next = (j.responseMetadata && j.responseMetadata.nextCursor) || null;
                if (!next || batch.length === 0) break;
                cursor = next;
            }
            return records;
        }

        // 并发：按步长分批拉；只有「成功且为空」才是越界到底
        const BATCH = 6;
        let base = step;
        for (let wave = 0; wave < 40; wave++) {
            const offsets = [];
            for (let k = 0; k < BATCH; k++) offsets.push(base + k * step);

            const got = await Promise.all(offsets.map(pageAt));
            got.sort(function (a, b) { return a.off - b.off; });
            for (const r of got) {
                if (!r.ok) { failed.push(r.off); continue; }
                if (r.records.length) records.push.apply(records, r.records);
            }
            if (got.some(function (r) { return r.ok && r.records.length === 0; })) break;
            base += BATCH * step;
        }
        await fillFailed();
        return records;
    }

    // 第 4 步：权益记录（用来确认条目确实在账号里且为 ACTIVE）
    async function fetchEntitlements(token, accountId) {
        // 实测（559 条 / 334KB）：只要 1 个请求时慢得反常——服务端 0.76s 就回了首字节，
        // 剩下 6.5s 全耗在单连接收数据上。拆成 count=100 的六页并发只要 2.2s，
        // 总字节数与条数和单请求写法完全一致。故改成分页并发。
        const out = [];

        for (let wave = 0; wave < 40; wave++) {
            const starts = [];
            for (let k = 0; k < ENT_WAVE; k++) starts.push((wave * ENT_WAVE + k) * ENT_PAGE);

            const got = [];
            await pool(starts, ENT_WAVE, async function (start) {
                const url = ENTITLEMENT_HOST + '/entitlement/api/account/'
                    + encodeURIComponent(accountId)
                    + '/entitlements?start=' + start + '&count=' + ENT_PAGE;

                const j = parseJson(await httpText(url, {
                    headers: { Authorization: 'bearer ' + token }
                }), '权益接口');

                got.push({ start: start, batch: Array.isArray(j) ? j : [] });
            });

            // 并发回来的顺序不定，按 start 排回来，保证输出顺序与旧写法一致
            got.sort(function (a, b) { return a.start - b.start; });
            for (const r of got) {
                if (r.batch.length) out.push.apply(out, r.batch);
            }
            // 只要这一波里有任何一页没填满，就说明已经越过末尾
            if (got.some(function (r) { return r.batch.length < ENT_PAGE; })) break;
        }
        return out;
    }

    // 第 4~5 步（快路径）：用商城同源 GraphQL 一次取回整个游戏库，含平台与标题。
    // 实测（浏览器内真实账号，532 条 / 426 个 namespace）：
    //   · 一次请求带 12 个分页别名 → 1.9s / 214KB，记录条数与 REST 库接口逐页一致
    //     （105/113/82/64/108/60 后全 0）；而走 GM 要 7 个库请求（16.0s）+ 1 个目录请求（1.7s）。
    //   · cursor 就是 base64 的 offset（"MA=="=0、"MTAw"=100），与 REST 库接口的分页语义一致；
    //     越界页返回空数组（p6~p11 实测全 0 条），多带几页别名不增加服务端成本。
    //   · 同源请求不经过 GM 通道，没有 GM 那 6~7s 的单请求固定开销。
    //
    // platforms 的来源（这是以前必须留在 REST 的原因，现已解决）：
    //   LibraryItem 自身没有 platform 字段，但 catalogItem.releaseInfo[].platform 就是平台数组，
    //   与 REST 库记录的 platform 逐条一致。532 条 "namespace|cid|排序后的平台" 的 SHA256
    //   两侧同为 d5f9f5cc…12df1；426 个 namespace 的平台并集摘要两侧同为 08b4ac65…1b56，
    //   平台组合分布也完全相同（269 Windows / 60 Win32+Windows / 56 Mac+Windows / …）。
    //   实测 532 条里多 releaseInfo 的条目为 0，故取首项与取并集结果一致。
    //
    // locale 必须写在子字段上：libraryItems 不接受 locale 参数（Unknown argument），
    // 只有 catalogItem(locale: "en-US") 有效。
    //
    // 用 en-US 而不是 zh-CN，是为了让导出的 name 全是英文原名。实测同一批 426 个
    // catalogItemId 在两个 locale 下的标题：
    //   zh-CN：含汉字 44 条、含书名号 43 条、含非 ASCII 93 条
    //   en-US：含汉字 0 条、含书名号 0 条、含非 ASCII 18 条
    // en-US 剩下的非 ASCII 都是英文原名自带的商标符号与破折号
    // （™ ×15、® ×4、– ×2、’ ×1、🍜 ×1），去不掉也不该去。
    // 两个 locale 标题相同 346 条、不同 80 条，无仅单侧存在的条目。
    async function fetchLibraryGraphql() {
        const PAGES = 12;
        const STEP = 100;

        const aliases = [];
        for (let i = 0; i < PAGES; i++) {
            aliases.push('p' + i + ': libraryItems(cursor: "' + btoa(String(i * STEP)) + '")'
                + ' { records { namespace catalogItemId productId appName sandboxName sandboxType'
                + ' acquisitionDate recordType'
                + ' catalogItem(locale: "en-US") { title releaseInfo { platform } } } }');
        }
        const query = 'query Q { Library { ' + aliases.join(' ') + ' } }';

        const res = await fetch('/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ query: query })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);

        const j = await res.json();
        if (j && j.errors && j.errors.length) {
            throw new Error(j.errors[0].message || 'GraphQL 返回错误');
        }
        const lib = j && j.data && j.data.Library;
        if (!lib) throw new Error('响应里没有 Library');

        // 还原成与 REST 库接口同形的记录，下游分组逻辑不必改动
        const records = [];
        const titles = new Map();
        for (let i = 0; i < PAGES; i++) {
            const page = lib['p' + i];
            if (!page || !page.records) continue;
            for (const r of page.records) {
                const item = r.catalogItem || null;
                const platforms = new Set();
                if (item && item.releaseInfo) {
                    for (const rel of item.releaseInfo) {
                        for (const p of (rel.platform || [])) platforms.add(p);
                    }
                }
                if (r.catalogItemId && item && item.title) titles.set(r.catalogItemId, item.title);
                records.push({
                    namespace: r.namespace,
                    catalogItemId: r.catalogItemId,
                    productId: r.productId,
                    appName: r.appName,
                    sandboxName: r.sandboxName,
                    sandboxType: r.sandboxType,
                    acquisitionDate: r.acquisitionDate,
                    recordType: r.recordType,
                    platform: Array.from(platforms)
                });
            }
        }
        if (!records.length) throw new Error('GraphQL 返回 0 条库记录');
        return { records: records, titles: titles };
    }

    // 第 5 步（兜底）：批量把 catalogItemId 解析成真实游戏名（库里的 sandboxName 常是代号）
    // 实测（真实账号 426 款，四轮交错 A/B）：
    //   - 跨 namespace 的 /catalog/api/shared/bulk/items 可用，参数是重复的 id=（逗号形式返回空对象）
    //   - 单请求带上 300 个 id 仍正常，故按 CATALOG_BATCH 分批
    //   - includeDLCDetails=true 让响应体积涨 7.7 倍、耗时涨 4.3 倍；426 款逐条比对过，
    //     带与不带该参数取到的标题完全一致（426 一致 / 0 不一致 / 0 取不到），故不再带
    //   426 款：单条 24 并发 7.0s → 批量 1.9s，下载量 4.63MB → 0.87MB
    // 返回 cid → title 的映射；取不到的条目不会进 Map，调用方回退到 sandboxName
    async function fetchCatalogTitles(token, ids) {
        const titles = new Map();
        const stats = { batches: 0, failedBatches: 0 };
        if (!ids.length) return { titles: titles, stats: stats };

        const chunks = [];
        for (let i = 0; i < ids.length; i += CATALOG_BATCH) {
            chunks.push(ids.slice(i, i + CATALOG_BATCH));
        }
        stats.batches = chunks.length;

        let done = 0;
        // 分波：每波最多 CATALOG_WAVE 个批次并发，避免一次性把 400+ 个请求全推出去
        for (let i = 0; i < chunks.length; i += CATALOG_WAVE) {
            const wave = chunks.slice(i, i + CATALOG_WAVE);

            await pool(wave, CATALOG_WAVE, async function (chunk) {
                const q = chunk.map(function (id) { return 'id=' + encodeURIComponent(id); }).join('&');
                const url = CATALOG_HOST + '/catalog/api/shared/bulk/items?' + q
                    + '&country=US&locale=en-US';

                let j = null;
                try {
                    j = parseJson(await httpText(url, {
                        headers: { Authorization: 'bearer ' + token }
                    }), '目录接口');
                } catch (e) {
                    // 单批失败不拖垮整体，但要计数并报给调用方，不能静默降级
                    j = null;
                    stats.failedBatches++;
                }

                if (j) {
                    for (const id of chunk) {
                        const item = j[id];
                        if (!item) continue;
                        const title = item.title
                            || (item.mainGameItem && item.mainGameItem.title)
                            || null;
                        if (title) titles.set(id, title);
                    }
                }

                done += chunk.length;
                // 批次是 30 个一跳，426 款共 15 跳，进度足够密，不必再额外做节流
                ui.progress(22 + Math.round(done / ids.length * 76),
                    '解析游戏名 ' + done + '/' + ids.length);
            });
        }
        return { titles: titles, stats: stats };
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

        // 分段计时：每个阶段结束时把耗时打进日志，避免"总耗时 40s 但不知道花在哪"
        let lapAt = Date.now();
        const stages = [];
        function lap(name) {
            const now = Date.now();
            const ms = now - lapAt;
            lapAt = now;
            stages.push({ name: name, ms: ms });
            return ms;
        }
        function lapLog(name) {
            lap(name);
            const s = (stages[stages.length - 1].ms / 1000).toFixed(1);
            ui.log('  · ' + name + ' ' + s + 's');
        }

        try {
            ui.log('获取授权码…');
            ui.progress(2, '获取授权码');
            const code = await fetchAuthCode();
            lapLog('获取授权码');

            ui.log('换取访问令牌…');
            ui.progress(6, '换取令牌');
            const tok = await exchangeToken(code);
            const token = tok.access_token;
            const accountId = tok.account_id;
            lapLog('换取令牌');

            // 读库优先走同源 GraphQL（1 个请求，约 1.9s，顺带拿全标题与平台）；
            // 不行再退回 GM 库接口（7 个请求，约 16.0s）。
            ui.log('读取游戏库…');
            ui.progress(10, '读取游戏库');
            let lib;
            let titles = null;
            try {
                const g = await fetchLibraryGraphql();
                lib = g.records;
                titles = g.titles;
                lapLog('读取游戏库（GraphQL ' + lib.length + ' 条）');
            } catch (e) {
                ui.log('  · GraphQL 不可用（' + ((e && e.message) || e) + '），改用库接口');
                lib = await fetchLibrary(token);
                lapLog('读取游戏库（' + lib.length + ' 条）');
            }

            ui.log('读取权益…');
            ui.progress(18, '读取权益');
            const ents = await fetchEntitlements(token, accountId);
            lapLog('读取权益（' + ents.length + ' 条）');

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
            const parseStart = Date.now();

            // 先把所有 catalogItemId 收齐一次性批量取标题，再组装；不要再在循环里逐条请求
            const allCids = [];
            for (const ns of list) {
                const rows = groups.get(ns);
                const cid = (rows.find(function (r) { return r.catalogItemId; }) || {}).catalogItemId || null;
                if (cid) allCids.push(cid);
            }

            // 标题通常已在读库时随 GraphQL 一并取到（同一个 catalogItem 子树，不额外花时间）。
            // 只有读库走了 GM 兜底时 titles 才是 null，这时用 GM 目录接口批量补标题。
            let catalogOut = null;
            if (!titles) {
                ui.progress(22, '解析游戏名');
                catalogOut = await fetchCatalogTitles(token, allCids);
                titles = catalogOut.titles;
                lapLog('解析游戏名（' + catalogOut.stats.batches + ' 批）');
            }
            if (catalogOut && catalogOut.stats.failedBatches > 0) {
                // 明确说出来，而不是让用户对着几个代号名猜
                ui.log('  ⚠ 有 ' + catalogOut.stats.failedBatches + ' / ' + catalogOut.stats.batches
                    + ' 批目录请求失败，对应游戏回退为沙盒名');
            }

            for (const ns of list) {
                const rows = groups.get(ns);
                const first = rows[0];
                // 同一个 namespace 下可能有多个 catalogItemId（38 组，典型是主游戏 + DLC/原声/壁纸，
                // 或者 iOS/Android 两条分平台记录）。这里取组内第一条，是按服务端返回顺序来的。
                // 实测这个顺序是稳定的：连续两次拉取 532 条，426 个 namespace 里 425 个的首条
                // catalogItemId 完全一致；唯一的例外是 4ff8a9b4…（《Faily Brakes 2》的 iOS 与 Android
                // 两条记录，acquisitionDate 只差 43 毫秒），而这两条的标题完全相同，所以导出内容不受影响。
                // 注：换过「最早获得」「cid 字典序」「标题最短」等确定性规则，都会把主游戏换成
                // 「HD Wallpaper」「Q.U.B.E. 2 Soundtrack」这类附加内容（8 个游戏会改名），故仍用组内首条。
                const cid = (rows.find(function (r) { return r.catalogItemId; }) || {}).catalogItemId || null;
                const title = cid ? (titles.get(cid) || null) : null;

                const dates = rows.map(function (r) { return r.acquisitionDate; })
                    .filter(Boolean).sort();
                const platforms = new Set();
                for (const r of rows) {
                    for (const p of (r.platform || [])) platforms.add(p);
                }

                games.push({
                    name: stripBookTitle(title) || first.sandboxName || ns,
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
            }

            const parseSec = (Date.now() - parseStart) / 1000;
            const resolvedCount = games.filter(function (g) { return g.resolved; }).length;
            ui.log('  已解析 ' + resolvedCount + '/' + games.length + ' 个标题，用时 ' + parseSec.toFixed(1) + 's');

            games.sort(function (a, b) {
                return String(a.name).localeCompare(String(b.name), 'en-US');
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
            ui.log('  分段：' + stages.map(function (s) {
                return s.name + ' ' + (s.ms / 1000).toFixed(1) + 's';
            }).join(' / '));
            enableDownloads(true);
        } catch (err) {
            const msg = (err && err.message) ? err.message : String(err);
            stopTicker();
            ui.log('✗ 失败：' + msg);
            ui.progress(0, '失败');
            // 环境性失败（响应里没有 status）不是重试能解决的，直接把判据摊开给用户看。
            // 手机上没有控制台，这段日志就是唯一的取证途径。
            if (err && err.envProblem) {
                runEnvCheck().catch(function () { });
            }
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

    // ── 环境自检 ────────────────────────────────────────────────────────────
    // 报错「HTTP undefined」时，唯一能把问题钉死在脚本管理器上的证据是「它到底给了
    // 我们什么」。所以自检不做判断，只把原始事实逐条打出来：管理器标识、GM4 / GM_
    // 两套 API 在不在、以及一次真实请求返回对象的字段清单。手机上看不到控制台，
    // 这些信息必须落在面板里。
    function envFacts() {
        const facts = [];
        let gm = null, info = null;
        try { if (typeof GM !== 'undefined' && GM) gm = GM; } catch (e) { /* 部分管理器访问即抛 */ }
        try { if (typeof GM_info !== 'undefined' && GM_info) info = GM_info; } catch (e) { }
        if (!info && gm && gm.info) info = gm.info;

        const handler = info && (info.scriptHandler || (info.script && info.script.name));
        const ver = info && info.version;
        facts.push('管理器：' + (handler
            ? handler + (ver ? ' ' + ver : '')
            : '读不到 GM_info（正常 Tampermonkey 会提供）'));
        facts.push('GM.xmlHttpRequest（GM4）：'
            + (gm && typeof gm.xmlHttpRequest === 'function' ? '可用' : '不可用'));
        facts.push('GM_xmlhttpRequest（旧版）：'
            + (typeof GM_xmlhttpRequest === 'function' ? '可用' : '不可用'));
        return facts;
    }

    // 探测一次真实请求。刻意不走 httpOnce：这里要看的就是原始响应对象本身，
    // 哪怕 status 缺失也要把对象交出来，而不是提前变成一句错误文案。
    // channel 决定走哪条既定的通道（'GM4' / 'GM_xmlhttpRequest'）。
    function probeOnce(url, channel) {
        return new Promise(function (resolve) {
            const cfg = { method: 'GET', url: url, timeout: 15000 };
            let done = false;
            function give(raw, via) {
                if (done) return;
                done = true;
                resolve({ raw: raw, via: via });
            }

            if (channel === 'GM4') {
                let p;
                // 必须和 httpOnce 里的 gm4Request 保持同一种调用形态：回调与 Promise 都挂。
                // 只等 Promise 会把「回调式实现」误报成坏通道，自检结论就和实际导出打架了。
                try {
                    p = GM.xmlHttpRequest(Object.assign({}, cfg, {
                        onload: function (r) { give(r, 'GM4 onload'); },
                        onerror: function (r) { give(r, 'GM4 onerror'); },
                        ontimeout: function (r) { give(r, 'GM4 ontimeout'); }
                    }));
                } catch (e) { give(e, 'GM4 同步抛错'); return; }

                if (p && typeof p.then === 'function') {
                    p.then(
                        function (res) { give(res, 'GM4'); },
                        function (e) { give(e, 'GM4 被拒绝'); });
                } else {
                    // 没回 Promise、回调也还没来：等一小会儿再下结论，别把回调式实现判死
                    setTimeout(function () {
                        give(p, p === undefined ? 'GM4 无返回（回调也没来）' : 'GM4 返回了非 Promise');
                    }, 1200);
                }
                return;
            }

            try {
                GM_xmlhttpRequest(Object.assign({}, cfg, {
                    onload: function (r) { give(r, 'GM_xmlhttpRequest'); },
                    onerror: function (r) { give(r, 'GM_xmlhttpRequest onerror'); },
                    ontimeout: function (r) { give(r, 'GM_xmlhttpRequest ontimeout'); }
                }));
            } catch (e) { give(e, 'GM_xmlhttpRequest 同步抛错'); }
        });
    }

    function describeRaw(raw) {
        if (raw instanceof Error) return '请求被拒绝：' + raw.message;
        if (raw === null || typeof raw !== 'object') return '响应对象：' + String(raw);

        const keys = Object.keys(raw);
        const out = ['响应对象字段：' + (keys.length ? keys.join(', ') : '(空)')];
        if ('status' in raw) {
            out.push('status = ' + JSON.stringify(raw.status) + '（类型 ' + typeof raw.status + '）');
        } else {
            out.push('status 字段不存在 ← 「HTTP undefined」就是这么来的');
        }
        if (typeof raw.responseText === 'string') out.push('responseText 长度 ' + raw.responseText.length);
        if (raw.statusText) out.push('statusText = ' + String(raw.statusText));
        if (raw.error) out.push('error = ' + String(raw.error));
        return out.join('\n    ');
    }

    async function runEnvCheck() {
        ui.progress(0, '环境自检中');
        ui.log('── 环境自检 ──');
        envFacts().forEach(function (f) { ui.log('    ' + f); });

        const url = 'https://www.epicgames.com/id/api/redirect'
            + '?clientId=' + CLIENT_ID + '&responseType=code';

        // 两条通道各打一次：这台机器上哪条真能用，只有实测说了算。
        // 存在 + 不报错 都不等于能用（XMonkey 1.2.7 的 GM4 就是函数在、Promise 解出来是 undefined）。
        const results = [];
        if (hasGm4()) {
            const got = await probeOnce(url, 'GM4');
            results.push({ name: 'GM4', got: got });
            ui.log('    探测 ' + shortUrl(url) + '（经 ' + got.via + '）');
            ui.log('    ' + describeRaw(got.raw));
        }
        if (hasLegacy()) {
            const got = await probeOnce(url, 'GM_xmlhttpRequest');
            results.push({ name: '旧版', got: got });
            ui.log('    探测 ' + shortUrl(url) + '（经 ' + got.via + '）');
            ui.log('    ' + describeRaw(got.raw));
        }

        function isNetCallback(r) {
            const via = r.got && r.got.via || '';
            return /onerror|ontimeout/.test(via);
        }
        function statusOf(r) {
            if (isNetCallback(r)) return null;
            const st = r.got && r.got.raw && r.got.raw.status;
            return (typeof st === 'number' && st >= 100 && st <= 599) ? st : null;
        }
        function isNetFailure(r) {
            if (isNetCallback(r)) return true;
            const st = r.got && r.got.raw && r.got.raw.status;
            return typeof st === 'number' && st <= 0;
        }
        const usable = results.filter(function (r) { return statusOf(r) !== null; });
        const netFailed = results.filter(function (r) { return statusOf(r) === null && isNetFailure(r); });
        const nameOf = function (n) { return n === 'GM4' ? 'GM.xmlHttpRequest（GM4）' : 'GM_xmlhttpRequest（旧版）'; };
        const gm4Failed = results.some(function (r) { return r.name === 'GM4' && statusOf(r) === null; });
        if (gm4Failed) gm4Broken = true;   // 与网络层的自动降级保持一致

        // 结论要说到「能不能导出」这个用户真正关心的问题上，而不是停在技术描述。
        let ok = false;
        if (!usable.length && netFailed.length) {
            const nf = netFailed[0];
            const rawSt = nf.got && nf.got.raw && nf.got.raw.status;
            const stHint = typeof rawSt === 'number' ? '（status = ' + rawSt + '，并非 Epic 服务端返回）' : '';
            ui.log('✗ ' + nameOf(nf.name) + ' 触发了网络错误' + stHint + '。'
                + '当前网络或浏览器拦截规则无法连上 www.epicgames.com，请检查代理/加速器或关闭广告拦截后重试。');
        } else if (!usable.length) {
            gm4Broken = hasGm4();
            ui.log('✗ 两条 GM 通道都没拿到 HTTP 响应，导出无法进行。上面的响应对象就是失败原因，与 Epic 账号和登录状态无关。');
        } else {
            const best = usable[0];
            const st = statusOf(best);
            // 能拿到有效 HTTP status（100..599）就说明这条链路是通的；非 2xx 是 Epic 那边的答复。
            if (st >= 200 && st < 300) ok = true;

            if (gm4Failed && st >= 200 && st < 300) {
                ui.log('⚠ 这个管理器的 GM.xmlHttpRequest（GM4）拿不到响应，但旧版 GM_xmlhttpRequest 正常。'
                    + '脚本已自动改用旧版通道，可以直接点「开始导出」，功能不受影响。');
            } else if (st >= 200 && st < 300) {
                ui.log('✓ 环境可用：' + nameOf(best.name) + ' 拿到了数字 status，请求链路正常。');
            } else {
                ui.log('⚠ 请求链路是通的（' + nameOf(best.name) + ' 拿到了数字 status），'
                    + '但 Epic 返回了 ' + st + '，这是服务端答复，不是脚本管理器的问题。');
            }
        }
        ui.progress(0, ok ? '自检通过' : '自检未通过');
        return ok;
    }

    // ── 界面 ────────────────────────────────────────────────────────────────
    const ui = (function () {
        let root, panel, statusEl, elapsedEl, barEl, logEl, btnRun, btnJson;

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
                + '#epic-export-json{width:100%;padding:9px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:#1a212a;color:#cfd6df;font-size:12px;font-weight:600;cursor:pointer}'
                + '#epic-export-json:disabled{opacity:.35;cursor:not-allowed}'
                + '#epic-export-diag{width:100%;padding:7px;border:1px solid #2f3945;border-radius:7px;'
                + 'background:transparent;color:#8b96a3;font-size:11px;font-weight:600;cursor:pointer;'
                + 'margin-top:8px}'
                + '#epic-export-diag:hover{color:#cfd6df;border-color:#3d4a58}'
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
                + '  <button id="epic-export-json" disabled>下载 JSON</button>'
                + '  <button id="epic-export-diag">环境自检</button>'
                + '</div>';

            document.body.appendChild(root);

            panel = root.querySelector('#epic-export-panel');
            statusEl = root.querySelector('#epic-export-status');
            elapsedEl = root.querySelector('#epic-export-elapsed');
            barEl = root.querySelector('#epic-export-bar');
            logEl = root.querySelector('#epic-export-log');
            btnRun = root.querySelector('#epic-export-run');
            btnJson = root.querySelector('#epic-export-json');
            const btnDiag = root.querySelector('#epic-export-diag');

            root.querySelector('#epic-export-fab').addEventListener('click', function () {
                panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
            });
            btnRun.addEventListener('click', function () {
                if (state.running) return;
                btnRun.disabled = true;
                runExport().then(function () { btnRun.disabled = false; });
            });
            btnJson.addEventListener('click', exportJson);
            btnDiag.addEventListener('click', function () {
                if (state.running) return;
                btnDiag.disabled = true;
                runEnvCheck().then(function () { btnDiag.disabled = false; },
                    function () { btnDiag.disabled = false; });
            });
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
    // 供自测台（tools/selftest.cjs，vm 沙箱）调用内部函数。只读句柄，不改行为：
    // 生产环境里没人会读这个对象，沙箱里靠它绕开界面直接验网络层与自检结论。
    window.__epicExport = {
        okStatus: okStatus,
        httpFailure: httpFailure,
        networkError: networkError,
        hasGm4: hasGm4,
        hasLegacy: hasLegacy,
        gm4Broken: function () { return gm4Broken; },
        setGm4Broken: function (v) { gm4Broken = !!v; },
        httpOnce: httpOnce,
        probeOnce: probeOnce,
        describeRaw: describeRaw,
        runEnvCheck: runEnvCheck,
        shortUrl: shortUrl
    };

    function boot() {
        if (document.getElementById('epic-export-root')) return;
        ui.mount();
        ui.progress(0, '就绪');
        ui.log('已就绪。确认已登录 Epic 后点「开始导出」。');

        // 启动时只报静态事实，不发请求（探测留给「环境自检」按钮，避免每次刷新都打一次 Epic）。
        // 注意不能把「没有 GM4」当成问题：旧版 GM_xmlhttpRequest 同样能用，
        // 真正会失败的是两套接口都没有的环境（例如脚本管理器整个没生效）。
        if (!hasGm4() && !hasLegacy()) {
            ui.log('⚠ 没检测到任何 GM 请求接口，导出无法进行。'
                + '请确认脚本由 Tampermonkey 等脚本管理器运行，或点「环境自检」查看详情。');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
})();
