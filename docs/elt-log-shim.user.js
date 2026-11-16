// ==UserScript==
// @name         ELT 日志采集器
// @namespace    local.hermes.elt.logs
// @version      1.8.0
// @description  把清华社英语在线页面上的 console 日志与 DOM 结构快照发到本机 127.0.0.1:8765，供本地排查使用。只发本机，不上外网。
// @match        *://www.tsinghuaelt.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    var ENDPOINT = 'http://127.0.0.1:8765/log';
    var buf = [];
    var seen = 0;

    function push(s) {
        try { buf.push(String(s).slice(0, 8000)); } catch (e) {}
        if (buf.length > 400) buf.splice(0, buf.length - 400);
    }

    function flush(snap) {
        if (!buf.length && !snap) return;
        var payload = { lines: buf.slice(0, 200) };
        buf = buf.slice(200);
        if (snap) payload.snap = snap;
        try {
            GM_xmlhttpRequest({
                method: 'POST',
                url: ENDPOINT,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(payload),
                timeout: 8000,
                onload: function () { },
                onerror: function () { }
            });
        } catch (e) {}
    }

    // ---- console 钩子 ----
    // 【关键】本脚本带 @grant，跑在 Tampermonkey 沙箱里；
    // 主脚本是 @grant none，跑在**页面上下文**。沙箱里改 console 拦不到它，
    // 必须挂到 unsafeWindow 上才能捕获 [刷课] 的输出。
    var W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    ['log', 'warn', 'error'].forEach(function (k) {
        var orig = W.console[k];
        W.console[k] = function () {
            try {
                var args = Array.prototype.slice.call(arguments).map(function (x) {
                    if (typeof x === 'string') return x;
                    try { return JSON.stringify(x); } catch (e) { return String(x); }
                }).join(' ');
                push(k.toUpperCase() + ' ' + args);
            } catch (e) {}
            try { orig.apply(W.console, arguments); } catch (e) {}
        };
    });

    W.addEventListener('error', function (e) {
        push('UNCAUGHT ' + String(e.message) + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno);
        flush();
    });
    W.addEventListener('unhandledrejection', function (e) {
        push('REJECTION ' + String(e.reason && e.reason.message ? e.reason.message : e.reason));
        flush();
    });

    // ---- DOM 快照 ----
    var SEL = [
        '.exercise-item', '.ant-radio-wrapper', 'input[type=radio]', 'input[type=checkbox]',
        '.judge-option-item', '.judge-topic-item', '.question-item', '.option-item',
        '.zty-exercise-item-fill-blank-do', '.zty-exercise-item-fill-blank',
        '.ant-select', '.answer-select', '.drag-drop-container', '.option-content',
        'textarea', '[contenteditable]', '.oral-brief-course-do', '.listen-repeat-view',
        '.avatar-view-container', '.role-play-course-container', 'img[title="录音"]'
    ];

    function snapshot() {
        var cards = Array.prototype.slice.call(document.querySelectorAll('.exercise-item'));
        var panel = document.querySelector('#b6-root');
        return {
            url: location.href.slice(0, 220),
            path: location.pathname,
            title: String(document.title || '').slice(0, 60),
            cardCount: cards.length,
            panel: !!panel,
            panelText: panel ? String(panel.innerText || '').replace(/\s+/g, ' ').slice(0, 240) : '',
            retryCandidates: (function () {
                try {
                    var out = [];
                    var all = document.querySelectorAll('div, button, span, a');
                    for (var i = 0; i < all.length && out.length < 8; i++) {
                        var el = all[i];
                        var txt = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!/^(Retry|重做)$/i.test(txt)) continue;
                        // 只留"没有同样文本的子节点"的那个（最内层可点元素）
                        var childSame = Array.prototype.slice.call(el.children).some(function (c) {
                            return String(c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim() === txt;
                        });
                        var chain = [];
                        var n = el;
                        for (var k = 0; k < 5 && n && n.tagName; k++) {
                            var cnn = String(n.className || '').trim();
                            chain.push(n.tagName.toLowerCase() + (cnn ? '.' + cnn.split(/\s+/).slice(0, 2).join('.') : ''));
                            n = n.parentElement;
                        }
                        var r = el.getBoundingClientRect();
                        out.push({
                            text: txt,
                            tag: el.tagName,
                            cls: String(el.className || ''),
                            innerLayer: !childSame,
                            rect: [Math.round(r.width), Math.round(r.height)],
                            chain: chain.join(' < ')
                        });
                    }
                    return out;
                } catch (e) { return []; }
            })(),
            buttons: (function () {
                try {
                    var scope = document;
                    return Array.prototype.slice.call(
                        scope.querySelectorAll('button, .ant-btn, [role="button"], .ly-button')
                    ).slice(0, 18).map(function (b) {
                        return {
                            tag: b.tagName,
                            cls: String(b.className || '').slice(0, 48),
                            text: String(b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18),
                            disabled: !!b.disabled
                        };
                    });
                } catch (e) { return []; }
            })(),
            apiCalls: (function () {
                try {
                    return performance.getEntriesByType('resource')
                        .map(function (e) { return String(e.name); })
                        .filter(function (n) { return /\/content\/\d+\/(answer|list)|contentId=/.test(n); })
                        .slice(-5).map(function (n) { return n.slice(-130); });
                } catch (e) { return []; }
            })(),
            // 【1.8.0】一个页面可能挂多个 .content-item（一个 catalog 挂多个内容项）。
            // 只有逐个 content-item 对账，才能知道「14 张卡为什么只回来 1 道题」。
            contentItems: (function () {
                try {
                    var items = Array.prototype.slice.call(document.querySelectorAll('.content-item'));
                    if (!items.length) {
                        items = Array.prototype.slice.call(document.querySelectorAll('.unit-exercise-preview'))
                            .map(function (e) { return e.parentElement || e; });
                    }
                    return items.slice(0, 6).map(function (it, ix) {
                        var r = it.getBoundingClientRect();
                        var st = window.getComputedStyle(it);
                        var cds = Array.prototype.slice.call(it.querySelectorAll('.exercise-item'));
                        var ids = [];
                        cds.forEach(function (c) {
                            var h = String(c.outerHTML || '');
                            var m = h.match(/data-(?:child-)?question-id="\d+"/g) || [];
                            m.forEach(function (x) {
                                var d = x.match(/(\d+)/);
                                if (d && ids.indexOf(d[1]) < 0) ids.push(d[1]);
                            });
                        });
                        var sp = cds.filter(function (c) {
                            return /oral-|listen-repeat|role-play/.test(String(c.className || '')) ||
                                c.querySelector('img[title="录音"], .oral-brief-course-do, .avatar-view-container');
                        }).length;
                        return {
                            i: ix,
                            visible: r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden',
                            rect: [Math.round(r.width), Math.round(r.height)],
                            top: Math.round(r.top),
                            cls: String(it.className || '').slice(0, 60),
                            dataContentId: String(it.getAttribute('data-content-id') || it.getAttribute('data-id') || ''),
                            cards: cds.length,
                            speechCards: sp,
                            ids: ids.slice(0, 10),
                            text: String(it.innerText || '').replace(/\s+/g, ' ').slice(0, 90)
                        };
                    });
                } catch (e) { return []; }
            })(),
            cards: cards.slice(0, 16).map(function (c, i) {
                var hits = {};
                SEL.forEach(function (s) {
                    var n = c.querySelectorAll(s).length;
                    if (n) hits[s] = n;
                });
                var ctrls = Array.prototype.slice.call(
                    c.querySelectorAll('input,select,textarea,[contenteditable]')
                ).slice(0, 8).map(function (e) {
                    return {
                        tag: e.tagName,
                        type: e.type || '',
                        cls: String(e.className || '').slice(0, 46),
                        value: String(e.value === undefined ? '' : e.value).slice(0, 28),
                        checked: !!e.checked,
                        disabled: !!e.disabled
                    };
                });
                // 结构轮廓：两层子元素的类名 + 拖拽相关计数，用于看清组合题/拖拽题的内部
                var outline = Array.prototype.slice.call(c.querySelectorAll('*')).slice(0, 40).map(function (e) {
                    var k = String(e.className || '').trim();
                    return k ? e.tagName.toLowerCase() + '.' + k.split(/\s+/).slice(0, 2).join('.') : '';
                }).filter(Boolean);
                var uniq = [];
                outline.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
                var dragInfo = {
                    draggable: c.querySelectorAll('[draggable="true"]').length,
                    dropZone: c.querySelectorAll('.drop-zone-item-wrapper, .drop-zone-list, .drag-drop-container').length,
                    optionContent: c.querySelectorAll('.option-content').length,
                    imgFill: c.querySelectorAll('.imgFillBlanks, [class*="img-fill"]').length
                };
                var rr = c.getBoundingClientRect();
                var ci = c.closest ? c.closest('.content-item') : null;
                var ciIdx = -1;
                if (ci) {
                    var allCi = Array.prototype.slice.call(document.querySelectorAll('.content-item'));
                    ciIdx = allCi.indexOf(ci);
                }
                return {
                    i: i,
                    visible: rr.width > 0 && rr.height > 0,
                    rect: [Math.round(rr.width), Math.round(rr.height)],
                    contentItem: ciIdx,
                    cls: String(c.className || ''),
                    outline: uniq.slice(0, 14),
                    dragInfo: dragInfo,
                    // 直接给出卡片 HTML（压缩空白），避免再一次来回猜结构
                    html: String(c.outerHTML || '').replace(/\s+/g, ' ').slice(0, 2600),
                    counts: {
                        doneBlanks: c.querySelectorAll('.zty-exercise-item-fill-blank-done').length,
                        doBlanks: c.querySelectorAll('.zty-exercise-item-fill-blank-do').length,
                        baseBlanks: c.querySelectorAll('.zty-exercise-item-fill-blank').length,
                        nestedItems: c.querySelectorAll('.exercise-item').length,
                        ctAny: c.querySelectorAll('[contenteditable]').length
                    },
                    text: String(c.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
                    hits: hits,
                    controls: ctrls
                };
            })
        };
    }


    // ---- 面板状态采集（不依赖 console，兜底）----
    var lastPanel = '';
    setInterval(function () {
        try {
            var el = document.getElementById('b6-root');
            if (!el) return;
            var txt = String(el.innerText || '').replace(/\s+/g, ' ').trim();
            if (!txt || txt === lastPanel) return;
            // 只取状态区那一段，避免把按钮文字反复刷进日志
            var cut = txt.indexOf('OPERATION');
            var head = cut > 0 ? txt.slice(0, cut) : txt.slice(0, 200);
            lastPanel = txt;
            push('PANEL ' + head);
            flush();
        } catch (e) {}
    }, 1500);

    // ---- 定时上报 ----
    setInterval(function () { flush(); }, 2500);

    // 页面稳定后打一次快照；之后每 20 秒最多再打 2 次（覆盖异步渲染）
    var snaps = 0;
    function maybeSnap(delay) {
        setTimeout(function () {
            if (snaps >= 3) return;
            snaps++;
            flush(snapshot());
        }, delay);
    }
    if (document.readyState === 'complete') {
        maybeSnap(3000); maybeSnap(10000);
    } else {
        window.addEventListener('load', function () { maybeSnap(3000); maybeSnap(10000); });
    }
})();
