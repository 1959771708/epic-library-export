#!/usr/bin/env node
'use strict';

// 自测台：把真实用户脚本丢进最小 vm 沙箱里跑，验证网络层与「环境自检」的分类结论。
//
// 为什么不能用 node --check 了事：node --check 只查语法，查不出未定义引用。
// 上一轮 gm4Request 里写了 networkError(...) 而函数根本没定义，语法检查是绿的，
// 真跑起来才会 ReferenceError。所以这里必须真执行。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'epic-library-export.user.js');

let total = 0;
const failures = [];

function check(name, fn) {
    total++;
    try {
        fn();
    } catch (e) {
        failures.push(name + ' → ' + (e && e.message || e));
    }
}

async function checkAsync(name, fn) {
    total++;
    try {
        await fn();
    } catch (e) {
        failures.push(name + ' → ' + (e && e.message || e));
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) {
        throw new Error((label || '') + ' 期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
    }
}

// ── DOM 桩 ──────────────────────────────────────────────────────────────────
// 只做脚本真正用到的那点事：createElement / appendChild / innerHTML 之后
// querySelector('#id') 能拿回节点 / addEventListener + click。
function makeDom() {
    const byId = new Map();

    function makeEl(tag) {
        const el = {
            tagName: String(tag || 'div').toUpperCase(),
            _id: '',
            style: {},
            children: [],
            _listeners: {},
            innerHTML: '',
            textContent: '',
            disabled: false,
            appendChild(c) { this.children.push(c); return c; },
            addEventListener(type, fn) {
                (this._listeners[type] = this._listeners[type] || []).push(fn);
            },
            click() {
                (this._listeners.click || []).forEach(function (f) { f({ target: el }); });
            },
            querySelector(sel) {
                const id = String(sel).replace(/^#/, '');
                if (!byId.has(id)) {
                    const stub = makeEl('div');
                    stub.id = id;
                }
                return byId.get(id);
            },
            remove() { }
        };
        // 赋 id 时自动登记，使 querySelector('#x') 能找到它
        Object.defineProperty(el, 'id', {
            get() { return this._id; },
            set(v) {
                this._id = String(v);
                byId.set(String(v), this);
            }
        });
        return el;
    }

    const body = makeEl('body');
    const document = {
        readyState: 'complete',
        body: body,
        createElement: function (tag) { return makeEl(tag); },
        getElementById: function (id) { return byId.get(String(id)) || null; },
        addEventListener: function () { }
    };
    return { document: document, body: body, byId: byId, makeEl: makeEl };
}

// ── GM 桩 ───────────────────────────────────────────────────────────────────
// env 决定行为：
//   'tm4'      完整 Tampermonkey：GM4 与旧版都能用，回真响应
//   'xmonkey'  XMonkey 1.2.7：GM4 函数存在、调用不抛、resolves undefined；旧版正常
//   'broken'   GM4 破损且没有旧版
//   'nocb'     两套接口都不存在
//   'e500'     GM4 正常但服务端回 500（用来确认不会误降级）
function makeGm(env, calls) {
    const gm = { env: env, calls: calls };

    function goodResponse(url) {
        return {
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ ok: true, url: url }),
            finalUrl: url
        };
    }

    if (env === 'tm4') {
        gm.GM = {
            xmlHttpRequest: function (cfg) {
                calls.push({ via: 'GM4', url: cfg.url });
                return Promise.resolve(goodResponse(cfg.url));
            }
        };
        gm.GM_xmlhttpRequest = function (cfg) {
            calls.push({ via: 'legacy', url: cfg.url });
            setTimeout(function () { cfg.onload(goodResponse(cfg.url)); }, 0);
        };
    } else if (env === 'xmonkey') {
        // 关键：GM4 是函数、不抛错、Promise 解出 undefined —— 复刻 XMonkey 1.2.7
        gm.GM = {
            xmlHttpRequest: function (cfg) {
                calls.push({ via: 'GM4', url: cfg.url });
                return Promise.resolve(undefined);
            }
        };
        gm.GM_xmlhttpRequest = function (cfg) {
            calls.push({ via: 'legacy', url: cfg.url });
            setTimeout(function () { cfg.onload(goodResponse(cfg.url)); }, 0);
        };
    } else if (env === 'broken') {
        gm.GM = {
            xmlHttpRequest: function (cfg) {
                calls.push({ via: 'GM4', url: cfg.url });
                return Promise.resolve(undefined);
            }
        };
        // 没有 GM_xmlhttpRequest
    } else if (env === 'e500') {
        gm.GM = {
            xmlHttpRequest: function (cfg) {
                calls.push({ via: 'GM4', url: cfg.url });
                return Promise.resolve({
                    status: 500,
                    statusText: 'Internal Server Error',
                    responseText: 'boom'
                });
            }
        };
        gm.GM_xmlhttpRequest = function (cfg) {
            calls.push({ via: 'legacy', url: cfg.url });
            setTimeout(function () {
                cfg.onload({ status: 500, statusText: 'Internal Server Error', responseText: 'boom' });
            }, 0);
        };
    }
    // 'nocb' 两个都不挂

    return gm;
}

function makeSandbox(options) {
    const opts = options || {};
    const calls = [];
    const dom = opts.mountUi === false ? null : makeDom();
    const gm = makeGm(opts.env || 'tm4', calls);

    const sandbox = {
        console: console,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setInterval: setInterval,
        clearInterval: clearInterval,
        Date: Date,
        JSON: JSON,
        Math: Math,
        Promise: Promise,
        Map: Map,
        Set: Set,
        Array: Array,
        Object: Object,
        String: String,
        Number: Number,
        Boolean: Boolean,
        Error: Error,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
        document: {
            readyState: 'loading',           // 不触发 boot()，由用例自己决定调什么
            addEventListener: function () { },
            getElementById: function () { return null; },
            createElement: function (tag) { return { style: {} }; },
            body: { appendChild: function () { } }
        },
        location: { hostname: 'www.epicgames.com', href: 'https://www.epicgames.com/store/zh-CN/' },
        GM_info: opts.env === 'nocb' ? undefined : { scriptHandler: opts.handler || 'Tampermonkey', version: '5.3.2' }
    };

    if (dom) sandbox.document = dom.document;
    if (gm.GM) sandbox.GM = gm.GM;
    if (gm.GM_xmlhttpRequest) sandbox.GM_xmlhttpRequest = gm.GM_xmlhttpRequest;

    sandbox.window = sandbox;
    return { sandbox: sandbox, calls: calls, dom: dom };
}

function load(sandbox) {
    const code = fs.readFileSync(SRC, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: SRC });
    assert(sandbox.window.__epicExport, '脚本没有暴露 window.__epicExport');
    return sandbox.window.__epicExport;
}

// ── 用例 ────────────────────────────────────────────────────────────────────
async function testNetwork() {
    // 1. okStatus 必须拒绝非数字
    {
        const env = makeSandbox({ env: 'tm4' });
        const api = load(env.sandbox);
        check('okStatus 只认数字 2xx', function () {
            assertEqual(api.okStatus(200), true, '200');
            assertEqual(api.okStatus(204), true, '204');
            assertEqual(api.okStatus(299), true, '299');
            assertEqual(api.okStatus(300), false, '300');
            assertEqual(api.okStatus(undefined), false, 'undefined');
            assertEqual(api.okStatus(null), false, 'null');
            assertEqual(api.okStatus('200'), false, '字符串 200');
            assertEqual(api.okStatus(NaN), false, 'NaN');
        });
    }

    // 2. 完整 TM4：走 GM4，一次请求就够
    await checkAsync('完整 GM4 环境：单次请求成功', async function () {
        const env = makeSandbox({ env: 'tm4' });
        const api = load(env.sandbox);
        const text = await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');
        assertEqual(env.calls.length, 1, '请求次数');
        assertEqual(env.calls[0].via, 'GM4', '走的通道');
        assert(JSON.parse(text).ok === true, '返回内容');
        assertEqual(api.gm4Broken(), false, 'gm4Broken 不应被置位');
    });

    // 3. XMonkey：GM4 解出 undefined → 自动降级旧版，且记住 GM4 坏了
    await checkAsync('XMonkey：GM4 解出 undefined 时自动降级', async function () {
        const env = makeSandbox({ env: 'xmonkey' });
        const api = load(env.sandbox);
        const text = await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');

        assertEqual(env.calls.length, 2, '应先试 GM4 再走旧版');
        assertEqual(env.calls[0].via, 'GM4', '第一次走 GM4');
        assertEqual(env.calls[1].via, 'legacy', '第二次走旧版');
        assert(JSON.parse(text).ok === true, '最终应拿到内容');
        assertEqual(api.gm4Broken(), true, 'gm4Broken 应被置位');
    });

    // 4. 降级后不再反复试 GM4
    await checkAsync('降级后第二次请求直接走旧版', async function () {
        const env = makeSandbox({ env: 'xmonkey' });
        const api = load(env.sandbox);
        await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/a');
        const before = env.calls.length;
        await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/b');
        assertEqual(env.calls.length, before + 1, '第二次应只发一个请求');
        assertEqual(env.calls[env.calls.length - 1].via, 'legacy', '应直接走旧版');
    });

    // 5. 真实状态码不降级：500 是服务端答复，换通道重打没意义
    await checkAsync('500 不触发降级（不重复请求）', async function () {
        const env = makeSandbox({ env: 'e500' });
        const api = load(env.sandbox);
        let caught = null;
        try {
            await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');
        } catch (e) { caught = e; }
        assert(caught, '应当抛错');
        assertEqual(caught.status, 500, 'err.status');
        assertEqual(env.calls.length, 1, '不应换通道重打');
        assertEqual(api.gm4Broken(), false, '真实状态码不该判定 GM4 坏了');
    });

    // 6. 两套接口都没有：明确的环境错误
    await checkAsync('无 GM 接口：抛 envProblem', async function () {
        const env = makeSandbox({ env: 'nocb' });
        const api = load(env.sandbox);
        let caught = null;
        try {
            await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');
        } catch (e) { caught = e; }
        assert(caught, '应当抛错');
        assertEqual(caught.envProblem, true, 'envProblem');
    });

    // 7. networkError 必须真的存在（上一轮就是漏了它）
    {
        const env = makeSandbox({ env: 'tm4' });
        const api = load(env.sandbox);
        check('networkError 已定义且不标 envProblem', function () {
            assertEqual(typeof api.networkError, 'function', 'networkError 类型');
            const e = api.networkError('网络错误', 'https://www.epicgames.com/abc');
            assert(e.message.indexOf('网络错误') === 0, '错误文案');
            assertEqual(e.envProblem, undefined, '不应标 envProblem');
        });
    }

    // 8. GM4 的 onerror 回调路径不能炸（上一轮 networkError 未定义就死在这）
    await checkAsync('GM4 onerror 路径可用', async function () {
        const calls = [];
        const dom = makeDom();
        const sandbox = {
            console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, JSON: JSON, Math: Math, Promise: Promise, Map: Map, Set: Set,
            Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
            Error: Error, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
            document: dom.document,
            location: { hostname: 'www.epicgames.com' },
            GM_info: { scriptHandler: 'Tampermonkey' }
        };
        sandbox.GM = {
            xmlHttpRequest: function (cfg) {
                setTimeout(function () { cfg.onerror(); }, 0);
                return undefined;   // 不给 Promise，逼它走回调
            }
        };
        sandbox.window = sandbox;
        const api = load(sandbox);
        let caught = null;
        try {
            await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');
        } catch (e) { caught = e; }
        assert(caught, '应当抛错');
        assert(caught.message.indexOf('网络错误') === 0, '应报「网络错误」，实际：' + caught.message);
    });

    // 9. 回调式 GM4：返回 undefined、稍后才 onload。脚本 GM 链路单次固定开销 6~7s，
    //    这类实现不能被「Promise 解出 undefined 就短判」的逻辑误伤。
    await checkAsync('回调式 GM4（返回 undefined，延迟 onload）不被误判', async function () {
        const calls = [];
        const dom = makeDom();
        const sandbox = {
            console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, JSON: JSON, Math: Math, Promise: Promise, Map: Map, Set: Set,
            Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
            Error: Error, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
            document: dom.document,
            location: { hostname: 'www.epicgames.com' },
            GM_info: { scriptHandler: 'Tampermonkey' }
        };
        sandbox.GM = {
            xmlHttpRequest: function (cfg) {
                calls.push({ via: 'GM4', url: cfg.url });
                // 1200ms 后才回调 —— 远超「Promise 短判」可能设的等待窗口
                setTimeout(function () {
                    cfg.onload({ status: 200, responseText: '{"ok":true}' });
                }, 1200);
                return undefined;   // 回调式实现：不返回 Promise
            }
        };
        sandbox.GM_xmlhttpRequest = function (cfg) {
            calls.push({ via: 'legacy', url: cfg.url });
            setTimeout(function () { cfg.onload({ status: 200, responseText: '{"ok":true}' }); }, 0);
        };
        sandbox.window = sandbox;
        const api = load(sandbox);

        const text = await api.httpOnce({ method: 'GET' }, 'https://www.epicgames.com/x');
        assertEqual(calls.length, 1, '这个环境 GM4 是可用的，不该降级重发');
        assertEqual(calls[0].via, 'GM4', '应走 GM4');
        assert(JSON.parse(text).ok === true, '应拿到内容');
        assertEqual(api.gm4Broken(), false, '不应判定 GM4 坏了');
    });
}

async function testEnvCheck() {
    // 9. XMonkey：自检必须说「GM4 不行、旧版能行、已降级、可以直接导出」
    await checkAsync('自检：XMonkey 报告双通道并说明已降级', async function () {
        const env = makeSandbox({ env: 'xmonkey' });
        const api = load(env.sandbox);
        const ok = await api.runEnvCheck();
        const log = env.dom.byId.get('epic-export-log').textContent;

        assertEqual(ok, true, '自检应判为可用');
        assert(log.indexOf('── 环境自检 ──') >= 0, '应有自检标题');
        assert(log.indexOf('GM.xmlHttpRequest（GM4）') >= 0, '应报告 GM4 事实');
        assert(log.indexOf('旧版') >= 0, '应报告旧版事实');
        assert(log.indexOf('已自动改用旧版通道') >= 0, '应说明已降级，实际日志：\n' + log);
        assert(log.indexOf('环境异常') < 0, '不应再报「环境异常」');
    });

    // 10. 两通道都失败才叫环境异常
    await checkAsync('自检：两通道都失败才报环境异常', async function () {
        const env = makeSandbox({ env: 'broken' });
        const api = load(env.sandbox);
        const ok = await api.runEnvCheck();
        const log = env.dom.byId.get('epic-export-log').textContent;
        assertEqual(ok, false, '自检应判为不可用');
        assert(log.indexOf('两条 GM 通道都没拿到 HTTP 响应') >= 0, '结论文案，实际：\n' + log);
        assertEqual(api.gm4Broken(), true, '应记住 GM4 不可用');
    });

    // 11. 500 不能报成环境问题
    await checkAsync('自检：500 归因到服务端而非环境', async function () {
        const env = makeSandbox({ env: 'e500' });
        const api = load(env.sandbox);
        const ok = await api.runEnvCheck();
        const log = env.dom.byId.get('epic-export-log').textContent;
        assertEqual(ok, false, '非 2xx 不算通过');
        assert(log.indexOf('服务端答复') >= 0, '应归因服务端，实际：\n' + log);
        assert(log.indexOf('两条 GM 通道都没拿到') < 0, '不应报成通道失败');
    });

    // 12. 完整环境自检通过
    await checkAsync('自检：完整环境通过', async function () {
        const env = makeSandbox({ env: 'tm4' });
        const api = load(env.sandbox);
        const ok = await api.runEnvCheck();
        assertEqual(ok, true, '应通过');
        const log = env.dom.byId.get('epic-export-log').textContent;
        assert(log.indexOf('环境可用') >= 0, '结论文案，实际：\n' + log);
    });

    // 13. describeRaw 要点出「status 字段不存在」
    {
        const env = makeSandbox({ env: 'tm4' });
        const api = load(env.sandbox);
        check('describeRaw 指出缺失的 status', function () {
            const s = api.describeRaw({ responseText: 'x' });
            assert(s.indexOf('status 字段不存在') >= 0, '文案：' + s);
            assert(s.indexOf('HTTP undefined') >= 0, '应点明报错来源');
        });
        check('describeRaw 对 undefined 也不炸', function () {
            const s = api.describeRaw(undefined);
            assert(s.indexOf('undefined') >= 0, '文案：' + s);
        });
    }

    // 14. 回调式 GM4：自检必须和实际导出一致地判它「可用」。
    //     只等 Promise 的探测会把这种实现误报成坏通道，导致「自检说不行、导出却成功」。
    await checkAsync('自检与网络层对回调式 GM4 的判断一致', async function () {
        const dom = makeDom();
        const sandbox = {
            console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
            setInterval: setInterval, clearInterval: clearInterval,
            Date: Date, JSON: JSON, Math: Math, Promise: Promise, Map: Map, Set: Set,
            Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
            Error: Error, encodeURIComponent: encodeURIComponent, decodeURIComponent: decodeURIComponent,
            document: dom.document,
            location: { hostname: 'www.epicgames.com' },
            GM_info: { scriptHandler: 'Tampermonkey' }
        };
        sandbox.GM = {
            xmlHttpRequest: function (cfg) {
                setTimeout(function () {
                    cfg.onload({ status: 200, responseText: '{"ok":true}' });
                }, 300);
                return undefined;   // 回调式：不返回 Promise
            }
        };
        sandbox.window = sandbox;
        const api = load(sandbox);

        const ok = await api.runEnvCheck();
        const log = dom.byId.get('epic-export-log').textContent;
        assertEqual(ok, true, '自检应判为可用');
        assert(log.indexOf('环境可用') >= 0, '应报环境可用，实际：\n' + log);
        assert(log.indexOf('已自动改用旧版通道') < 0, '不该误报降级');
    });
}

async function main() {
    await testNetwork();
    await testEnvCheck();

    failures.forEach(function (f) { console.error('✗ ' + f); });
    console.log('TOTAL=' + total + ' FAIL=' + failures.length);
    if (failures.length) process.exit(1);
}

main().catch(function (e) {
    console.error('自测台自身出错：', e && e.stack || e);
    process.exit(1);
});
