// ==UserScript==
// @name         TSH自动刷课
// @version      2.3.1-local78
// @namespace    wasd258-jpg.tsh-autobrush
// @description  清华社英语在线自动刷课（双引擎版）。自动识别站点版本：新版 /course_center/ 与旧站 /legacy/ 均支持，装一次即可。功能：自动答题+章节推进+查成绩+学习时长保活。新版支持单选/多选/判断/填空/下拉/拖拽；语音题需真人录音。含结构自检。
// @author       WASD258-jpg
// @match        *://www.tsinghuaelt.com/*
// @run-at       document-idle
// @grant        none
// @license      GPL-3.0-only
// @icon         https://www.tsinghuaelt.com/favicon.ico
// @homepageURL  https://github.com/WASD258-jpg/tsh-auto-brush
// @supportURL   https://github.com/WASD258-jpg/tsh-auto-brush/issues
// @updateURL    https://github.com/WASD258-jpg/tsh-auto-brush/raw/main/tsh-auto-brush.user.js
// @downloadURL  https://github.com/WASD258-jpg/tsh-auto-brush/raw/main/tsh-auto-brush.user.js
// ==/UserScript==

/*
 * v2.3.0 —— 双引擎版（构建产物）
 *
 * ⚠ 本文件由 test/build-dual.js 从 engines/ 目录组装生成，请勿直接编辑。
 *   修改逻辑请改：
 *     engines/new-engine.user.js    （新版引擎）
 *     engines/legacy-engine.user.js （旧站引擎）
 *   然后运行 node test/build-dual.js 重新构建。
 *
 * 背景：站点自 2026-09 起双轨运行。
 *   /legacy/       → Angular 7 旧站（未下线）
 *   /course_center/ → Vue3 新版「智慧版」
 * 登录由统一认证中心按账号属性分流（type=3 的账号被送往旧站），
 * 因此不同用户可能落在不同前端上。本版把两套引擎都内置，按路径只启动一套，
 * 用户无需再判断该装哪个版本。
 *
 * 已知边界：
 *   - 新版引擎未在登录态由作者实测（作者账号被分流至旧站，无新版权限）
 *   - 语音题（口语/跟读/角色扮演）走驰声实时评测，需真人录音，脚本会提示跳过
 *   - 作业/考试模块的反作弊机制脚本不触碰
 */

// ============================================================================
// 引擎 A · 新版站点（/course_center/）—— 包裹在独立作用域内
// ============================================================================
function __TSH_NEW_ENGINE__() {

    'use strict';

    const SCRIPT_VERSION = '2.3.1-local78'; // 与 @version 保持一致

    // ============================================================================
    // 1. 新站契约常量（逆向自线上产物，构建版本 20260930165203）
    // ============================================================================

    const API_BASE = 'https://zhjyapi.tsinghuaelt.com/elt-user';
    const TOKEN_KEY = 'eltUserToken';          // localStorage 令牌键
    const TOKEN_HEADER = 'elt-user-token';     // 对应请求头名
    const REFRESH_KEY = 'eltsUserRefreshToken';
    const REFRESH_HEADER = 'elt-user-refresh-token';

    // contentType：1=教材(Textbook) 2=学生课程(StudentCourse)
    const CT = { TEXTBOOK: 1, STUDENT_COURSE: 2 };

    // 阅读器路由类型（router param :type）
    const RT = { TEXTBOOK: 'Textbook', STUDENT_COURSE: 'StudentCourse', PUBLIC_COURSE: 'PublicCourse' };

    // 题型枚举（站点变量 Q 的字符串值）
    const TYPE = {
        SINGLE: 'choice_single',
        MULTIPLE: 'choice_multiple',
        FILL: 'fill_base',
        FILL_DIALOG: 'fill_dialog',
        FILL_IMAGE: 'fill_image',
        FILL_CLOZE: 'fill_word_selection',
        FILL_CLOZE_MN: 'fill_mchoosen',
        JUDGE: 'judge_basic',
        JUDGE_HIGH: 'judge_advanced',
        WRITING: 'essay_writing',
        TRANSLATE: 'essay_translate',
        QA: 'essay_questions_answers',
        CORRECT: 'correction_error',
        DRAG_ONE: 'matching_onetoonedrag',
        DRAG_MANY: 'matching_onetomanydrag',
        DRAG_FILL: 'matching_dragfillblank',
        DROP_IMG: 'matching_imagedropdown',
        DROP_PARA: 'matching_paragraphdropdown',
        COMBINED: 'combined_basic',
        READING: 'combined_read_comprehension',
        ORAL_SPEAK: 'oral_simple_speak',
        ORAL_FOLLOW: 'oral_follow_along',      // 注意：CSS 类名 listen-repeat-view 对应的就是它
        ORAL_ROLEPLAY: 'oral_roleplay',
        ORAL_WORDS: 'oral_vocabulary_learning'
    };

    // 走「裸标量」编码的题型（parseAnswer / parseDoRecord 只对这两个走该分支）。
    // 陷阱：judge_advanced 不在此列 —— 它的 doRecord 是 JSON 数组。
    const BARE_SCALAR_TYPES = new Set([TYPE.SINGLE, TYPE.JUDGE]);

    // 明确的客观题型。用途：压过站点可能给错的 obSub 标签。
    // 【实测 2026-11】judge_advanced 的题目数据里 obSub 竟然是 'sub'，
    // 于是 isSubjective() 把它判成主观题 → 走 AI（AI 又不支持该题型）
    // → retryUntilAnswer 里 expectAnswer() 也把它排除 → missing 为空
    // → 直接进「答案已齐」分支 → 回填 0 条 → 一次占位提交都没发，
    // 服务端永远累计不到答错次数，标准答案永远拿不到。
    const KNOWN_OBJECTIVE_TYPES = new Set([
        TYPE.SINGLE, TYPE.MULTIPLE, TYPE.JUDGE, TYPE.JUDGE_HIGH,
        TYPE.FILL, TYPE.FILL_DIALOG, TYPE.FILL_IMAGE, TYPE.FILL_CLOZE, TYPE.FILL_CLOZE_MN,
        TYPE.DRAG_ONE, TYPE.DRAG_MANY, TYPE.DRAG_FILL, TYPE.DROP_IMG, TYPE.DROP_PARA,
        TYPE.CORRECT
    ]);

    // 语音评测类题型（驰声 chivox 实时评测，必须真人录音）
    const SPEECH_TYPE_LIST = [TYPE.ORAL_SPEAK, TYPE.ORAL_FOLLOW, TYPE.ORAL_ROLEPLAY, TYPE.ORAL_WORDS];

    // 站点 createDoRecord 的空初值形态（用于判断"是否已作答"）
    const EMPTY_AS_STRING = new Set([TYPE.SINGLE, TYPE.JUDGE, TYPE.ORAL_SPEAK]);
    const EMPTY_AS_OBJECT = new Set([TYPE.WRITING, TYPE.TRANSLATE, TYPE.QA, TYPE.ORAL_ROLEPLAY]);

    // 课程学习模式（站点变量 Hq）。它决定**成绩如何取值**，因而决定作答策略：
    //   自由模式   learnMode=1 → 学习成绩记录**末次**答题结果（反复提交会覆盖）
    //   闯关模式   learnMode=2 → 学习成绩记录**最高**答题结果（反复提交取最好）
    // 教师端配置界面原文（course-manage-main）：
    //   自由：「学生答对即时显示答案与解析，答错 N 次后显示答案与解析，学习成绩记录末次答题结果。」
    //   闯关：「学生任务过关后显示答案与解析，学习成绩记录最高答题结果。」
    const LEARN_MODE = { FREE: 1, BREAKTHROUGH: 2 };

    // 题目状态枚举（站点变量 Z）
    const ST = {
        PREVIEW_BASIC: 1, PREVIEW_COMPOSING: 2, PREVIEW_COMPOSED: 3, PREVIEW_SIMPLE: 16,
        EXAM_DOING: 4, EXAM_FINISH: 5, EXAM_DONE_MARK: 6, EXAM_DONE_MARKED: 7,
        EXAM_DONE_MARKED_NO_ANSWER: 8, EXAM_ANALYSIS: 9,
        COURSE_DOING: 10, COURSE_FINISH: 11, COURSE_DONE_MARKED: 12,
        COURSE_DONE_MARKED_NO_ANSWER: 13, COURSE_ANALYSIS: 14, COURSE_ANALYSIS_NOT: 15
    };

    // 站点自身节流常量（逆自称常量 Me/Ne/Pe）
    const AI_ASSESS_INTERVAL_MS = 3000;
    const AI_ASSESS_MAX_TRIES = 30;
    const CONTENT_REPORT_INTERVAL_MS = 1000;

    // ============================================================================
    // 2. 工具函数
    // ============================================================================

    const $ = (s, p) => Array.from((p || document).querySelectorAll(s));
    const $1 = (s, p) => (p || document).querySelector(s);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
    const log = (...a) => { try { console.log('[刷课]', ...a); } catch (e) {} };

    // 【local57】抓站点自己的提交请求体：我们的接口提交返回 200 但服务端没记录，
    // 需要站点真实 payload 做字段对比。本脚本 @grant none 跑在页面上下文，能 hook fetch。
    (function hookFetchForCapture() {
        try {
            if (window.__tshFetchCaptured) return;
            window.__tshFetchCaptured = true;
            const orig = window.fetch;
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : ((input && input.url) || '');
                    const body = init && init.body;
                    if (/(answer|submit)/i.test(String(url)) && body) {
                        const txt = typeof body === 'string' ? body : '[非文本 body]';
                        log('站点请求', { method: (init && init.method) || 'GET', url: String(url).slice(-90), body: txt.slice(0, 600) });
                    }
                } catch (e) {}
                return orig.apply(this, arguments);
            };
        } catch (e) {}
    })();

    // 【local58】站点用 axios（XHR），fetch 钩子抓不到 → 再挂一层 XHR。
    (function hookXHRForCapture() {
        try {
            if (window.__tshXhrCaptured) return;
            window.__tshXhrCaptured = true;
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url) {
                try { this.__tshMeta = { method: method, url: String(url || '') }; } catch (e) {}
                return origOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function (body) {
                try {
                    const meta = this.__tshMeta || {};
                    if (/(answer|submit)/i.test(meta.url) && body) {
                        const txt = typeof body === 'string' ? body : '[非文本]';
                        log('站点XHR请求', { method: meta.method, url: meta.url.slice(-80), body: txt.slice(0, 700) });
                        this.addEventListener('load', () => {
                            try {
                                log('站点XHR响应', {
                                    status: this.status,
                                    url: meta.url.slice(-60),
                                    body: String(this.responseText || '').slice(0, 400)
                                });
                            } catch (e) {}
                        });
                    }
                } catch (e) {}
                return origSend.apply(this, arguments);
            };
        } catch (e) {}
    })();

    // 派发完整鼠标序列（antd 组件监听 pointer/mouse 组合，顺序须与真实浏览器一致）
    function click(el) {
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }
    function clickSeq(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, base)));
        el.dispatchEvent(new MouseEvent('mousedown', Object.assign({ button: 0, buttons: 1 }, base)));
        el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }, base)));
        el.dispatchEvent(new MouseEvent('mouseup', Object.assign({ button: 0, buttons: 0 }, base)));
        el.dispatchEvent(new MouseEvent('click', Object.assign({ button: 0, buttons: 0 }, base)));
        return true;
    }
    // 写入文本（适配 React/Vue 受控组件：先置原生值再派发 input/change）
    function fillInput(el, val) {
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    // 派发焦点类事件。FocusEvent 在部分环境（如离线测试的 mock DOM）不存在，
    // 退回普通 Event —— 站点只读事件类型与 relatedTarget（undefined/null 均可）。
    function fireFocusEvent(el, type) {
        if (!el) return false;
        let ev;
        try { ev = new FocusEvent(type, { bubbles: true, relatedTarget: null }); }
        catch (e) { ev = new Event(type, { bubbles: true }); }
        try { el.dispatchEvent(ev); } catch (e) {}
        return true;
    }

    // 写入 contenteditable（新站填空题主体是 span.zty-exercise-item-fill-blank-do）
    //
    // 【实测】只做 textContent + input + blur 是**不够**的：DOM 会有值，但站点的
    // doRecord 不更新，点提交时被前端硬门禁拦下（提示「已完成 0 题」）。
    //
    // 站点填空题组件（产物 src-DZ23PK2 的 Ij()）在容器 #do_{id} 上绑定：
    //   input    → O()  用 span.id 作 key 写入 doRecord，并置 changed = true
    //   focusout → M()  置 focus = false，若 inner 也为 false 则 emit doRecordChange
    //   mouseout → j()  置 inner = false，若 focus 也为 false 则 emit doRecordChange
    // 即必须让 changed / focus / inner 三个标志依次就位，才会真正提交作答。
    // 注意监听的是 focusout（冒泡）而非 blur。
    function fillEditable(el, val) {
        if (!el) return false;
        try { el.focus(); } catch (e) {}
        fireFocusEvent(el, 'focusin');
        el.textContent = val;
        el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, inputType: 'insertText', data: val
        }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        fireFocusEvent(el, 'focusout');
        try { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); } catch (e) {
            el.dispatchEvent(new Event('mouseout', { bubbles: true }));
        }
        return true;
    }

    // ============================================================================
    // 3. API 层（新站契约）
    // ============================================================================

    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
    }
    function getRefreshToken() {
        try { return localStorage.getItem(REFRESH_KEY) || ''; } catch (e) { return ''; }
    }

    // 统一请求：自动带 elt-user-token，解析 {code,data,message}
    //
    // 【已证实的限流契约】站点全局拦截器对 429 只做提示 + reject，**无重试、无退避**：
    //   if (status===429 || data.code===429) { error('提交过于频繁，请休息一下，1分钟后再试'); reject() }
    // 因此脚本必须自己实现冷却，否则连击只会持续吃 429。
    const RATE_LIMIT_COOLDOWN_MS = 60000;   // 与站点提示文案一致：1 分钟
    let rateLimitedUntil = 0;

    // 【local33】站点除了 HTTP 429，还会用**业务文案**提示：
    //   「操作过于频繁」「请稍后重试」「请勿重复提交」…
    // 这些返回的 http/code 往往是 200，原来的判断只看 429 → 提示被当成正常返回，
    // 这一步就被"吞掉"了（用户看到的就是步骤消失、答案没提交）。
    const THROTTLE_RE = /操作过于频繁|过于频繁|请稍后|稍后重试|请勿重复提交|频繁|too\s*many|rate\s*limit|429/i;
    let minGapMs = 900;                      // 触发过限流后自动拉大
    let lastReqAt = 0;

    function isRateLimited() { return Date.now() < rateLimitedUntil; }
    function rateLimitRemainSec() { return Math.max(0, Math.ceil((rateLimitedUntil - Date.now()) / 1000)); }
    function enterRateLimit(ms) {
        const d = ms || RATE_LIMIT_COOLDOWN_MS;
        rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + d);
        minGapMs = Math.min(3500, Math.round(minGapMs * 1.6));   // 每次限流后放慢
    }
    async function waitGap() {
        const gap = Date.now() - lastReqAt;
        if (gap < minGapMs) await sleep(minGapMs - gap + rnd(0, 250));
        lastReqAt = Date.now();
    }

    async function api(path, opts) {
        opts = opts || {};
        // 冷却期内不发请求（读接口豁免，避免正常浏览被阻断）
        if (isRateLimited() && opts.method && opts.method !== 'GET') {
            return { code: 429, message: '本地冷却中（剩余 ' + rateLimitRemainSec() + 's）', data: null, _localCooldown: true };
        }
        const url = API_BASE + path;
        const qs = opts.params
            ? '?' + Object.entries(opts.params)
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
                .join('&')
            : '';
        const headers = { 'Content-Type': 'application/json;charset=UTF-8', 'Accept-Language': 'zh-CN' };
        const tok = getToken();
        if (tok) headers[TOKEN_HEADER] = tok;

        const init = { method: opts.method || 'GET', headers, credentials: 'omit' };
        if (opts.data !== undefined) init.body = JSON.stringify(opts.data);

        await waitGap();
        let resp;
        try {
            resp = await fetch(url + qs, init);
        } catch (e) {
            return { code: -1, message: '网络错误：' + e.message, data: null };
        }
        let body;
        try { body = await resp.json(); } catch (e) { return { code: resp.status, message: '响应非 JSON（HTTP ' + resp.status + '）', data: null }; }

        // 限流：HTTP/业务码 429，或文案提示「操作过于频繁」等
        const msgText = body && body.message ? String(body.message) : '';
        if (resp.status === 429 || (body && body.code === 429) || THROTTLE_RE.test(msgText)) {
            enterRateLimit();
            log('触发限流（' + (msgText || ('HTTP ' + resp.status)) + '），冷却 '
                + Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000) + 's，之后请求间隔 ' + minGapMs + 'ms');
            status('站点提示操作过于频繁，冷却 ' + Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000) + 's 后继续');
            return { code: 429, message: msgText || '触发限流', data: null, _rateLimited: true };
        }

        // 【local33】命中限流且允许等待时，冷却结束后自动重发一次，避免整步被吞
        if (!opts._waited && THROTTLE_RE.test(String((body && body.message) || ''))) {
            const waitMs = Math.max(3000, rateLimitedUntil - Date.now()) + rnd(500, 1500);
            status('等待 ' + Math.ceil(waitMs / 1000) + 's 后重试该请求');
            await sleep(waitMs);
            opts._waited = true;
            return api(path, opts);
        }

        // 令牌过期：尝试刷新一次后重试
        if (body && body.code === 401 && !opts._retried) {
            const ok = await refreshToken();
            if (ok) { opts._retried = true; return api(path, opts); }
        }
        return body;
    }

    async function refreshToken() {
        const t = getToken(), rt = getRefreshToken();
        if (!t || !rt) return false;
        try {
            const resp = await fetch(API_BASE + '/user/refresh/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json;charset=UTF-8', [TOKEN_HEADER]: t, [REFRESH_HEADER]: rt },
                body: '{}'
            });
            const b = await resp.json();
            if (b && b.code === 200 && b.data && b.data.token) {
                localStorage.setItem(TOKEN_KEY, b.data.token);
                if (b.data.refreshToken) localStorage.setItem(REFRESH_KEY, b.data.refreshToken);
                return true;
            }
        } catch (e) {}
        return false;
    }

    // --- 内容与题目 ---
    const apiGetContent = (bizId, catalogId, contentType) =>
        api('/textbook/course/' + bizId + '/content/' + catalogId + '/list', { params: { content_type: contentType } });

    const apiGetExercise = (contentId, contentType, bizId, userId) =>
        api('/question/echo/content/' + contentId + '/answer', {
            params: { content_type: contentType, biz_id: bizId, user_id: userId || undefined }
        });

    const apiSubmitAnswer = (payload) => api('/question/submit/answer', { method: 'POST', data: payload });

    const apiMarkContentDone = (courseId, catalogId, contentId) =>
        api('/user/study/course/content/record', { method: 'POST', data: { courseId, catalogId, contentId } });

    const apiSaveStudyTime = (bizId, contentType, catalogId) =>
        api('/user/study/time/record', { method: 'POST', data: { bizId, contentType, catalogId } });

    const apiGetReadRecord = (bizId, contentType) =>
        api('/user/study/read/record', { params: { biz_id: bizId, content_type: contentType } });

    const apiSaveReadRecord = (bizId, contentType, catalogId, contentId) =>
        api('/user/study/read/record', { method: 'POST', data: { bizId, contentType, catalogId, contentId } });

    const apiLoadProgress = (courseId, catalogId) =>
        api('/user/study/course/' + courseId, { params: { catalog_id: catalogId } });

    const apiGetAssessStatus = (courseId, catalogId) =>
        api('/user/study/course/' + courseId + '/ai/assess/status', { params: { catalog_id: catalogId } });

    const apiGetCatalogWithProgress = (courseId, userId, type) =>
        api('/course/' + courseId + '/catalog/list/with/progress', { params: { user_id: userId, type: type } });

    const apiGetCatalog = (courseId, type, status) =>
        api('/course/' + courseId + '/catalog/list', { params: { type: type, status: status } });

    const apiGetUserInfo = () => api('/user/info');

    // 课程详情：携带**判分规则**（learnMode / freeShowAnswer / passShowAnswer /
    // errorNumShow / caculateToGrade / learnTimeLimit）。
    // 阅读器页面自身也调这个接口；实测其返回里这些字段齐全。
    const apiGetCourseDetail = (courseId) => api('/course/' + courseId + '/detail');

    // ============================================================================
    // 4. 路由与页面识别
    // ============================================================================

    // 阅读器路由：/course_center/reader/{Textbook|StudentCourse|PublicCourse}/{bizId}?catalogId=&contentId=
    function parseReaderRoute() {
        const m = location.pathname.match(/\/course_center\/reader\/([^/]+)\/(\d+)/i);
        if (!m) return null;
        const q = new URLSearchParams(location.search);
        const rawType = m[1];
        let contentType = CT.TEXTBOOK;
        // 【登录态实测修正】路由段实际是带下划线的 student_course / public_course。
        // 原正则 /studentcourse/ 因下划线永远不匹配，导致 contentType 恒为 1，
        // 取题接口随之返回 80020「内容项不存在！」。
        // 实测：content_type=2 时 student_course 取题返回 200。
        if (/student_?course/i.test(rawType)) contentType = CT.STUDENT_COURSE;
        else if (/public_?course/i.test(rawType)) contentType = CT.STUDENT_COURSE; // 公共课与课程同走 content_type=2
        return {
            type: rawType,
            contentType: contentType,
            bizId: m[2],
            catalogId: q.get('catalogId') ? Number(q.get('catalogId')) : null,
            contentId: q.get('contentId') ? Number(q.get('contentId')) : null
        };
    }

    // 页面识别（新站 DOM）
    const SEL = {
        readerRoot: '.textbook-preview-content',
        chapterSection: '.chapter-section',
        contentItem: '.content-item',
        exercisePreview: '.unit-exercise-preview',
        exerciseList: '.exercise-list',
        exerciseItem: '.exercise-item',
        exerciseContent: '.exercise-content',
        exerciseView: '.exercise-view',
        paginationBtn: '.pagination-btn',
        // 【登录态实测修正】站点并不存在 .pagination-btn-wrap。
        // 实测结构：div.preview-pagination 下同时挂着 2 个 button.pagination-btn
        // 与 1 个 .pagination-text（计数 "25/377"），即计数 span 与按钮是**同容器兄弟**，
        // 而非原先推断的「计数 span 包着 wrap」。
        paginationWrap: '.preview-pagination',
        // 答题计数：产物中 exercise-actions 内渲染的两个容器为
        //   hae = { class: 'unit-exercise-answer-account' }（作答情况/次数）
        //   gae = { class: 'right-button' }（右侧按钮区）
        // 旧命名 answer-count 在产物中仅 1 处且非独立类，保留作兼容探测。
        // 另注：分页栏位于 .preview-navbar 内，仅在「预览模式 + 总页数>0」时渲染。
        answerCount: '.answer-count',
        answerAccount: '.unit-exercise-answer-account',
        exerciseActions: '.exercise-actions',
        previewNavbar: '.preview-navbar'
    };

    function isReaderPage() {
        return !!parseReaderRoute() && !!$1(SEL.readerRoot);
    }
    function isCoursePage() {
        // 兼容：未进入具体阅读器但在课程中心
        return /\/course_center\//.test(location.pathname);
    }

    // ============================================================================
    // 4bis. 课程判分策略 —— 作答前必须先分清模式
    // ============================================================================
    //
    // 【为什么必须先分清】
    // 学习模式决定「反复提交」的后果，因而决定脚本敢不敢试错：
    //   自由模式 → 成绩记**末次**：中途提交的错答案会成为最终成绩，除非最后一次答对
    //   闯关模式 → 成绩记**最高**：反复提交不会拉低成绩
    // 另有 errorNumShow 决定要答错几次服务端才下发标准答案。
    //
    // 【证据】教师端配置界面（course-manage-main）对两种模式的原文说明见 LEARN_MODE 注释；
    // 字段本身来自 GET /course/{id}/detail，阅读器页面自身也调这个接口。
    //
    // 【保守原则】读不到策略时一律视为「不可试错」，宁可不做也不冒险改成绩。

    let coursePolicy = null;

    // 拉取并缓存当前课程的判分策略
    async function loadCoursePolicy(force) {
        const r = parseReaderRoute();
        if (!r) return null;
        const key = r.bizId + '|' + r.contentType;
        if (!force && coursePolicy && coursePolicy.key === key) return coursePolicy;

        const resp = await apiGetCourseDetail(r.bizId);
        if (!resp || resp.code !== 200 || !resp.data) {
            coursePolicy = { key: key, loaded: false, error: (resp && resp.message) || '未知错误' };
            return coursePolicy;
        }
        const d = resp.data;
        coursePolicy = {
            key: key,
            loaded: true,
            learnMode: Number(d.learnMode),
            freeShowAnswer: Number(d.freeShowAnswer),
            passShowAnswer: Number(d.passShowAnswer),
            errorNumShow: Number(d.errorNumShow),
            caculateToGrade: Number(d.caculateToGrade),
            learnTimeLimit: Number(d.learnTimeLimit)
        };
        log('课程判分策略', coursePolicy);
        return coursePolicy;
    }

    // 由策略推导出「该模式下反复提交是否安全」
    function strategyOf(p) {
        if (!p || !p.loaded) {
            return {
                mode: '未知', retrySafe: false, gradeBy: '-',
                note: '未能读到课程设置，出于安全考虑不做试错提交'
            };
        }
        if (p.learnMode === LEARN_MODE.BREAKTHROUGH) {
            return {
                mode: '闯关模式', retrySafe: true, gradeBy: '最高',
                note: '成绩记录最高答题结果 —— 反复提交不会拉低成绩；任务达标后显示答案与解析'
            };
        }
        if (p.learnMode === LEARN_MODE.FREE) {
            return {
                mode: '自由模式', retrySafe: false, gradeBy: '末次',
                note: '成绩记录末次答题结果 —— 中途的错误提交会成为最终成绩，除非最后一次答对'
            };
        }
        return {
            mode: '未知(' + p.learnMode + ')', retrySafe: false, gradeBy: '-',
            note: '未识别的学习模式，不做试错提交'
        };
    }

    // 服务端在答错几次后下发标准答案。
    // 读不到课程设置、或 errorNumShow 非正数时返回 **Infinity**，表示「永不试错」
    // （调用方用 Number.isFinite 判定，Infinity 即跳过试错）。
    function answerRevealThreshold(p) {
        if (!p || !p.loaded) return Infinity;          // 读不到 → 永不试错
        const n = Number(p.errorNumShow);
        return Number.isFinite(n) && n > 0 ? n : Infinity;
    }
    // 取顶层题卡。
    // 【关键】组合题（combined_basic / combined_read_comprehension）的子题同样带
    // `.exercise-item` 类，并以 `data-child-question-id` 标识，**嵌在父题卡片内部**
    // （站点模板：div.exercise-item[data-child-question-id] 位于父题 div.exercise-item 之内）。
    // 若直接 querySelectorAll('.exercise-item') 会把子题一并收进来，导致题卡索引错位、
    // 答案与题目错配。因此必须过滤掉"祖先中已有 .exercise-item"的节点。
    // 【local44】接口返回 ≠ 页面渲染完毕。取题成功后立即读 DOM 会读到空页面
    // （domIds=0 → 判定"页面没题卡、已完成"→ 整节跳过，且时快时慢，典型的竞态）。
    async function waitForCards(maxMs) {
        const limit = maxMs || 8000;
        const t0 = Date.now();
        for (;;) {
            try {
                if (getExerciseItems().length && domQuestionIds().size) return Date.now() - t0;
            } catch (e) {}
            if (Date.now() - t0 >= limit) return -1;
            await sleep(400);
        }
    }

    function getExerciseItems() {
        const root = $1(SEL.readerRoot);
        if (!root) return [];
        let items = $(SEL.exerciseItem, root);
        if (!items.length) items = $(SEL.exercisePreview + ' ' + SEL.exerciseItem);
        if (!items.length) return [];
        // 【local35】排除预加载但 display:none 的相邻内容项中的卡片
        const shown = items.filter(el => isShownEl(el) || !!visibleContentItem(el));
        if (shown.length) items = shown;
        if (!items.length && $(SEL.exerciseItem).length) {
            log('题卡全被判为不可见', { total: $(SEL.exerciseItem).length });
        }
        const top = items.filter(el => {
            let p = el.parentElement;
            while (p && p !== root) {
                if (p.classList && p.classList.contains('exercise-item')) return false;
                p = p.parentElement;
            }
            return true;
        });
        return top.length ? top : items;
    }

    // ============================================================================
    // 5. 题型识别与作答
    // ============================================================================

    // 从题目卡片 DOM 推断题型（选择器取自线上构建产物的类名）
    function detectType(el) {
        if (!el) return null;
        const has = s => !!$1(s, el);
        // 语音类优先判定（其 DOM 特征最独特）
        if (has('.role-play-course-container')) return TYPE.ORAL_ROLEPLAY;
        if (has('.zty-exercise-view-main.listen-repeat-view')) return TYPE.ORAL_FOLLOW;
        if (has('.oral-brief-course-do') || has('.oral-brief-course-done')) return TYPE.ORAL_SPEAK;
        if (has('.drag-drop-container')) return TYPE.DRAG_ONE;
        if (has('.judge-option-item')) {
            // 【本地修复 local6】多行 .judge-option-item = 多小题判断（judge_advanced），
            // 只有一行才是 judge_basic。原来一律返回 JUDGE，导致占位/回填走错分支。
            return $('.judge-option-item', el).length > 1 ? TYPE.JUDGE_HIGH : TYPE.JUDGE;
        }
        if (has('.zty-exercise-item-fill-blank-do') || has('span.zty-exercise-item-fill-blank-do')) return TYPE.FILL;
        if (has('input[type="radio"]') || has('.ant-radio-wrapper') || has('.ant-radio-group')) return TYPE.SINGLE;
        if (has('input[type="checkbox"]') || has('.ant-checkbox-wrapper') || has('.ant-checkbox-group')) return TYPE.MULTIPLE;
        if (has('textarea')) return TYPE.WRITING;
        if (has('input[type="text"]') || has('input:not([type])')) return TYPE.FILL;
        if (has('.ant-select')) return TYPE.DROP_PARA;
        return null;
    }

    // 语音评测类题型：走驰声 chivox 实时评测（wss://cloud.chivox.com + 麦克风采集 + 服务端打分），
    // 结构上无法靠填 DOM 作答，必须真实录音。识别出来是为了明确跳过并告知用户，而非静默失败。
    const SPEECH_TYPES = new Set(SPEECH_TYPE_LIST);
    function isSpeechType(type) { return SPEECH_TYPES.has(type); }

    // 可作答控件：任意一种命中，说明这张卡能靠填 DOM 完成，不应按语音题跳过。
    //
    // 【本地修复 v2.3.1-local78】判据最终收敛为两条：
    //   v2.3.0   卡片深处出现语音类名就判语音题（后代查询 → 误判填空题）
    //   local1   加"可填控件优先"+"标记须在自身包装层"，仍漏：听力填空题的
    //            空位是基础类 fill-blank / antd 下拉，未聚焦时不含 -do 与 contenteditable
    //   local2   改用"录音控件"判语音题，但保留了 `|| isSpeechType(detectType(el))` 兜底，
    //            于是「纯音频播放卡」被 detectType 判成 oral_follow_along（因为音频视图
    //            复用 .zty-exercise-view-main.listen-repeat-view 包装类）又被误当语音题
    //   local4   去掉题型兜底：**只有真的存在录音/播报控件才算语音题**。
    //            纯播放音频只是题干，不是要你开口；真语音题必然有录音按钮或头像播报位。
    const ANSWERABLE_SELECTOR = [
        '[class*="fill-blank"]',       // 覆盖 fill-blank / -do / -done / -do-filled / fill-blank-empty
        '[contenteditable]',           // 含 "true" 与 "false" 两态（编辑态是 false）
        'input', 'select', 'textarea',
        '.ant-select', '.ant-select-selector',
        '.ant-radio-wrapper', '.ant-checkbox-wrapper',
        '.judge-option-item',
        '[class*="drag-drop"]',
        // 【local40】查看态的问答题（readonly-answer / do-record）不是语音题，
        // 它只是需要先点 Retry 回到作答态。
        '[class*="readonly-answer"]', '[class*="do-record"]', '.answer-card-course'
    ].join(', ');

    // 只有这些才说明题目要求真人发声：录音按钮、口语图、头像播报、角色扮演容器
    // 【local40】[class*="record"] 会命中答题容器 do-record / do-record-answer，
    // 把每张问答题卡都判成"有录音控件"→ 整节当语音题跳过。改成精确的录音控件。
    // 【local74】[class*="record-start"] / [class*="record-play"] 会命中**听力播放条**的
    // 播放按钮（class 形如 record-play / record-start），导致「有录音条的填空题」被判语音题跳过。
    // 只保留真正代表"麦克风/录音设备"的选择器；播放条再怎么放音也不需要真人发声。
    const RECORDING_SELECTOR = [
        'img[title*="录音"]', '.lib-oral-img',
        '[class*="record-btn"]', '[class*="recordBtn"]', '[class*="recorder"]',
        '[class*="oral-record"]', '[class*="mic-icon"]', '[class*="microphone"]',
        '.avatar-view-container', '.role-play-course-container',
        '.oral-brief-course-do', '.oral-brief-course-done'
    ].join(', ');

    // 保留给诊断用：这些类名出现在卡片里但不等于语音题
    const SPEECH_MARKER_SELECTOR =
        '.oral-brief-course-do, .oral-brief-course-done, .listen-repeat-view, ' +
        '.role-play-course-container, .avatar-view-container';

    function hasAnswerableControl(el) {
        return !!el && !!$1(ANSWERABLE_SELECTOR, el);
    }

    function hasRecordingAffordance(el) {
        return !!el && !!$1(RECORDING_SELECTOR, el);
    }

    function cardNeedsSpeech(el) {
        if (!el) return false;
        if (hasAnswerableControl(el)) return false;    // 能填/能选 → 按可作答题处理
        return hasRecordingAffordance(el);             // 只有真的录音控件才算语音题
    }

    // 被跳过时打印判定依据，用于区分「真语音题」与「误判」
    function speechDiagnosis(el) {
        let rec = null;
        try {
            const hit = $1(RECORDING_SELECTOR, el);
            if (hit) {
                rec = {
                    tag: hit.tagName,
                    cls: String(hit.className || '').slice(0, 40),
                    title: String(hit.getAttribute && hit.getAttribute('title') || '').slice(0, 12)
                };
            }
        } catch (e) {}
        return {
            type: detectType(el),
            hasAnswerable: hasAnswerableControl(el),
            hasRecControl: hasRecordingAffordance(el),
            recHit: rec,
            blanks: el ? el.querySelectorAll('[class*="fill-blank"]').length : 0,
            radios: el ? el.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper').length : 0,
            areas: el ? el.querySelectorAll('textarea').length : 0,
            cardClass: el && el.className ? String(el.className).slice(0, 90) : '',
            markers: $(SPEECH_MARKER_SELECTOR, el).map(n => String(n.className).slice(0, 40)).slice(0, 3)
        };
    }

    // 卡片 ↔ 题目配对。
    //
    // 【实测 2026-11，本 bug 的根因】getExerciseItems() 只返回顶层卡片，而
    // questions 来自 questionVOList —— 两者**数量与顺序都不保证一致**：
    // 例如本节 4 张卡（口语×2 + 组合题父卡 + 若干）只对应 1 道题，
    // 之前用 `items[i]` 兜底（i=0）就把**口语那张卡**当成了组合题卡，
    // 于是 doneBlanks/subCards/controlsTotal 全是 0，看起来像"找错结构"，
    // 实际是"拿错了卡"。这里按 data-question-id / data-child-question-id 精确配对。
    function findCardForQuestion(items, q, fallbackIndex) {
        if (!items || !items.length) return null;
        if (!q) return items[fallbackIndex] || null;
        const id = Number(q.id);
        let hit = items.find(c => c.dataset && Number(c.dataset.questionId) === id);
        if (hit) return hit;
        const kids = (q.children || []).map(k => Number(k && k.id)).filter(n => Number.isFinite(n) && n > 0);
        if (kids.length) {
            hit = items.find(c => kids.some(kid =>
                c.querySelector('[data-child-question-id="' + kid + '"]')));
            if (hit) return hit;
        }
        hit = items.find(c => c.querySelector('.exercise-item[data-child-question-id="' + id + '"]'));
        if (hit) return hit;
        return items[fallbackIndex] || null;
    }

    // 读取卡片内的选项元素
    // 【登录态实测修正】线上选择题里 .option-line 命中数为 0，
    // 真正的选项容器是 antd 的 .ant-radio-wrapper / .ant-checkbox-wrapper；
    // .option-content 属于**拖拽题**的投放项，故降为次选，.option-line 仅作历史兼容。
    function getOptions(el) {
        let opts = $('.ant-radio-wrapper, .ant-checkbox-wrapper', el);
        if (opts.length) return opts;
        opts = $('.option-content', el);
        if (opts.length) return opts;
        opts = $('.option-line', el);
        return opts;
    }

    // 点击选项（优先点内部可聚焦控件，antd 需要点到 input 才触发表单变更）
    function selectOption(optEl) {
        if (!optEl) return false;
        const input = $1('input', optEl);
        if (input && !input.disabled) {
            clickSeq(optEl);
            // antd 受控组件：直接点 input 更可靠
            try { input.click(); } catch (e) {}
            // 【local52】点击后 DOM 的 checked 未必立刻同步（Vue 下一 tick 才更新），
            // v-model 也可能没收到变更 → 表现是"点了但一个都没勾上"。
            // 直接置位并派发 input/change，确保模型同步。
            try {
                if ((input.type === 'checkbox' || input.type === 'radio') && !input.checked) {
                    input.checked = true;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            return true;
        }
        const inner = $1('.option-content', optEl) || optEl;
        return clickSeq(inner);
    }

    // 把"刚写入 DOM 的作答"回写进 currentResp，让 hasUserAnswer() 能立即反映。
    //
    // 【为什么需要】hasUserAnswer() 读的是 currentResp 里的 doRecord，而 doRecord 来自服务端。
    // 填充只改了 DOM 的话，刚填的题仍会被判为「未作答」—— 流程就会停在提交之前，
    // 表现是"AI 已作答但一个请求都不发"。
    //
    // 编码规则与站点 stringifyField 一致（DEVELOPMENT §6.1.1）：
    //   裸串原样 / 非空数组或对象 JSON.stringify / 空数组 → 空串
    function stringifyDoRecord(value) {
        if (value === undefined || value === null) return '';
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) return value.length ? JSON.stringify(value) : '';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    }

    function markAnswered(q, value, card) {
        if (!q) return;
        // 填空类在站点的线格式是 [{idx, answer}]，idx 就是题干里每个空 span 的 id
        // （实测与 extension[].idx 一致）。若写成裸值数组，服务端会整题判错：
        // 实测提交 ["surrogate","hyena",…] 得到 rightRate 0，而 [{idx,answer},…] 才是正常格式。
        if (card && AI_FILL_TYPES.has(q.type)) {
            const blanks = $('.zty-exercise-item-fill-blank-do', card);
            const vals = Array.isArray(value) ? value : [value];
            if (blanks.length) {
                q.doRecord = JSON.stringify(blanks.map((b, i) => ({
                    idx: b.id,
                    answer: String(vals[i] == null ? '' : vals[i])
                })));
                return;
            }
        }
        q.doRecord = stringifyDoRecord(value);
    }

    // 本地占位标记：记录哪些题是"我们填的占位"，服务端尚未确认。
    // 【local7】原来占位只写 q.doRecord 就完事，hasUserAnswer() 于是把它当真实作答，
    // 脚本会报"已作答完成"而页面按钮还停在"提交"。
    const PLACEHOLDER_IDS = new Set();

    // 从 DOM 当前选中态编码出符合站点契约的 doRecord。
    //
    // 【本地修复 local7】占位也必须用**合法格式**提交，否则服务端不受理：
    // judge_advanced 的 doRecord 是 JSON 数组（每个小题一个选项 id），
    // 而原来 markAnswered(q, 'a') 写的是裸串 'a' —— 服务端不认，答错次数不累计，
    // errorNumShow 的阈值永远达不到，标准答案也就永远拿不到。
    function encodeChoiceFromDom(card, type) {
        if (!card) return '';
        if (type === TYPE.JUDGE_HIGH) {
            const rows = $('.judge-option-item', card);
            if (rows.length) {
                const arr = rows.map(row => {
                    const inp = $1('input:checked', row);
                    return inp ? String(inp.value) : '';
                });
                return arr.some(v => v !== '') ? JSON.stringify(arr) : '';
            }
        }
        const inp = $1('input:checked', card);
        if (inp) return String(inp.value);
        const checked = $1('.ant-radio-wrapper-checked, .ant-checkbox-wrapper-checked', card);
        if (checked) {
            const i2 = $1('input', checked);
            if (i2) return String(i2.value);
        }
        return '';
    }

    // 写入占位后同步本地状态，并记入 PLACEHOLDER_IDS
    function markAnsweredFromDom(q, card) {
        if (!q) return false;
        const enc = encodeChoiceFromDom(card, q.type);
        if (enc) {
            q.doRecord = enc;
            PLACEHOLDER_IDS.add(Number(q.id));
            return true;
        }
        markAnswered(q, 'a', card);
        PLACEHOLDER_IDS.add(Number(q.id));
        return true;
    }

    // 读取标准答案（来自取题接口的 questionAnswerItemVOList[].answer）
    // 结构：{ questionId, answer, userAnswer, overWriteUserAnswer, answerStatus, analysis }
    function buildAnswerMap(respData) {
        const map = new Map();
        if (!respData) return map;
        const list = respData.questionAnswerItemVOList || [];
        list.forEach(it => {
            const id = Number(it.questionId);
            if (!Number.isFinite(id)) return;
            map.set(id, {
                answer: it.answer,
                userAnswer: it.userAnswer,
                overWrite: it.overWriteUserAnswer,
                status: it.answerStatus
            });
        });
        return map;
    }

    // 解析 doRecord / answer。
    // 【站点契约，已证实】parseAnswer / parseDoRecord 只对 choice_single 与 judge_basic
    // 走「裸标量」分支；其余题型（**含 judge_advanced**）若为字符串则 JSON.parse。
    function decodeUserAnswer(raw, type) {
        if (raw === undefined || raw === null) return null;
        if (BARE_SCALAR_TYPES.has(type)) return raw;
        if (typeof raw === 'string') { try { return JSON.parse(raw); } catch (e) { return raw; } }
        return raw;
    }

    // 把标准答案（可能是 JSON 字符串）解码为可比较结构
    function decodeAnswer(raw, type) {
        return decodeUserAnswer(raw, type);
    }

    // 填空类的"标准答案"是结构化数组，需要摊平成每个空一个字符串。
    //
    // 【实测】服务端下发的是：
    //   [{"group":"group_1","idx":"…","standardAnswer":"wild","val":"wild"},
    //    {"group":"group_2","idx":"…","standardAnswer":"habitat(s)","val":"habitats; habitat"}, …]
    // 而 applyAnswer 的填空分支按"字符串数组"逐空写入，直接喂会得到 "[object Object]"。
    // 取值优先级：standardAnswer → val 的第一个分号项。
    // 另外有些题是**答案多样**的主观填空（standardAnswer = "Answers will vary."），
    // 这类无法自动作答，返回 null 交由调用方跳过。
    const ANSWER_VARIES_RE = /answers?\s+will\s+vary|answers?\s+may\s+vary|言之有理|答案不唯一/i;

    function normalizeFillAnswer(raw) {
        let v = raw;
        // 【local39】问答题/写作题的标准答案是 {"annex":[],"answer":"文本"} 包了一层的对象，
        // 直接 String() 会得到 JSON 字符串写进 textarea。
        if (v && typeof v === 'object' && !Array.isArray(v) && v.answer !== undefined) {
            v = v.answer;
        }
        if (typeof v === 'string') {
            const s = v.trim();
            if (!s) return null;
            try { v = JSON.parse(s); } catch (e) { return s; }   // 普通文本答案
            // 【local46】解析后可能变成 {"annex":[],"answer":"…"}：
            // 上面那次解包只覆盖"传进来就是对象"的情况，字符串解出来的没人管，
            // 于是落到结尾返回 null，回填被静默跳过。
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                if (v.answer !== undefined && v.answer !== null && String(v.answer).trim()) {
                    return String(v.answer).trim();
                }
                if (v.standardAnswer !== undefined && String(v.standardAnswer).trim()) {
                    return String(v.standardAnswer).trim();
                }
            }
        }
        if (Array.isArray(v)) {
            const structured = v.some(x => x && typeof x === 'object' &&
                (x.standardAnswer !== undefined || x.val !== undefined));
            if (!structured) return v.map(x => String(x == null ? '' : x));
            const out = v.map(x => {
                if (!x || typeof x !== 'object') return String(x == null ? '' : x);
                const sa = String(x.standardAnswer == null ? '' : x.standardAnswer).trim();
                if (sa) return sa;
                const vals = String(x.val == null ? '' : x.val).split(';').map(t => t.trim()).filter(Boolean);
                return vals[0] || '';
            });
            // 全部为空、或出现"答案多样"提示 → 无法自动作答
            if (!out.some(s => s)) return null;
            if (out.some(s => ANSWER_VARIES_RE.test(s))) return null;
            return out;
        }
        if (v && typeof v === 'object') {
            const sa = String(v.standardAnswer == null ? '' : v.standardAnswer).trim();
            if (sa) return ANSWER_VARIES_RE.test(sa) ? null : sa;
            const vals = String(v.val == null ? '' : v.val).split(';').map(t => t.trim()).filter(Boolean);
            return vals[0] || null;
        }
        return v == null ? null : String(v);
    }

    // ============================================================================
    // 6. AI 答题（支持 OpenAI 与 Anthropic 两种请求格式）
    // ============================================================================

    const AI_STORAGE_KEY = 'tsh_auto_brush_ai';
    let aiConfig = { enabled: false, baseUrl: '', apiKey: '', model: '', format: 'auto' };
    function loadAiConfig() {
        try { const s = localStorage.getItem(AI_STORAGE_KEY); if (s) aiConfig = Object.assign(aiConfig, JSON.parse(s)); } catch (e) {}
    }
    function saveAiConfig() {
        try { localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiConfig)); } catch (e) {}
    }
    function aiEnabled() { return !!(aiConfig.enabled && aiConfig.baseUrl && aiConfig.apiKey && aiConfig.model); }

    // 请求格式：显式指定优先，否则按 baseUrl 推断。
    // 含 /anthropic 的地址走 Messages 格式 —— 例如 DeepSeek 的
    // https://api.deepseek.com/anthropic 与 CommandCode 的 /provider/v1（其模型只接受 Messages）。
    // 【实测】CommandCode 对 /chat/completions 会直接报
    //   Model "…" must be called via /provider/v1/messages (Anthropic Messages shape).
    function aiFormat() {
        const f = aiConfig.format;
        if (f === 'anthropic' || f === 'openai') return f;
        return /anthropic|commandcode/i.test(aiConfig.baseUrl || '') ? 'anthropic' : 'openai';
    }

    // 组装端点：baseUrl 末尾已带 /v1 时不重复追加（两种填法都容错）
    function aiEndpoint() {
        const base = (aiConfig.baseUrl || '').replace(/\/+$/, '');
        const hasVersion = /\/v\d+$/.test(base);
        if (aiFormat() === 'anthropic') return base + (hasVersion ? '/messages' : '/v1/messages');
        return base + (hasVersion ? '/chat/completions' : '/v1/chat/completions');
    }

    // 输出额度（max_tokens）。
    //
    // 【实测】推理模型会先用大量输出 token 写思维链，额度给小了会导致
    // **思维链吃光额度、正文一个字都不产出**（stop_reason = max_tokens）：
    //   max_tokens=4096  → thinking 17271 字，text 为空        ✗
    //   max_tokens=8192  → thinking 5762 字 + 正文正常         ✓
    //   max_tokens=32000 → 正常，但模型思考更久
    // 所以默认给足；可用 aiConfig.maxTokens 覆盖。
    function aiMaxTokens() {
        const n = Number(aiConfig.maxTokens);
        if (Number.isFinite(n) && n >= 1024) return Math.floor(n);
        return 16384;
    }

    async function aiAsk(prompt) {
        if (!aiEnabled()) return null;
        const fmt = aiFormat();
        const url = aiEndpoint();
        const ctrl = new AbortController();
        // 超时要给足：推理模型会先写很长的思维链，实测单次可达 15s 以上，
        // 25s 会在复杂题上误判为超时。
        const timer = setTimeout(() => ctrl.abort(), 90000);
        try {
            let headers, body;
            if (fmt === 'anthropic') {
                // Anthropic Messages：鉴权用 x-api-key，另需 anthropic-version
                headers = {
                    'Content-Type': 'application/json',
                    'x-api-key': aiConfig.apiKey,
                    'anthropic-version': '2023-06-01'
                };
                body = {
                    model: aiConfig.model,
                    max_tokens: aiMaxTokens(),
                    temperature: 0.1,
                    messages: [{ role: 'user', content: prompt }]
                };
                // 【实测】不要禁用思维链。
                // deepseek-flash 等推理模型会先输出很长的 thinking；禁用后虽然快（0.9s），
                // 但答案质量明显下降（把整句当答案，而非题目要的词/短语）。
                // 正确做法是**给足输出额度**让思维链自然跑完。
                // 至于「额度被思维链吃光导致无正文」：那是额度不足所致，
                // 实测 4096 时 thinking 17271 字把额度耗尽、text 为空；
                // 8192 起即正常产出，故默认取更大的值（见 aiMaxTokens()）。
                if (aiConfig.thinking === 'off') body.thinking = { type: 'disabled' };
            } else {
                headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiConfig.apiKey };
                body = {
                    model: aiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    max_tokens: aiMaxTokens()
                };
            }
            const resp = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctrl.signal });
            if (!resp.ok) {
                let detail = '';
                try { detail = (await resp.text()).slice(0, 160); } catch (e) {}
                throw new Error('HTTP ' + resp.status + (detail ? ' ' + detail : ''));
            }
            const data = await resp.json();
            let c = '';
            if (fmt === 'anthropic') {
                // 只取 text 块；thinking 块不是答案正文
                c = Array.isArray(data && data.content)
                    ? data.content.filter(x => x && x.type === 'text').map(x => x.text || '').join('')
                    : '';
                if (!c.trim()) {
                    const kinds = Array.isArray(data && data.content) ? data.content.map(x => x && x.type) : [];
                    log('AI 无正文输出', 'stop=' + (data && data.stop_reason), 'blocks=' + JSON.stringify(kinds));
                    return null;
                }
            } else {
                c = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            }
            return typeof c === 'string' && c.trim() ? c.trim() : null;
        } catch (e) {
            status('AI 请求失败（' + (e.name === 'AbortError' ? '超时' : '网络') + '）');
            return null;
        } finally { clearTimeout(timer); }
    }

    // ---- AI 补答 ----
    //
    // 【登录态实测结论 · 2026-10-08，志愿者学生账号实测】
    //   GET  /question/echo/content/{contentId}/answer
    //        → questionVOList[].answer            恒为 ""（抽样 40 个内容项，40/40 为空）
    //        → questionAnswerItemVOList[].answer  **仅在答错累计到 errorNumShow 次后**
    //                                             由服务端下发标准答案（见 §11.3）
    //   POST /question/submit/answer
    //        → 响应 answer 同为 ""，只回 rightRate 表示对错
    //
    // 即：**标准答案不是没有，而是有门槛**。因此存在两条拿分的路：
    //   · AI 补答（本条）—— 一次答对，最快
    //   · 试错取答案（retryUntilAnswer）—— 站点直接给答案，但要先答错若干次
    // 两者可并存：AI 优先，未覆盖的题再由试错兜底（仅限闯关模式）。
    //
    // 未配置 AI 且模式不安全时，脚本**不伪造作答**：提交空答案只会撞站点前端硬门禁
    // （请完成所有习题后再提交），徒增无效请求 —— 此时明确停下并告知用户。

    const AI_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const AI_FILL_TYPES = new Set([TYPE.FILL, TYPE.FILL_DIALOG, TYPE.FILL_IMAGE, TYPE.FILL_CLOZE, TYPE.FILL_CLOZE_MN]);
    const AI_ESSAY_TYPES = new Set([TYPE.WRITING, TYPE.TRANSLATE, TYPE.QA]);

    // 判断是否「主观题」——决定用 AI 还是用轮询。
    //
    // 【实测依据】两条路互补，混用只是浪费：
    //   · 客观题（obSub === 'ob'）：服务端会下发权威 standardAnswer，轮询即可拿到，
    //     且比 AI 更准（实测同一题 AI 五个空全错，轮询拿到的全对），且零 token 成本。
    //   · 主观题（obSub === 'sub'）：answerStatus 恒为 -1，服务端**不下发答案**
    //     （实测返回 "Answers will vary." 或整句参考），轮询对它完全无效 ——
    //     这才是 AI 唯一真正必要的场景。
    function isSubjective(q) {
        if (!q) return false;
        if (q.children && q.children.length) return q.children.some(isSubjective);
        if (q.type && KNOWN_OBJECTIVE_TYPES.has(q.type)) return false;   // 客观题型压过 obSub 标签
        if (String(q.obSub || '').toLowerCase() === 'sub') return true;
        return AI_ESSAY_TYPES.has(q.type);      // 写作 / 翻译 / 问答
    }

    // 依据服务端**实际返回**判断题型性质 —— 比 obSub 标签可靠。
    //
    // 【实测的行为差异】
    //   客观题：answerStatus ∈ {1, 2, 3}（已自动判分），且 answer 会下发标准答案
    //   主观题：answerStatus === -1（服务端不自动判分），answer 不下发
    //           （填空会返回 "Answers will vary." 之类，轮询对它零收益）
    //   语音题：走第三方语音评测，空提交直接 500，answerStatus 始终不存在
    //
    // 返回 'objective' | 'subjective' | null（null = 尚未作答，无从判断）。
    // 用途：首次作答时只能用 obSub 猜；一旦有返回，就应该以行为证据为准，
    // 避免因为站点给了错的标签而把客观题当主观题（白调 AI）或反之（白轮询）。
    function gradedKindOf(item) {
        if (!item) return null;
        // 【易错】两种承载字段名不同，必须都认：
        //   · buildAnswerMap() 产出的项用 `status`（内部短名）
        //   · 接口原始题项用 `answerStatus`
        // 只读其中一个会导致恒为 null —— 分类静默失效，且不报错，极难察觉。
        const raw = item.answerStatus !== undefined ? item.answerStatus : item.status;
        const st = Number(raw);
        if (st === -1) return 'subjective';
        if (st === 1 || st === 2 || st === 3) return 'objective';
        return null;
    }

    function htmlToText(html) {
        if (!html) return '';
        const d = document.createElement('div');
        d.innerHTML = String(html);
        return (d.textContent || '').replace(/\s+/g, ' ').trim();
    }

    // extension 在接口里是 JSON 字符串；fill_base 等题型为空串，解析失败返回 null
    function parseExtension(q) {
        let ext = q && q.extension;
        if (ext === '' || ext === undefined || ext === null) return null;
        if (typeof ext === 'string') { try { return JSON.parse(ext); } catch (e) { return null; } }
        return ext;
    }

    // 填空题的空位数：题干里的 .zty-exercise-item-fill-blank / data-group-id
    function countBlanks(q) {
        const html = String(q.stem || '');
        const m = html.match(/data-group-id=/g);
        return m ? m.length : 0;
    }

    // 构造给 AI 的题目描述；不支持的题型返回 null
    function buildAIPrompt(q) {
        const type = q.type;
        const stem = htmlToText(q.stem || q.stemNoLabel || '');
        const ext = parseExtension(q);

        // 【关键】听力题的题干往往在音频里，文本 stem 为空 —— 但接口会把音频原文
        // 放在 attachmentList[].script，题干说明放在 instruction。
        // 不喂这两项，AI 只能瞎猜（实测 deepseek 会直接说「missing actual question」）。
        const context = [];
        if (q.instruction) {
            const ins = htmlToText(q.instruction);
            if (ins && ins !== stem) context.push('题目说明：' + ins);
        }
        const scripts = (q.attachmentList || [])
            .map(a => a && a.script ? htmlToText(a.script) : '')
            .filter(Boolean);
        if (scripts.length) context.push('听力原文/材料：\n' + scripts.join('\n---\n'));
        if (q.material) {
            const mat = htmlToText(q.material);
            if (mat) context.push('材料：' + mat);
        }

        if (type === TYPE.SINGLE || type === TYPE.MULTIPLE) {
            const opts = Array.isArray(ext) ? ext : [];
            if (!opts.length) return null;
            const L = [];
            L.push(type === TYPE.SINGLE ? '这是一道英语单选题（只有一个正确选项）。' : '这是一道英语多选题（可能有多个正确选项）。');
            if (stem) L.push('题目：' + stem);
            context.forEach(c => L.push(c));
            L.push('选项：');
            opts.forEach((o, i) => L.push(AI_LETTERS[i] + '. ' + htmlToText(o.val)));
            L.push('');
            L.push(type === TYPE.SINGLE
                ? '只回答一个选项字母，例如：B'
                : '只回答选项字母，多个用逗号分隔，例如：A,C。注意：多选题务必给出全部正确选项。');
            return L.join('\n');
        }

        if (type === TYPE.JUDGE) {
            const L = ['这是一道英语判断题。'];
            if (stem) L.push('题目：' + stem);
            context.forEach(c => L.push(c));
            L.push('');
            L.push('只回答 A 或 B：A 表示正确，B 表示错误。');
            return L.join('\n');
        }

        if (AI_FILL_TYPES.has(type)) {
            const n = countBlanks(q);
            const L = ['这是一道英语填空题，请根据句意填出每个空。'];
            if (stem) L.push('题目：' + stem);
            context.forEach(c => L.push(c));
            L.push('');
            L.push(n > 0
                ? '共有 ' + n + ' 个空。每行只写一个空的答案，不要编号，不要解释。'
                : '每行只写一个空的答案，不要编号，不要解释。');
            return L.join('\n');
        }

        if (AI_ESSAY_TYPES.has(type)) {
            const what = type === TYPE.WRITING ? '英语写作'
                : (type === TYPE.TRANSLATE ? '英汉互译' : '英语问答题');
            const L = ['这是一道' + what + '题，请直接给出答案正文。'];
            if (stem) L.push('题目：' + stem);
            context.forEach(c => L.push(c));
            L.push('');
            L.push('只输出答案正文本身，不要任何解释或前后缀。');
            return L.join('\n');
        }

        return null;
    }

    // 把 AI 的自由文本解析成 applyAnswer 需要的 value
    function aiAnswerToValue(reply, q) {
        const type = q.type;
        const raw = String(reply == null ? '' : reply).trim();
        if (!raw) return null;
        const ext = parseExtension(q);

        if (type === TYPE.SINGLE || type === TYPE.MULTIPLE) {
            const opts = Array.isArray(ext) ? ext : [];
            // 优先匹配选项字母
            let letters = (raw.toUpperCase().match(/[A-Z]/g) || []).filter(l => AI_LETTERS.indexOf(l) >= 0);
            // 兜底：AI 直接回了选项原文
            if (!letters.length && opts.length) {
                const hits = [];
                opts.forEach((o, i) => { if (raw.indexOf(htmlToText(o.val)) >= 0) hits.push(i); });
                if (hits.length) {
                    return type === TYPE.MULTIPLE ? hits.map(i => optionValue(opts, i)) : optionValue(opts, hits[0]);
                }
                return null;
            }
            if (!letters.length) return null;
            // 去重并保序
            letters = letters.filter((v, i) => letters.indexOf(v) === i);
            const vals = letters.map(l => optionValue(opts, AI_LETTERS.indexOf(l)));
            return type === TYPE.MULTIPLE ? vals : vals[0];
        }

        if (type === TYPE.JUDGE) {
            // 站点判断题的提交值是裸标量 "1"(正确) / "0"(错误)
            if (/^\s*(A|T|TRUE|对|正确|是)\b/i.test(raw) || /^(A|T)$/i.test(raw)) return '1';
            if (/^\s*(B|F|FALSE|错|错误|否)\b/i.test(raw) || /^(B|F)$/i.test(raw)) return '0';
            return null;
        }

        if (AI_FILL_TYPES.has(type)) {
            const parts = raw.split(/\r?\n/)
                .map(s => s.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, '').trim())
                .filter(Boolean);
            if (!parts.length) return null;
            return parts.length > 1 ? parts : parts[0];
        }

        if (AI_ESSAY_TYPES.has(type)) {
            return { answer: raw, annex: [] };
        }

        return null;
    }

    // 选项 i 对应的站点提交值：优先 extension[].idx（实测为 UUID），缺失时退回下标
    function optionValue(opts, i) {
        const o = opts[i];
        if (o && o.idx !== undefined && o.idx !== null && o.idx !== '') return String(o.idx);
        return String(i);
    }

    // 对给定题目逐题调用 AI 并写入 DOM
    async function fillByAI(questions) {
        const items = getExerciseItems();
        const list = (currentResp && currentResp.questionVOList) || [];
        if (!items.length || !questions.length) return { filled: 0, total: questions.length, failed: [] };

        let filled = 0;
        const failed = [];
        for (const q of questions) {
            const card = items.find(c => c.dataset && Number(c.dataset.questionId) === Number(q.id))
                || items[list.findIndex(x => Number(x.id) === Number(q.id))];
            if (!card) { failed.push(q.type + '#' + q.id + '（未找到题卡）'); continue; }

            const prompt = buildAIPrompt(q);
            if (!prompt) { failed.push(q.type + '#' + q.id + '（题型暂未支持）'); continue; }

            const reply = await aiAsk(prompt);
            if (!reply) { failed.push(q.type + '#' + q.id + '（AI 无响应）'); continue; }

            const value = aiAnswerToValue(reply, q);
            if (value === null) { failed.push(q.type + '#' + q.id + '（答案解析失败）'); continue; }

            const ok = applyAnswer(card, q.type, value);
            if (ok) { markAnswered(q, value, card); filled++; } else failed.push(q.type + '#' + q.id + '（写入失败）');
            await sleep(rnd(400, 900));   // 控制节奏，避免触发站点限流
        }
        return { filled, total: questions.length, failed };
    }

    // ============================================================================
    // 7. 章节推进
    // ============================================================================

    // 点击分页按钮：dir='next' | 'prev'
    //
    // 【关键契约，已证实】阅读器内部**完全不改 URL**（全文无 location/href/history 写入）。
    // 翻页只改内存状态：左按钮 `Se--`、右按钮 `Se++`，由 watcher 触发滚动与内容切换。
    // 因此 URL 变化**不能**作为翻页判据，只能靠页面内容签名与分页计数文本。
    //
    // 另：右按钮在下一条目 lock 为真时 `disabled`（闯关模式未达标），此时视为无法前进。
    async function clickPagination(dir) {
        const btns = $(SEL.paginationBtn);
        if (!btns.length) return false;

        // 站点用 pagination-left / pagination-right 图标类区分方向
        let target = null;
        for (const b of btns) {
            const isLeft = !!$1('.pagination-left', b) || /left/i.test(b.className);
            const isRight = !!$1('.pagination-right', b) || /right/i.test(b.className);
            if (dir === 'next' && isRight) target = b;
            if (dir === 'prev' && isLeft) target = b;
        }
        // 兜底：最后一个按钮视为"下一页"
        if (!target && dir === 'next' && btns.length >= 2) target = btns[btns.length - 1];
        if (!target) return false;

        // 站点自身用 disabled 表达"不可前进"（含 lock 未解锁）
        if (target.disabled || target.getAttribute('disabled') !== null) return false;

        const beforeCounter = paginationCounter();
        const beforeSig = pageSignature();
        clickSeq(target);

        for (let i = 0; i < 30; i++) {
            await sleep(200);
            // 判据 1：分页计数文本变化（如 "3/42" → "4/42"）—— 最直接、最可靠
            const c = paginationCounter();
            if (c && c !== beforeCounter) return true;
            // 判据 2：页面内容签名变化（激活节点 / contentId / 正文长度）
            if (pageSignature() !== beforeSig) return true;
        }
        return false;
    }

    // 读取分页计数文本。
    // 【登录态实测修正】原注释描述的
    //   div[ button(左), span(计数), span.pagination-btn-wrap[button(右)] ]
    // 与线上不符：.pagination-btn-wrap 命中数为 0。
    // 实测真实结构为单一容器：
    //   div.preview-pagination[ button.pagination-btn, button.pagination-btn, span.pagination-text ]
    // 计数文本形如 "25/377"（实测样例）。
    function paginationCounter() {
        // 优先：直接按站点类名取
        const direct = $1('.pagination-text');
        if (direct) {
            const s = (direct.textContent || '').trim();
            if (/^\d+\s*\/\s*\d+$/.test(s)) return s;
        }
        // 其次：从容器（.preview-pagination）的子节点里找 n/m 形态
        const wrap = $1(SEL.paginationWrap) || $1('.pagination-btn-wrap') || $1(SEL.paginationBtn);
        if (!wrap) return '';
        const parent = wrap.parentElement;
        for (const scope of [wrap, parent]) {
            if (!scope) continue;
            for (const c of Array.from(scope.children)) {
                const s = (c.textContent || '').trim();
                if (/^\d+\s*\/\s*\d+$/.test(s)) return s;
            }
        }
        // 兜底：从容器自身文本里提取
        const m = (wrap.textContent || '').match(/(\d+)\s*\/\s*(\d+)/);
        return m ? m[0] : '';
    }

    // 页面内容签名：用于判断翻页是否真的生效（不依赖 URL 变化）
    function pageSignature() {
        const activeChapter = $1('.chapter-section.active, .chapter-section.course.active, .chapter-section[data-active="true"]');
        const firstItem = $1(SEL.contentItem);
        const counter = paginationCounter();
        return [
            activeChapter && activeChapter.dataset && activeChapter.dataset.catalogId,
            firstItem && firstItem.dataset && firstItem.dataset.contentId,
            counter,
            $1(SEL.exercisePreview) ? getExerciseItems().length : 0,
            // 内容文本长度作为兜底信号（整章滚动时文本会变）
            ($1(SEL.readerRoot) ? ($1(SEL.readerRoot).textContent || '').length : 0)
        ].join('|');
    }

    // 通过路由跳转到指定 catalog（DOM 翻页失败时的兜底）
    function gotoCatalog(catalogId, contentId) {
        const r = parseReaderRoute();
        if (!r) return false;
        const q = new URLSearchParams();
        q.set('catalogId', String(catalogId));
        if (contentId) q.set('contentId', String(contentId));
        location.href = '/course_center/reader/' + r.type + '/' + r.bizId + '?' + q.toString();
        return true;
    }

    // ============================================================================
    // 8. 答题主流程
    // ============================================================================

    let lastAnswerMap = new Map();  // 最近一次取题拿到的标准答案
    let currentResp = null;         // 最近一次取题响应

    // 复刻站点 T()/E()：把 questionAnswerItemVOList 合并进 questionVOList 元素。
    //
    // 【为什么必须做】`doRecord` / `overWriteUserAnswer` / `userAnswer` 只存在于
    // questionAnswerItemVOList 的元素上；questionVOList 的元素里根本没有这些字段。
    // 站点前端会先把两者按 questionId 合并（见 src-DZ23PK2 的 T/E），再据此判断
    // 「这题答过没有」。引擎此前漏了这一步，导致 hasUserAnswer() 恒为 false ——
    // 已作答的题也会被当成未答，从而反复重做。
    function mergeAnswerItems(data) {
        if (!data) return data;
        const list = data.questionVOList || [];
        const items = data.questionAnswerItemVOList || [];
        const byId = new Map();
        items.forEach(it => byId.set(Number(it.questionId), it));
        const apply = (q) => {
            const n = byId.get(Number(q.id));
            if (n) {
                q.doRecord = n.overWriteUserAnswer || n.userAnswer || '';
                q.answer = n.answer || '';
                q.answerStatus = n.answerStatus;
                q.analysis = n.analysis;
                q.assessStatus = n.assessStatus;
            }
            if (q.children && q.children.length) q.children.forEach(apply);
        };
        list.forEach(apply);
        return data;
    }

    // 解析当前章节的 contentId。
    //
    // 【实测 2026-11】阅读器 URL 可能只有 ?catalogId=… 而**没有** contentId
    // （站点用 SPA 状态渲染内容，不回写 URL）。原实现直接读 query 参数，
    // 拿不到就 return null —— doOneRound 于是立刻返回，日志里连「取题失败」
    // 都没有，表现就是「点做一轮→两秒后本轮完成、页面一个字没动」。
    // 三级兜底：
    //   a) 站点自己发出的取题请求 URL 里带着 contentId（performance 资源计时可见）
    //   b) 该 catalog 的内容项列表的第一个
    //   c) DOM 上可能挂的 data-content-id
    // 【local18】parseReaderRoute() 每次调用都新建对象，回填到局部 r 上等于没回填：
    // submitAnswers() / apiMarkContentDone() 里重新 parse 一次就又是 contentId=null，
    // 于是提交走到 `if (!r || !r.contentId) return false` —— 静默失败，日志里连
    // 「提交失败」都没有。这里改成模块级缓存。
    let CONTENT_ID = null;
    function currentContentId() {
        const r = parseReaderRoute();
        return (r && r.contentId) || CONTENT_ID || null;
    }

    // 从 DOM 里收集「当前这一节真实在显示的题目 id」
    //   组合题子卡：div.exercise-item[data-child-question-id="20411"]
    //   普通卡：可能带 data-question-id
    function domQuestionIds(scopeEl) {
        const ids = new Set();
        const okScope = (el) => {
            if (!el) return false;
            if (scopeEl) return scopeEl.contains(el);
            return isShownEl(el) || !!visibleContentItem(el);
        };
        try {
            $('[data-child-question-id]').forEach(el => {
                if (!okScope(el)) return;
                const v = Number(el.getAttribute('data-child-question-id'));
                if (Number.isFinite(v) && v > 0) ids.add(v);
            });
            $('[data-question-id]').forEach(el => {
                if (!okScope(el)) return;
                const v = Number(el.getAttribute('data-question-id'));
                if (Number.isFinite(v) && v > 0) ids.add(v);
            });
            // 【local49】很多题卡既没有 data-question-id 也没有 data-child-question-id，
            // 题号只出现在题干容器的 id 上：<div id="do_20458" class="stem-content">。
            // 不读这个来源 → domIds 恒为 0 → contentId 只能盲选候选 → 提交写错内容。
            $('[id^="do_"], [id^="do-"]').forEach(el => {
                if (!okScope(el)) return;
                const m = String(el.id || '').match(/^do[-_](\d+)$/);
                if (m) ids.add(Number(m[1]));
            });
        } catch (e) {}
        return ids;
    }

    // 同一 catalog 的校验结果缓存：避免每轮都发起 2~5 次探测请求（正是限流的主要来源）
    const CONTENT_ID_CACHE = new Map();

    async function resolveContentId(r) {
        if (r && r.contentId) { CONTENT_ID = r.contentId; return r.contentId; }
        const cacheKey = r ? (r.bizId + '|' + r.catalogId) : '';
        if (cacheKey && CONTENT_ID_CACHE.has(cacheKey)) {
            CONTENT_ID = CONTENT_ID_CACHE.get(cacheKey);
            return CONTENT_ID;
        }

        // 候选集合：performance 里出现过的 + 本 catalog 的内容项列表
        const cands = [];
        const push = (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0 && cands.indexOf(n) < 0) cands.push(n);
        };
        try {
            const perf = (performance.getEntriesByType ? performance.getEntriesByType('resource') : []) || [];
            // 【local34】页面渲染可见内容项时先请求 /content/<id>/list，再请求 /content/<id>/answer。
            // 只认 answer 会漏掉正好在屏幕上那一项，因此两类都收。
            for (let i = perf.length - 1; i >= 0 && cands.length < 8; i--) {
                const m = String(perf[i].name || '').match(/\/content\/(\d+)\/(?:answer|list)/);
                if (m) push(m[1]);
            }
        } catch (e) {}
        try {
            if (r && r.catalogId) {
                const c = await apiGetContent(r.bizId, r.catalogId, r.contentType);
                const list = Array.isArray(c && c.data) ? c.data : ((c && c.data && c.data.list) || []);
                list.forEach(x => x && x.id && push(x.id));
            }
        } catch (e) {}

        // 【local21】用 DOM 上的题目 id 做**确定性**校验：
        // 候选 contentId 取回的题目 id（含子题 id）只要与 DOM 里出现的 id 有交集，
        // 就认定它就是屏幕上这一节。纯 performance 猜测会出现「取到别的节」的错位。
        const domIds = domQuestionIds();
        // 【local34】命中一个 id 就返回太脆：相邻内容项也会有个别 id 撞上。
        // 改为遍历候选、按交集数量打分，取分最高的；交集 >= min(3, domIds) 时提前结束。
        let best = null;
        const scores = [];
        for (const cid of cands.slice(0, 7)) {
            try {
                const resp = await apiGetExercise(cid, r && r.contentType, r && r.bizId, null);
                const qs = (resp && resp.data && resp.data.questionVOList) || [];
                const apiIds = new Set();
                const walk = (arr) => (arr || []).forEach(q => {
                    if (q && q.id) apiIds.add(Number(q.id));
                    if (q && q.children && q.children.length) walk(q.children);
                });
                walk(qs);
                let score = 0;
                domIds.forEach(id => { if (apiIds.has(id)) score++; });
                scores.push({ cid: cid, score: score, apiIds: apiIds.size });
                if (score > 0 && (!best || score > best.score)) best = { cid: cid, score: score, apiIds: apiIds.size };
                if (score >= Math.min(3, domIds.size)) break;
            } catch (e) {}
            await sleep(rnd(400, 800));
        }
        if (best) {
            CONTENT_ID = best.cid;
            if (cacheKey) CONTENT_ID_CACHE.set(cacheKey, best.cid);
            log('contentId 经 DOM 打分命中', {
                cid: best.cid,
                score: best.score,
                domIds: domIds.size,
                apiIds: best.apiIds,
                all: scores
            });
            return best.cid;
        }

        // 校验不成立时退回第一个候选（保持旧行为），但要明确告知
        if (cands.length) {
            CONTENT_ID = cands[0];
            if (cacheKey) CONTENT_ID_CACHE.set(cacheKey, cands[0]);
            log('contentId 未能与 DOM 校验一致，退回第一个候选', { picked: cands[0], candidates: cands, domIds: Array.from(domIds).slice(0, 8) });
            return CONTENT_ID;
        }
        return null;
    }

    // 拉取当前章节题目（含标准答案）
    async function loadCurrentExercise() {
        const r = parseReaderRoute();
        if (!r) return null;
        const cid = await resolveContentId(r);
        if (!cid) {
            status('无法确定本节 contentId（URL 只有 catalogId=' + r.catalogId + '，目录项也取不到），本轮跳过');
            return null;
        }
        if (!r.contentId) {
            r.contentId = cid;                                  // 回填，供后续 apiMarkContentDone 等使用
            log('contentId 由兜底解析得到', cid);
        }
        const resp = await apiGetExercise(cid, r.contentType, r.bizId, null);
        if (!resp || resp.code !== 200 || !resp.data) {
            status('取题失败：' + (resp && resp.message ? resp.message : '未知错误'));
            return null;
        }
        mergeAnswerItems(resp.data);        // ← 先合并，hasUserAnswer() 才能正确判断
        currentResp = resp.data;
        lastAnswerMap = buildAnswerMap(resp.data);
        const n = (resp.data.questionVOList || []).length;
        const k = lastAnswerMap.size;
        const done = (resp.data.questionVOList || []).filter(hasUserAnswer).length;
        log('取题成功：题目 ' + n + '，已答 ' + done + '，答案条目 ' + k, resp.data);
        // 【local44】等题卡挂载，避免拿空 DOM 下判断
        try {
            const waited = await waitForCards(8000);
            log('等待题卡挂载', { ms: waited, cards: getExerciseItems().length, domIds: domQuestionIds().size });
        } catch (e) {}
        // 【local38】站点到底会不会给这类题下发标准答案？把每条答案的状态压成一行，
        // 避免大 JSON 被日志行上限截断后看不见关键字段。
        try {
            const items = resp.data.questionAnswerItemVOList || [];
            const allQ = [];
            const walkQ = (arr) => (arr || []).forEach(q => {
                allQ.push(q);
                if (q && q.children && q.children.length) walkQ(q.children);
            });
            walkQ(resp.data.questionVOList || []);
            const typeOf = (id) => {
                const q = allQ.find(x => Number(x.id) === Number(id));
                return q ? (q.type || '?') : '?';
            };
            log('答案条目摘要', items.slice(0, 10).map(it => ({
                qid: Number(it.questionId || it.id),
                type: typeOf(it.questionId || it.id),
                st: it.answerStatus,
                score: it.score,
                hasAns: !!(it.answer && String(it.answer).trim()),
                ansLen: it.answer ? String(it.answer).length : 0
            })));
        } catch (e) {}
        // 【local34】对账：接口回来的题目 id 是否覆盖页面上的卡片 id。
        // 覆盖不全 = contentId 选错或该 content 只含部分题目，提前暴露，
        // 免得又走成「已作答完成 → 整节跳过」。
        try {
            const domIds = domQuestionIds();
            const apiIds = new Set();
            const walkIds = (arr) => (arr || []).forEach(q => {
                if (q && q.id) apiIds.add(Number(q.id));
                if (q && q.children && q.children.length) walkIds(q.children);
            });
            walkIds(resp.data.questionVOList || []);
            let hit = 0;
            domIds.forEach(id => { if (apiIds.has(id)) hit++; });
            log('题目对账', {
                domIds: domIds.size,
                apiIds: apiIds.size,
                overlap: hit,
                ok: domIds.size ? (hit === domIds.size) : '页面未读到题目 id'
            });
            if (domIds.size && hit < domIds.size) {
                status('注意：接口题目未覆盖页面全部卡片（' + hit + '/' + domIds.size + '），可能仍有题目被跳过');
            }
        } catch (e) {}
        // 【local7】服务端已确认记录的题，撤掉本地占位标记（避免误报"只有本地占位"）
        (resp.data.questionVOList || []).forEach(q => {
            if (q && !(q.children && q.children.length) && hasUserAnswer(q)) {
                PLACEHOLDER_IDS.delete(Number(q.id));
            }
        });
        return resp.data;
    }

    // 判断某道题是否已有作答
    // 判定某道题（含子题）是否已有作答。
    // 站点契约：createDoRecord 按题型给空初值 —— 裸串题型为 ''，多数题型为 []，
    // 主观题为 {answer:'',annex:[]}，角色扮演为 {roleId:'',answer:[]}。
    // 组合题需递归看子题。
    function hasUserAnswer(q) {
        if (!q) return false;
        if (q.children && q.children.length) {
            return q.children.some(hasUserAnswer);
        }
        const type = q.type;
        const raw = (q.doRecord !== undefined && q.doRecord !== null && q.doRecord !== '')
            ? q.doRecord
            : q.overWriteUserAnswer || q.userAnswer || '';

        if (raw === '' || raw === null || raw === undefined) return false;

        let v = raw;
        if (typeof v === 'string' && !BARE_SCALAR_TYPES.has(type)) {
            const s = v.trim();
            if (!s) return false;
            try { v = JSON.parse(s); } catch (e) { return true; }   // 非 JSON 的裸串视为已答
        }
        if (typeof v === 'string') return v.trim().length > 0;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'object') {
            // 主观题 {answer, annex} / 角色扮演 {roleId, answer}
            const ans = v.answer;
            if (Array.isArray(ans)) return ans.length > 0;
            if (typeof ans === 'string') return ans.trim().length > 0;
            if (ans !== undefined && ans !== null) return true;
            return Object.keys(v).some(k => {
                const x = v[k];
                if (Array.isArray(x)) return x.length > 0;
                if (typeof x === 'string') return x.trim().length > 0;
                return x !== undefined && x !== null;
            });
        }
        return true;
    }

    // 用标准答案填充当前页面所有题卡
    async function fillByAnswerMap() {
        const items = getExerciseItems();
        if (!items.length) return { filled: 0, total: 0 };
        if (!lastAnswerMap.size) return { filled: 0, total: items.length };

        const list = (currentResp && currentResp.questionVOList) || [];
        let filled = 0;

        for (let i = 0; i < list.length; i++) {
            const q = list[i];
            const card = findCardForQuestion(items, q, i);
            if (!card || !q) continue;

            // 组合题：答案在子题上，逐个子题回填
            if (q.children && q.children.length) {
                // 【local42】查看态（readonly-answer）没有输入框，先点 Retry 回到作答态
                if (!firstEditableControl()) {
                    const okState = await ensureEditableState(card);
                    log('组合题回填前确保作答态', { ok: okState });
                    if (okState) await sleep(rnd(500, 900));
                }
                const n = await applyCompositeAnswers(card, q);
                log('组合题回填', {
                    filled: n,
                    kids: q.children.length,
                    subCards: card.querySelectorAll('.exercise-item[data-child-question-id]').length,
                    childAnswerIds: q.children.map(c => Number(c.id)).slice(0, 6)
                });
                if (n) filled += n;
                await sleep(rnd(120, 260));
                continue;
            }

            const type = q.type || detectType(card);
            const ans = lastAnswerMap.get(Number(q.id));
            if (!ans || ans.answer === undefined || ans.answer === null || ans.answer === '') continue;

            // 填空类的答案是结构化数组，需要摊平；"答案多样"的主观填空返回 null 跳过
            const value = AI_FILL_TYPES.has(type) ? normalizeFillAnswer(ans.answer) : decodeAnswer(ans.answer, type);
            if (value === null || value === undefined) continue;

            const ok = (type === TYPE.JUDGE_HIGH)
                ? await applyJudgeHigh(card, q, value)
                : (type === TYPE.MULTIPLE
                    ? await fillMultipleChoice(card, value)
                    : (type === TYPE.SINGLE ? await fillSingleChoice(card, value) : applyAnswer(card, type, value)));
            if (ok) { markAnswered(q, value, card); filled++; }
            await sleep(rnd(120, 260));
        }
        return { filled, total: items.length };
    }

    // 按题型把答案写入 DOM
    // 取出卡片内各选项对应的"提交值"。
    // 关键证据（src-DqZ23PK2.js，SingleChoiceCourseDone / 判断分支）：
    //   <RadioGroup value={doRecord}>
    //     {extension.map((e,t) => <Radio value={e.idx}>{yO(t)}. {e.val}</Radio>)}   // 显示字母，值却是 idx
    //     判断题特例：<Radio value="1">A、正确</Radio> <Radio value="0">B、错误</Radio>
    //   单选回显：extension.findIndex(t => t.idx === answer)
    //   多选回显：Array.isArray(answer) && answer.includes(e.idx)
    // 即 answer / doRecord 的线格式是 option 的 **idx 值**，不是字母。
    // 因此优先读 DOM 上真实的 input.value 来匹配，而不是猜字母映射。
    function getOptionValues(card) {
        const opts = getOptions(card);
        return opts.map((o, i) => {
            const input = $1('input', o);
            if (input && input.value !== undefined && input.value !== '') return String(input.value);
            const radio = $1('[value]', o);
            if (radio && radio.getAttribute('value') !== null) return String(radio.getAttribute('value'));
            return String(i);
        });
    }

    // 把答案值解析为"要点击的选项下标"列表。
    // 兼容三种形态：站点 idx 值、字母 A/B、纯下标。
    function resolveOptionIndexes(card, value) {
        const opts = getOptions(card);
        if (!opts.length) return [];
        const values = getOptionValues(card);
        const raws = Array.isArray(value) ? value : [value];
        const out = [];
        for (const raw of raws) {
            if (raw === undefined || raw === null) continue;
            const s = String(raw).trim();
            if (!s) continue;
            // 1) 直接匹配 DOM 上的提交值（最可靠）
            let idx = values.indexOf(s);
            // 2) 数字形态：先当 idx 值匹配，再当 0-based 下标
            if (idx < 0 && /^\d+$/.test(s)) {
                const n = Number(s);
                idx = values.indexOf(String(n));
                if (idx < 0 && n >= 0 && n < opts.length) idx = n;
            }
            // 3) 字母形态：转 0-based 下标（仅当答案确实用字母表示时）
            if (idx < 0 && /^[A-Za-z]$/.test(s)) {
                const n = s.toUpperCase().charCodeAt(0) - 65;
                if (n >= 0 && n < opts.length) idx = n;
            }
            // 4) 布尔/中文形态（判断题）
            if (idx < 0) {
                if (/^(true|对|正确|1)$/i.test(s)) idx = values.indexOf('1') >= 0 ? values.indexOf('1') : 0;
                else if (/^(false|错|错误|0)$/i.test(s)) idx = values.indexOf('0') >= 0 ? values.indexOf('0') : 1;
            }
            if (idx >= 0 && idx < opts.length && out.indexOf(idx) < 0) out.push(idx);
        }
        return out;
    }

    // ---- 拖拽类作答（matching_onetoonedrag / matching_onetomanydrag / matching_dragfillblank）----
    //
    // 【站点契约，已证实】事件序列（DragDropOneCourseDo @855532 / 组合式函数 MR @844180）：
    //   dragstart  → dataTransfer.setData('text/plain', item.idx)，effectAllowed='move'
    //   dragover   → preventDefault()，dropEffect='move'
    //   dragenter  → 记录 activeDropZoneId
    //   drop       → 读 dataTransfer.getData('text/plain') 写入 answer
    //
    // 投放区结构：div.drag-drop-container > div.drop-zone-list > div.drop-zone-item-wrapper
    //             （绑定 onDrop / onDragover / onDragenter / onDragleave）
    // 可拖项结构：div.drag-item-list > div.drag-item.drag-item-with-handle[draggable="true"]
    //             （绑定 onDragstart / onDragend）
    //
    // 字段语义（与命名直觉相反，以代码为准）：
    //   extension.drag    → 投放目标（drop-zone-item-wrapper）
    //   extension.dragged → 可拖拽项（drag-item[draggable]）
    //
    // answer 形状：
    //   onetoonedrag / onetomanydrag → [{ idx:"<投放区idx>", answer:["<拖拽项idx>", ...] }]
    //   dragfillblank                → [{ idx:"<blankId>",  answer:"<拖拽项idx>" }]（扁平）
    function applyDragAnswer(card, type, value) {
        try {
            // 【local73】先量清这页拖拽题的真实结构：拖拽源、投放区、是否用 HTML5 DnD。
            try {
                const drags = card.querySelectorAll('[draggable="true"]');
                const zones = card.querySelectorAll('.drop-zone-item-wrapper, .drop-zone-list, .drag-drop-container, [class*="drop-zone"], [class*="blank-placeholder"]');
                const pairs = normalizeDragPairs(type, value);
                log('拖拽结构', {
                    type: type,
                    draggable: drags.length,
                    dropZones: zones.length,
                    pairs: pairs.length,
                    sampleDraggable: drags.length ? String(drags[0].className || drags[0].tagName).slice(0, 50) : null,
                    sampleZone: zones.length ? String(zones[0].className || zones[0].tagName).slice(0, 50) : null,
                    firstPair: pairs[0] ? { zone: pairs[0].zone, item: String(pairs[0].item).slice(0, 20) } : null
                });
            } catch (e) {}
            const pairs = normalizeDragPairs(type, value);
            if (!pairs.length) return false;

            if (type === TYPE.DRAG_FILL) {
                // 拖拽填空：目标是题干内的 span.blank-placeholder[data-blank-id]
                let any = false;
                pairs.forEach(p => {
                    const target = $1('.blank-placeholder[data-blank-id="' + p.zone + '"], .inline-answer[data-blank-id="' + p.zone + '"]', card);
                    const src = findDragSource(card, p.item);
                    if (target && src) { simulateDragDrop(src, target, p.item); any = true; }
                });
                return any;
            }

            // 普通拖拽：目标是 div.drop-zone-item-wrapper（按 extension.drag 的 idx 匹配）
            const zones = $('.drop-zone-item-wrapper', card);
            if (!zones.length) return false;
            let any = false;
            pairs.forEach(p => {
                const zone = findDropZone(card, zones, p.zone);
                const src = findDragSource(card, p.item);
                if (zone && src) { simulateDragDrop(src, zone, p.item); any = true; }
            });
            return any;
        } catch (e) {
            log('拖拽作答失败', type, e);
            return false;
        }
    }

    // 归一化拖拽答案为 [{zone, item}]，兼容两种站点形状
    function normalizeDragPairs(type, value) {
        const out = [];
        let v = value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return out; } }
        if (!Array.isArray(v)) return out;
        v.forEach(entry => {
            if (!entry || entry.idx === undefined) return;
            const zone = String(entry.idx);
            if (type === TYPE.DRAG_FILL) {
                // 扁平：answer 是单项字符串
                const it = Array.isArray(entry.answer) ? entry.answer[0] : entry.answer;
                if (it !== undefined && it !== null && it !== '') out.push({ zone, item: String(it) });
            } else {
                const arr = Array.isArray(entry.answer) ? entry.answer : [entry.answer];
                arr.forEach(it => {
                    if (it !== undefined && it !== null && it !== '') out.push({ zone, item: String(it) });
                });
            }
        });
        return out;
    }

    // 按 extension.drag 的顺序找到投放区（站点按 extension.drag 渲染 drop-zone-item-wrapper）
    function findDropZone(card, zones, zoneIdx) {
        // 优先：按 data 属性匹配（若站点渲染了 idx）
        const byData = $1('[data-idx="' + zoneIdx + '"]', card) ||
            $1('[data-drop-zone-idx="' + zoneIdx + '"]', card);
        if (byData) return byData;
        // 兜底：按 extension.drag 数组下标定位
        const ext = getCardExtension(card);
        if (ext && Array.isArray(ext.drag)) {
            const i = ext.drag.findIndex(d => String(d.idx) === zoneIdx);
            if (i >= 0 && zones[i]) return zones[i];
        }
        return null;
    }

    // 找到可拖拽项元素（按 extension.dragged 的 idx 定位到 div.drag-item[draggable]）
    function findDragSource(card, itemIdx) {
        const draggables = $('.drag-item[draggable="true"], .drag-item', card);
        if (!draggables.length) return null;
        const byData = $1('[data-idx="' + itemIdx + '"]', card);
        if (byData) return byData;
        const ext = getCardExtension(card);
        if (ext && Array.isArray(ext.dragged)) {
            const i = ext.dragged.findIndex(d => String(d.idx) === itemIdx);
            if (i >= 0 && draggables[i]) return draggables[i];
        }
        return null;
    }

    // 从当前题目数据里取 extension（可能为 JSON 字符串）
    function getCardExtension(card) {
        const list = (currentResp && currentResp.questionVOList) || [];
        const id = card && card.dataset ? card.dataset.questionId : null;
        const q = (id && list.find(x => Number(x.id) === Number(id))) ||
            list[getExerciseItems().indexOf(card)];
        if (!q) return null;
        let ext = q.extension;
        if (typeof ext === 'string') { try { ext = JSON.parse(ext); } catch (e) { return null; } }
        return ext || null;
    }

    // 构造并派发完整 DnD 事件序列（含 dataTransfer 桩，因为脚本无法持有真实 DataTransfer）
    function simulateDragDrop(srcEl, dstEl, payload) {
        const dt = makeDataTransfer();
        dt.setData('text/plain', String(payload));

        fireDragEvent(srcEl, 'dragstart', dt);
        fireDragEvent(dstEl, 'dragenter', dt);
        fireDragEvent(dstEl, 'dragover', dt);
        fireDragEvent(dstEl, 'drop', dt);
        fireDragEvent(srcEl, 'dragend', dt);
        return true;
    }

    // 最小 DataTransfer 实现（站点只用到 setData/getData/effectAllowed/dropEffect）
    function makeDataTransfer() {
        const store = {};
        return {
            effectAllowed: '',
            dropEffect: '',
            files: [],
            types: [],
            setData(k, v) { store[k] = String(v); if (this.types.indexOf(k) < 0) this.types.push(k); },
            getData(k) { return store[k] === undefined ? '' : store[k]; },
            clearData() { Object.keys(store).forEach(k => delete store[k]); },
            setDragImage() {}
        };
    }

    // 派发拖拽事件并挂上 dataTransfer（DragEvent 在部分环境不可构造，退回 Event + 属性注入）
    function fireDragEvent(el, type, dt) {
        if (!el) return false;
        let ev;
        try {
            ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        } catch (e) {
            ev = new Event(type, { bubbles: true, cancelable: true });
        }
        // 兜底：确保 dataTransfer 一定可读（站点直接读 e.dataTransfer）
        try {
            if (!ev.dataTransfer) Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
        } catch (e) {}
        el.dispatchEvent(ev);
        return true;
    }

    // 按题型把答案写入 DOM
    // 【local65】多选必须异步填：clickSeq 会同步触发 v-model 变更 → Vue 重建整组选项，
    // 手里那个 input 立刻变成脱离文档的死节点，写 checked 等于写进虚空。
    // 所以要「点击 → 等重建 → 重新取节点 → 置位 → 再验证」，全程 await。
    // 【local66】单选题与多选同一病根：antd 受控组件在 click 后重建整组 radio，
    // 手里的 input 立刻失效。同样要「点击 → 等 → 重新取节点 → 置位 → 验证」，
    // 并且按 input.value === 答案 uuid 精确匹配（不能按下标）。
    // 【local67】判断题只有两个选项：答错就等价于"答案是另一个"。
    // 不需要跑 errorNumShow 轮试错，直接取反提交一次即可。
    // 【local70】judge_advanced 是"多行对/错"：每个 topic 一组 radio（name 相同）。
    // flipJudgeAnswer 只处理"两个选项"的单行判断，这里按 radio group 逐行取反。
    // 【local71】不碰 UI 的取反：选项值可从 DOM 读，答案格式已知，
    // 直接算出"另一个答案"写进提交模型走接口。彻底绕开 antd 节点重建问题。
    function computeFlippedAnswer(card, q) {
        const vals = getOptionValues(card).filter(v => v !== '');
        const cur = String((q && q.doRecord) || '').trim();
        // 1) 单值型（判断题 / 两选项单选）：换另一个 uuid
        if (q.type === TYPE.JUDGE || q.type === TYPE.SINGLE || vals.length === 2) {
            if (vals.length !== 2) return undefined;
            const other = vals[0] === cur ? vals[1] : (vals[1] === cur ? vals[0] : vals[vals.length - 1]);
            if (!other || other === cur) return undefined;
            return other;
        }
        // 2) judge_advanced：doRecord = [{idx: topic, answer: option}]
        if (q.type === TYPE.JUDGE_HIGH) {
            let ext = null;
            try { ext = typeof q.extension === 'string' ? JSON.parse(q.extension) : q.extension; } catch (e) { return undefined; }
            const opts = (ext && ext.option) || [];
            const topics = (ext && ext.topic) || [];
            if (!opts.length || !topics.length) return undefined;
            const curMap = {};
            try { (JSON.parse(cur) || []).forEach(it => { if (it && it.idx) curMap[it.idx] = it.answer; }); } catch (e) {}
            return topics.map(t => {
                const chosen = curMap[t.idx];
                const other = opts.find(o => o.idx !== chosen) || opts[0];
                return { idx: t.idx, answer: other.idx };
            });
        }
        return undefined;
    }

    // 【local72】judge_advanced 是 n 个 topic × 2 选项 = 2^n 种组合，
    // "全部取反"只有 1/2^n 的概率对。要稳拿分只能穷举：每种组合提交一次，判对即停。
    async function readQuestionStatus(qid) {
        try {
            const r = parseReaderRoute();
            const cid = (r && r.contentId) || CONTENT_ID;
            const resp = await apiGetExercise(cid, r && r.contentType, r && r.bizId, null);
            const items = (resp && resp.data && resp.data.questionAnswerItemVOList) || [];
            const it = items.find(x => Number(x.questionId) === Number(qid)) || items.find(x => Number(x.id) === Number(qid));
            return it ? { st: Number(it.answerStatus), answer: it.answer || '' } : null;
        } catch (e) { return null; }
    }

    // 【local73】穷举按用户要求停用：32 次提交太慢太吵，判断题不再穷举。
    const BRUTE_JUDGE_ENABLED = false;

    async function bruteForceJudge(q, card) {
        if (!BRUTE_JUDGE_ENABLED) return false;
        let topics = [], opts = [];
        const curArr = (() => {
            try { return JSON.parse(String(q.doRecord || '[]')) || []; } catch (e) { return []; }
        })();
        if (q.type === TYPE.JUDGE_HIGH) {
            let ext = null;
            try { ext = typeof q.extension === 'string' ? JSON.parse(q.extension) : q.extension; } catch (e) { return false; }
            topics = (ext && ext.topic) || [];
            opts = (ext && ext.option) || [];
            if (!topics.length || opts.length < 2) return false;
        } else {
            // 两选项单行判断：直接把两个值当"选项"
            const vals = getOptionValues(card).filter(v => v !== '');
            if (vals.length !== 2) return false;
            topics = [{ idx: '_' }];
            opts = [{ idx: vals[0] }, { idx: vals[1] }];
        }
        const n = Math.min(topics.length, 6);
        const total = 1 << n;
        // 起点：沿用当前作答（若能解析），否则从全 0 开始
        const curMap = {};
        (Array.isArray(curArr) ? curArr : []).forEach(it => { if (it && it.idx) curMap[it.idx] = it.answer; });

        for (let m = 0; m < total; m++) {
            let ans;
            if (q.type === TYPE.JUDGE_HIGH) {
                ans = topics.map((t, i) => {
                    const bit = (m >> i) & 1;
                    return { idx: t.idx, answer: opts[bit % opts.length].idx };
                });
            } else {
                ans = opts[m & 1].idx;
            }
            markAnswered(q, ans, card);
            status('判断题穷举 ' + (m + 1) + '/' + total);
            const ok = await submitAnswers(true);
            if (!ok) { log('穷举提交失败', { m: m }); continue; }
            await sleep(rnd(700, 1200));
            const st = await readQuestionStatus(q.id);
            log('穷举回查', { try: m + 1, total: total, st: st && st.st, hasAns: !!(st && st.answer) });
            if (st && st.st === 1) {
                status('判断题穷举成功（第 ' + (m + 1) + '/' + total + ' 种）');
                return true;
            }
            if (st && st.answer) {
                // 服务端终于下发答案 → 直接按答案提交
                const val = decodeAnswer(st.answer, q.type);
                markAnswered(q, val, card);
                await submitAnswers(true);
                const st2 = await readQuestionStatus(q.id);
                log('按下发答案提交', { st: st2 && st2.st });
                if (st2 && st2.st === 1) return true;
            }
        }
        return false;
    }

    async function flipJudgeRows(card) {
        const q2 = 'input[type="radio"], input[type="checkbox"]';
        const all = Array.prototype.slice.call(card.querySelectorAll(q2));
        const names = [];
        all.forEach(i => { const k = i.name || '_'; if (names.indexOf(k) < 0) names.push(k); });
        let flipped = 0;
        for (const name of names) {
            const pick = () => Array.prototype.slice.call(card.querySelectorAll(q2))
                .filter(i => (i.name || '_') === name);
            let group = pick();
            if (group.length !== 2) continue;
            const curIdx = group.findIndex(i => i.checked);
            const targetIdx = curIdx === 0 ? 1 : 0;
            let t = pick()[targetIdx];
            if (!t) continue;
            try { clickSeq(t.closest('.ant-radio-wrapper, .ant-checkbox-wrapper') || t); } catch (e) {}
            await sleep(110);
            t = pick()[targetIdx] || t;
            try {
                if (!t.checked) {
                    t.checked = true;
                    t.dispatchEvent(new Event('input', { bubbles: true }));
                    t.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            if (t.checked) flipped++;
        }
        log('多行判断取反', { rows: names.length, flipped: flipped });
        return flipped;
    }

    async function flipJudgeAnswer(card, q) {
        const opts = getOptions(card);
        if (opts.length !== 2) {
            log('判断题选项数异常', { n: opts.length, id: q && q.id });
            return false;
        }
        const valOf = (o) => {
            const inp = o.querySelector ? o.querySelector('input') : null;
            return inp ? String(inp.value || '') : '';
        };
        const cur = String((q && q.doRecord) || '').trim();
        let curIdx = -1;
        if (cur) {
            for (let i = 0; i < opts.length; i++) {
                if (valOf(opts[i]) === cur) { curIdx = i; break; }
            }
        }
        if (curIdx < 0) {
            for (let i = 0; i < opts.length; i++) {
                const inp = opts[i].querySelector ? opts[i].querySelector('input') : null;
                if (inp && inp.checked) { curIdx = i; break; }
            }
        }
        const targetIdx = curIdx === 0 ? 1 : 0;
        const target = getOptions(card)[targetIdx];
        if (!target) return false;
        try { clickSeq(target); } catch (e) {}
        await sleep(120);
        const again = getOptions(card)[targetIdx] || target;
        const inp2 = again.querySelector ? again.querySelector('input') : null;
        try {
            if (inp2 && !inp2.checked) {
                inp2.checked = true;
                inp2.dispatchEvent(new Event('input', { bubbles: true }));
                inp2.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {}
        await sleep(80);
        const nowInp = (getOptions(card)[targetIdx] || again).querySelector
            ? (getOptions(card)[targetIdx] || again).querySelector('input') : null;
        const ok = !!(nowInp && nowInp.checked);
        const newVal = nowInp ? String(nowInp.value || '') : valOf(target);
        log('判断取反', { id: q && q.id, from: curIdx, to: targetIdx, newVal: newVal.slice(0, 12), ok: ok });
        if (!ok) return false;
        markAnswered(q, newVal, card);
        return true;
    }

    async function fillSingleChoice(card, value) {
        const idv = typeof value === 'object' ? (value && value.idx) : value;
        if (idv === undefined || idv === null || idv === '') return false;
        const want = String(idv);
        const findOpt = () => {
            const opts = getOptions(card);
            for (const o of opts) {
                const inp = o.querySelector ? o.querySelector('input') : null;
                if (inp && String(inp.value) === want) return { opt: o, inp: inp };
            }
            return null;
        };
        let hit = findOpt();
        if (!hit) {
            log('单选未匹配到选项', {
                want: want.slice(0, 12),
                domValues: getOptionValues(card).slice(0, 8)
            });
            return false;
        }
        try { clickSeq(hit.opt); } catch (e) {}
        await sleep(120);
        hit = findOpt() || hit;
        try {
            if (!hit.inp.checked) {
                hit.inp.checked = true;
                hit.inp.dispatchEvent(new Event('input', { bubbles: true }));
                hit.inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
        } catch (e) {}
        await sleep(80);
        const now = findOpt();
        const ok = !!(now && now.inp.checked);
        log('单选回填', { want: want.slice(0, 12), checked: ok, optsNow: getOptions(card).length });
        return ok;
    }

    async function fillMultipleChoice(card, value) {
        const ids = (Array.isArray(value) ? value : [value]).map(v => String(v));
        const findOpt = (idv) => {
            const opts = getOptions(card);
            for (const o of opts) {
                const inp = o.querySelector ? o.querySelector('input') : null;
                if (inp && String(inp.value) === idv) return { opt: o, inp: inp };
            }
            return null;
        };
        const missing = [];
        let okCount = 0;
        for (const idv of ids) {
            let hit = findOpt(idv);
            if (!hit) { missing.push(idv.slice(0, 8)); continue; }
            try { clickSeq(hit.opt); } catch (e) {}
            await sleep(120);                       // 等 Vue 重建
            hit = findOpt(idv) || hit;              // 重新取最新节点
            try {
                if (!hit.inp.checked) {
                    hit.inp.checked = true;
                    hit.inp.dispatchEvent(new Event('input', { bubbles: true }));
                    hit.inp.dispatchEvent(new Event('change', { bubbles: true }));
                }
            } catch (e) {}
            await sleep(80);
            const now = findOpt(idv);
            if (now && now.inp.checked) okCount++;
        }
        log('多选回填', {
            wantN: ids.length,
            checkedMatched: okCount,
            optsNow: getOptions(card).length,
            missing: missing.slice(0, 4),
            ok: okCount >= ids.length
        });
        return okCount >= ids.length;
    }

    function applyAnswer(card, type, value) {
        try {
            switch (type) {
                case TYPE.SINGLE:
                case TYPE.JUDGE: {
                    const idxs = resolveOptionIndexes(card, value);
                    if (!idxs.length) return false;
                    return selectOption(getOptions(card)[idxs[0]]);
                }
                case TYPE.JUDGE_HIGH: {
                    // 多小题判断：doRecord 是数组（每子题一个答案），不是裸标量
                    const arr = Array.isArray(value) ? value : [value];
                    const rows = $('.judge-option-item', card);
                    if (!rows.length) return false;
                    let any = false;
                    rows.forEach((row, i) => {
                        if (arr[i] === undefined) return;
                        // 【登录态实测修正】.option-line 线上不存在，优先 antd 选项容器
                        const opts = $('.ant-radio-wrapper', row).length ? $('.ant-radio-wrapper', row)
                            : ($('.option-line', row).length ? $('.option-line', row) : $('label', row));
                        const idxs = resolveOptionIndexes(row, arr[i]);
                        if (idxs.length && opts[idxs[0]]) { selectOption(opts[idxs[0]]); any = true; }
                    });
                    return any;
                }
                case TYPE.MULTIPLE: {
                    // 【local63】不能按下标点选项：实测同一张卡里可能混着 12 个选项元素
                    // （题目选项 + 其他小题的选项），下标一错位就只勾上 1 个。
                    // 改为按 input.value === 答案 uuid 精确匹配，与顺序无关。
                    const ids = (Array.isArray(value) ? value : [value]).map(v => String(v));
                    const findOpt = (idv) => {
                        const opts = getOptions(card);          // 每次重新查询（Vue 会重建节点）
                        for (const o of opts) {
                            const inp = o.querySelector ? o.querySelector('input') : null;
                            if (inp && String(inp.value) === idv) return { opt: o, inp: inp };
                        }
                        return null;
                    };
                    let any = false;
                    const missing = [];
                    for (const idv of ids) {
                        const hit = findOpt(idv);
                        if (!hit) { missing.push(idv.slice(0, 8)); continue; }
                        try { clickSeq(hit.opt); } catch (e) {}
                        try {
                            if (hit.inp.type === 'checkbox' || hit.inp.type === 'radio') {
                                hit.inp.checked = true;
                                hit.inp.dispatchEvent(new Event('input', { bubbles: true }));
                                hit.inp.dispatchEvent(new Event('change', { bubbles: true }));
                            } else {
                                hit.inp.click();
                            }
                            any = true;
                        } catch (e) {}
                    }
                    const after = getOptions(card);
                    const checkedIds = after.filter(o => {
                        const inp = o.querySelector ? o.querySelector('input') : null;
                        return (inp && inp.checked) || /-checked/.test(String(o.className || ''));
                    }).map(o => {
                        const inp = o.querySelector ? o.querySelector('input') : null;
                        return inp ? String(inp.value || '') : '?';
                    });
                    const hitCount = ids.filter(idv => checkedIds.indexOf(idv) >= 0).length;
                    log('多选回填', {
                        wantN: ids.length,
                        checkedMatched: hitCount,
                        checkedTotal: checkedIds.length,
                        optsNow: after.length,
                        missing: missing.slice(0, 4),
                        ok: hitCount >= ids.length
                    });
                    if (!any) return false;
                    return hitCount >= ids.length;
                }
                case TYPE.FILL:
                case TYPE.FILL_DIALOG:
                case TYPE.FILL_IMAGE:
                case TYPE.FILL_CLOZE:
                case TYPE.FILL_CLOZE_MN: {
                    const blanks = $('.zty-exercise-item-fill-blank-do', card);
                    if (!blanks.length) {
                        const inputs = $('input[type="text"], input:not([type])', card);
                        if (!inputs.length) return false;
                        const arr = Array.isArray(value) ? value : [value];
                        inputs.forEach((inp, i) => { if (arr[i] !== undefined) fillInput(inp, String(arr[i])); });
                        return true;
                    }
                    const arr = Array.isArray(value) ? value
                        : (value && typeof value === 'object' ? Object.values(value) : String(value).split('|'));
                    blanks.forEach((b, i) => { if (arr[i] !== undefined) fillEditable(b, String(arr[i])); });
                    return true;
                }
                case TYPE.DROP_PARA:
                case TYPE.DROP_IMG: {
                    const selects = $('.ant-select', card);
                    if (!selects.length) return false;
                    const arr = Array.isArray(value) ? value : [value];
                    selects.forEach((sel, i) => {
                        if (arr[i] === undefined) return;
                        clickSeq(sel);
                        const opt = $('.ant-select-item-option')[Number(arr[i]) - 1] || $('.ant-select-item-option')[0];
                        if (opt) clickSeq(opt);
                    });
                    return true;
                }
                case TYPE.WRITING:
                case TYPE.TRANSLATE:
                case TYPE.QA:
                case TYPE.CORRECT: {
                    // 主观题：doRecord 形态为 {answer, annex}；答案是文本
                    const text = (value && typeof value === 'object' && !Array.isArray(value))
                        ? (value.answer || '')
                        : (Array.isArray(value) ? value.join('') : String(value || ''));
                    if (!String(text).trim()) return false;
                    const ta = $1('textarea', card);
                    if (ta) return fillInput(ta, String(text));
                    const ce = $1('[contenteditable="true"]', card) ||
                        $1('.zty-exercise-item-fill-blank-do', card);
                    if (ce) return fillEditable(ce, String(text));
                    const inp = $1('input[type="text"], input:not([type])', card);
                    if (inp) return fillInput(inp, String(text));
                    return false;
                }
                case TYPE.DRAG_ONE:
                case TYPE.DRAG_MANY:
                case TYPE.DRAG_FILL: {
                    return applyDragAnswer(card, type, value);
                }
                default:
                    // 未适配题型：记录但不阻断
                    return false;
            }
        } catch (e) {
            log('填充失败', type, e);
            return false;
        }
    }

    // 点击提交按钮（antd a-button，文案 Submit）
    // 【local25】原来的按钮查找只认 `button` 且文本必须**精确**等于 Submit/Retry。
    // 实测本站按钮常是 antd 的 `<div class="ant-btn">`、或 .ly-button 这类自绘元素，
    // 文本也可能带空格/后缀，于是 findRetryButton() 恒为 null →
    // 「无法进入作答态（重做按钮不可用）」。改为：多选择器 + 宽松匹配。
    // 【local28】「真人式点击」：先滚动进视口，再按坐标取**命中的最顶层元素**派事件。
    // 本站的 Retry 是 div.right-button，监听器多半挂在内层 span/图标上；
    // 对包装层合成事件 Vue 不认，所以手动点有效、脚本点无效。
    function realClick(el, label) {
        if (!el) return false;
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) {
            log('realClick: 元素不可见，退回普通 click', { label: label, rect: [Math.round(r ? r.width : 0), Math.round(r ? r.height : 0)] });
            clickSeq(el);
            try { el.click(); } catch (e) {}
            return true;
        }
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        let hit = el;
        try { hit = document.elementFromPoint(x, y) || el; } catch (e) {}
        log('realClick 落点', {
            label: label,
            hit: hit.tagName,
            hitCls: String(hit.className || '').slice(0, 40),
            x: x, y: y
        });
        const seq = ['pointerover', 'pointerenter', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
        const fire = (node) => {
            if (!node) return;
            seq.forEach(type => {
                const isPointer = type.indexOf('pointer') === 0;
                const opts = {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: x, clientY: y, view: window, button: 0,
                    buttons: type.indexOf('down') >= 0 ? 1 : 0
                };
                try {
                    node.dispatchEvent(isPointer ? new PointerEvent(type, opts) : new MouseEvent(type, opts));
                } catch (e) {}
            });
            try { node.click(); } catch (e) {}
        };
        fire(hit);
        if (hit !== el) fire(el);
        if (el.parentElement) fire(el.parentElement);
        return true;
    }

    // 【local35】"隐藏"判定要更宽：预加载的相邻内容项是 display:none → 尺寸 0。
    // 用它把不可见 content-item 里的卡片和题目 id 全部排除，
    // 否则 domIds / 提交按钮都会指到看不见的那些上。
    // 【local41】不能用"尺寸为 0"判不可见：虚拟滚动/过渡动画期间真实题卡也会是 0×0，
    // 结果整页题卡全被判隐藏 → domIds=0 → 回填 0 题 → 直接宣布"已完成"。
    // 只看祖先链上有没有 display:none / visibility:hidden（预加载内容项正是 display:none）。
    function isShownEl(el) {
        if (!el) return false;
        let n = el;
        try {
            while (n && n.nodeType === 1) {
                const st = window.getComputedStyle(n);
                if (st.display === 'none' || st.visibility === 'hidden') return false;
                n = n.parentElement;
            }
        } catch (e) { return true; }
        return true;
    }

    function visibleContentItem(el) {
        const ci = el && el.closest ? el.closest('.content-item') : null;
        if (!ci) return null;
        return isShownEl(ci) ? ci : null;
    }

    function isVisibleEl(el) {
        if (!el) return false;
        try {
            const r = el.getBoundingClientRect();
            if (!r || r.width <= 0 || r.height <= 0) return false;
            const cs = getComputedStyle(el);
            if (!cs) return true;
            if (cs.visibility === 'hidden' || cs.display === 'none') return false;
            if (Number(cs.opacity) === 0) return false;
            return true;
        } catch (e) { return true; }
    }

    function findClickableByText(re, extraSelector) {
        const scope = $1(SEL.exercisePreview) || document;
        const sel = 'button, .ant-btn, [role="button"], .ly-button' + (extraSelector ? ', ' + extraSelector : '');
        const els = $(sel, scope);
        const matched = [];
        for (let i = 0; i < els.length; i++) {
            const el = els[i];
            if (el.disabled) continue;
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (re.test(t)) matched.push(el);
        }
        if (matched.length > 1 || (matched.length && !isVisibleEl(matched[0]))) {
            log('按钮候选', {
                matched: matched.length,
                visible: matched.filter(isVisibleEl).length,
                detail: matched.slice(0, 4).map(e => ({
                    tag: e.tagName,
                    cls: String(e.className || '').slice(0, 40),
                    visible: isVisibleEl(e)
                }))
            });
        }
        const vis = matched.find(isVisibleEl);
        return vis || matched[0] || null;
    }

    // 【local30】本站的 Submit / Retry 都是自绘 div（实测 div.right-button），
    // 不在 button/.ant-btn/.ly-button 里。按文本全页扫一遍最内层可见节点。
    function scanByTextExact(re) {
        const all = document.querySelectorAll('div, button, span, a, i');
        const hits = [];
        for (let i = 0; i < all.length && hits.length < 8; i++) {
            const el = all[i];
            const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!re.test(t)) continue;
            // 只取最内层（子元素里没有同样文本的）
            let inner = true;
            for (let k = 0; k < el.children.length; k++) {
                const ct = String(el.children[k].textContent || '').replace(/\s+/g, ' ').trim();
                if (ct === t) { inner = false; break; }
            }
            if (!inner) continue;
            hits.push(el);
        }
        const vis = hits.filter(isVisibleEl);
        if (vis.length || hits.length) {
            log('按钮扫描', {
                matched: hits.length,
                visible: vis.length,
                detail: hits.slice(0, 4).map(e => ({
                    tag: e.tagName,
                    cls: String(e.className || '').slice(0, 36),
                    visible: isVisibleEl(e)
                }))
            });
        }
        return vis[0] || hits[0] || null;
    }

    function findSubmitButton(scopeEl) {
        // 【local35】内容项各有一个 Submit。全局扫会命中隐藏项的按钮 → 点了没反应。
        const roots = [];
        if (scopeEl) roots.push(scopeEl);
        // 本页所有可见的 content-item
        $('.content-item').forEach(ci => { if (isShownEl(ci)) roots.push(ci); });
        for (const root of roots) {
            const els = $('button, div, span, a', root);
            for (const el of els) {
                const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/^(Submit|提交|提交答案)$/i.test(t)) continue;
                // 最内层
                let inner = true;
                for (const c of el.children) {
                    if (String(c.textContent || '').replace(/\s+/g, ' ').trim() === t) { inner = false; break; }
                }
                if (!inner) continue;
                if (isShownEl(el)) return el;
            }
        }
        const sc = scanByTextExact(/^(Submit|提交|提交答案)$/i);
        if (sc && isShownEl(sc)) return sc;
        return null;
    }

    // 人工点得动、脚本点不动 → 说明脚本拿到的不是同一个节点。
    // 用户提供的实测 XPath（阅读器里那个真正生效的「重做」）作为最后兜底。
    const RETRY_XPATH = '/html/body/div[1]/div/div[1]/section/main/div[1]/div/div[3]/div[3]/div/div[4]/div[2]/div/div/div[2]/div[2]';

    function byXPath(xp) {
        try {
            const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return r && r.singleNodeValue ? r.singleNodeValue : null;
        } catch (e) { return null; }
    }

    function looksLikeRetry(el) {
        if (!el) return false;
        const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        return /^(Retry|重做|重做本题|再做一次|再试一次)$/i.test(t) || /Retry|重做/.test(t);
    }

    function findRetryButton(scopeEl) {
        // 【local35】作用域内的按钮优先（多内容项页面里各有一个 Retry）
        if (scopeEl) {
            const els = $('button, div, span, a', scopeEl);
            for (const el of els) {
                const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/^(Retry|重做|重做本题|再做一次|再试一次)$/i.test(t)) continue;
                let inner = true;
                for (const c of el.children) {
                    if (String(c.textContent || '').replace(/\s+/g, ' ').trim() === t) { inner = false; break; }
                }
                if (!inner) continue;
                if (isShownEl(el)) return el;
            }
        }
        const sc = scanByTextExact(/^(Retry|重做|重做本题|再做一次|再试一次)$/i);
        if (sc && isVisibleEl(sc)) return sc;
        const byText = findClickableByText(/^(Retry|重做|重做本题|再做一次|再试一次)$/i);
        if (byText && isVisibleEl(byText)) return byText;
        const xp = byXPath(RETRY_XPATH);
        if (xp && looksLikeRetry(xp)) {
            log('重做按钮由 XPath 兜底命中', {
                tag: xp.tagName,
                cls: String(xp.className || '').slice(0, 70),
                text: String(xp.textContent || '').trim().slice(0, 12),
                visible: isVisibleEl(xp)
            });
            return xp;
        }
        // 兜底失败时把两边的候选都打出来
        log('重做按钮定位失败', {
            byTextFound: !!byText,
            byTextVisible: byText ? isVisibleEl(byText) : null,
            xpathFound: !!xp,
            xpathText: xp ? String(xp.textContent || '').trim().slice(0, 16) : null
        });
        // 【local39】绝对不能用 xp 兜底直接返回：实测 XPath 命中过 Submit，
        // 于是"点重做"变成了"点提交"，页面空着答案就提交上去了。
        const okText = (el) => {
            const t = String(el && el.textContent || '').replace(/\s+/g, ' ').trim();
            return /^(Retry|重做|重做本题|再做一次|再试一次)$/i.test(t) || /Retry|重做/.test(t);
        };
        if (byText && okText(byText)) return byText;
        if (xp && okText(xp)) return xp;
        return null;
    }

    // 提交：优先走页面真实按钮（保证站点状态机同步），失败则回退到直接调接口
    // 【local56】提交成功 ≠ 服务端记下了。"提交后回查"把 answerStatus 打出来：
    //   1 = 已判对  2 = 仍判错  其他 = 未知
    // 这是判断"接口提交到底有没有被采纳"的唯一确凿证据。
    async function verifyAfterSubmit(questions) {
        try {
            await sleep(rnd(1800, 2600));
            const r = parseReaderRoute();
            const cid = (r && r.contentId) || CONTENT_ID;
            if (!cid) return;
            const resp = await apiGetExercise(cid, r && r.contentType, r && r.bizId, null);
            const items = (resp && resp.data && resp.data.questionAnswerItemVOList) || [];
            const digest = (questions || []).slice(0, 4).map(q => {
                const it = items.find(x => Number(x.questionId) === Number(q.id))
                    || items.find(x => Number(x.id) === Number(q.id));
                // 【local60】answerStatus 的语义未确认（2 可能是"判错"也可能是"已判分"），
                // 用页面上真实的红叉/对勾做交叉验证。
                let domWrong = 0, domRight = 0;
                try {
                    const card = findCardForQuestion(getExerciseItems(), q, 0)
                        || document.querySelector('[id^="do_' + Number(q.id) + '"]');
                    const root = (card && card.closest ? card.closest('.exercise-item') : null) || card;
                    if (root) {
                        domWrong = root.querySelectorAll('[class*="wrong"], img[src*="wrong"]').length;
                        domRight = root.querySelectorAll('[class*="right"], [class*="-checked"], img[src*="right"]').length;
                    }
                } catch (e) {}
                return {
                    qid: Number(q.id),
                    st: it ? it.answerStatus : null,
                    hasAns: !!(it && it.answer),
                    domWrong: domWrong,
                    domRight: domRight
                };
            });
            log('提交后回查', digest);
            // 【local59】判"服务端不认"：有回查结果且全部不是 st=1
            // 判"服务端不认"：既不是 st=1，页面上也没有任何"对"的标记
            const allWrong = digest.length > 0 && digest.every(d => d.st !== 1 && d.domRight === 0);
            if (allWrong) {
                const key = String(cid);
                const n = (MANUAL_SECTIONS.get(key) || 0) + 1;
                MANUAL_SECTIONS.set(key, n);
                if (n >= 2) {
                    status('本节提交后仍被判错 ' + n + ' 次，标记为需手工处理，跳过');
                    log('本节需手工', { contentId: cid, attempts: n, lastDigest: digest });
                    stopRun('本节需手工处理（服务端不接受自动提交），已停止');
                } else {
                    status('提交后回查仍判错（' + n + '/2），本轮结束');
                }
            } else {
                MANUAL_SECTIONS.delete(String(cid));
            }
        } catch (e) { log('提交后回查异常', String(e).slice(0, 60)); }
    }

    async function submitAnswers(forceApi) {
        // 【local35】作用域锁定到本次作答卡片所在的 content-item
        let scopeEl = null;
        try {
            const items = getExerciseItems();
            if (items.length) scopeEl = visibleContentItem(items[0]);
        } catch (e) {}
        // 【local55】forceApi：UI 回填失败时跳过页面按钮，直接提交接口。
        // 自绘 checkbox 点不动/选中态不可读时，硬点只会提交一份残缺答案。
        const btn = forceApi ? null : findSubmitButton(scopeEl);
        log('提交入口', {
            byButton: !!btn,
            visible: btn ? isShownEl(btn) : null,
            scope: scopeEl ? 'content-item' : 'global'
        });
        if (btn && !btn.disabled) {
            if (!isVisibleEl(btn)) log('提交按钮不可见，尝试滚动后点击', { cls: String(btn.className || '').slice(0, 40) });
            realClick(btn, 'submit');
            log('已点击页面提交按钮', { cls: String(btn.className || '').slice(0, 30) });
            await sleep(rnd(1400, 2000));
            // 【local76】点完必须验收：实测某些页面点击落点正确但站点毫无反应
            // （st 不变、按钮还在、仍停在作答态）。这时直接 return true 会白白少一次提交。
            const stillWritable = !!firstEditableControl();
            const btnAlive = !!(btn && document.contains(btn) && isShownEl(btn));
            log('页面提交验收', { stillWritable: stillWritable, btnAlive: btnAlive });
            if (!stillWritable || !btnAlive) {
                log('页面提交已生效（离开作答态或按钮消失）');
                return true;
            }
            log('页面提交无响应，转走接口提交');
        } else {
            log('页面无可点提交按钮，转走接口提交');
        }
        // 无按钮（可能未答完/已提交）：尝试直接调接口
        const r = parseReaderRoute();
        const cid = (r && r.contentId) || CONTENT_ID || null;
        if (!r || !cid || !currentResp) {
            log('提交被跳过：路由或 contentId 缺失', { hasRoute: !!r, cid: cid, hasResp: !!currentResp });
            return false;
        }
        const qs = currentResp.questionVOList || [];
        if (!qs.length) { log('提交被跳过：当前响应没有题目'); return false; }
        const map = new Map();
        // 优先取 questionVOList 上的 doRecord（包含刚刚填充的作答），再退回 answerItem。
        // 顺序不能反 —— 否则刚填的内容会被服务端的旧值盖掉。
        // 【local17】组合题的作答挂在**子题**上，必须递归收集，否则提交时子题的
        // doRecord 全部丢失（服务端收到空串 → 认为没作答）。
        const collectAnswers = (list) => {
            (list || []).forEach(q => {
                const id = Number(q.id);
                if (q.doRecord !== undefined && q.doRecord !== null && q.doRecord !== '') {
                    map.set(id, q.doRecord);
                } else {
                    const it = (currentResp.questionAnswerItemVOList || []).find(x => Number(x.questionId) === id);
                    if (it) map.set(id, it.overWriteUserAnswer || it.userAnswer || it.answer || '');
                }
                if (q.children && q.children.length) collectAnswers(q.children);
            });
        };
        collectAnswers(currentResp.questionVOList);
        const questionItemList = flattenForSubmit(qs, map);
        const payload = { bizId: r.bizId, contentType: r.contentType, catalogId: r.catalogId, contentId: cid, questionItemList };
        // 【local13】站点对提交有节流：短时间连续提交会返回「请勿重复提交，请稍后重试」。
        // 实测该文案下等待数秒后重发即可成功，因此这里做带退避的重试，而不是直接放弃。
        const DUP_RE = /重复提交|稍后重试|过于频繁|频繁|too\s*(many|fast)|429/i;
        let resp = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            resp = await apiSubmitAnswer(payload);
            if (resp && resp.code === 200) {
                currentResp.questionAnswerItemVOList = resp.data || currentResp.questionAnswerItemVOList;
                lastAnswerMap = buildAnswerMap(currentResp);
                await apiMarkContentDone(r.bizId, r.catalogId, cid);
                log('提交成功（接口）', {
                    contentId: cid,
                    items: questionItemList.length,
                    attempt: attempt + 1
                });
                return true;
            }
            const msg = resp && resp.message ? String(resp.message) : '';
            if (!DUP_RE.test(msg)) break;
            const wait = 5000 + attempt * 4000 + rnd(0, 2000);
            status('提交被节流（' + msg + '），' + Math.round(wait / 1000) + 's 后重试 ' + (attempt + 1) + '/3');
            await sleep(wait);
        }
        status('提交失败：' + (resp && resp.message ? resp.message : '未知'));
        return false;
    }

    // 展平组合题（复刻站点 le() 行为）
    function flattenForSubmit(list, answerMap) {
        const out = [];
        (list || []).forEach(q => {
            if (q.children && q.children.length) {
                out.push(...flattenForSubmit(q.children, answerMap));
                return;
            }
            out.push({ questionId: Number(q.id), userAnswer: answerMap.get(Number(q.id)) || '' });
        });
        return out;
    }

    // ---- 试错取答案（两种学习模式都启用）----
    //
    // 【机制，实测】服务端只在作答次数累计到 errorNumShow 次后，才在
    // questionAnswerItemVOList[].answer 下发标准答案（见 DEVELOPMENT §11.3）。
    // 因此必须先制造「答错」，才可能拿到答案。
    //
    // 【为什么自由模式也跑】自由模式记「末次」，直觉上试错有风险（中途的错误提交会
    // 成为最终成绩）。但本轮试错流程保证：
    //   1. 每一轮**保持当前最优答案、只补空白**（见本函数内的占位逻辑），不覆盖已有作答；
    //   2. 拿到服务端答案后**立刻回填并再提交一次**闭环。
    // 因此整体是**单调改善**：最坏情况只是停在当前水平，不会比不试错更差；
    // 唯一例外是中途被限流打断，此时成绩停在最后一次提交的值。
    // 闯关模式记「最高」，反复提交本就无副作用。
    //
    // 【真实生效的门禁】只有 `answerRevealThreshold()` 返回有限值（即读到了 errorNumShow）。
    // 读不到课程设置时返回 Infinity → 直接跳过试错。`strat.retrySafe` 仅用于决定提示文案。
    //
    // 【闭环要求】拿到答案后**必须再提交一次正确答案**，否则成绩仍是上一次的错误值。

    // 给未作答的题填一个"占位答案"，使站点的前端硬门禁（请完成所有习题后再提交）得以通过
    // 【local29】占位值必须每轮不同，否则服务端把重复提交当同一份作答，
    // errorNumShow 的计数不增长，标准答案永远不下发。
    let PLACEHOLDER_ROUND = 0;
    function placeholderText() {
        PLACEHOLDER_ROUND++;
        return 'z' + PLACEHOLDER_ROUND;
    }

    // 【local78】服务端 answerStatus=3（已判分）不等于页面上有答案：
    // 实测 fill_image 的节，接口说已作答，但卡片里一个字都没有。
    // 原来的 `if (hasUserAnswer(q)) continue` 会因此跳过填写、直接空提交。
    function cardHasContent(card) {
        if (!card) return false;
        try {
            const blanks = card.querySelectorAll('.zty-exercise-item-fill-blank-do, [contenteditable="true"]');
            for (const b of blanks) {
                if (String(b.textContent || '').trim()) return true;
            }
            const areas = card.querySelectorAll('textarea');
            for (const t of areas) {
                if (String(t.value || '').trim()) return true;
            }
            const inputs = card.querySelectorAll('input');
            for (const i of inputs) {
                const t = String(i.type || '').toLowerCase();
                if (t === 'radio' || t === 'checkbox') { if (i.checked) return true; continue; }
                if (String(i.value || '').trim()) return true;
            }
            const marked = card.querySelectorAll('.ant-radio-wrapper-checked, .ant-checkbox-wrapper-checked');
            if (marked.length) return true;
        } catch (e) {}
        return false;
    }

    function fillPlaceholder(card, type) {
        try {
            if (type === TYPE.SINGLE || type === TYPE.MULTIPLE || type === TYPE.JUDGE) {
                const opts = getOptions(card);
                if (!opts.length) return false;
                return selectOption(opts[0]);
            }
            // 【本地修复 v2.3.1-local78】judge_advanced（多小题判断）原来没有占位分支：
            // fillPlaceholder 落到最后的 return false，于是 retryUntilAnswer 第 1819 行
            // 「仍有无法写入的题」直接 return，一次提交都不发 → 服务端永远累计不到
            // 答错次数 → 拿不到标准答案 → 该题最终报「未能作答（judge_advanced）」。
            // 每行 .judge-option-item 各有一套选项，逐行选第一个当占位。
            if (type === TYPE.JUDGE_HIGH) {
                const rows = $('.judge-option-item', card);
                if (rows.length) {
                    let any = false;
                    rows.forEach(row => {
                        const opts = $('.ant-radio-wrapper', row).length ? $('.ant-radio-wrapper', row)
                            : ($('.option-line', row).length ? $('.option-line', row) : $('label', row));
                        if (opts[0] && selectOption(opts[0])) any = true;
                    });
                    if (any) return true;
                }
                // 兜底：结构不是逐行选项时，当成单套选项处理
                const opts = getOptions(card);
                if (!opts.length) return false;
                return selectOption(opts[0]);
            }
            // 【local73】拖拽题占位：原来根本没有分支 → 试错时这一题一个字都写不进，
            // retryUntilAnswer 直接判定"无法写入"返回，一次提交都不发。
            // 占位策略：把前 N 个可拖项依次丢进前 N 个投放区（只为通过"未作答"检查）。
            if (type === TYPE.DRAG_ONE || type === TYPE.DRAG_MANY || type === TYPE.DRAG_FILL) {
                const zones = $('.drop-zone-item-wrapper, [class*="drop-zone"], .blank-placeholder, .inline-answer', card);
                const srcs = $('[draggable="true"]', card);
                if (!zones.length || !srcs.length) {
                    log('拖拽占位缺元素', { zones: zones.length, srcs: srcs.length });
                    return false;
                }
                const n = Math.min(zones.length, srcs.length);
                let anyDrop = false;
                for (let i = 0; i < n; i++) {
                    if (simulateDragDrop(srcs[i], zones[i], srcs[i].getAttribute('data-idx') || srcs[i].textContent || '')) anyDrop = true;
                }
                log('拖拽占位', { zones: zones.length, srcs: srcs.length, dropped: n, any: anyDrop });
                return anyDrop;
            }
            if (type === TYPE.FILL || type === TYPE.FILL_DIALOG || type === TYPE.FILL_IMAGE ||
                type === TYPE.FILL_CLOZE || type === TYPE.FILL_CLOZE_MN) {
                const blanks = $('.zty-exercise-item-fill-blank-do', card);
                // 【local77】fill_image 的输入框常是 <input class="imgFillBlanks">，
                // 类型也可能是 number/tel 或没有 type，原选择器直接漏掉 → 一个字都写不进去。
                // 这里放宽为"卡片内所有可见、非选项类、非隐藏的 input"。
                const allInputs = Array.prototype.slice.call(card.querySelectorAll('input'))
                    .filter(i => {
                        const t = String(i.type || '').toLowerCase();
                        if (t === 'radio' || t === 'checkbox' || t === 'hidden' || t === 'file') return false;
                        if (i.disabled || i.readOnly) return false;
                        return true;
                    });
                log('填空占位前', {
                    type: type,
                    doBlanks: blanks.length,
                    doneBlanks: card.querySelectorAll('.zty-exercise-item-fill-blank-done').length,
                    baseBlanks: card.querySelectorAll('[class*="fill-blank"]').length,
                    imgFill: card.querySelectorAll('.imgFillBlanks, [class*="img-fill"]').length,
                    inputs: allInputs.length,
                    inputTypes: allInputs.slice(0, 6).map(i => i.type || '(none)'),
                    inputCls: allInputs.slice(0, 3).map(i => String(i.className || '').slice(0, 24))
                });
                if (blanks.length) {
                    const v = placeholderText();
                    blanks.forEach(b => fillEditable(b, v));
                    log('填空占位后', { via: 'fill-blank-do', wrote: blanks.length });
                    return true;
                }
                const inputs = $('input[type="text"], input:not([type])', card);
                const targets = inputs.length ? inputs : allInputs;
                if (targets.length) {
                    const v2 = placeholderText();
                    targets.forEach(i => fillInput(i, v2));
                    log('填空占位后', { via: inputs.length ? 'input[type=text]' : 'all-inputs', wrote: targets.length });
                    return true;
                }
                log('填空占位后', { via: 'none', wrote: 0 });
                return false;
            }
            if (AI_ESSAY_TYPES.has(type)) {
                const ta = $1('textarea', card) || $1('[contenteditable="true"]', card);
                if (ta) { fillInput(ta, placeholderText()); return true; }
                return false;
            }
            return false;   // 其余题型（拖拽等）无法用占位通过，交由调用方跳过
        } catch (e) {
            return false;
        }
    }

    // ============================================================================
    // judge_advanced（多小题判断）专用作答
    //
    // 【站点契约，从构建产物反推，2026-11 实测数据核对】
    //   组件 JudgeMainCourseDo（scopeId data-v-59bf3187）：
    //     - extension.option[] : 选项图例，{idx, val}
    //     - extension.topic[]  : 每个小题一句，{idx, text}
    //     - 每行一个 antd Select（class="answer-select"），value 是**选项 idx**
    //     - 变更回调：l(topicIdx, optionIdx) → doRecord = [{idx: topicIdx, answer: optionIdx}, …]
    //   所以：
    //     1) 不能按 radio 找选项（这类题根本没有 radio，只有下拉框）；
    //     2) 占位/答案都必须是 [{idx,answer}] 的 JSON 数组，裸串或字符串数组服务端不认。
    // ============================================================================

    // 逐小题的可作答单元。两种线上变体：
    //   radio  变体（实测 2026-11，catalogId 10990）：每个 .judge-option-item 是一套
    //          .ant-radio-group，内含 2 个 input[type=radio]，value 就是 option 的 idx(UUID)
    //   select 变体（构建产物里的另一种实现）：.question-item 里放 .answer-select 下拉
    function judgeUnits(card) {
        const groups = $('.judge-option-item', card).map(el => ({ el, kind: 'radio' }));
        if (groups.length) return groups;
        const rows = $('.question-item', card).map(el => ({ el, kind: 'select' }));
        if (rows.length) return rows;
        return $('.judge-topic-item', card).map(el => ({ el, kind: 'select' }));
    }

    // 【实测 2026-11】取题接口下发的 q.extension 是** JSON 字符串**，不是对象。
    // 直接取 ext.option 会永远是 undefined，导致 option/topic 列表为空、
    // doRecord 里的 idx 退化成 0..n（服务端不认）。
    function judgeExt(q) {
        let e = q && q.extension;
        if (typeof e === 'string') { try { e = JSON.parse(e); } catch (err) { e = {}; } }
        return (e && typeof e === 'object') ? e : {};
    }

    function judgeOptionList(q) {
        const ext = judgeExt(q);
        return Array.isArray(ext.option) ? ext.option : [];
    }

    function judgeTopicList(q) {
        const ext = judgeExt(q);
        return Array.isArray(ext.topic) ? ext.topic : [];
    }

    // 服务端答案 → Map(topicIdx -> optionIdx)；兼容数组字符串与对象数组
    function parseJudgeHighAnswer(value) {
        const map = new Map();
        let v = value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return map; } }
        if (Array.isArray(v)) {
            v.forEach((it, i) => {
                if (it && typeof it === 'object') {
                    const k = it.idx !== undefined ? String(it.idx) : String(i);
                    map.set(k, it.answer === undefined ? '' : String(it.answer));
                } else if (it !== undefined && it !== null) {
                    map.set(String(i), String(it));
                }
            });
        }
        return map;
    }

    // 在一个单元里选中指定选项：radio 变体按 option idx 命中 input，其次按序号；select 变体按下标点下拉项
    async function fillJudgeUnit(unit, optionIdx, k) {
        if (!unit) return false;
        if (unit.kind === 'radio') {
            let inp = null;
            if (optionIdx) inp = $1('input[type="radio"][value="' + optionIdx + '"]', unit.el);
            if (!inp) inp = $('input[type="radio"]', unit.el)[k] || null;
            if (!inp) return false;
            const wrap = inp.closest('.ant-radio-wrapper') || inp;
            clickSeq(wrap);
            try { inp.click(); } catch (e) {}
            await sleep(rnd(80, 180));
            return true;
        }
        const sel = $1('.ant-select', unit.el) || $1('.answer-select', unit.el) || $1('.ant-select-selector', unit.el);
        if (!sel) return false;
        clickSeq(sel);
        await sleep(rnd(180, 400));
        let list = $('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option');
        if (!list.length) list = $('.ant-select-item-option');
        const target = list[k];
        if (!target) {
            try { document.body.click(); } catch (e) {}
            return false;
        }
        clickSeq(target);
        await sleep(rnd(150, 300));
        return true;
    }

    // 按服务端答案逐行选择
    async function applyJudgeHigh(card, q, value) {
        const units = judgeUnits(card);
        if (!units.length) return false;
        const topics = judgeTopicList(q);
        const options = judgeOptionList(q);
        const desired = parseJudgeHighAnswer(value);
        let any = false;
        for (let i = 0; i < units.length; i++) {
            const topicIdx = topics[i] ? String(topics[i].idx) : null;
            let optionIdx = topicIdx !== null ? desired.get(topicIdx) : undefined;
            if (optionIdx === undefined) optionIdx = desired.get(String(i));       // 兜底：按行序
            if (optionIdx === undefined || optionIdx === '') continue;
            let k = options.findIndex(o => String(o.idx) === String(optionIdx));
            if (k < 0) k = 0;
            if (await fillJudgeUnit(units[i], optionIdx, k)) any = true;
        }
        return any;
    }

    // 占位：每行都选第一个选项（制造"答错一次"，用于触发服务端下发答案）
    // 组合题（combined_basic / combined_read_comprehension）占位。
    //
    // 【实测 2026-11】combined_basic 的父卡片上没有任何可写控件
    // （fillBlanks/radios/selects 全为 0），真正的作答控件在**子题**里：
    // 子题各有一张 div.exercise-item[data-child-question-id] 卡片。
    // 原 fillPlaceholder 没有组合题分支 → 直接返回 false → 整节试错放弃。
    async function fillCompositePlaceholder(card, q) {
        const kids = (q && q.children) || [];
        if (!kids.length) return false;

        // 【local19】组合题常以「已作答态」渲染：填空是 span.-done（含 -done-wrong/-done-right），
        // 里面根本没有可写元素，于是怎么填都是 0。必须先点「重做」回到 -do 态。
        // 实测该节 DOM：span.zty-exercise-item-fill-blank-done...-wrong / -right。
        const doneBlanks = card.querySelectorAll('.zty-exercise-item-fill-blank-done').length;
        const doBlanks = card.querySelectorAll('.zty-exercise-item-fill-blank-do').length;
        if (doneBlanks && !doBlanks) {
            const retry = findRetryButton(visibleContentItem(card));
            if (retry && !retry.disabled) {
                log('组合题为查看态，点击重做回到作答态', { doneBlanks, retryText: String(retry.textContent || '').trim().slice(0, 12) });
                clickSeq(retry);
                await sleep(rnd(1500, 2500));
            } else {
                log('组合题为查看态但没有可点的重做按钮', { doneBlanks, found: !!retry, disabled: retry ? retry.disabled : null });
            }
        }

        // 子卡片：线上实测**不带** data-child-question-id，就是嵌在父卡里的 .exercise-item
        let subCards = $('.exercise-item[data-child-question-id]', card);
        if (!subCards.length) {
            subCards = $('.exercise-item', card).filter(el => !el.querySelector('.exercise-item'));
        }
        let any = false;
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (!child) continue;
            const target = subCards[i] || card;
            if (child.type === TYPE.JUDGE_HIGH) {
                if (await fillJudgeHighPlaceholder(target, child)) {
                    const enc = encodeJudgeHighFromDom(target, child);
                    if (enc) { child.doRecord = enc; PLACEHOLDER_IDS.add(Number(child.id)); any = true; }
                }
                continue;
            }
            if (fillPlaceholder(target, child.type)) {
                markAnswered(child, 'a', target);
                PLACEHOLDER_IDS.add(Number(child.id));
                any = true;
            }
        }
        return any;
    }

    // 组合题回填：按子题逐个取标准答案写入各自的子卡片。
    //
    // 【local31】applyAnswer 没有组合题分支（父卡零可写控件），所以
    // fillByAnswerMap 对组合题永远 filled=0 → 页面停在占位值 z12/z13。
    // 【local39】把服务端已下发的标准答案写回页面。返回实际写入的题数。
    // 判据：有答案 + 该卡在页面上没有"答对"标记。问答题(answerStatus=-1)同样处理，
    // 因为实测站点对 essay_questions_answers 也会下发 {"annex":[],"answer":"…"}。
    function cardLooksRight(card) {
        if (!card) return false;
        try {
            const ok = card.querySelectorAll(
                '[class*="done-right"], [class*="radio-group-right"], [class*="answer-right"], img[src*="right"], img[src*="correct"]'
            );
            const bad = card.querySelectorAll('[class*="wrong"], img[src*="wrong"]');
            return ok.length > 0 && bad.length === 0;
        } catch (e) { return false; }
    }

    // 【local45】改成「以页面卡片为准」的回填：
    // 接口的 questionVOList 有时只有父题、没有 children（子题挂在 answerItem 里），
    // 按题目树遍历会一条都写不进去。这里直接扫页面卡片，用卡片类名判题型，
    // 用 answerMap 取该 id 的标准答案。
    const TYPE_VALUES = Object.keys(TYPE).map(k => TYPE[k]).filter(Boolean);

    function typeFromCard(card) {
        const cls = String((card && card.className) || '');
        for (const v of TYPE_VALUES) {
            if (v && cls.indexOf(v) >= 0) return v;
        }
        try { return detectType(card); } catch (e) { return ''; }
    }

    function cardIdOf(card) {
        if (!card || !card.dataset) return 0;
        const v = card.dataset.childQuestionId || card.dataset.questionId ||
            card.getAttribute('data-child-question-id') || card.getAttribute('data-question-id');
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
    }

    async function fillFromStandardAnswers(questions) {
        // 【local40】查看态（readonly-answer）没有可写控件：先点 Retry 回到作答态
        let items = getExerciseItems();
        try {
            if (items.length && !firstEditableControl()) {
                const ok = await ensureEditableState(items[0]);
                if (ok) {
                    await sleep(rnd(600, 1000));
                    items = getExerciseItems();
                } else {
                    log('回填前无法进入作答态（可能已是查看态且无 Retry）');
                }
            }
        } catch (e) {}

        const allCards = [];
        items.forEach(c => {
            allCards.push(c);
            try {
                c.querySelectorAll('.exercise-item[data-child-question-id]').forEach(x => allCards.push(x));
            } catch (e) {}
        });

        log('回填扫描', {
            cards: allCards.length,
            withId: allCards.filter(c => cardIdOf(c) > 0).length,
            answers: lastAnswerMap.size,
            editable: !!firstEditableControl()
        });
        let filled = 0;
        for (const card of allCards) {
            const id = cardIdOf(card);
            if (!id) continue;
            const a = lastAnswerMap.get(id);
            let raw = (a && a.answer !== undefined && a.answer !== null && a.answer !== '') ? a.answer : null;
            if (raw === null) {
                const q = (questions || []).find(x => Number(x.id) === id);
                if (q && q.answer) raw = q.answer;
            }
            if (raw === null || raw === '') continue;

            const type = typeFromCard(card);
            const textual = AI_FILL_TYPES.has(type) || AI_ESSAY_TYPES.has(type);
            const fillable = textual || type === TYPE.SINGLE || type === TYPE.MULTI ||
                type === TYPE.JUDGE || type === TYPE.JUDGE_HIGH;
            if (!fillable) continue;
            if (cardLooksRight(card)) continue;

            const value = textual ? normalizeFillAnswer(raw) : decodeAnswer(raw, type);
            if (value === null || value === undefined || value === '') continue;
            const ok = (type === TYPE.JUDGE_HIGH)
                ? await applyJudgeHigh(card, findQuestionById(questions, id) || {}, value)
                : (type === TYPE.MULTIPLE
                    ? await fillMultipleChoice(card, value)
                    : (type === TYPE.SINGLE ? await fillSingleChoice(card, value) : applyAnswer(card, type, value)));
            if (ok) {
                const q = findQuestionById(questions, id) || { id: id, type: type };
                markAnswered(q, value, card);
                filled++;
                log('标准答案回填', { id: id, type: type, preview: String(JSON.stringify(value)).slice(0, 46) });
            }
            await sleep(rnd(100, 200));
        }
        return filled;
    }

    function findQuestionById(questions, id) {
        let hit = null;
        const walk = (arr) => (arr || []).forEach(q => {
            if (hit) return;
            if (Number(q.id) === Number(id)) { hit = q; return; }
            if (q.children && q.children.length) walk(q.children);
        });
        walk(questions);
        return hit;
    }

    async function applyCompositeAnswers(card, q) {
        const kids = (q && q.children) || [];
        if (!kids.length) return 0;
        const subCards = $('.exercise-item[data-child-question-id]', card);
        // 父题答案可能是「按子题 id 组织的映射」，先解出来备用
        let parentMap = null;
        try {
            const pa = lastAnswerMap.get(Number(q.id));
            if (pa && pa.answer) {
                const parsed = typeof pa.answer === 'string' ? JSON.parse(pa.answer) : pa.answer;
                if (Array.isArray(parsed)) {
                    parentMap = new Map();
                    parsed.forEach(it => {
                        if (it && it.idx !== undefined) parentMap.set(String(it.idx), it.answer !== undefined ? it.answer : it);
                    });
                } else if (parsed && typeof parsed === 'object') {
                    parentMap = new Map(Object.keys(parsed).map(k => [String(k), parsed[k]]));
                }
            }
        } catch (e) {}

        let filled = 0;
        for (let i = 0; i < kids.length; i++) {
            const child = kids[i];
            if (!child) continue;
            const target = subCards[i] || card;
            let raw;
            const ca = lastAnswerMap.get(Number(child.id));
            if (ca && ca.answer !== undefined && ca.answer !== null && ca.answer !== '') raw = ca.answer;
            else if (child.answer !== undefined && child.answer !== null && child.answer !== '') raw = child.answer;
            else if (parentMap && parentMap.has(String(child.id))) raw = parentMap.get(String(child.id));
            log('子题答案', {
                childId: Number(child.id),
                type: child.type,
                gotAnswer: raw !== undefined && raw !== null && raw !== '',
                preview: String(raw === undefined ? '' : JSON.stringify(raw)).slice(0, 60)
            });
            if (raw === undefined || raw === null || raw === '') continue;

            const type = child.type || detectType(target);
            // 【local42】essay_questions_answers 之类的文本题也必须走 normalizeFillAnswer：
            // 标准答案是 {"annex":[],"answer":"…"}，用 decodeAnswer 会原样塞 JSON 进输入框，
            // 校验失败 → filled 恒为 0。
            const value = (AI_FILL_TYPES.has(type) || AI_ESSAY_TYPES.has(type))
                ? normalizeFillAnswer(raw)
                : decodeAnswer(raw, type);
            if (value === null || value === undefined) continue;
            const ok = (type === TYPE.JUDGE_HIGH)
                ? await applyJudgeHigh(target, child, value)
                : (type === TYPE.MULTIPLE
                    ? await fillMultipleChoice(target, value)
                    : (type === TYPE.SINGLE ? await fillSingleChoice(target, value) : applyAnswer(target, type, value)));
            if (ok) { markAnswered(child, value, target); filled++; }
            await sleep(rnd(120, 240));
        }
        return filled;
    }

    async function fillJudgeHighPlaceholder(card, q) {
        const units = judgeUnits(card);
        if (!units.length) return false;
        const first = judgeOptionList(q)[0];
        const firstIdx = first ? String(first.idx) : '';
        let any = false;
        for (const u of units) {
            if (await fillJudgeUnit(u, firstIdx, 0)) any = true;
        }
        return any;
    }

    // 从 DOM 当前选中态编码 doRecord：[{idx: topicIdx, answer: optionIdx}, …]
    function encodeJudgeHighFromDom(card, q) {
        const units = judgeUnits(card);
        if (!units.length) return '';
        const topics = judgeTopicList(q);
        const options = judgeOptionList(q);
        const norm = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        const arr = [];
        units.forEach((u, i) => {
            let ans = '';
            if (u.kind === 'radio') {
                const inp = $1('input[type="radio"]:checked', u.el);
                if (inp) ans = String(inp.value);
            } else {
                const sel = $1('.ant-select-selection-item', u.el)
                    || $1('.ant-select-selection-selected-value', u.el);
                const text = sel ? norm(sel.textContent) : '';
                if (text) {
                    const hit = options.find(o => {
                        const v = norm(o.val);
                        const txt = norm(o.text);
                        return (v && text.indexOf(v) >= 0) || (txt && text.indexOf(txt) >= 0);
                    });
                    if (hit) ans = String(hit.idx);
                }
            }
            if (!ans) return;
            arr.push({ idx: topics[i] ? topics[i].idx : i, answer: ans });
        });
        return arr.length ? JSON.stringify(arr) : '';
    }

    // 确保题目处于「作答态」。
    //
    // 【实测】已作答的题会渲染成**查看态**：填空题的元素是
    // span.zty-exercise-item-fill-blank-**done**（done），而不是 zty-exercise-item-fill-blank-**do**（do）。
    // 查看态下题卡没有可写的作答元素，直接填答案会「写入 0 个空」而静默失败，
    // 随后提交的仍是上一轮的旧答案 —— 表现为「拿到了服务端标准答案却拿不到分」。
    // 必须先点 Retry 回到作答态。
    // 可写入的作答元素（排除 disabled / antd 的 -disabled 变体）
    //
    // 【实测 2026-11，catalogId 10988 判分后页面】已提交的节里，input[type=radio]
    // 全部带 disabled，wrapper 上有 ant-radio-wrapper-disabled。原来的实现只判断
    // "元素是否存在"，于是把查看态当可写态，回填时点了 0 个反被当成成功。
    // 【local39】问答题的可写控件是 textarea，原来不在选择器里 →
    // firstEditableControl() 永远返回 null，被误判成"无法进入作答态"。
    const EDITABLE_SEL = '.zty-exercise-item-fill-blank-do, [contenteditable="true"], .ant-radio-wrapper, ' +
        '.option-content, .drag-drop-container, .answer-select, .ant-select, ' +
        'textarea:not([disabled]):not([readonly]), input[type="text"]:not([disabled]):not([readonly])';

    // 【local53】必须支持作用域：整页找会把**别的卡片**的控件当成"本节可写"，
    // 于是判"已进入作答态"，而当前这张卡的 checkbox 其实还是 disabled。
    function firstEditableControl(scopeEl) {
        const list = scopeEl ? $(EDITABLE_SEL, scopeEl) : $(EDITABLE_SEL);
        for (let i = 0; i < list.length; i++) {
            const el = list[i];
            if (!el || el.disabled) continue;
            const inp = el.tagName === 'INPUT' ? el : (el.querySelector ? el.querySelector('input') : null);
            // 【local50】类名里的 disabled 不可信：站点在作答态有时仍保留
            // ant-checkbox-wrapper-disabled 之类的类名，于是"页面明明能答"却被判不可写。
            // 只有内部 input 真的 disabled（或根本没有 input 可查）才算不可写。
            const clsDisabled = String(el.className || '').indexOf('disabled') >= 0;
            if (clsDisabled && (!inp || inp.disabled)) continue;
            if (inp && inp.disabled) continue;
            return el;
        }
        return null;
    }

    // 【local50】"重做"在同一页可能有多个节点：div.right-button 里的 span、看不见的
    // antd <button>、XPath 命中的那个……**点哪个生效不固定**（实测 span 按坐标点无效，
    // 而 rect=[0,0] 的 antd button 用原生 click() 反而生效）。
    // 因此不再"选一个点了就算了"，而是把所有候选轮流试，每次点完都验证能否写入。
    function collectRetryCandidates(scopeEl) {
        const RE = /^(Retry|重做|重做本题|再做一次|再试一次)$/i;
        const out = [];
        const push = (el) => { if (el && out.indexOf(el) < 0) out.push(el); };
        const scanIn = (root) => {
            if (!root) return;
            const els = $('button, div, span, a', root);
            for (const el of els) {
                const t = String(el.textContent || '').replace(/\s+/g, ' ').trim();
                if (!RE.test(t)) continue;
                let inner = true;
                for (const c of el.children) {
                    if (String(c.textContent || '').replace(/\s+/g, ' ').trim() === t) { inner = false; break; }
                }
                if (inner) push(el);
            }
        };
        scanIn(scopeEl);
        $('.content-item').forEach(ci => { if (isShownEl(ci)) scanIn(ci); });
        scanIn(document);
        const xp = byXPath(RETRY_XPATH);
        if (xp && looksLikeRetry(xp)) push(xp);
        // 可见的排前面
        return out.filter(el => isShownEl(el)).concat(out.filter(el => !isShownEl(el)));
    }

    async function ensureEditableState(scopeEl) {
        if (!scopeEl) {
            try {
                const items2 = getExerciseItems();
                if (items2.length) scopeEl = visibleContentItem(items2[0]);
            } catch (e) {}
        }
        if (firstEditableControl(scopeEl)) return true;

        const cands = collectRetryCandidates(scopeEl);
        log('重做候选', {
            n: cands.length,
            detail: cands.slice(0, 4).map(el => ({
                tag: el.tagName,
                cls: String(el.className || '').slice(0, 26),
                shown: isShownEl(el),
                text: String(el.textContent || '').trim().slice(0, 8)
            }))
        });

        for (let i = 0; i < cands.length && i < 4; i++) {
            const el = cands[i];
            // 1) 按坐标点最顶层元素
            realClick(el, 'retry#' + i);
            await sleep(1400);
            if (firstEditableControl(scopeEl)) {
                log('已进入作答态', { via: 'realClick', idx: i });
                return true;
            }
            // 2) 原生 click（对不可见的 antd button 有效）
            try { el.click(); } catch (e) {}
            await sleep(1400);
            if (firstEditableControl(scopeEl)) {
                log('已进入作答态', { via: 'nativeClick', idx: i });
                return true;
            }
        }

        // 【local54】三级判定：作用域认错卡时不要把"整页可写"也否掉。
        // 实测 {inCard:0, inPage:1, disabledInputs:0, radios:14, checks:12, textareas:4}：
        // 页面明明是可写状态，只是 items[0] 落在别的内容项上。
        // 【local64】不能用"存在任何 disabled input"来否定整页可写：
        // 实测 22 个输入框里只有 1 个 disabled（常是无关的隐藏 input / 音频控件），
        // 却因此把整节判成不可写 → 直接跳过。改成数"真正可用的控件"。
        const enabledChecks = $('.ant-checkbox-wrapper:not(.ant-checkbox-wrapper-disabled)').length;
        const enabledRadios = $('.ant-radio-wrapper:not(.ant-radio-wrapper-disabled)').length;
        const enabledAreas = $('textarea:not([disabled])').length;
        const enabledTotal = enabledChecks + enabledRadios + enabledAreas;
        const inPage = !!firstEditableControl();
        log('作答态探测', {
            inCard: firstEditableControl(scopeEl) ? 1 : 0,
            inPage: inPage ? 1 : 0,
            enabledChecks: enabledChecks,
            enabledRadios: enabledRadios,
            enabledAreas: enabledAreas,
            disabledInputs: $('input[disabled]').length,
            totalInputs: $('input').length,
            scope: scopeEl ? String(scopeEl.className || '').slice(0, 30) : 'none'
        });
        if (inPage || enabledTotal > 0) {
            log('按整页判定可写', { enabledTotal: enabledTotal });
            return true;
        }
        log('点击重做后仍无可写元素', {
            doneBlanks: $('.zty-exercise-item-fill-blank-done').length,
            doBlanks: $('.zty-exercise-item-fill-blank-do').length,
            ctAny: $('[contenteditable]').length,
            radios: $('.ant-radio-wrapper:not(.ant-radio-wrapper-disabled)').length,
            checks: $('.ant-checkbox-wrapper:not(.ant-checkbox-wrapper-disabled)').length,
            textareas: $('textarea:not([disabled])').length,
            tried: Math.min(cands.length, 4)
        });
        return false;
    }

    async function retryUntilAnswer(route, questions, threshold, forceRewrite) {
        if (!Number.isFinite(threshold)) return false;
        const maxCalls = threshold + 3;

        // 先看服务端有没有已经用 answerStatus === -1 表明这些题不由它自动判分。
        // 若有，试错再多次也拿不到答案，只是白烧提交次数（还可能触发限流）——直接放弃。
        {
            const pre = buildAnswerMap(currentResp);
            const kinds = questions.map(q => gradedKindOf(pre.get(Number(q.id))));
            if (kinds.length && kinds.every(k => k === 'subjective')) {
                status('这些题服务端不自动判分（answerStatus = -1），试错无法取得答案，跳过轮询');
                return false;
            }
        }

        for (let calls = 0; calls < maxCalls; calls++) {
            const map = buildAnswerMap(currentResp);

            // 【关键】missing 只能统计「本来就该下发答案」的题 —— 即客观题。
            //
            // 主观题（问答/写作/翻译/答案多样的填空）服务端**永不下发** answer
            // （answerStatus 恒为 -1）。若把它们也算进 missing，那么本节只要含一道
            // 主观题，`missing` 就永远非空 ——「答案已齐」分支永不进入，
            // 客观题已经拿到的官方答案也就永远不回填，循环空转到 maxCalls 后返回 false。
            // 实测（同节 1 客观 + 1 主观）：取题 7 次、提交 6 次、24.6 秒、返回 false；
            // 而全客观的对照只需要 2 次提交、7 秒、返回 true。
            const expectAnswer = (q) => {
                if (q.type && KNOWN_OBJECTIVE_TYPES.has(q.type)) return true;  // 客观题必须期望答案下发
                const a = map.get(Number(q.id));
                if (gradedKindOf(a) === 'subjective') return false;   // 行为证据优先
                if (!a && isSubjective(q)) return false;              // 尚无返回，按标签判断
                return true;
            };

            // "答案可用"= 有答案，且填空题的答案能真正摊平成每空一项。
            // 注意：主观填空可能下发 "Answers will vary."，非空但无法作答，
            // 只看非空会误判为"已齐"从而卡住。
            // 【local32】组合题的标准答案按**子题**下发（父题 answer 恒为空），
            // 原来只看父题 → 永远判定"答案未齐" → 死循环占位试错。
            const childAnswerOf = (child) => {
                if (!child) return null;
                const ca = map.get(Number(child.id));
                if (ca && ca.answer !== undefined && ca.answer !== null && ca.answer !== '') return ca.answer;
                if (child.answer !== undefined && child.answer !== null && child.answer !== '') return child.answer;
                return null;
            };
            const usable = (q) => {
                if (q.children && q.children.length) {
                    return q.children.every(c => !!childAnswerOf(c));
                }
                const a = map.get(Number(q.id));
                if (a && a.answer !== undefined && a.answer !== null && a.answer !== '') {
                    return AI_FILL_TYPES.has(q.type) ? normalizeFillAnswer(a.answer) !== null : true;
                }
                if (q.answer !== undefined && q.answer !== null && q.answer !== '') {
                    return true;
                }
                return false;
            };
            const missing = questions.filter(q => expectAnswer(q) && !usable(q));

            if (!missing.length) {
                // 答案已齐 → 先回到作答态（查看态下无法写入），再填入并提交
                if (await ensureEditableState()) {
                    const r = await fillByAnswerMap();
                    log('试错取得答案，回填', r);
                    if (r.filled) {
                        await sleep(rnd(400, 800));
                        // 【local15】部分题没填上也不再整体放弃：能提交的先提交
                        const rest = questions.filter(q => !hasUserAnswer(q));
                        if (rest.length) log('部分题未填上（仍提交已作答部分）', rest.map(q => ({ id: q.id, type: q.type })));
                        await submitAnswers();
                        return true;
                    }
                    // 【local12】答案条目看着有、实际填不进去（空串/格式不认）
                    // 不再直接 return false，而是继续走下面的**占位 + 提交**流程，
                    // 让服务端累计答错次数，从而真正拿到答案。
                    log('回填未写入任何答案，转入占位试错');
                } else {
                    log('无法进入作答态，转入占位试错');
                }
            }

            // 尚未下发答案 → 只为**真正没作答的**题补占位，然后提交以累计作答次数。
            //
            // 【关键】不能对已有作答的题填占位：AI 可能已经答对，占位会把它盖掉。
            // 只补空位，其余保持原样，这样每轮提交都保住当前最好结果。
            // 注意：AI 已填满时没有空位可补，但**仍然要提交**才能累计次数，
            // 因此这里不能用"是否补了占位"作为继续条件。
            // 【local75】每轮试错前都要确保"可写"，不能只给 forceRewrite 开绿灯。
            // 实测 fill_image / 已判分（answerStatus=3）的节：卡片停在查看态（readonly-answer），
            // 没有可写控件 → 占位填不进去 → 提交的是空答案 → 服务端永远累计不到答错次数。
            const editableNow = await ensureEditableState();
            if (!editableNow) {
                if (forceRewrite) {
                    log('重做模式下无法进入作答态，终止试错');
                    return false;
                }
                log('试错前无法进入作答态，本轮按当前作答提交', { round: i });
            }
            const items = getExerciseItems();
            let wroteAny = 0;
            const unfillable = [];
            for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                // forceRewrite：错题重做场景。服务端认为"已作答"（answerStatus=3），
                // 但页面上是判错态，必须强制覆盖写入**不同的**占位值才能累计答错次数。
                // 【local78】再加一条：服务端说已作答、但卡片里**一个字都没有**时，
                // 也要强制重写（否则占位填不进、直接空提交，答错次数永远不涨）。
                const cardNow = findCardForQuestion(items, q, i);
                const domHas = cardHasContent(cardNow);
                if (hasUserAnswer(q) && !forceRewrite && domHas) { wroteAny++; continue; }
                if (hasUserAnswer(q) && !domHas) {
                    log('服务端说已作答但页面无内容，强制重写', { id: q.id, type: q.type });
                }
                const card = findCardForQuestion(items, q, i);
                if (!card) { unfillable.push({ id: q.id, type: q.type, why: 'no-card' }); continue; }
                // 组合题：正确答案在子题里，逐个子题填
                if (q.children && q.children.length) {
                    if (await fillCompositePlaceholder(card, q)) {
                        wroteAny++;
                    } else {
                        unfillable.push({
                            id: q.id, type: q.type, why: 'composite-fill-failed',
                            children: q.children.length,
                            subCards: card.querySelectorAll('.exercise-item[data-child-question-id]').length,
                            controlsTotal: card.querySelectorAll('input,select,textarea,[contenteditable]').length
                        });
                    }
                    continue;
                }
                // judge_advanced 走下拉框专用的占位逻辑（没有 radio 可点）
                if (q.type === TYPE.JUDGE_HIGH) {
                    if (await fillJudgeHighPlaceholder(card, q)) {
                        const enc = encodeJudgeHighFromDom(card, q);
                        if (enc) { q.doRecord = enc; PLACEHOLDER_IDS.add(Number(q.id)); }
                        else markAnsweredFromDom(q, card);
                        wroteAny++;
                    } else {
                        unfillable.push({ id: q.id, type: q.type, why: 'judge-fill-failed' });
                    }
                    continue;
                }
                if (fillPlaceholder(card, q.type)) {
                    markAnsweredFromDom(q, card);
                    wroteAny++;
                } else {
                    // 【local15】把"为什么写不进去"记下来：卡片类名 + 命中的可写控件数
                    unfillable.push({
                        id: q.id,
                        type: q.type,
                        why: 'fill-failed',
                        cardCls: String(card.className || '').slice(0, 50),
                        fillBlanks: card.querySelectorAll('.zty-exercise-item-fill-blank-do').length,
                        radios: card.querySelectorAll('.ant-radio-wrapper, input[type=radio]').length,
                        selects: card.querySelectorAll('.ant-select').length,
                        ctEditable: card.querySelectorAll('[contenteditable]').length,
                        controlsTotal: card.querySelectorAll('input,select,textarea,[contenteditable]').length
                    });
                }
            }
            if (!items.length) return false;
            // 【local15】只要求"至少有一题能写入"，不再要求全部可写。
            // 原来只要有一题填不进去（例如答案在卡片外、或拖拽类无输入控件），
            // 整个试错循环立刻 return false —— 一次提交都不发，表现为
            // 「跑了三轮、页面一个字没变、然后跳到下一节」。
            if (!wroteAny) {
                log('本节没有任何题能写入占位，放弃试错', unfillable);
                return false;
            }
            if (unfillable.length) log('这些题写不进占位（跳过，其余照常提交）', unfillable);

            await sleep(rnd(600, 1200));                          // 节流：站点无退避，必须自控节奏
            const ok = await submitAnswers();
            if (!ok) return false;
            status('试错取答案 第 ' + (calls + 1) + '/' + maxCalls + ' 次（服务端在答错 ' + threshold + ' 次后下发答案）');

            await sleep(rnd(1600, 2800));
            if (!(await loadCurrentExercise())) return false;     // 重新取题，看答案是否已下发
        }
        return false;
    }

    // ============================================================================
    // 9. 学习时长（防空闲熔断）
    // ============================================================================
    //
    // 【关键契约，已证实】站点**自身**已经在自动上报时长，无需脚本代劳：
    //   Be(){ F.value = setInterval(() => { ze() || onSaveStudyTime(catalogId) }, 1e4) }   // 每 10 秒
    //   function ze(){ return Date.now() - Le >= Ede }                                     // Ede = 6e5
    //   Le 由 mousedown/mousemove/wheel/keydown/touchstart/touchmove/scroll 重置
    //
    // 即：只要页面开着且**用户在 10 分钟内有任何交互**，站点自己就会上报。
    // 空闲 ≥ 10 分钟则跳过本次上报（熔断）。
    //
    // 因此脚本的正确职责不是"代刷"，而是**防止空闲熔断**：周期性派发无害的用户活动
    // 事件，让站点自身的计时器保持活跃。这比直接重放上报接口更稳妥——
    // 上报接口体 {bizId, contentType, catalogId} 与站点完全一致，
    // 但由页面自己按节奏发出，不会产生异常密集的请求。
    const STUDY_ACTIVITY_INTERVAL_MS = 60000;   // 每分钟轻推一次，远低于 10 分钟熔断阈值
    const STUDY_ACTIVITY_EVENTS = ['mousemove', 'wheel', 'keydown', 'scroll'];

    let studyTimer = null;
    let studyCount = 0;

    function keepAliveTick() {
        // 派发 capture 阶段的用户活动事件（站点以 {capture:true, passive:true} 监听）
        for (const name of STUDY_ACTIVITY_EVENTS) {
            try {
                const ev = name === 'keydown'
                    ? new KeyboardEvent(name, { bubbles: true, cancelable: true })
                    : (name === 'wheel'
                        ? new WheelEvent(name, { bubbles: true, cancelable: true, deltaY: 0 })
                        : new MouseEvent(name, { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }));
                window.dispatchEvent(ev);
            } catch (e) { /* 事件构造失败不致命 */ }
        }
        studyCount++;
        status('保活中 第' + studyCount + ' 次（防 10 分钟空闲熔断，站点自身每 10s 上报）');
    }

    function startStudyFarm() {
        if (studyTimer) return;
        const r = parseReaderRoute();
        if (!r) { status('请先进入阅读器页面再开启时长保活'); return; }
        studyCount = 0;
        keepAliveTick();   // 立即推一次，避免刚开启就处于空闲态
        studyTimer = setInterval(() => {
            if (!parseReaderRoute()) { stopStudyFarm(); return; }
            keepAliveTick();
        }, STUDY_ACTIVITY_INTERVAL_MS);
        status('时长保活已开启（站点自身每 10s 上报，本功能仅防空闲熔断）');
    }
    function stopStudyFarm() {
        if (studyTimer) { clearInterval(studyTimer); studyTimer = null; }
        studyCount = 0;
    }

    // 主动补一次时长上报（可选，用于页面切走等场景的兜底）
    async function reportStudyTimeOnce() {
        const r = parseReaderRoute();
        if (!r || !r.catalogId) return false;
        const resp = await apiSaveStudyTime(r.bizId, r.contentType, r.catalogId);
        return !!(resp && resp.code === 200);
    }

    // ============================================================================
    // 9b. 运行环境自检（装错版本的友好提示）
    // ============================================================================
    //
    // 站点是双轨的：/legacy/ 是 Angular 旧站，/course_center/reader/ 才是本脚本适配的新版。
    // 平台按账号属性分流（uc.izhixue.cn 返回 type=3 的账号会被送往旧站）。
    // 装错版本时脚本不会报错、也不会做任何事 —— 所以在面板上明确说明，避免用户困惑。
    function detectEnvironment() {
        const path = location.pathname;
        if (/^\/legacy\//.test(path) || path.indexOf('/legacy') === 0) {
            return {
                kind: 'legacy',
                msg: '检测到旧站（/legacy/）——本版 v' + SCRIPT_VERSION +
                     ' 只适配新版。旧站请改用 v1.1.2。'
            };
        }
        if (/\/course_center\/reader\//i.test(path)) {
            return { kind: 'reader', msg: '新版阅读器 —— 环境正常' };
        }
        if (/\/course_center\//.test(path)) {
            return { kind: 'course_center', msg: '课程中心 —— 请进入具体教材/课程章节' };
        }
        return { kind: 'other', msg: '非教材页面' };
    }

    // ============================================================================
    // 10. 成绩查询（新站接口）
    // ============================================================================

    // 新站成绩接口。
    //
    // 【实测】教师视角的 /course/{id}/class/base/info 对学生账号返回
    //   403 您没有该操作权限
    // 因此课程名/班级名不能从那里取。有权限的是学生视角的 /student/course/{id}/detail
    // （含 title、courseClassName、teacherName、learnMode、errorNumShow）。
    async function fetchScore() {
        const r = parseReaderRoute();
        if (!r) return null;
        const courseId = r.contentType === CT.STUDENT_COURSE ? r.bizId : null;
        if (!courseId) return { unsupported: true };

        const overview = await api('/course/' + courseId + '/study/situation/overview', { params: {} });
        if (!overview || overview.code !== 200) {
            return { error: overview && overview.message ? overview.message : '查询失败' };
        }
        // 下面两个接口失败不影响主流程，能取到就展示
        const detail = await api('/student/course/' + courseId + '/detail', { params: {} });
        const units = await api('/course/' + courseId + '/study/situation/unit/list', { params: {} });
        return {
            courseId: courseId,
            overview: overview.data,
            detail: detail && detail.code === 200 ? detail.data : null,
            units: units && units.code === 200 ? units.data : null
        };
    }

    // 秒 → 中文可读时长
    function formatDuration(sec) {
        const n = Number(sec);
        if (!Number.isFinite(n) || n <= 0) return '—';
        const h = Math.floor(n / 3600);
        const m = Math.floor((n % 3600) / 60);
        const s = Math.floor(n % 60);
        if (h > 0) return h + '小时' + (m > 0 ? m + '分' : '');
        if (m > 0) return m + '分' + (s > 0 ? s + '秒' : '');
        return s + '秒';
    }

    // 排名 → "第 9 / 39 名"；缺分母时只显示名次
    function formatRank(rank, total) {
        const r = Number(rank), t = Number(total);
        if (!Number.isFinite(r)) return '—';
        return Number.isFinite(t) && t > 0 ? r + '/' + t : String(r);
    }

    // 成绩面板。字段到中文的映射见 README「查成绩」一节。
    function formatScore(d) {
        if (!d) return '查询失败（需在课程阅读器页面且已登录）';
        if (d.unsupported) return '成绩查询仅支持「学生课程」，当前为教材页面';
        if (d.error) return '查询失败：' + d.error;

        const o = d.overview || {};
        const det = d.detail || {};
        const total = Number(o.classNum || o.courseNum) || 0;

        const lines = [];

        // —— 课程信息 ——
        const title = det.title || det.parentTitle || '';
        const cls = det.courseClassName ? ' · ' + det.courseClassName : '';
        if (title) lines.push('课程：' + title + cls);
        if (det.teacherName) lines.push('教师：' + det.teacherName);

        // —— 学习模式（决定成绩取值，直接影响策略）——
        const modeMap = { 1: '自由模式（成绩记末次）', 2: '闯关模式（成绩记最高）' };
        if (det.learnMode !== undefined && det.learnMode !== null) {
            lines.push('学习模式：' + (modeMap[Number(det.learnMode)] || ('未知(' + det.learnMode + ')')));
        }
        if (det.errorNumShow !== undefined) {
            lines.push('答错 ' + det.errorNumShow + ' 次后显示答案');
        }

        // —— 三项核心指标 ——
        lines.push('');
        const sc = o.score === '' || o.score === null || o.score === undefined ? '—' : o.score;
        lines.push('学习成绩：' + sc + '　　班级排名 ' + formatRank(o.courseScoreCourseRank, total));
        lines.push('学习进度：' + (o.progress === undefined ? '—' : o.progress + '%')
            + '　　班级排名 ' + formatRank(o.courseProgressCourseRank, total));
        lines.push('学习时长：' + formatDuration(o.duration)
            + '　　班级排名 ' + formatRank(o.courseStudyUseTimeCourseRank, total));

        // —— 单元明细（只展示一层，够定位问题单元）——
        const unitList = Array.isArray(d.units) ? d.units : [];
        if (unitList.length) {
            lines.push('');
            lines.push('各单元：');
            unitList.slice(0, 20).forEach(u => {
                const s = u.score === '' || u.score === null || u.score === undefined ? '—' : u.score;
                const p = u.progress === undefined || u.progress === null ? '—' : u.progress + '%';
                lines.push('  ' + String(u.title || ('单元' + u.id)).slice(0, 28)
                    + '　成绩 ' + s + '　进度 ' + p + '　时长 ' + formatDuration(u.duration));
            });
        }

        return lines.join('\n');
    }

    // ============================================================================
    // 12bis. 自动连续刷课（跨节推进）
    // ============================================================================
    //
    // 【为什么需要】原先「开始刷课」只在阅读器页面内工作：从目录页点它，parseReaderRoute()
    // 返回 null，只闪一行提示就退出 —— 用户看到的就是「点了完全没反应」。
    // 而且一节处理完就停住，不会自动去下一节。本模块补上「像旧站那样，进了课程就能
    // 从进度不足处自动往下刷」的能力。
    //
    // 【机制】状态存 localStorage，因为跨节推进靠 location.href 导航，页面会整页重载、
    // 脚本重新注入 —— 必须靠持久化状态恢复「正在自动刷」这件事。
    //
    // 【遍历单位是 contentId 而非 catalogId】实测一个 catalog 下挂着多个内容项：
    //   catalog 13053 → contentId 23882(type4) / 23883(type14) / 23884(type6)
    // 所以要先按 catalog 的进度找到「未完成的叶子」，再取它的内容列表逐个处理。

    const AUTO_RUN_KEY = 'tsh_auto_run';

    function getAutoRun() {
        try {
            const s = localStorage.getItem(AUTO_RUN_KEY);
            return s ? JSON.parse(s) : null;
        } catch (e) { return null; }
    }

    function setAutoRun(v) {
        try {
            if (v) localStorage.setItem(AUTO_RUN_KEY, JSON.stringify(v));
            else localStorage.removeItem(AUTO_RUN_KEY);
        } catch (e) {}
    }

    // 当前页面对应的 bizId（课程 id）。
    //
    // 【实测的 URL 形态】
    //   阅读器  /course_center/reader/student_course/{bizId}?catalogId=…&contentId=…
    //   课程内页 /course_center/my_course/{courseId}/manage/1
    //   课程列表 /course_center/my_course          ← 这里**拿不到** id，URL 与 DOM 都没有，
    //                                              Vue 用编程式路由且不把数据挂到 DOM
    // 所以列表页要靠 /student/school/course 接口拿课程清单。
    function currentCourseId() {
        const r = parseReaderRoute();
        if (r && r.contentType === CT.STUDENT_COURSE) return r.bizId;
        const m = location.pathname.match(/\/course_center\/[a-z_]+\/(\d{15,})/i);
        if (m) return m[1];
        const q = new URLSearchParams(location.search).get('courseId');
        return q || null;
    }

    // 取当前账号的课程清单（含 courseId 与课程名）
    async function fetchMyCourses() {
        const r = await api('/student/school/course', { params: {} });
        if (!r || r.code !== 200) return [];
        const d = r.data;
        const arr = Array.isArray(d) ? d : (d && (d.records || d.list)) || [];
        return arr.filter(x => x && x.id).map(x => ({
            id: String(x.id),
            name: x.title || x.courseName || ('课程 ' + x.id)
        }));
    }

    // 解析出要操作的课程：优先用面板里选中的，其次页面上下文，最后课程清单
    async function resolveCourseId() {
        const picked = ($1('#b6-course') && $1('#b6-course').value) || '';
        if (picked) return picked;
        const ctx = currentCourseId();
        if (ctx) return ctx;
        const list = await fetchMyCourses();
        if (list.length === 1) return list[0].id;
        if (list.length > 1) {
            status('检测到 ' + list.length + ' 门课程，请在面板「课程」下拉中选择');
            fillCourseSelect(list);
            return null;
        }
        return null;
    }

    // 填充课程下拉
    function fillCourseSelect(list) {
        const sel = $1('#b6-course');
        if (!sel || !list || !list.length) return;
        const cur = sel.value;
        sel.textContent = '';
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '（自动）';
        sel.appendChild(blank);
        list.forEach(c => {
            const o = document.createElement('option');
            o.value = c.id;
            o.textContent = String(c.name).slice(0, 20);
            sel.appendChild(o);
        });
        if (cur) sel.value = cur;
        sel.style.display = '';
    }

    // 找到下一个待处理的内容项：返回 { catalogId, contentId }，全部完成则返回 null
    async function findNextTarget(courseId, doneSet) {
        const cat = await api('/course/' + courseId + '/catalog/list/with/progress', {
            params: { user_id: 0, type: 0 }
        });
        if (!cat || cat.code !== 200) return { error: cat && cat.message ? cat.message : '目录获取失败' };

        // 扁平化出「叶子节点」，保持目录顺序
        const leaves = [];
        const walk = (arr) => {
            (arr || []).forEach(n => {
                const kids = n.children || [];
                if (kids.length) walk(kids);
                else leaves.push(n);
            });
        };
        walk(cat.data || []);

        const undone = leaves.filter(n => {
            const p = Number(n.progress);
            return !Number.isFinite(p) || p < 100;      // 无进度字段也视为未完成
        });
        if (!undone.length) return null;                 // 全部完成

        // 逐个未完成目录找它的内容项，跳过已处理过的 contentId
        for (const node of undone) {
            const c = await apiGetContent(courseId, node.id, CT.STUDENT_COURSE);
            if (!c || c.code !== 200) continue;
            const list = Array.isArray(c.data) ? c.data : (c.data && c.data.list) || [];
            const next = list.find(x => x && x.id && !doneSet.has(String(x.id)));
            if (next) return { catalogId: node.id, contentId: next.id, title: node.title || '' };
            await sleep(rnd(100, 200));
        }
        return null;
    }

    // 跳到某个内容项的阅读器页
    function gotoContent(courseId, catalogId, contentId) {
        const url = location.origin + '/course_center/reader/student_course/' + courseId
            + '?catalogId=' + catalogId + '&contentId=' + contentId;
        location.href = url;
    }

    // 处理完当前节后推进到下一节；由 doOneRound 尾部调用
    async function autoAdvance() {
        const st = getAutoRun();
        if (!st || !st.active) return false;
        const courseId = st.courseId || currentCourseId();
        if (!courseId) { setAutoRun(null); status('自动刷课：无法确定课程，已停止'); return false; }

        const r = parseReaderRoute();
        if (r && r.contentId) st.done = Array.from(new Set((st.done || []).concat([String(r.contentId)])));
        st.courseId = courseId;
        setAutoRun(st);

        const doneSet = new Set((st.done || []).map(String));
        const next = await findNextTarget(courseId, doneSet);

        if (next && next.error) { status('自动刷课：' + next.error + '，已停止'); setAutoRun(null); return false; }
        if (!next) {
            setAutoRun(null);
            status('★ 自动刷课完成：该课程已无未完成内容（共处理 ' + doneSet.size + ' 项）');
            stopRun('全部完成');
            return false;
        }
        if (next.contentId === (r && r.contentId)) {
            // 没推进（例如服务端尚未更新进度）——避免原地打转
            st.stuck = (st.stuck || 0) + 1;
            setAutoRun(st);
            if (st.stuck >= 3) { setAutoRun(null); status('自动刷课：连续 3 次未见推进，已停止'); stopRun('未见推进'); return false; }
        } else {
            st.stuck = 0;
            setAutoRun(st);
        }
        // 【local14】整页跳转是"自动刷新"观感的来源。加计数上限，避免无人值守时无限跳。
        st.jumps = (st.jumps || 0) + 1;
        if (st.jumps > 300) {
            setAutoRun(null);
            status('自动刷课：已跳转 ' + st.jumps + ' 次，为防止无限刷新已自动停止');
            stopRun('跳转次数超限');
            return false;
        }
        setAutoRun(st);
        status('自动刷课 → 第 ' + st.jumps + ' 次跳转：' + String(next.title).slice(0, 18)
            + '（已处理 ' + doneSet.size + ' 项，剩余待刷；点「停止」可中断）');
        await sleep(rnd(600, 1000));
        gotoContent(courseId, next.catalogId, next.contentId);
        return true;
    }

    // 启动自动刷课（课程页与阅读器页都可调用）
    async function startAutoRun() {
        const courseId = await resolveCourseId();
        if (!courseId) {
            status('未能确定课程：请进入课程内页，或在面板「课程」下拉中选择一门');
            return false;
        }
        const st = { active: true, courseId: courseId, done: [], stuck: 0, jumps: 0 };
        // 记录当前已处理的节，避免重复
        const r = parseReaderRoute();
        if (r && r.contentId) st.done.push(String(r.contentId));
        setAutoRun(st);

        if (r) {
            // 已在阅读器：先处理当前节，其尾部会自动推进
            status('自动刷课已启动（先处理当前节，再自动往下）');
            return true;
        }
        // 在课程页：直接定位到进度不足的第一项
        status('自动刷课：正在查找进度不足的内容...');
        const next = await findNextTarget(courseId, new Set());
        if (next && next.error) { status('自动刷课：' + next.error); setAutoRun(null); return false; }
        if (!next) { status('★ 该课程已无未完成内容'); setAutoRun(null); return false; }
        status('自动刷课 → 首节：' + String(next.title).slice(0, 18));
        await sleep(rnd(400, 700));
        gotoContent(courseId, next.catalogId, next.contentId);
        return true;
    }
    //
    // 设计要点（来自 issue #2 的实测反馈）：
    //   1. 统计前先等渲染稳定 —— 首轮自检曾只数到 2 个题卡，实际有 17 个；
    //      若照首轮结果推进，只会处理 2/17 的内容。
    //   2. 输出「DOM 快照规模」作为可信度依据，让读者能判断这次统计是否可靠。
    //   3. 探针区分「类名不存在」与「元素存在但类名不同」——
    //      按语义宽匹配一次，把命中元素的 class 打印出来。
    //   4. 题卡不只列前 5 条，另给题型分布汇总。

    // 等待内容渲染稳定：连续两次采样题卡数不再增长，或超时
    async function waitForStableRender(maxMs) {
        const deadline = Date.now() + (maxMs || 6000);
        let prev = -1, stable = 0;
        while (Date.now() < deadline) {
            const n = $(SEL.exerciseItem).length;
            if (n > 0 && n === prev) {
                stable++;
                if (stable >= 2) return { stable: true, items: n, waited: true };
            } else {
                stable = 0;
            }
            prev = n;
            await sleep(400);
        }
        return { stable: false, items: $(SEL.exerciseItem).length, waited: true };
    }

    // 取某选择器命中元素的 class 摘要（最多 6 个不同值）
    function classSummary(sel, limit) {
        const els = $(sel);
        if (!els.length) return null;
        const set = new Set();
        els.forEach(el => {
            const c = (el.className || '').toString().trim();
            if (c) set.add(c.length > 60 ? c.slice(0, 60) + '…' : c);
        });
        return Array.from(set).slice(0, limit || 6);
    }

    async function selfCheck() {
        const out = [];
        const route = parseReaderRoute();

        out.push('== 环境 ==');
        out.push('URL: ' + location.pathname + (location.search || ''));
        out.push('脚本版本: v' + SCRIPT_VERSION + '（' + detectEnvironment().kind + ' 引擎）');
        out.push('');

        out.push('== 路由 ==');
        out.push(route ? JSON.stringify(route) : '未匹配阅读器路由：' + location.pathname);
        out.push('');

        // 判分策略 —— 决定反复提交的后果，是作答策略的前提
        out.push('== 课程判分策略 ==');
        if (route) {
            const p = await loadCoursePolicy(true);
            const st = strategyOf(p);
            if (p && p.loaded) {
                out.push('学习模式: ' + st.mode + '（learnMode=' + p.learnMode + '）');
                out.push('成绩取值: 记' + st.gradeBy + '答题结果');
                out.push('反复提交: ' + (st.retrySafe ? '安全（记最高，不会拉低成绩）' : '有风险（记末次，错误提交会成为最终成绩）'));
                out.push('显示答案: freeShowAnswer=' + p.freeShowAnswer + ' passShowAnswer=' + p.passShowAnswer);
                out.push('答案下发阈值 errorNumShow: ' + p.errorNumShow + '（答错达该次数后服务端下发标准答案）');
                out.push('计入成绩 caculateToGrade: ' + p.caculateToGrade + '；学习时长限制 learnTimeLimit: ' + p.learnTimeLimit);
                out.push('说明: ' + st.note);
            } else {
                out.push('读取失败：' + ((p && p.error) || '未知') + '（将按最保守策略执行，不做试错提交）');
            }
        } else {
            out.push('跳过（非阅读器页面）');
        }
        out.push('');
        out.push('== 令牌 ==');
        out.push('localStorage.' + TOKEN_KEY + '：' + (getToken() ? '存在（' + getToken().length + ' 字符）' : '缺失'));
        out.push('');

        // ---- 渲染稳定性（issue #2 第 3 条）----
        out.push('== 渲染稳定性 ==');
        const before = $(SEL.exerciseItem).length;
        const stab = await waitForStableRender(6000);
        const after = $(SEL.exerciseItem).length;
        out.push('题卡数：初次 ' + before + ' → 稳定后 ' + after +
            (stab.stable ? '（已稳定）' : '（超时未稳定，结果可能偏少）'));
        if (after > before) {
            out.push('注意：初次统计偏少 ' + (after - before) + ' 个，已采用稳定后的数值');
        }
        out.push('');

        out.push('== DOM 探针 ==');
        for (const [name, sel] of Object.entries(SEL)) {
            const n = $(sel).length;
            let line = sel + ' → ' + n + (n ? ' 命中' : ' 未命中');
            if (!n) {
                // 未命中时尝试宽匹配，区分「不存在」与「类名不同」
                const kw = sel.replace(/^\./, '').split('-')[0];
                if (kw && kw.length >= 3) {
                    const loose = classSummary('[class*="' + kw + '"]', 4);
                    if (loose && loose.length) line += '  ⚠ 宽匹配 [class*="' + kw + '"] 命中：' + loose.join(' | ');
                }
            }
            out.push(line);
        }
        out.push('');
        out.push('== 语义宽匹配（校准类名用）==');
        for (const kw of ['fill', 'blank', 'option', 'answer', 'pagination', 'choice', 'contenteditable']) {
            const sel = kw === 'contenteditable' ? '[contenteditable]' : '[class*="' + kw + '"]';
            const n = $(sel).length;
            out.push('  ' + sel + ' → ' + n + (n ? ('  ' + (classSummary(sel, 3) || []).join(' | ')) : ''));
        }
        out.push('');

        // ---- 题卡 + 题型分布（issue #2 第 4 条）----
        const items = getExerciseItems();
        out.push('== 题卡 == 共 ' + items.length + ' 个');
        const dist = {};
        const details = [];
        items.forEach((el, i) => {
            const t = detectType(el) || '未知';
            dist[t] = (dist[t] || 0) + 1;
            if (i < 8) {
                details.push('  #' + i + ' 推断题型=' + t +
                    ' 选项数=' + getOptions(el).length +
                    ' 填空数=' + $('.zty-exercise-item-fill-blank-do', el).length +
                    ' contenteditable=' + $('[contenteditable="true"]', el).length);
            }
        });
        if (details.length) out.push(details.join('\n'));
        if (items.length > details.length) {
            out.push('  …（仅列前 ' + details.length + ' 条，其余见下方分布）');
        }
        out.push('  题型分布：' + (Object.keys(dist).length
            ? Object.entries(dist).map(([k, v]) => k + ' ×' + v).join(' / ')
            : '（无）'));
        out.push('');

        // ---- 按钮 ----
        out.push('== 按钮 ==');
        const sub = findSubmitButton(), ret = findRetryButton();
        out.push('Submit 按钮：' + (sub ? '存在' + (sub.disabled ? '（禁用）' : '') : '未找到'));
        out.push('Retry 按钮：' + (ret ? '存在' : '未找到'));

        // 分页按钮的渲染条件（已从产物证实）：
        //   分页栏位于 div.preview-navbar 内，且受「预览模式 && 总页数>0」控制。
        //   流式滚动模式（readMode==='stream'）下不渲染分页栏，此时 0 命中是正常的，
        //   并非类名错误。故一并打印导航栏状态以便区分。
        const hasNavbar = !!$1('.preview-navbar');
        out.push('分页按钮(' + SEL.paginationBtn + ')：' + $(SEL.paginationBtn).length + ' 个');
        out.push('分页计数(' + SEL.paginationWrap + ')：' + $(SEL.paginationWrap).length + ' 个');
        out.push('分页栏容器(.preview-navbar)：' + (hasNavbar ? '存在' : '不存在'));
        if (!$(SEL.paginationBtn).length) {
            out.push('  → 说明：分页栏仅在「预览模式 + 总页数>0」时渲染；' +
                (hasNavbar ? '当前有导航栏但无分页按钮，可能非分页模式' : '当前无导航栏，可能为流式滚动模式') +
                '。这不代表类名错误。');
        }
        const pc = paginationCounter();
        out.push('分页计数文本：' + (pc ? pc : '（未读到）'));
        const pgLoose = classSummary('[class*="pagination"]', 5);
        if (pgLoose) out.push('  宽匹配 [class*="pagination"] 命中：' + pgLoose.join(' | '));
        out.push('');

        // ---- 取题接口（脱敏：只报字段名与长度，不报答案内容）----
        if (route && route.contentId) {
            out.push('== 取题接口 ==');
            const data = await loadCurrentExercise();
            if (data) {
                out.push('questionVOList: ' + (data.questionVOList || []).length + ' 题');
                out.push('answerCount: ' + data.answerCount);
                out.push('questionAnswerItemVOList: ' + (data.questionAnswerItemVOList || []).length + ' 条');
                const first = (data.questionVOList || [])[0];
                if (first) out.push('首题字段：' + Object.keys(first).join(', '));
                out.push('首题 type=' + (first && first.type) + ' obSub=' + (first && first.obSub));
                const firstAns = (data.questionAnswerItemVOList || [])[0];
                if (firstAns) {
                    // 只报字段名与类型/长度，不回显答案内容（自检输出会贴到公开 issue）
                    const desc = Object.keys(firstAns).map(k => {
                        const v = firstAns[k];
                        if (v === null || v === undefined) return k + '=null';
                        if (Array.isArray(v)) return k + '=[array×' + v.length + ']';
                        if (typeof v === 'object') return k + '={obj}';
                        return k + '=(' + typeof v + ', len ' + String(v).length + ')';
                    });
                    out.push('首条答案字段：' + desc.join(', '));
                }
            } else {
                out.push('取题失败');
            }
        } else {
            out.push('== 取题接口 ==');
            out.push('跳过（URL 无 contentId）');
        }
        return out.join('\n');
    }

    // ============================================================================
    // 12. 脚本有效性检测 + GitHub Issue 上报
    // ============================================================================

    const REPORT_KEY = 'tsh_auto_brush_report';
    let reportConfig = { consent: null, consentVersion: '', enabled: false, owner: '', repo: '', token: '', lastReport: 0 };
    function loadReportConfig() {
        try { const s = localStorage.getItem(REPORT_KEY); if (s) reportConfig = Object.assign(reportConfig, JSON.parse(s)); } catch (e) {}
    }
    function saveReportConfig() {
        try { localStorage.setItem(REPORT_KEY, JSON.stringify(reportConfig)); } catch (e) {}
    }

    // 探针：对照【新站】结构。v2.0.0 起改为新站选择器。
    function checkScriptValidity() {
        if (!/tsinghuaelt\.com/.test(location.hostname)) return true;
        if (document.readyState !== 'complete') return true;
        // 只在阅读器页面判定（其他页面没有这些结构是正常的，不算失效）
        if (!parseReaderRoute()) return true;
        const probes = [SEL.readerRoot, SEL.exercisePreview, SEL.exerciseItem, SEL.paginationBtn, SEL.chapterSection];
        return probes.some(s => $1(s)) === true;
    }

    async function reportIssue(reason) {
        if (!reportConfig.enabled || !reportConfig.owner || !reportConfig.repo || !reportConfig.token ||
            reportConfig.consent !== true || reportConfig.consentVersion !== '1.0') return false;
        const now = Date.now();
        if (now - reportConfig.lastReport < 86400000) return false;

        const title = '[自动报告] 清华社刷课脚本可能失效 v' + SCRIPT_VERSION;
        const pathMasked = location.pathname.replace(/\/reader\/([^/]+)\/\d+/, '/reader/$1/{bizId}');
        const body = [
            '**脚本版本**：v' + SCRIPT_VERSION,
            '**站点**：' + location.origin,
            '**页面**：' + (location.origin + pathMasked).slice(0, 120),
            '**构建版本**：' + (window.__BUILD_VERSION__ || '未知'),
            '**时间**：' + new Date().toLocaleString('zh-CN'),
            '**检测**：核心 DOM 探针全未命中（站点可能再次改版）',
            '**原因**：' + (reason || '脚本失效检测触发'),
            '',
            '<details><summary>结构自检</summary>',
            '',
            '```',
            (await selfCheck()).slice(0, 3000),
            '```',
            '</details>'
        ].join('\n');

        try {
            const resp = await fetch('https://api.github.com/repos/' + reportConfig.owner + '/' + reportConfig.repo + '/issues', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + reportConfig.token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({ title, body })
            });
            if (resp.ok) {
                reportConfig.lastReport = now;
                saveReportConfig();
                status('已自动上报 issue（24h 内不再重复）');
                return true;
            }
            status('上报失败（HTTP ' + resp.status + '，检查 token 权限）');
        } catch (e) { status('上报失败（网络）'); }
        return false;
    }

    // ============================================================================
    // 13. 主循环
    // ============================================================================

    let running = false;
    let timer = null;
    let roundCount = 0;
    let noProgressRounds = 0;
    let wrongRedoFails = 0;
    // 【local59】提交了但服务端不认的节：连续 2 次就标记为需手工，避免无限重试
    const MANUAL_SECTIONS = new Map();      // 【local36】同一节连续重做仍未取得答案的次数
    let invalidRounds = 0;
    let statusEl = null;
    const MAX_ROUNDS = 500;

    async function doOneRound() {
        // 限流冷却（站点自身无退避，必须由脚本控制节奏）
        if (isRateLimited()) {
            status('限流冷却中 ' + rateLimitRemainSec() + 's，稍后自动继续');
            return;
        }
        const route = parseReaderRoute();
        if (!route) {
            if (isCoursePage()) { status('请在课程中打开具体教材/课程章节'); return; }
            status('当前不是阅读器页面，请进入教材/课程阅读页');
            return;
        }
        // 有效性检测（仅阅读器页）
        if (!checkScriptValidity()) {
            invalidRounds++;
            if (invalidRounds >= 10) {
                const reported = await reportIssue('核心 DOM 探针连续 10 轮未命中');
                stopRun('脚本可能已失效（站点结构不匹配），' + (reported ? '已自动上报 issue' : '请检查/更新脚本'));
                return;
            }
            status('页面结构异常（' + invalidRounds + '/10），等待确认...');
        } else {
            invalidRounds = 0;
        }

        roundCount++;
        if (roundCount > MAX_ROUNDS) { stopRun('达到最大轮次保护(' + MAX_ROUNDS + ')，已停止'); return; }

        // 0) 判分策略 —— 必须在作答之前分清模式
        //
        // 自由模式记「末次」、闯关模式记「最高」，这直接决定反复提交的后果。
        // 读不到策略时按最保守处理（不试错），宁可少做也不冒险改成绩。
        const policy = await loadCoursePolicy();
        const strat = strategyOf(policy);
        if (!policy || !policy.loaded) {
            status('未能读取课程设置（' + ((policy && policy.error) || '未知') + '），本次按最保守策略执行');
        } else {
            log('判分策略', strat, policy);
        }

        // 1) 取题（含标准答案）
        //
        // 取题前先等题卡渲染稳定（issue #2 实测反馈）：
        // 页面内容异步加载，首轮可能只渲染出 2 个题卡而实际有 17 个。
        // 若按未稳定的快照推进，只会处理其中一小部分内容。
        await waitForStableRender(5000);

        const data = await loadCurrentExercise();
        if (!data) {
            noProgressRounds++;
            if (noProgressRounds >= 3) { noProgressRounds = 0; stopRun('连续取题失败，已停止'); }
            return;
        }

        const questions = data.questionVOList || [];

        // 【local70】整节都是判断题 → 放在所有分支之前处理。
        // 之前放在"未答完/已全部作答"分支里，都被前面的路径抢走（judge_advanced 的
        // doRecord 是 JSON 数组，hasUserAnswer 判成未作答 → 直接进试错轮询）。
        // 判断题只有对/错两态，是最不该跑 6 轮试错的题型。
        try {
            const JT = [TYPE.JUDGE, TYPE.JUDGE_HIGH];
            const allJudge = questions.length > 0 && questions.every(q => JT.indexOf(q.type) >= 0);
            if (allJudge && getExerciseItems().length) {
                const amapA = buildAnswerMap(currentResp || data);
                const wrongQs = questions.filter(q => {
                    const a = amapA.get(Number(q.id));
                    const st = a ? Number(a.status) : Number(q.answerStatus);
                    return st === 2;
                });
                const domWrong = $('[class*="wrong"], img[src*="wrong"]').length;
                if (wrongQs.length || domWrong > 0) {
                    status('整节判断题（' + questions.length + ' 题，答错 ' + wrongQs.length + '）→ 逐行纠正后提交');
                    const cardOf = (q) => findCardForQuestion(getExerciseItems(), q, 0) || getExerciseItems()[0] || null;
                    let apiFlipUsed = false;
                    if (await ensureEditableState()) {
                        let fixedA = 0;
                        for (const q of questions) {
                            const a = amapA.get(Number(q.id));
                            const card = findCardForQuestion(getExerciseItems(), q, 0);
                            if (!card) continue;
                            let done = false;
                            if (a && a.answer) {
                                const val = decodeAnswer(a.answer, q.type);
                                done = await fillSingleChoice(card, val);
                                if (!done) done = applyAnswer(card, q.type, val);
                                if (done) markAnswered(q, val, card);
                                log('判断题按标准答案纠正', { id: q.id, ok: done });
                            }
                            if (!done) {
                                // 【local71】先算答案走接口（不依赖点击），失败再退回 DOM 点击
                                const flipped = computeFlippedAnswer(card, q);
                                if (flipped !== undefined) {
                                    markAnswered(q, flipped, card);
                                    done = true;
                                    apiFlipUsed = true;
                                    log('接口取反', { id: q.id, val: String(JSON.stringify(flipped)).slice(0, 60) });
                                } else {
                                    const rows = await flipJudgeRows(card);
                                    if (rows) { done = true; markAnswered(q, 'flip' + rows, card); }
                                    else done = await flipJudgeAnswer(card, q);
                                }
                            }
                            if (done) fixedA++;
                        }
                        if (fixedA) {
                            await sleep(rnd(400, 800));
                            await submitAnswers(apiFlipUsed);
                            await verifyAfterSubmit(questions);
                            // 【local72】取反后仍判错 → 穷举（2^n 种组合，判对即停）
                            let solvedAll = true;
                            for (const q of questions) {
                                const card2 = findCardForQuestion(getExerciseItems(), q, 0) || cardOf(q);
                                const stNow = await readQuestionStatus(q.id);
                                if (stNow && stNow.st === 1) continue;
                                solvedAll = false;
                                if (!card2) continue;
                                const solved = await bruteForceJudge(q, card2);
                                log('判断题穷举结果', { id: q.id, solved: solved });
                                if (solved) solvedAll = true;
                            }
                            noProgressRounds = 0;
                            return;
                        }
                        status('判断题纠正失败，继续常规流程');
                    } else {
                        status('判断题纠正前无法进入作答态，继续常规流程');
                    }
                }
            }
        } catch (e) { log('判断题快路异常', String(e).slice(0, 60)); }

        if (questions.length) {
            // 语音评测题需真实录音，无法自动作答 —— 但不因此跳过整节。
            //
            // 【本地修复 v2.3.1-local78】站点并没有"整节答完才能提交"的硬门禁：
            // 全量前端产物里搜不到「请完成所有习题」这类文案（0 命中），
            // 而 submitAnswers() 在按钮 disabled 时会直接调提交接口，
            // 也就是说部分作答是可以提交的。因此只在这两种情况下跳过：
            //   a) 整节所有题卡都是语音题（没有可作答的东西）
            //   b) 服务端真的拒绝提交（由路径 B 处理）
            // 其余情况照常作答并提交，让语音题留空。
            const allCards = getExerciseItems();
            const speechCards = allCards.filter(cardNeedsSpeech);
            const allSpeech = allCards.length > 0 && speechCards.length === allCards.length;
            if (speechCards.length) {
                log('语音题卡片', {
                    cards: allCards.length,
                    speechCards: speechCards.length,
                    questions: questions.length,
                    allSpeech
                });
                // 逐张打印判定依据：hasAnswerable=true、或 hasRecControl=false 时高度可疑是误判
                speechCards.forEach((c, i) => log('语音判定 #' + (i + 1), speechDiagnosis(c)));
            }
            if (allSpeech) {
                status('本节 ' + allCards.length + ' 个题卡全部是语音题（需真人录音），整节跳过');
                await sleep(rnd(600, 1000));
                // 标记内容完成并尝试翻页，让用户自行处理语音题
                if (route.catalogId) await apiMarkContentDone(route.bizId, route.catalogId, route.contentId || 0);
                const movedBySpeech = await clickPagination('next');
                if (!movedBySpeech) {
                    noProgressRounds++;
                    if (noProgressRounds >= 3) { noProgressRounds = 0; stopRun('遇到语音题且无法翻页，已停止'); }
                } else { noProgressRounds = 0; }
                return;
            }
            if (speechCards.length) {
                status('本节有 ' + speechCards.length + ' 个语音题卡（需真人录音）将留空，'
                    + '其余 ' + (allCards.length - speechCards.length) + ' 个正常作答并提交');
            }

            // 判定是否已全部作答
            const unanswered = questions.filter(q => !hasUserAnswer(q));
            if (unanswered.length) {
                status('作答中（未答 ' + unanswered.length + '/' + questions.length + '）· '
                    + strat.mode + '（成绩记' + strat.gradeBy + '）');

                // 路径 1：页面下发了答案就直接填。
                // 注意：标准答案只在作答次数达到 errorNumShow 后才由服务端下发，
                // 未必在首次取题时就有（见 DEVELOPMENT §11.3）。
                const r = await fillByAnswerMap();
                log('页面答案填充结果', r);
                await sleep(rnd(300, 600));

                // 路径 2：AI 补答 —— **只针对主观题**。
                //
                // 客观题不需要 AI：轮询就能从服务端拿到权威 standardAnswer，
                // 比 AI 更准（实测同一题 AI 五空全错、轮询得到的全对），且零 token 成本。
                // 主观题才是 AI 唯一必要的场景 —— 服务端对它们不下发答案。
                let left = questions.filter(q => !hasUserAnswer(q));

                // 【local69】判断题专项：只要"待作答"的题全是判断题，就直接纠正一次提交。
                // 之前这段放在"已全部作答"分支里，但 judge_advanced 的 doRecord 是 JSON 数组，
                // hasUserAnswer() 判成未作答 → 整节直接进试错轮询，专用路径永远轮不到。
                // 判断题只有对/错两态，是最省时的一种题，值得单独一条快路。
                const JUDGE_FAST = [TYPE.JUDGE, TYPE.JUDGE_HIGH];
                const judgeLeft = left.filter(q => JUDGE_FAST.indexOf(q.type) >= 0);
                if (judgeLeft.length && judgeLeft.length === left.length) {
                    status('待作答的都是判断题（' + judgeLeft.length + ' 题），直接纠正后提交一次');
                    const amapJ = buildAnswerMap(currentResp);
                    if (await ensureEditableState()) {
                        const itemsJ = getExerciseItems();
                        let fixedJ = 0;
                        for (const q of judgeLeft) {
                            const a = amapJ.get(Number(q.id));
                            const card = findCardForQuestion(itemsJ, q, 0);
                            if (!card) continue;
                            let done = false;
                            if (a && a.answer) {
                                const val = decodeAnswer(a.answer, q.type);
                                done = await fillSingleChoice(card, val);
                                if (!done) done = applyAnswer(card, q.type, val);
                                if (done) markAnswered(q, val, card);
                                log('判断题按标准答案纠正', { id: q.id, ok: done });
                            }
                            if (!done) done = await flipJudgeAnswer(card, q);
                            if (done) fixedJ++;
                        }
                        if (fixedJ) {
                            await sleep(rnd(400, 800));
                            await submitAnswers();
                            await verifyAfterSubmit(judgeLeft);
                            noProgressRounds = 0;
                            return;
                        }
                        status('判断题纠正失败，回退到通用流程');
                    } else {
                        status('判断题纠正前无法进入作答态，回退到通用流程');
                    }
                    left = questions.filter(q => !hasUserAnswer(q));
                }
                // 分流优先采用**服务端行为证据**（gradedKindOf），标签只作兜底：
                // 有返回时以 answerStatus 为准，避免站点标签不准导致白调 AI 或白轮询。
                const kindMap = buildAnswerMap(currentResp);
                const subjectiveLeft = left.filter(q => {
                    const kind = gradedKindOf(kindMap.get(Number(q.id)));
                    if (kind === 'subjective') return true;
                    if (kind === 'objective') return false;
                    return isSubjective(q);          // 尚无返回 → 退回 obSub/题型标签
                });
                if (subjectiveLeft.length) {
                    if (aiEnabled()) {
                        status('主观题 ' + subjectiveLeft.length + ' 道（服务端不下发答案），改用 AI 作答');
                        const ai = await fillByAI(subjectiveLeft);
                        log('AI 补答结果', ai);
                        if (ai.failed && ai.failed.length) log('AI 未覆盖的题', ai.failed);
                        await sleep(rnd(400, 800));
                    } else {
                        status('本节含 ' + subjectiveLeft.length + ' 道主观题，服务端不下发答案 —— 需配置 AI 才能作答');
                    }
                    left = questions.filter(q => !hasUserAnswer(q));
                }
                const objectivePending = left.filter(q => !isSubjective(q)).length;
                if (objectivePending) {
                    log('客观题 ' + objectivePending + ' 道交由轮询取权威答案（不调用 AI）');
                }

                if (!getExerciseItems().length) { status('未找到题卡元素'); return; }

                // 路径 3：试错取答案。
                //
                // 【为什么即便 AI 已填满也要走这一步】AI 的作答只是"当前最优猜测" ——
                // 实测同一道填空题 AI 五个空全判错（rightRate 0），而服务端下发的
                // standardAnswer 才是权威答案。因此**没有官方答案就继续轮询**，
                // 拿到后重填并提交，这才是保证满分的路径。
                //
                // 【机制】服务端在作答次数累计到 errorNumShow 次后，才在
                // questionAnswerItemVOList[].answer 下发标准答案（选择题与填空题均已实测）。
                //
                // 【关于自由模式】成绩记「末次」，理论上有风险；但本流程每一轮都**保留当前最优答案**
                // 只补空白（见 retryUntilAnswer），并最终用服务端答案闭环提交，
                // 因此实际是单调改善：中途中断最多停在当前水平，不会比不试错更差。
                const amap = buildAnswerMap(currentResp);
                const hasOfficialAnswer = questions.length > 0 && questions.every(q => {
                    const a = amap.get(Number(q.id));
                    return !!(a && a.answer);
                });
                const threshold = answerRevealThreshold(policy);

                if (!hasOfficialAnswer) {
                    if (!Number.isFinite(threshold)) {
                        status('未能确定答案下发阈值（errorNumShow 缺失），跳过试错，按当前作答提交');
                    } else {
                        if (!strat.retrySafe) {
                            status('【' + strat.mode + '】成绩记' + strat.gradeBy
                                + ' —— 保持当前答案不变，只补空白，拿到服务端答案后闭环覆盖');
                        }
                        status('试错取答案：服务端在答错 ' + threshold + ' 次后下发标准答案');
                        const got = await retryUntilAnswer(route, questions, threshold);
                        if (!got) status('试错未取得标准答案，按当前作答提交');
                        left = questions.filter(q => !hasUserAnswer(q));
                    }
                }

                // 注：原注释称"站点前端有硬门禁：未答完提交会被拦下"——实测不成立，
                // 见下方 local5 的说明。此处不再假设门禁存在。
                if (left.length) {
                    // 【本地修复 v2.3.1-local78】先尝试提交已作答部分。
                    // 站点前端没有"整节答完才能提交"的硬门禁（全量产物里无相关文案），
                    // 且 submitAnswers() 在按钮 disabled 时会直接走提交接口。
                    // 只有服务端确实拒绝时，才按原逻辑跳过/停止。
                    const kinds = left.map(q => q.type || '未知').slice(0, 6).join(' / ');
                    status('本节仍有 ' + left.length + ' 题未能作答（' + kinds + '），尝试提交已作答部分');
                    log('未作答题目', left.map(q => ({ id: q.id, type: q.type })));
                    const partialOk = await submitAnswers();
                    if (partialOk) {
                        noProgressRounds = 0;
                        return;
                    }
                    // 【自动刷课时不能停】真正的语音题走第三方评测，空提交会失败。
                    // 交给 loop 尾部的 autoAdvance 继续，避免卡死在同一节。
                    if ((getAutoRun() || {}).active) {
                        status('提交被服务端拒绝，跳过并继续下一节');
                        return;
                    }
                    stopRun('仍有 ' + left.length + ' 题无法作答且提交被拒，已停止。');
                    return;
                }

                await submitAnswers();
                noProgressRounds = 0;
                return;
            }
            // 已全部作答：doRecord 有值即说明服务端已记录。
            //
            // 但如果存在**答错的题**（answerStatus 不是 1）、且服务端已下发标准答案，
            // 就值得重做一次把它覆盖掉 —— 否则这一节的分数会永久停在错误值上。
            // 这正是「拿分」的关键：站点既然后来给了正确答案，就没有理由让它白给。
            const doneMap = buildAnswerMap(currentResp);
            const redoList = questions.filter(q => {
                const a = doneMap.get(Number(q.id));
                if (!a) return false;
                const st = Number(a.status);
                if (st === 1) return false;        // 已答对
                if (st === -1) return false;       // 主观题，服务端不自动判分
                return !!a.answer;                 // 答错 且 有官方答案 → 可覆盖
            });

            // 【local68】判断题专项必须在 redoList 分支**之前**：
            // 判断题答错且服务端已下发答案时，会先被 redoList 吃掉，专用路径永远不触发。
            // 优先用服务端标准答案；没有答案才取反（对⇄错 只有两种可能）。
            const JUDGE_T = [TYPE.JUDGE, TYPE.JUDGE_HIGH];
            const judgeWrongAll = questions.filter(q => {
                if (JUDGE_T.indexOf(q.type) < 0) return false;
                const a = doneMap.get(Number(q.id));
                const st = a ? Number(a.status) : Number(q.answerStatus);
                return st === 2;
            });
            if (judgeWrongAll.length) {
                status('判断题答错 ' + judgeWrongAll.length + ' 题，直接纠正后提交一次');
                if (await ensureEditableState()) {
                    const items1 = getExerciseItems();
                    let fixed = 0;
                    for (const q of judgeWrongAll) {
                        const a = doneMap.get(Number(q.id));
                        const card = findCardForQuestion(items1, q, 0);
                        if (!card) continue;
                        let done = false;
                        if (a && a.answer) {
                            const val = decodeAnswer(a.answer, q.type);
                            done = await fillSingleChoice(card, val);
                            if (!done) done = applyAnswer(card, q.type, val);
                            if (done) markAnswered(q, val, card);
                            log('判断题按标准答案纠正', { id: q.id, val: String(val).slice(0, 12), ok: done });
                        }
                        if (!done) done = await flipJudgeAnswer(card, q);
                        if (done) fixed++;
                    }
                    if (fixed) {
                        await sleep(rnd(400, 800));
                        await submitAnswers();
                        await verifyAfterSubmit(judgeWrongAll);
                        noProgressRounds = 0;
                        return;
                    }
                    status('判断题纠正失败，回退到通用流程');
                } else {
                    status('判断题纠正前无法进入作答态，回退到通用流程');
                }
            }

            if (redoList.length) {
                status('本节有 ' + redoList.length + ' 题答错且服务端已下发标准答案，重做覆盖');
                if (await ensureEditableState()) {
                    const rr = await fillByAnswerMap();
                    log('重做回填', rr);
                    if (rr.filled) {
                        await sleep(rnd(400, 800));
                        await submitAnswers();
                        await verifyAfterSubmit(redoList);
                        noProgressRounds = 0;
                        return;
                    }
                    // 【local55】UI 填不进去（自绘 checkbox 等）→ 把标准答案直接写进
                    // 提交模型，走接口提交。答案本身是服务端下发的，不依赖页面点击。
                    let marked = 0;
                    for (const q of redoList) {
                        const a = lastAnswerMap.get(Number(q.id));
                        if (!a || a.answer === undefined || a.answer === '') continue;
                        const type = q.type || '';
                        const val = (AI_FILL_TYPES.has(type) || AI_ESSAY_TYPES.has(type))
                            ? normalizeFillAnswer(a.answer) : decodeAnswer(a.answer, type);
                        if (val === null || val === undefined || val === '') continue;
                        markAnswered(q, val, findCardForQuestion(getExerciseItems(), q, 0));
                        marked++;
                    }
                    if (marked) {
                        status('UI 回填失败，改用接口提交 ' + marked + ' 题标准答案');
                        log('接口直提', { marked: marked, types: redoList.map(q => q.type) });
                        await submitAnswers(true);
                        await verifyAfterSubmit(redoList);
                        noProgressRounds = 0;
                        return;
                    }
                    status('重做未能填入答案（可能在查看态下无可写元素）');
                } else {
                    status('无法进入作答态，跳过重做');
                }
            }

            // 【local22】判错、但服务端还没下发标准答案 —— 这类题最容易被漏掉：
            // 本节「已全部作答」→ 直接报完成并翻页，页面上那些 -done-wrong 永远不被纠正。
            // 服务端是在答错累计到 errorNumShow 次后才下发答案的，所以这里主动
            // 把那几个错误答案再提交几轮，逼出标准答案后回填覆盖。
            // 自由模式记末次：重复提交**同一个**错误答案不会让成绩更差，
            // 拿到答案后最后一次提交才是最终成绩，属于单调改善。
            // 【local23】answerMap 有时是空的：questionAnswerItemVOList[].questionId
            // 若不是数字，buildAnswerMap 会整条丢掉（Number() → NaN 被跳过），
            // 于是上面的 filter 恒为空、错题重做永不触发。
            // 这里同时读「合并后的题目字段」（mergeAnswerItems 已经把 answerStatus /
            // answer 写到 q 上），两条路都试。
            const judgeStatusOf = (q, a) => {
                if (a && a.status !== undefined && a.status !== null && a.status !== '') return Number(a.status);
                if (q && q.answerStatus !== undefined && q.answerStatus !== null && q.answerStatus !== '') return Number(q.answerStatus);
                return null;
            };
            const hasAnswerOf = (q, a) => {
                if (a && a.answer) return true;
                if (q && q.answer) return true;
                return false;
            };
            log('错题判定输入', {
                questions: questions.length,
                answerMapSize: doneMap.size,
                sample: questions.slice(0, 4).map(q => ({
                    id: q.id,
                    type: q.type,
                    doRecord: String(q.doRecord === undefined ? '' : q.doRecord).slice(0, 24),
                    answerStatus: q.answerStatus,
                    hasAnswerField: !!q.answer
                }))
            });
            const wrongNoAnswer = questions.filter(q => {
                const a = doneMap.get(Number(q.id));
                const st = judgeStatusOf(q, a);
                if (st === 1) return false;              // 已答对
                if (st === -1) return false;             // 主观题，服务端不判分
                if (st === null) return false;           // 状态未知，不动
                return !hasAnswerOf(q, a);               // 判错 且 没有官方答案
            });
            // 【local24】API 字段靠不住时（实测本节的 q.doRecord 是空串、
            // answerStatus 缺失，answerMap 里又对不上 id），改用**页面上的红叉**判定：
            // 判错的空会渲染成 span.zty-exercise-item-fill-blank-done-wrong。
            // 这是用户肉眼能看到的事实，比接口字段可靠。
            // 【local36】判错标记不能只认填空题的 -done-wrong：
            // 选择题/判断题答错时站点用别的标记（图标/类名），原来恒为 0，
            // 于是"答错了"被当成"已完成"直接翻页。
            let wrongMarks = 0;
            const wrongDetail = [];
            try {
                // 【local47】判错统计必须覆盖**嵌套子卡**：多选题/填空题常常挂在
                // 组合题父卡内部，只扫顶层卡片会一个标记都数不到 → 判成"已完成"跳过。
                const scanCards = [];
                getExerciseItems().forEach(c => {
                    scanCards.push(c);
                    try {
                        c.querySelectorAll('.exercise-item').forEach(x => scanCards.push(x));
                    } catch (e) {}
                });
                scanCards.forEach((card, ci) => {
                    // 【local37】实测选择题的判错标记是 radio-group-wrong
                    // （ant-radio-group ant-radio-group-outline radio-group-wrong …）。
                    // 枚举类名永远漏，改用通配 "wrong"。
                    const hits = card.querySelectorAll(
                        '[class*="wrong"], img[src*="wrong"], img[src*="error"], [class*="incorrect"]'
                    );
                    if (hits.length) {
                        wrongMarks += hits.length;
                        wrongDetail.push({
                            card: ci,
                            n: hits.length,
                            cls: String(card.className || '').slice(0, 40),
                            sample: String(hits[0].className || hits[0].getAttribute('src') || '').slice(0, 40)
                        });
                    }
                });
            } catch (e) {}
            if (wrongMarks > 0 && !wrongNoAnswer.length) {
                log('页面存在判错标记', { wrongMarks, questions: questions.length, wrongDetail });
                const th2 = answerRevealThreshold(policy);
                if (Number.isFinite(th2)) {
                    status('页面有 ' + wrongMarks + ' 个判错的空，重做以触发答案下发');
                    if (await ensureEditableState()) {
                        const gotMark = await retryUntilAnswer(route, questions, th2, true);
                        if (gotMark) {
                            status('错题重做期间已取得标准答案并回填');
                            noProgressRounds = 0;
                            wrongRedoFails = 0;
                            return;
                        }
                        status('错题重做未取得标准答案，保持原状');
                        wrongRedoFails++;
                    } else {
                        status('无法进入作答态（重做按钮不可用），跳过');
                        wrongRedoFails++;
                    }
                    if (wrongRedoFails >= 4) {
                        wrongRedoFails = 0;
                        log('本节错题重做 4 次仍未取得答案，放弃并推进', { wrongMarks });
                    }
                } else {
                    status('课程未提供答错阈值，跳过错题重做');
                }
            }

            // 【local67】判断题专项：只有对/错两种可能，答错 → 取反提交一次即可，
            // 不必等 errorNumShow 轮试错。
            const JUDGE_TYPES = [TYPE.JUDGE, TYPE.JUDGE_HIGH];
            const judgeWrong = wrongNoAnswer.filter(q => JUDGE_TYPES.indexOf(q.type) >= 0);
            if (judgeWrong.length && judgeWrong.length === wrongNoAnswer.length) {
                status('判断题答错 ' + judgeWrong.length + ' 题，取反后提交一次');
                const items0 = getExerciseItems();
                let flipped = 0;
                for (const q of judgeWrong) {
                    const card = findCardForQuestion(items0, q, 0);
                    if (!card) continue;
                    if (await flipJudgeAnswer(card, q)) flipped++;
                }
                if (flipped) {
                    log('判断题取反完成', { flipped: flipped });
                    await sleep(rnd(400, 800));
                    await submitAnswers();
                    await verifyAfterSubmit(judgeWrong);
                    noProgressRounds = 0;
                    return;
                }
                status('判断题取反失败，回退到通用流程');
            }

            if (wrongNoAnswer.length) {
                const th = answerRevealThreshold(policy);
                log('判错但无标准答案的题', wrongNoAnswer.map(q => ({ id: q.id, type: q.type })));
                if (Number.isFinite(th)) {
                    status('本节有 ' + wrongNoAnswer.length + ' 题判错且无标准答案，重做以触发答案下发');
                    const gotWrong = await retryUntilAnswer(route, questions, th);
                    if (gotWrong) {
                        status('错题重做期间已取得标准答案并回填');
                        noProgressRounds = 0;
                        return;
                    }
                    status('错题重做未取得标准答案，保持原状');
                } else {
                    status('课程未提供答错阈值，跳过错题重做');
                }
            }

            // 【local39】服务端已经下发标准答案（含 textarea 问答题，answerStatus=-1 也算），
            // 但页面还没判对 —— 先回填并提交，不要直接宣布完成翻页。
            try {
                const fixedN = await fillFromStandardAnswers(questions);
                if (fixedN > 0) {
                    status('已按服务端标准答案回填 ' + fixedN + ' 题，提交');
                    log('按标准答案回填', { filled: fixedN });
                    await submitAnswers();
                    noProgressRounds = 0;
                    return;
                }
            } catch (e) { log('按标准答案回填异常', e); }

            // 【本地修复 local7】宣布"已作答完成"之前，先核对是不是只有本地占位。
            // 之前占位写进 currentResp 后 hasUserAnswer() 就返回 true，脚本据此
            // 直接报完成并翻页，而页面按钮还停在"提交"——服务端其实没记录。
            const localOnly = questions.filter(q => PLACEHOLDER_IDS.has(Number(q.id)));
            if (localOnly.length) {
                status('有 ' + localOnly.length + ' 题只有本地占位、服务端未记录作答，重新作答');
                log('本地占位未落地', localOnly.map(q => ({ id: q.id, type: q.type })));
                PLACEHOLDER_IDS.clear();
                noProgressRounds++;
                if (noProgressRounds >= 3) {
                    noProgressRounds = 0;
                    stopRun('提交未被服务端接受（' + localOnly.length + ' 题无记录），已停止');
                }
                return;
            }

            status('本节已作答完成（成绩记' + strat.gradeBy + '），推进下一节');
            noProgressRounds = 0;
            if (route.catalogId) await apiMarkContentDone(route.bizId, route.catalogId, route.contentId || 0);
            const movedNext = await clickPagination('next');
            if (!movedNext) {
                noProgressRounds++;
                if (noProgressRounds >= 3) { noProgressRounds = 0; stopRun('已到最后一页，全部完成'); }
                else status('未检测到下一页（' + noProgressRounds + '/3），等待后重试');
            }
            return;
        }

        // 2) 无题（阅读类内容）：标记完成 + 翻页
        if (route.catalogId) {
            await apiMarkContentDone(route.bizId, route.catalogId, route.contentId || 0);
        }
        status('翻下一页');
        const moved = await clickPagination('next');
        if (!moved) {
            noProgressRounds++;
            if (noProgressRounds >= 3) { noProgressRounds = 0; stopRun('已到最后一页，全部完成'); }
            else status('未检测到下一页（' + noProgressRounds + '/3），等待后重试');
        } else {
            noProgressRounds = 0;
        }
    }

    async function loop() {
        if (!running) return;
        try {
            await doOneRound();
        } catch (e) {
            log('轮次异常', e);
            status('轮次异常：' + (e && e.message ? e.message : e));
        }
        if (!running) return;
        // 自动连续刷课：一轮结束后推进到下一节。
        // autoAdvance 走 location.href 导航，本页随即重载 → 直接返回结束本页循环，
        // 新页面加载后由启动逻辑从持久化状态恢复继续刷。
        if ((getAutoRun() || {}).active) {
            const advanced = await autoAdvance();
            if (advanced) return;
        }
        timer = setTimeout(loop, rnd(6000, 10000));
    }

    function stopRun(msg) {
        running = false;
        if (timer) { clearTimeout(timer); timer = null; }
        setAutoRun(null);                        // 停止时一并清掉跨页状态
        const b = $1('#b6-start');
        if (b) b.textContent = '开始刷课';
        status(msg || '已停止');
    }

    function status(m) {
        if (statusEl) statusEl.textContent = m;
        try { console.log('[刷课]', m); } catch (e) {}
    }

    // ============================================================================
    // 14. GUI
    // ============================================================================

    function mkUI() {
        if ($1('#b6-root')) return;
        const root = document.createElement('div');
        root.id = 'b6-root';
        const css = document.createElement('style');
        css.textContent = [
            '#b6-root * { box-sizing: border-box; margin: 0; padding: 0; }',
            '#b6-root { font: 13px/1.7 "Microsoft YaHei", system-ui, sans-serif; }',
            '#b6-panel { position: fixed; top: 80px; right: 16px; width: 330px; background: #F4F6F8; border: 1px solid #CBD6E0; border-radius: 10px; box-shadow: 0 6px 20px rgba(43,58,73,.15); z-index: 2147483647; overflow: hidden; }',
            '#b6-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #33475C; color: #F0F4F7; cursor: move; user-select: none; }',
            '#b6-hex { width: 22px; height: 22px; flex: 0 0 22px; background: #7C93A8; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #F4F7FA; }',
            '#b6-hd-title { font-size: 13.5px; font-weight: 600; letter-spacing: 1px; }',
            '#b6-hd-sub { font-size: 9px; opacity: .72; letter-spacing: 2px; }',
            '#b6-x { cursor: pointer; padding: 0 2px; font-size: 14px; color: #9FB4C6; }',
            '#b6-x:hover { color: #fff; }',
            '#b6-set-btn { cursor: pointer; padding: 2px 6px; font-size: 11px; border: 1px solid #7C93A8; border-radius: 4px; color: #D6E3EC; }',
            '#b6-set-btn:hover { background: #46607A; color: #fff; }',
            '#b6-reopen { position: fixed; top: 80px; right: 16px; width: 28px; height: 28px; background: #33475C; color: #F0F4F7; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); display: none; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; cursor: pointer; z-index: 2147483647; }',
            '#b6-bd { padding: 12px; user-select: text; -webkit-user-select: text; }',
            '#b6-status { text-align: center; padding: 8px 10px; margin-bottom: 12px; background: #E8EDF3; border: 1px solid #D5DEE6; border-radius: 6px; font-size: 12px; font-weight: 600; color: #2B3A49; word-break: break-all; }',
            '.b6-group { margin-bottom: 13px; }',
            '.b6-glabel { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #4A6A85; margin-bottom: 7px; text-transform: uppercase; }',
            '.b6-glabel::before { content: ""; width: 6px; height: 6px; background: #7C93A8; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); }',
            '.b6-btn { display: block; width: 100%; padding: 9px; border-radius: 6px; cursor: pointer; font-size: 13px; border: 1px solid; transition: all .15s; }',
            '#b6-start { background: #3D6B99; color: #fff; border-color: #3D6B99; font-weight: 600; margin-bottom: 6px; }',
            '#b6-start:hover { background: #33587E; }',
            '#b6-one, #b6-score, #b6-farm, #b6-check { background: #fff; color: #33587E; border-color: #CBD6E0; margin-bottom: 6px; }',
            '#b6-one:hover, #b6-score:hover, #b6-farm:hover, #b6-check:hover { background: #E9EEF3; }',
            '#b6-out { margin-top: 6px; padding: 8px 9px; background: #F7F9FB; border: 1px dashed #CBD6E0; border-radius: 6px; font: 11px/1.55 Consolas,monospace; white-space: pre-wrap; word-break: break-all; color: #2B3A49; display: none; max-height: 320px; overflow: auto; }',
            '.b6-in { width: 100%; padding: 6px 8px; font-size: 12px; margin-bottom: 5px; border: 1px solid #D5DEE6; border-radius: 4px; background: #fff; color: #2B3A49; }',
            '.b6-label { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; font-size: 12px; color: #33587E; cursor: pointer; }',
            '.b6-sm-btn { padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; border: 1px solid #CBD6E0; background: #fff; color: #33587E; }',
            '.b6-sm-btn:hover { background: #E9EEF3; }',
            '.b6-row { display: flex; gap: 4px; }'
        ].join('\n');
        root.appendChild(css);

        const panel = document.createElement('div');
        panel.id = 'b6-panel';
        panel.innerHTML =
            '<div id="b6-hd">' +
            '  <div id="b6-hex">R</div>' +
            '  <div style="flex:1">' +
            '    <div id="b6-hd-title">TSH AUTO STUDY</div>' +
            '    <div id="b6-hd-sub">v' + SCRIPT_VERSION + ' · 新版</div>' +
            '  </div>' +
            '  <div id="b6-set-btn" title="设置">设置</div>' +
            '  <div id="b6-x">&times;</div>' +
            '</div>' +
            '<div id="b6-reopen" title="展开面板">R</div>' +
            '<div id="b6-bd">' +
            '  <div id="b6-status">就绪</div>' +
            '  <div class="b6-group">' +
            '    <div class="b6-glabel">Operation · 执行</div>' +
            '    <button id="b6-start" class="b6-btn">开始刷课</button>' +
            '    <button id="b6-one" class="b6-btn">做一轮</button>' +
            '  </div>' +
            '  <div class="b6-group">' +
            '    <div class="b6-glabel">Data · 数据</div>' +
            '    <button id="b6-score" class="b6-btn">查成绩</button>' +
            '    <button id="b6-farm" class="b6-btn">时长保活（防空闲熔断）</button>' +
            '    <button id="b6-check" class="b6-btn">结构自检（排错用）</button>' +
            '    <pre id="b6-out"></pre>' +
            '  </div>' +
            '</div>';
        root.appendChild(panel);

        const sp = document.createElement('div');
        sp.id = 'b6-settings';
        sp.style.cssText = 'position:fixed;top:80px;right:360px;width:330px;background:#F4F6F8;border:1px solid #CBD6E0;border-radius:10px;box-shadow:0 6px 20px rgba(43,58,73,.15);z-index:2147483647;overflow:hidden;display:none';
        sp.innerHTML =
            '<div id="b6-s-hd" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#33475C;color:#F0F4F7;cursor:move">' +
            '  <div style="flex:1;font-size:13.5px;font-weight:600;letter-spacing:1px">CONFIG · 设置</div>' +
            '  <div id="b6-s-x" style="cursor:pointer;padding:0 2px;font-size:14px;color:#9FB4C6">&times;</div>' +
            '</div>' +
            '<div style="padding:12px">' +
            '  <div class="b6-glabel">Course · 课程</div>' +
            '  <select id="b6-course" class="b6-in" style="display:none"></select>' +
            '  <p style="font-size:11px;color:#7A8EA0;margin-bottom:6px">留空「自动」即识别当前页面；在课程列表页需在此选定。</p>' +
            '  <div class="b6-glabel">AI · 答题兜底</div>' +
            '  <p style="font-size:11px;color:#7A8EA0;margin-bottom:6px">仅用于主观题（服务端不下发答案的题）。客观题走轮询取权威答案，不调用 AI。</p>' +
            '  <label class="b6-label"><input type="checkbox" id="b6-ai-en"> 启用 AI 补答</label>' +
            '  <input id="b6-ai-url" class="b6-in" placeholder="API Base URL（OpenAI 兼容）">' +
            '  <input id="b6-ai-key" class="b6-in" type="password" placeholder="API Key">' +
            '  <input id="b6-ai-model" class="b6-in" placeholder="模型名">' +
            '  <button id="b6-ai-save" class="b6-sm-btn" style="width:100%">保存 AI 设置</button>' +
            '  <div class="b6-glabel" style="margin-top:12px">Report · 失效上报</div>' +
            '  <div id="b6-rp-auth" style="display:none">' +
            '    <p style="font-size:12px;color:#7A8EA0;margin-bottom:6px">失效自动上报未授权（默认关闭）。</p>' +
            '    <button id="b6-rp-consent" class="b6-sm-btn" style="width:100%">查看知情同意书并授权</button>' +
            '  </div>' +
            '  <div id="b6-rp-form" style="display:none">' +
            '    <label class="b6-label"><input type="checkbox" id="b6-rp-en"> 失效自动上报 issue</label>' +
            '    <input id="b6-rp-owner" class="b6-in" placeholder="GitHub 用户名">' +
            '    <input id="b6-rp-repo" class="b6-in" placeholder="仓库名">' +
            '    <input id="b6-rp-token" class="b6-in" type="password" placeholder="GitHub Token（Issues: write）">' +
            '    <div class="b6-row">' +
            '      <button id="b6-rp-save" class="b6-sm-btn" style="flex:1">保存设置</button>' +
            '      <button id="b6-rp-test" class="b6-sm-btn" style="flex:1;color:#B3544B">发测试 issue</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        root.appendChild(sp);
        document.body.appendChild(root);

        statusEl = $1('#b6-status');
        const out = $1('#b6-out');
        const show = t => { out.textContent = t; out.style.display = 'block'; };

        // 拖动
        const mkDrag = (handle, target) => {
            let dragging = false, dx = 0, dy = 0, px = 0, py = 0;
            handle.addEventListener('pointerdown', e => {
                dragging = true; dx = e.clientX; dy = e.clientY;
                px = target.offsetLeft; py = target.offsetTop; e.preventDefault();
            });
            document.addEventListener('pointermove', e => {
                if (!dragging) return;
                target.style.left = (px + e.clientX - dx) + 'px';
                target.style.top = (py + e.clientY - dy) + 'px';
                target.style.right = 'auto';
            });
            document.addEventListener('pointerup', () => { dragging = false; });
        };
        mkDrag($1('#b6-hd'), panel);
        mkDrag($1('#b6-s-hd'), sp);

        $1('#b6-start').addEventListener('click', async () => {
            const b = $1('#b6-start');
            if (running || (getAutoRun() || {}).active) { stopRun('已停止'); return; }
            running = true; roundCount = 0; noProgressRounds = 0; invalidRounds = 0;
            b.textContent = '停止';
            // 在课程页/目录页点击 → 自动定位到进度不足的内容并跳转；
            // 在阅读器页点击 → 启动跨节连续刷（本页先处理，尾部自动推进）。
            const ok = await startAutoRun();
            if (!ok) { running = false; b.textContent = '开始刷课'; return; }
            status('运行中（自动连续刷课）');
            loop();
        });
        $1('#b6-one').addEventListener('click', async () => {
            status('执行一轮...');
            await doOneRound();
            status('本轮完成');
        });
        $1('#b6-x').addEventListener('click', () => {
            if (studyTimer) stopStudyFarm();
            panel.style.display = 'none';
            $1('#b6-reopen').style.display = 'flex';
        });
        $1('#b6-reopen').addEventListener('click', () => {
            $1('#b6-reopen').style.display = 'none';
            panel.style.display = 'block';
        });
        $1('#b6-set-btn').addEventListener('click', async () => {
            sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
            // 打开设置时刷新课程下拉（课程列表页拿不到 id，只能从这里选）
            if (sp.style.display === 'block') {
                try {
                    const list = await fetchMyCourses();
                    if (list.length) {
                        fillCourseSelect(list);
                        const sel = $1('#b6-course');
                        if (sel && !sel.value) {
                            const ctx = currentCourseId();
                            if (ctx) sel.value = ctx;
                        }
                    }
                } catch (e) {}
            }
        });
        $1('#b6-s-x').addEventListener('click', () => { sp.style.display = 'none'; });

        // 结构自检
        $1('#b6-check').addEventListener('click', async () => {
            status('自检中...');
            show('自检中，请稍候...');
            try { show(await selfCheck()); status('自检完成，可复制结果反馈'); }
            catch (e) { show('自检异常：' + e.message); status('自检异常'); }
        });

        // 查成绩
        let scoreCooldown = false;
        $1('#b6-score').addEventListener('click', async () => {
            if (scoreCooldown) { status('查询冷却中...'); return; }
            scoreCooldown = true;
            status('查询中...');
            const d = await fetchScore();
            show(formatScore(d));
            status('成绩查询完成');
            setTimeout(() => { scoreCooldown = false; }, 3000);
        });

        // 时长保活（站点自身每 10s 上报，本功能仅防 10 分钟空闲熔断）
        $1('#b6-farm').addEventListener('click', () => {
            const b = $1('#b6-farm');
            if (studyTimer) { stopStudyFarm(); b.textContent = '时长保活（防空闲熔断）'; }
            else { startStudyFarm(); b.textContent = studyTimer ? '停止保活' : '时长保活（防空闲熔断）'; }
        });

        // AI 设置
        loadAiConfig();
        $1('#b6-ai-en').checked = aiConfig.enabled;
        $1('#b6-ai-url').value = aiConfig.baseUrl;
        $1('#b6-ai-key').value = aiConfig.apiKey;
        $1('#b6-ai-model').value = aiConfig.model;
        $1('#b6-ai-save').addEventListener('click', () => {
            aiConfig.enabled = $1('#b6-ai-en').checked;
            aiConfig.baseUrl = $1('#b6-ai-url').value.trim();
            aiConfig.apiKey = $1('#b6-ai-key').value.trim();
            aiConfig.model = $1('#b6-ai-model').value.trim();
            saveAiConfig();
            status('AI 设置已保存' + (aiConfig.enabled ? '（已启用）' : '（未启用）'));
        });

        // 上报设置
        loadReportConfig();
        const syncRp = () => {
            const granted = reportConfig.consent === true && reportConfig.consentVersion === '1.0';
            $1('#b6-rp-auth').style.display = granted ? 'none' : 'block';
            $1('#b6-rp-form').style.display = granted ? 'block' : 'none';
        };
        syncRp();
        $1('#b6-rp-en').checked = reportConfig.enabled;
        $1('#b6-rp-owner').value = reportConfig.owner;
        $1('#b6-rp-repo').value = reportConfig.repo;
        $1('#b6-rp-token').value = reportConfig.token;
        $1('#b6-rp-consent').addEventListener('click', () => {
            reportConfig.consent = true;
            reportConfig.consentVersion = '1.0';
            saveReportConfig(); syncRp();
            status('已授权失效上报（仍默认关闭）');
        });
        $1('#b6-rp-save').addEventListener('click', () => {
            reportConfig.enabled = $1('#b6-rp-en').checked;
            reportConfig.owner = $1('#b6-rp-owner').value.trim();
            reportConfig.repo = $1('#b6-rp-repo').value.trim();
            reportConfig.token = $1('#b6-rp-token').value.trim();
            saveReportConfig();
            status('上报设置已保存' + (reportConfig.enabled ? '（已启用）' : '（未启用）'));
        });
        $1('#b6-rp-test').addEventListener('click', async () => {
            reportConfig.enabled = $1('#b6-rp-en').checked;
            reportConfig.owner = $1('#b6-rp-owner').value.trim();
            reportConfig.repo = $1('#b6-rp-repo').value.trim();
            reportConfig.token = $1('#b6-rp-token').value.trim();
            saveReportConfig();
            status('发送测试 issue...');
            const ok = await reportIssue('手动测试上报');
            status(ok ? '测试 issue 已发送' : '测试失败（检查 owner/repo/token）');
        });

        log('v' + SCRIPT_VERSION + ' 已加载');

        // 环境提示：装错版本（落在旧站）时直接说明，避免用户以为脚本坏了
        const env = detectEnvironment();
        log('运行环境:', env.kind, '|', env.msg);
        if (env.kind === 'legacy') {
            status('⚠ ' + env.msg);
            const b = $1('#b6-start');
            if (b) { b.disabled = true; b.style.opacity = '0.5'; b.textContent = '本版不支持旧站'; }
            const one = $1('#b6-one');
            if (one) { one.disabled = true; one.style.opacity = '0.5'; }
            const farm = $1('#b6-farm');
            if (farm) { farm.disabled = true; farm.style.opacity = '0.5'; }
        } else {
            status(env.msg);
        }
    }

    // SPA 路由变化时不重建 UI（面板是 fixed 常驻）
    setTimeout(mkUI, 1500);

    // 跨节导航后自动恢复。
    // 自动刷课靠 location.href 整页跳转推进，页面重载后脚本重新注入 ——
    // 必须从持久化状态恢复「正在自动刷」，否则每跳一次就停住。
    (function resumeAutoRun() {
        const st = getAutoRun();
        if (!st || !st.active) return;
        setTimeout(() => {
            const b = $1('#b6-start');
            if (b) b.textContent = '停止';
            running = true; roundCount = 0; noProgressRounds = 0; invalidRounds = 0;
            status('自动刷课：已恢复运行（已处理 ' + ((st.done || []).length) + ' 项，第 '
                + ((st.jumps || 0) + 1) + ' 次跳转；点「停止」可中断，页面自动刷新即由此产生）');
            loop();
        }, 2200);
    })();

}

// ============================================================================
// 引擎 B · 旧站站点（/legacy/）—— 包裹在独立作用域内
// ============================================================================
function __TSH_OLD_ENGINE__() {

    'use strict';

    // ================= 工具函数 =================
    const $ = (s, p) => Array.from((p || document).querySelectorAll(s));
    const $1 = (s, p) => (p || document).querySelector(s);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));

    const WORDS = ['good', 'well', 'nice', 'great', 'fine', 'best', 'better', 'happy', 'easy', 'hard', 'true', 'right', 'morning', 'evening', 'work', 'study', 'play', 'talk', 'listen', 'speak', 'English'];
    const rw = () => WORDS[rnd(0, WORDS.length)];

    // 派发 click（实测对 Angular (click) 绑定有效）
    function click(el) {
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        return true;
    }
    // 完整鼠标序列（部分组件监听 pointer/mouse 组合，顺序须与真实浏览器一致）
    function clickSeq(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        try {
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1, isPrimary: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y, button: 0 }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        } catch (e) { click(el); }
        return true;
    }

    // 填写 input / contenteditable span（实测填空是 span[contenteditable]，必须设 textContent 并派发 input）
    function fill(el, val) {
        if (!el) return;
        try {
            if (el.tagName === 'SPAN' || el.isContentEditable || el.hasAttribute('contenteditable')) {
                el.textContent = val;
            } else {
                const proto = Object.getPrototypeOf(el);
                const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, val); else el.value = val;
            }
        } catch (e) {
            try { el.value = val; } catch (e2) {}
        }
        ['input', 'change', 'blur', 'keyup'].forEach(et => {
            el.dispatchEvent(new Event(et, { bubbles: true, cancelable: true }));
        });
    }

    // ================= 脚本有效性检测 + GitHub Issue 上报 =================
    // 用途：开源托管时，若网站改版导致脚本失效，自动向 GitHub 发 issue（需用户同意；24h 去重防刷）
    const SCRIPT_VERSION = '2.3.1-local78'; // 与 @version 保持一致
    const REPORT_KEY = 'tsh_auto_brush_report';
    let reportConfig = { consent: null, consentVersion: '', enabled: false, owner: '', repo: '', token: '', lastReport: 0 };
    function loadReportConfig() {
        try {
            const s = localStorage.getItem(REPORT_KEY);
            if (s) reportConfig = Object.assign(reportConfig, JSON.parse(s));
        } catch (e) {}
    }
    function saveReportConfig() {
        try { localStorage.setItem(REPORT_KEY, JSON.stringify(reportConfig)); } catch (e) {}
    }
    // 知情同意书：首次启用弹出（默认不授权上报；同意后才显示并可用上报设置，仍默认关闭）
    function showConsentModal(force) {
        const granted = reportConfig.consent === true && reportConfig.consentVersion === '1.0';
        if (!force && granted) return; // 已按当前版本同意书授权（force=重新授权）
        if ($1('#b6-consent')) return;
        const m = document.createElement('div');
        m.id = 'b6-consent';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(30,40,50,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font:13px/1.7 "Microsoft YaHei",sans-serif';
        m.innerHTML =
            '<div style="width:420px;max-width:92vw;background:#F7F9FB;border:1px solid #CBD6E0;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden">' +
            '<div style="background:#33475C;color:#F0F4F7;padding:12px 16px;font-weight:600;font-size:14px;letter-spacing:1px">知情同意书</div>' +
            '<div style="padding:14px 16px;color:#2B3A49;max-height:55vh;overflow:auto">' +
            '<p style="margin:0 0 8px">本脚本在以下情况下可能向第三方发送数据，请阅读后授权：</p>' +
            '<ol style="padding-left:18px;margin:0 0 8px">' +
            '<li>失效自动上报：网站改版导致脚本失效时，可自动向 GitHub 提交 issue。内容仅含脚本版本、打码页面路径、检测结果、时间，24 小时内同版本仅上报一次。</li>' +
            '<li>AI 答题（可选）：启用后，题目文本发送至您自行配置的 AI 服务商。</li>' +
            '<li>凭据存储：AI Key 与 GitHub Token 明文保存在本地浏览器 localStorage，建议使用最小权限令牌。</li>' +
            '</ol>' +
            '<p style="margin:0">默认<strong>不启用</strong>失效自动上报；授权后仍可在设置面板随时开关或撤销。</p>' +
            '</div>' +
            '<div style="padding:12px 16px;border-top:1px solid #E3E8EE;display:flex;gap:8px;justify-content:flex-end">' +
            '<button id="b6-consent-no" style="padding:7px 14px;background:#fff;color:#5A6B7A;border:1px solid #CBD6E0;border-radius:5px;cursor:pointer">拒绝</button>' +
            '<button id="b6-consent-yes" style="padding:7px 14px;background:#3D6B99;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600">同意并继续</button>' +
            '</div></div>';
        document.body.appendChild(m);
        $1('#b6-consent-yes').addEventListener('click', () => {
            reportConfig.consent = true;
            reportConfig.consentVersion = '1.0';
            saveReportConfig();
            m.remove();
            syncReportArea();
            maybeShowGuide();
        });
        $1('#b6-consent-no').addEventListener('click', () => {
            reportConfig.consent = false;
            reportConfig.consentVersion = '';
            saveReportConfig();
            m.remove();
            syncReportArea();
            maybeShowGuide();
        });
    }

    // 上报区显隐：仅在知情同意书授权（consent=true）后显示表单；未授权显示授权入口（默认不允许）
    function syncReportArea() {
        const form = $1('#b6-rp-form'), auth = $1('#b6-rp-auth');
        if (!form || !auth) return;
        const granted = reportConfig.consent === true && reportConfig.consentVersion === '1.0';
        form.style.display = granted ? 'block' : 'none';
        auth.style.display = granted ? 'none' : 'block';
    }

    // 首次使用引导（知情同意书之后弹出；可随时经主面板"?"重新查看）
    const GUIDE_KEY = 'tsh_auto_brush_guide';
    function maybeShowGuide() {
        try { if (localStorage.getItem(GUIDE_KEY) === '1') return; } catch (e) {}
        showGuide();
    }
    function showGuide() {
        if ($1('#b6-guide')) return;
        const m = document.createElement('div');
        m.id = 'b6-guide';
        m.style.cssText = 'position:fixed;inset:0;background:rgba(30,40,50,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font:13px/1.7 "Microsoft YaHei",sans-serif';
        m.innerHTML =
            '<div style="width:440px;max-width:92vw;background:#F7F9FB;border:1px solid #CBD6E0;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.25);overflow:hidden">' +
            '<div style="display:flex;align-items:center;gap:8px;padding:12px 16px;background:#33475C;color:#F0F4F7;font-weight:600;font-size:14px;letter-spacing:1px">' +
            '<span style="width:20px;height:20px;background:#7C93A8;clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%);display:inline-flex;align-items:center;justify-content:center;font-size:9px;color:#F4F7FA">R</span>' +
            '使用引导</div>' +
            '<div style="padding:14px 16px;color:#2B3A49;max-height:58vh;overflow:auto">' +
            '<ol style="padding-left:18px;margin:0">' +
            '<li style="margin-bottom:8px"><strong>登录</strong>：打开 www.tsinghuaelt.com 并登录。</li>' +
            '<li style="margin-bottom:8px"><strong>开始刷课</strong>：进入任意练习页，点面板"开始刷课"挂机即可。脚本自动答题、翻页、跨任务/跨单元推进，刷完整门课自动停止。</li>' +
            '<li style="margin-bottom:8px"><strong>AI 答题（可选）</strong>：点主面板"设置"打开设置面板，启用并填入 API 配置；AI 出答案，失败自动回退试错法，答题不中断。</li>' +
            '<li style="margin-bottom:8px"><strong>查成绩 / 刷时长</strong>：随时点主面板对应按钮查看进度；刷学习时长需在练习页挂机。</li>' +
            '<li style="margin-bottom:8px"><strong>失效上报</strong>：需先在知情同意书授权（默认关闭），再在设置面板填写 GitHub 信息并启用。</li>' +
            '<li><strong>限流自动恢复</strong>：偶发"系统繁忙"会冷却约 90 秒自动继续，无需操作。</li>' +
            '</ol>' +
            '</div>' +
            '<div style="padding:12px 16px;border-top:1px solid #E3E8EE;display:flex;gap:8px;justify-content:flex-end">' +
            '<button id="b6-guide-ok" style="padding:7px 16px;background:#3D6B99;color:#fff;border:none;border-radius:5px;cursor:pointer;font-weight:600">开始使用</button>' +
            '</div></div>';
        document.body.appendChild(m);
        $1('#b6-guide-ok').addEventListener('click', () => {
            try { localStorage.setItem(GUIDE_KEY, '1'); } catch (e) {}
            m.remove();
        });
    }
    // 核心 DOM 探针：在课程/练习页上，关键选择器应至少命中 1 个；全缺 → 站点改版
    function checkScriptValidity() {
        if (!/tsinghuaelt\.com/.test(location.hostname)) return true; // 非本站不判
        if (document.readyState !== 'complete') return true; // 页面加载中不判定（避免误报失效）
        const probes = ['button.wy-btn', '.lib-single-item', '.page-next', 'app-course-task-stu', '.courseList', '.uniteTitle'];
        return probes.some(s => $1(s)) === true;
    }
    // 上报 GitHub issue（24h 去重）
    async function reportIssue(reason) {
        if (!reportConfig.enabled || !reportConfig.owner || !reportConfig.repo || !reportConfig.token || reportConfig.consent !== true || reportConfig.consentVersion !== '1.0') return false;
        const now = Date.now();
        if (now - reportConfig.lastReport < 86400000) return false; // 24h 去重
        const title = '[自动报告] 清华社刷课脚本可能失效 v' + SCRIPT_VERSION;
        // 打码页面：剥离 query/hash，数字型课程/用户 ID 替换为占位符（公开 issue 可见，防泄漏）
        const pathMasked = location.pathname
            .replace(/course-study-student\/\d+\/(\d+)/, 'course-study-student/{bookId}/{courseId}')
            .replace(/course-student\/(\d+)\/study/, 'course-student/{courseId}/study');
        const safePage = location.origin + pathMasked;
        const body = [
            '**脚本版本**：v' + SCRIPT_VERSION,
            '**站点**：https://www.tsinghuaelt.com',
            '**页面**：' + safePage.slice(0, 120),
            '**时间**：' + new Date().toLocaleString('zh-CN'),
            '**检测**：核心 DOM 探针全未命中（站点可能改版）',
            '**原因**：' + (reason || '脚本失效检测触发')
        ].join('\n');
        try {
            const resp = await fetch('https://api.github.com/repos/' + reportConfig.owner + '/' + reportConfig.repo + '/issues', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + reportConfig.token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({ title: title, body: body })
            });
            if (resp.ok) {
                reportConfig.lastReport = now;
                saveReportConfig();
                status('已自动上报 issue（24h 内不再重复）');
                return true;
            }
            status('上报失败（HTTP ' + resp.status + '，检查 token 权限）');
        } catch (e) {
            status('上报失败（网络）');
        }
        return false;
    }

    // ================= AI 配置与调用（OpenAI 兼容） =================
    const AI_STORAGE_KEY = 'tsh_auto_brush_ai';
    const AMAP = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9 };
    let aiConfig = { enabled: false, baseUrl: '', apiKey: '', model: '' };
    function loadAiConfig() {
        try {
            const s = localStorage.getItem(AI_STORAGE_KEY);
            if (s) aiConfig = Object.assign(aiConfig, JSON.parse(s));
        } catch (e) {}
    }
    function saveAiConfig() {
        try { localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(aiConfig)); } catch (e) {}
    }
    function aiEnabled() {
        return !!(aiConfig.enabled && aiConfig.baseUrl && aiConfig.apiKey && aiConfig.model);
    }
    // OpenAI 兼容 chat/completions 调用，返回文本内容；失败/超时返回 null
    async function aiAsk(prompt) {
        if (!aiEnabled()) return null;
        const url = aiConfig.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + aiConfig.apiKey },
                body: JSON.stringify({
                    model: aiConfig.model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.1,
                    max_tokens: 1024
                }),
                signal: ctrl.signal
            });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            const data = await resp.json();
            const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            return typeof content === 'string' ? content.trim() : null;
        } catch (e) {
            // 网络超时 / 连接失败 / 限流等：提示并回退试错法（不中断答题）
            status('AI 请求失败（' + (e.name === 'AbortError' ? '超时' : '网络/连接') + '），已回退试错法');
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    // ================= 成绩查询与学习时长（综合成绩） =================
    // 请求签名（与站点拦截器同算法；依赖页面暴露的 window.CryptoJS）
    function makeSigned(url) {
        try {
            const cu = JSON.parse(localStorage.getItem('tsinghuayingyu-front.currUser') || '{}');
            if (!cu.id || typeof window.CryptoJS === 'undefined') return null;
            const f = (crypto.randomUUID ? crypto.randomUUID() : 'x'.repeat(36));
            const rid = Math.floor(100000 + Math.random() * 900000) + '';
            const m = url + (url.indexOf('?') > -1 ? '&' : '?')
                + 'clientTime=' + f + '&diResU=' + cu.id + '&diLoohcs=' + cu.schoolId
                + '&version=3.0.149&request_id=' + rid;
            const x = m.split('?')[1].split('&').map(k => k.split('=')[0]).sort().join('');
            return { url: m, sign: CryptoJS.MD5((cu.serverTime || '') + f + x + cu.id).toString() };
        } catch (e) { return null; }
    }
    function getCourseId() {
        // 练习页 /course-study-student/{bookId}/{courseId}/... 与 主页 /course-student/{courseId}/study
        let m = location.pathname.match(/course-study-student\/\d+\/(\d+)/);
        if (m) return m[1];
        m = location.pathname.match(/course-student\/(\d+)\/study/);
        return m ? m[1] : null;
    }
    // 查综合成绩（POST /tsenglish/course/stuGeneralScore；注意 POST 有约 1 次/秒频率限制）
    async function fetchScore() {
        const courseId = getCourseId();
        const cu = JSON.parse(localStorage.getItem('tsinghuayingyu-front.currUser') || '{}');
        if (!courseId || !cu.id) return null;
        const s = makeSigned('/tsenglish/course/stuGeneralScore?id=' + courseId + '&userId=' + cu.id);
        if (!s) return null;
        const res = await fetch(s.url, { method: 'POST', headers: { 'sign': s.sign, 'Content-Type': 'application/json' }, body: '{}' });
        const body = await res.text();
        // 频率限制（HTTP 530）或业务拦截提示
        if (res.status === 530 || body.indexOf('系统繁忙') > -1 || body.indexOf('频繁') > -1) {
            return { blocked: true };
        }
        if (res.status !== 200) return null;
        try { return JSON.parse(body); } catch (e) { return null; }
    }
    function formatScore(data) {
        if (data && data.blocked) return '⚠ 触发频率限制（HTTP 530），请等待 30 秒后再试，勿连续点击';
        if (!data || !data.object) return '查询失败（需在课程页且已登录）';
        const cv = data.object.courseScoreVo, ev = data.object.examSetVo, sv = data.object.stuScoreVo;
        if (!cv || !ev || !sv) return '返回数据异常';
        const lines = [];
        lines.push('综合成绩: ' + cv.score + ' 分 | 排名 ' + cv.rank);
        lines.push('最高 ' + cv.maxScore + ' / 最低 ' + cv.minScore + ' / 平均 ' + cv.avgScore);
        const dims = [
            ['学习时长', sv.studyTimeScore, ev.studyTimeRate, sv.studyTime],
            ['完成率', sv.completeScore, ev.completeRate, sv.complete + '%'],
            ['学习得分', sv.studyScore, ev.studyScoreRate, ''],
            ['作业', sv.homeworkScore, ev.homeworkScoreRate, ''],
            ['测试', sv.testScore, ev.testRate, ''],
            ['期末', sv.endScore, ev.endRate, '']
        ];
        for (const [name, score, rate, extra] of dims) {
            if (rate > 0) lines.push(name + ': ' + score + '/' + rate + (extra ? '（' + extra + '）' : ''));
        }
        return lines.join('\n');
    }

    // ---- 学习时长刷取 ----
    // 机制：页面 setInterval 每 10 秒自动上报 course/studyTimeCountNew（挂机即涨）；
    // 后端对高频重放去重（实测 30 次 300ms 间隔不累计），只能按真实时间节奏累计。
    // 本模块：hook 捕获页面真实上报地址（含 stuKey），并兜底定时重放（页面切走也尽量续报）。
    let studyReport = null;   // 捕获的 {method, url, sign}（每次页面上报自动刷新）
    let studyTimer = null;
    let studyCount = 0;
    function hookStudyReport() {
        try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSet = XMLHttpRequest.prototype.setRequestHeader;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; this.__h = {}; return origOpen.apply(this, arguments); };
            XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
                if (!this.__h) this.__h = {};
                if (k.toLowerCase() === 'sign') this.__h.sign = v;
                return origSet.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function (b) {
                // 每次捕获刷新（不一次性锁死），确保拿到最新 URL+sign，且校验 sign 存在
                if (this.__u && this.__u.indexOf('studyTimeCountNew') > -1 && this.__h.sign) {
                    studyReport = { method: this.__m || 'GET', url: this.__u, sign: this.__h.sign };
                }
                return origSend.apply(this, arguments);
            };
        } catch (e) {}
    }
    function startStudyFarm() {
        if (studyTimer) return;
        hookStudyReport();
        studyCount = 0;
        studyTimer = setInterval(async () => {
            // 离开练习页则自动停止（防 SPA 路由后上报旧地址）
            if (!isExercisePage()) { stopStudyFarm(); return; }
            if (studyReport) {
                try {
                    await fetch(studyReport.url, {
                        method: studyReport.method,
                        headers: studyReport.sign ? { 'sign': studyReport.sign } : {}
                    });
                    studyCount++;
                    status('刷时长中 第' + studyCount + ' 次（挂机累计）');
                } catch (e) { status('刷时长上报失败: ' + e.message); }
            } else {
                status('等待捕获学习时长上报地址...');
            }
        }, 10000);
        status('刷时长开始（每10秒上报，挂机累计）');
    }
    function stopStudyFarm() {
        if (studyTimer) { clearInterval(studyTimer); studyTimer = null; }
        const b = $1('#b6-farm');
        if (b) { b.textContent = '刷学习时长'; b.style.background = '#fff'; }
        status('刷时长已停止');
    }

    // ================= 页面识别 =================
    function isCourseHome() {
        return /\/course-student\/\d+\/study/.test(location.pathname)
            || /\/studentcourse/.test(location.pathname)
            || !!$1('.courseList') || !!$1('.uniteTitle');
    }
    function isExercisePage() {
        return location.pathname.indexOf('/course-study-student/') !== -1 || !!$1('app-course-task-stu');
    }

    // ================= 题型检测 =================
    function detectType() {
        if ($1('lib-video-exercise-cs-study') || $1('#J_prismPlayer') || $1('.prism-player')) return 'video';
        if ($1('lib-listen-and-repeat-exercise-cs-study') || $('.lib-listen-container').length) return 'listen_repeat';
        if ($1('lib-oral-brief-exercise-cs-study') || $1('lib-free-assess-exercise-cs-study') || $1('lib-paragraph-assess-exercise-cs-study')) return 'oral';
        if ($1('lib-role-play-exercise-cs-study') || $('.lib-role-select-item').length) return 'roleplay';
        if ($1('lib-judge-exercise-cs-study') || $('.lib-judge-radio').length) return 'judge';
        if ($1('lib-drop-down-exercise-cs-study') || $('.lib-drop-down-container').length || $('.lib-drop-down-item-select').length) return 'dropdown';
        if ($1('lib-fill-blank-exercise-cs-study') || $('.lib-fill-blank-do-input-left').length) return 'fill';
        if ($1('lib-drag-drop-one-exercise-cs-study') || $1('lib-drag-drop-many-exercise-cs-study') || $1('lib-paragraph-drop-exercise-cs-study') || $('.lib-drag-box').length || $('.lib-drag-item').length) return 'drag';
        if ($1('lib-multiple-choice-exercise-cs-study') || $1('lib-single-choice-exercise-cs-study')) {
            // 多选组件名或 no-choices 图标
            if ($1('lib-multiple-choice-exercise-cs-study') || $('.lib-single-item-img img[src*="no-choices"]').length) return 'multiple';
            return 'single';
        }
        if ($('.lib-single-box').length) {
            return $('.lib-single-item-img img[src*="no-choices"]').length ? 'multiple' : 'single';
        }
        if ($('.lib-textarea-container').length || $('.img-blank-answer').length) return 'listen_fill';
        return 'unknown';
    }

    // 页面是否处于"已作答完成"状态（按钮只剩 Retry，且无 Submit）
    function isAnsweredState() {
        const btns = $('button.wy-btn').map(b => (b.textContent || '').trim());
        return btns.includes('Retry') && !btns.includes('Submit');
    }
    // 是否处于可作答状态（有 Submit 按钮）
    function isAnsweringState() {
        return $('button.wy-btn').some(b => (b.textContent || '').trim() === 'Submit');
    }

    // ================= 按钮 =================
    function findBtn(texts) {
        const all = $('button.wy-btn, button.ant-btn, .wy-course-btn-right button, button[class*="btn"]');
        for (const b of all) {
            if (!b.isConnected) continue;
            const st = getComputedStyle(b);
            if (st.display === 'none' || st.visibility === 'hidden') continue;
            const t = (b.textContent || '').replace(/\s+/g, '').toLowerCase();
            for (const tx of texts) {
                if (t.indexOf(tx.toLowerCase()) >= 0) return b;
            }
        }
        return null;
    }
    async function clickSubmit() {
        await sleep(rnd(800, 2000));
        const b = findBtn(['Submit', '提交']);
        if (b) { click(b); await sleep(rnd(1500, 3500)); return true; }
        return false;
    }

    // 智能提交：先播放页面音频（听力题需播完才能提交），点击 Submit，并确认提交成功（按钮变 Retry）
    async function submitSmart() {
        await sleep(rnd(600, 1500));
        const audio = $1('lib-audio-player audio, .show-audio audio, audio');
        if (audio) {
            try {
                audio.muted = true; // 静音播放，绕过浏览器自动播放策略
                const p = audio.play();
                if (p && p.catch) p.catch(() => {});
                audio.playbackRate = 4;
            } catch (e) {}
            await sleep(rnd(2000, 3500));
            // 播放被拦截（仍处于暂停）→ 直接快进到结尾
            if (audio.paused) {
                try { audio.currentTime = (audio.duration || 60) - 1; } catch (e) {}
            }
        }
        let b = findBtn(['Submit', '提交']);
        if (b) { click(b); }
        await sleep(rnd(2500, 4000));
        if (isAnsweredState()) return true;
        // 首次提交未生效：尝试快进音频后，等待 3 秒（频率限制窗口）再重试一次
        if (audio) {
            try { audio.currentTime = (audio.duration || 60) - 1; } catch (e) {}
        }
        await sleep(3000);
        b = findBtn(['Submit', '提交']);
        if (b) { click(b); await sleep(rnd(3000, 4000)); }
        if (isAnsweredState()) return true;
        // 二次提交仍失败 → 疑似触发频率限制（HTTP 530 / 系统繁忙），标记停止
        rateLimited = true;
        return false;
    }
    async function clickRetry() {
        await sleep(rnd(800, 1500));
        const b = findBtn(['Retry', '重试', '重做']);
        if (b) { click(b); await sleep(rnd(1500, 3000)); return true; }
        return false;
    }

    // ================= AI 猜测（按题型构造 prompt） =================
    // 单选/多选：返回每题字母答案数组（如 ['A','BC']）；失败返回 null
    async function aiGuessChoice(groups, isMultiple) {
        if (!aiEnabled()) return null;
        const lines = [];
        groups.forEach((g, i) => {
            const stem = $1('.exercise-content, .default-stem-content, [class*="stem"]', g);
            const items = $('.lib-single-item', g);
            const opts = items.map((it, j) => {
                const label = $1('.lib-single-item-order', it);
                return (label ? (label.textContent || '').trim() : String.fromCharCode(65 + j)) + '. ' + (it.textContent || '').trim().replace(/\s+/g, ' ');
            });
            lines.push('题目' + (i + 1) + '：' + (stem ? (stem.textContent || '').trim().replace(/\s+/g, ' ') : '(无文字题目，可能是听力题，请根据选项语义推断)'));
            lines.push('选项：' + opts.join('  '));
        });
        const prompt = '你是英语在线学习平台的答题助手。根据题目和选项，给出正确答案的字母。'
            + (isMultiple ? '多选题：每行输出该题所有正确字母，用逗号分隔（如 A,C,D）。' : '单选题：每行只输出一个字母（如 A）。')
            + '严格按题目顺序输出，每题一行，不要输出任何解释或其他文字。\n\n' + lines.join('\n');
        const out = await aiAsk(prompt);
        if (!out) return null;
        const answers = out.split(/\n+/).map(l => (l.match(/[A-Ja-j]/g) || []).map(x => x.toUpperCase()).join('')).filter(Boolean);
        return answers.length ? answers : null;
    }

    // 判断：返回每行 T/F
    async function aiGuessJudge(rows) {
        if (!aiEnabled()) return null;
        const lines = rows.map((r, i) => (i + 1) + '. ' + (r.textContent || '').trim().replace(/\s+/g, ' '));
        const prompt = '判断以下英语句子描述的正误（True/False）。严格按题目顺序，每行只输出 T 或 F，不要输出任何解释或其他文字。\n\n' + lines.join('\n');
        const out = await aiAsk(prompt);
        if (!out) return null;
        const answers = out.split(/\n+/).map(l => { const m = l.match(/[TFtf]/); return m ? m[0].toUpperCase() : ''; }).filter(Boolean);
        return answers.length ? answers : null;
    }

    // 下拉：返回每空答案文本
    async function aiGuessDropdown(sels) {
        if (!aiEnabled()) return null;
        const words = $('.lib-select-word-list-content-item-main').map(w => (w.textContent || '').trim()).filter(Boolean);
        const dir = $1('.exercise-directiveContent');
        const lines = sels.map((sel, i) => {
            const item = sel.closest('.lib-drop-down-item');
            const numEl = item ? $1('.lib-drop-down-item-content', item) : null;
            return '空' + (i + 1) + '：' + (numEl ? (numEl.textContent || '').trim() : '');
        });
        const prompt = '你是英语在线学习平台的答题助手。根据题干和候选词，为每个空选择正确的单词。'
            + '候选词：' + (words.join(', ') || '(无)')
            + '\n严格按空的顺序，每行输出一个空对应的词，不要输出任何解释或其他文字。\n\n'
            + '题干：' + (dir ? (dir.textContent || '').trim().replace(/\s+/g, ' ') : '(无文字题干)') + '\n'
            + lines.join('\n');
        const out = await aiAsk(prompt);
        if (!out) return null;
        const answers = out.split(/\n+/).map(l => l.replace(/^\d+[.、)\s]+/, '').trim()).filter(Boolean);
        return answers.length ? answers : null;
    }

    // 填空：返回每空答案文本
    async function aiGuessFill(inputs) {
        if (!aiEnabled()) return null;
        const dir = $1('.exercise-directiveContent');
        const prompt = '你是英语在线学习平台的答题助手。根据题干上下文，填写每个空。'
            + '严格按空的顺序，每行输出一个空的答案（可以是不定冠词、介词、动词形式等），不要输出任何解释或其他文字。\n\n'
            + '题干：' + (dir ? (dir.textContent || '').trim().replace(/\s+/g, ' ') : '(无文字题干，请根据上下文推断)')
            + '\n共 ' + inputs.length + ' 个空，请输出 ' + inputs.length + ' 行。';
        const out = await aiAsk(prompt);
        if (!out) return null;
        const answers = out.split(/\n+/).map(l => l.replace(/^\d+[.、)\s]+/, '').trim()).filter(Boolean);
        return answers.length ? answers : null;
    }

    // ================= 单选/多选 =================
    // 每题组：lib-adap-group/lib-adap-exercise 外层容器 > 内层题型组件；取最内层组件
    function getQuizGroups() {
        const innerSel = 'lib-single-choice-exercise-cs-study, lib-single-choice-exercise-tb-study, lib-multiple-choice-exercise-cs-study';
        let groups = $('lib-adap-group-exercise-cs-study, lib-adap-exercise-cs-study, ' + innerSel);
        // 去重：保留不含任何内层组件的组（即最内层题型组件本身）
        groups = groups.filter(g => !g.querySelector(innerSel));
        if (groups.length === 0) {
            // 直接单选容器
            const boxes = $('.lib-single-box');
            groups = boxes;
        }
        return groups;
    }

    function optionLetter(orderText) {
        const m = (orderText || '').match(/[A-Ha-h]/);
        return m ? m[0].toUpperCase() : null;
    }

    // 点击某组的第 idx 个选项（单选点击 p，实测有效）
    function clickOption(group, idx) {
        const items = $('.lib-single-item', group);
        const it = items[idx];
        if (!it) return false;
        const p = $1('p.lib-single-item-one, .lib-single-item-content', it);
        click(p || it);
        return true;
    }

    // 从已提交的 DOM 读正确答案（.lib-single-cs-answer span）
    function readChoiceAnswers() {
        const groups = getQuizGroups();
        const answers = [];
        for (const g of groups) {
            const spans = $('.lib-single-cs-answer span', g);
            if (spans.length) {
                answers.push(spans.map(s => (s.textContent || '').trim()).filter(Boolean).join(''));
            } else {
                answers.push('');
            }
        }
        return answers;
    }

    async function solveChoice(isMultiple) {
        const groups = getQuizGroups();
        if (groups.length === 0) return 'no-groups';
        // ---- 试错：优先 AI 猜测，失败则随机 ----
        const aiAns = await aiGuessChoice(groups, isMultiple);
        if (aiAns) status('AI 答案: ' + aiAns.join(', '));
        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const items = $('.lib-single-item', g);
            if (items.length === 0) continue;
            const guess = aiAns && aiAns[i];
            if (guess) {
                // AI 答案直接点选
                for (const ch of guess) {
                    const idx = AMAP[ch.toUpperCase()];
                    if (idx !== undefined) { clickOption(g, idx); await sleep(rnd(150, 350)); }
                }
            } else if (isMultiple) {
                // 多选随机选 1~3 个
                const n = rnd(1, Math.min(3, items.length) + 1);
                const chosen = new Set();
                for (let k = 0; k < n; k++) {
                    let idx = rnd(0, items.length);
                    if (chosen.has(idx)) { k--; continue; }
                    chosen.add(idx);
                    clickOption(g, idx);
                }
            } else {
                clickOption(g, rnd(0, items.length));
            }
            await sleep(rnd(150, 400));
        }
        await submitSmart();
        // ---- 读答案 ----
        const answers = readChoiceAnswers();
        if (!answers.length || answers.every(a => !a)) {
            // fallback：从 wy-lib-right 标记读
            return 'no-answer';
        }
        // ---- Retry 重做 ----
        if (!await clickRetry()) return 'no-retry';
        await sleep(rnd(500, 1200));
        // ---- 按答案填 ----
        const groups2 = getQuizGroups();
        for (let i = 0; i < groups2.length; i++) {
            const g = groups2[i];
            const ans = answers[i] || '';
            for (const ch of ans) {
                const idx = AMAP[ch.toUpperCase()];
                if (idx !== undefined) { clickOption(g, idx); await sleep(rnd(120, 300)); }
            }
        }
        await sleep(rnd(300, 800));
        await submitSmart();
        return 'done';
    }

    // ================= 判断 =================
    async function solveJudge() {
        const rows = $('.lib-judge-left-item');
        const cols = $('.lib-judge-right-item-text');
        if (rows.length === 0 || cols.length === 0) return 'no-structure';
        // 每行 T/F 列数（实测为 2）
        const colCount = $('.lib-judge-right-item').length ? ($('.lib-judge-right-item')[0].querySelectorAll('.lib-judge-right-item-i').length || 2) : 2;
        // ---- 试错：优先 AI 猜测，失败每行点第一列 ----
        const aiAns = await aiGuessJudge(rows);
        if (aiAns) status('AI 答案: ' + aiAns.join(','));
        const radios = $('.lib-judge-radio');
        for (let i = 0; i < rows.length; i++) {
            if (aiAns && aiAns[i]) {
                // 按 AI 答案点对应列
                for (let c = 0; c < colCount; c++) {
                    const radio = radios[i * colCount + c];
                    if (!radio) continue;
                    const item = radio.closest('.lib-judge-right-item-i');
                    const txt = item ? $1('.lib-judge-right-item-text', item) : null;
                    if (txt && (txt.textContent || '').trim() === aiAns[i]) { clickSeq(radio); break; }
                }
            } else {
                const r = radios[i * colCount];
                if (r) clickSeq(r);
            }
            await sleep(rnd(150, 350));
        }
        await submitSmart();
        // ---- 读答案：Key 区或 wy-lib-right 标记 ----
        const keys = [];
        const keyTexts = $('.lib-judge-info .lib-judge-info-text, .lib-judge-info-text');
        if (keyTexts.length) {
            for (const k of keyTexts) keys.push((k.textContent || '').trim());
        } else {
            // fallback: 从每行的 wy-lib-right 读
            const rightRows = $('.lib-judge-right-item');
            for (const rr of rightRows) {
                const correct = $1('.wy-lib-right, .lib-judge-right-item-i.lib-judge-right', rr);
                if (correct) {
                    const txt = $1('.lib-judge-right-item-text', correct);
                    keys.push(txt ? (txt.textContent || '').trim() : '');
                } else keys.push('');
            }
        }
        if (!keys.length || keys.every(k => !k)) return 'no-answer';
        // ---- Retry ----
        if (!await clickRetry()) return 'no-retry';
        await sleep(rnd(500, 1200));
        // ---- 按答案填 ----
        const radios2 = $('.lib-judge-radio');
        for (let i = 0; i < keys.length; i++) {
            const want = keys[i];
            for (let c = 0; c < colCount; c++) {
                const radio = radios2[i * colCount + c];
                if (!radio) continue;
                const item = radio.closest('.lib-judge-right-item-i');
                const txt = item ? $1('.lib-judge-right-item-text', item) : null;
                if (txt && (txt.textContent || '').trim() === want) { clickSeq(radio); await sleep(rnd(150, 350)); }
            }
        }
        await sleep(rnd(300, 800));
        await submitSmart();
        return 'done';
    }

    // ================= 下拉 =================
    // 取当前展开的 nz-select 下拉选项（下拉渲染在 body，同一时刻通常只有一个展开）
    function getOpenDropdownOptions() {
        const dd = $1('.ant-select-dropdown:not(.ant-select-dropdown-hidden), .ant-select-dropdown:not([style*="display: none"])');
        return dd ? $('.ant-select-item-option, .ant-select-dropdown-menu-item', dd) : [];
    }

    async function solveDropdown() {
        const sels = $('.lib-drop-down-item-select nz-select, .lib-drop-down-item-select .ant-select, .ant-select');
        if (sels.length === 0) return 'no-selects';
        // ---- 试错：优先 AI 猜测，失败随机选 ----
        const aiAns = await aiGuessDropdown(sels);
        if (aiAns) status('AI 答案: ' + aiAns.join(', '));
        for (let i = 0; i < sels.length; i++) {
            const sel = sels[i];
            const trigger = $1('.ant-select-selection, .ant-select', sel) || sel;
            clickSeq(trigger);
            await sleep(rnd(400, 800));
            const opts = getOpenDropdownOptions();
            if (!opts.length) continue;
            let picked = null;
            if (aiAns && aiAns[i]) {
                picked = opts.find(o => (o.textContent || '').trim() === aiAns[i]) || null;
            }
            if (picked) clickSeq(picked);
            else clickSeq(opts[rnd(0, opts.length)]);
            await sleep(rnd(200, 400));
        }
        await submitSmart();
        // ---- 读答案：每个 .lib-edit-score.lib-edit-score-tb 里 Key 后的 span ----
        const keys = [];
        $('.lib-edit-score.lib-edit-score-tb span.wy-lib-cs-key, .lib-edit-score span.wy-lib-cs-key').forEach(k => {
            const next = k.nextElementSibling;
            if (next) keys.push((next.textContent || '').trim());
        });
        if (!keys.length) {
            // fallback: 选项 wy-lib-right 标记
            const items = $('.lib-drop-down-item');
            for (const it of items) {
                const right = $1('.wy-lib-right', it);
                keys.push(right ? (right.textContent || '').trim() : '');
            }
        }
        if (!keys.length || keys.every(k => !k)) return 'no-answer';
        // ---- Retry ----
        if (!await clickRetry()) return 'no-retry';
        await sleep(rnd(500, 1200));
        // ---- 按答案填 ----
        const sels2 = $('.lib-drop-down-item-select nz-select, .lib-drop-down-item-select .ant-select, .ant-select');
        for (let i = 0; i < sels2.length && i < keys.length; i++) {
            const sel = sels2[i];
            const trigger = $1('.ant-select-selection, .ant-select', sel) || sel;
            clickSeq(trigger);
            await sleep(rnd(400, 800));
            const opts = getOpenDropdownOptions();
            for (const o of opts) {
                if ((o.textContent || '').trim() === keys[i]) { clickSeq(o); break; }
            }
            await sleep(rnd(200, 400));
        }
        await sleep(rnd(300, 800));
        await submitSmart();
        return 'done';
    }

    // ================= 填空 =================
    async function solveFill() {
        let inputs = $('.lib-fill-blank-do-input-left, .lib-textarea-container textarea, .img-blank-answer input');
        if (inputs.length === 0) return 'no-inputs';
        // ---- 试错：优先 AI 猜测，失败随机填 ----
        const aiAns = await aiGuessFill(inputs);
        if (aiAns) status('AI 答案: ' + aiAns.join(', '));
        for (let i = 0; i < inputs.length; i++) {
            fill(inputs[i], (aiAns && aiAns[i]) ? aiAns[i] : rw());
            await sleep(rnd(100, 250));
        }
        await submitSmart();
        // ---- 读答案：优先 .lib-edit-score.lib-edit-score-tb 的 Key 后 span（与下拉题同结构），兜底旧 data-type 结构 ----
        let anyVary = false;
        const ans = [];
        $('.lib-edit-score.lib-edit-score-tb span.wy-lib-cs-key, .lib-edit-score span.wy-lib-cs-key').forEach(k => {
            const next = k.nextElementSibling;
            if (!next) return;
            const t = (next.textContent || '').trim();
            if (t.toLowerCase().indexOf('vary') >= 0) { anyVary = true; ans.push('*ANY*'); }
            else ans.push(t);
        });
        if (!ans.length) {
            $('.lib-edit-score span[data-type="1"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t.toLowerCase().indexOf('vary') >= 0) { anyVary = true; ans.push('*ANY*'); }
                else ans.push(t);
            });
        }
        if (!ans.length) return 'no-answer';
        // ---- Retry ----
        if (!await clickRetry()) return 'no-retry';
        await sleep(rnd(500, 1200));
        // ---- 按答案填 ----
        const inputs2 = $('.lib-fill-blank-do-input-left, .lib-textarea-container textarea, .img-blank-answer input');
        for (let i = 0; i < inputs2.length; i++) {
            const v = ans[i] === '*ANY*' ? rw() : (ans[i] || rw());
            fill(inputs2[i], v);
            await sleep(rnd(100, 250));
        }
        await sleep(rnd(300, 800));
        await submitSmart();
        return 'done';
    }

    // ================= 跟读/录音 =================
    async function solveListenRepeat() {
        // 每个句子：点"录音" → 录 1.5~3 秒 → 点"停止"（出现"播放"按钮即录音成功）
        const items = $('.lib-listen-item');
        for (const item of items) {
            const rec = $1('img[title="录音"], .lib-listen-item-right-img img:last-child', item);
            if (rec) {
                clickSeq(rec);
                await sleep(rnd(1500, 2500));
                const stop = $1('img[title="停止"]', item);
                if (stop) clickSeq(stop);
                await sleep(rnd(400, 900));
            }
        }
        await sleep(rnd(2000, 4000)); // 等录音上传/评测
        await submitSmart();
        return 'done';
    }

    // ================= 口语 =================
    async function solveOral() {
        // 找录音按钮：完成"录音 → 停止"
        const recBtn = $1('img[title="录音"], .lib-oral-img, [class*="record"]');
        if (recBtn) {
            clickSeq(recBtn);
            await sleep(rnd(2000, 3000));
            const stop = $1('img[title="停止"]');
            if (stop) clickSeq(stop);
        }
        await sleep(rnd(2000, 4000));
        await submitSmart();
        return 'done';
    }

    // ================= 角色扮演 =================
    async function solveRoleplay() {
        const items = $('.lib-role-select-item');
        if (items.length) { clickSeq(items[0]); await sleep(rnd(400, 800)); }
        const start = $1('.lib-role-select-start button, button[class*="start"]');
        if (start) { click(start); await sleep(rnd(2000, 4000)); }
        // 对话/录音兜底：若出现录音按钮，录几秒后停止
        const recBtn = $1('img[title="录音"]');
        if (recBtn) {
            clickSeq(recBtn);
            await sleep(rnd(2000, 3000));
            const stop = $1('img[title="停止"]');
            if (stop) clickSeq(stop);
            await sleep(rnd(1000, 2000));
        }
        await submitSmart();
        return 'done';
    }

    // ================= 拖拽 =================
    async function solveDrag() {
        const items = $('.lib-drag-item, [class*="drag-item"]');
        const zones = $('.lib-drag-item-place, .lib-drop-zone, [class*="drop-zone"], .blank, .lib-drag-ffzz');
        if (items.length === 0) return 'no-items';
        // 用 pointer 事件模拟拖拽
        async function dragTo(from, to) {
            if (!from || !to) return;
            const fr = from.getBoundingClientRect(), tr = to.getBoundingClientRect();
            const sx = fr.left + fr.width / 2, sy = fr.top + fr.height / 2;
            const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
            from.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sx, clientY: sy, button: 0, pointerId: 1 }));
            await sleep(80);
            const steps = 10;
            for (let i = 1; i <= steps; i++) {
                const x = sx + (tx - sx) * i / steps, y = sy + (ty - sy) * i / steps;
                from.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
                await sleep(30);
            }
            to.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: tx, clientY: ty, button: 0, pointerId: 1 }));
            await sleep(150);
        }
        // ---- 试错 ----
        for (let i = 0; i < Math.min(items.length, zones.length); i++) {
            await dragTo(items[i], zones[i]);
            await sleep(rnd(150, 350));
        }
        await submitSmart();
        // ---- 读答案 ----
        let ans = [];
        $('.lib-drag-answer span, .lib-drag-answer-box span, [class*="drag-answer"] span').forEach(el => ans.push((el.textContent || '').trim()));
        if (!ans.length || ans.every(a => !a)) return 'no-answer';
        if (!await clickRetry()) return 'no-retry';
        await sleep(rnd(500, 1200));
        // ---- 按答案填 ----
        const items2 = $('.lib-drag-item, [class*="drag-item"]');
        const zones2 = $('.lib-drag-item-place, .lib-drop-zone, [class*="drop-zone"], .blank, .lib-drag-ffzz');
        for (let j = 0; j < ans.length && j < zones2.length; j++) {
            for (let k = 0; k < items2.length; k++) {
                if ((items2[k].textContent || '').trim() === ans[j]) { await dragTo(items2[k], zones2[j]); break; }
            }
        }
        await sleep(rnd(300, 800));
        await submitSmart();
        return 'done';
    }

    // ================= 视频 =================
    async function solveVideo() {
        const v = $1('#J_prismPlayer video') || $1('.prism-player video') || $1('video');
        if (v) {
            try {
                v.muted = true;
                v.playbackRate = 16;
                if (v.paused) v.play().catch(() => {});
                if (v.duration && v.duration > 5) v.currentTime = v.duration - 2;
            } catch (e) {}
        }
        const bigBtn = $1('.prism-big-play-btn, .prism-player .prism-big-play-btn');
        if (bigBtn) click(bigBtn);
        await sleep(rnd(6000, 10000));
        if (v && v.duration && v.duration > 5) { try { v.currentTime = v.duration - 1; } catch (e) {} }
        // Aliplayer 直接跳结尾
        try {
            const player = window['player'] || null;
            if (player && player.seek) player.seek(player.getDuration ? player.getDuration() - 1 : 999999);
        } catch (e) {}
        await sleep(rnd(3000, 5000));
        // 提交/下一步（音频视频题需播完，用 submitSmart 统一处理）
        if (isAnsweringState()) await submitSmart();
        return 'done';
    }

    // ================= 听力图片填空（遗留题型） =================
    async function solveListenFill() {
        const inputs = $('.lib-textarea-container textarea, .img-blank-answer input');
        for (const el of inputs) { fill(el, rw()); await sleep(rnd(100, 250)); }
        await submitSmart();
        const ans = [];
        // 与 solveFill 统一：Key 后 span 优先，兜底 data-type
        $('.lib-edit-score.lib-edit-score-tb span.wy-lib-cs-key, .lib-edit-score span.wy-lib-cs-key').forEach(k => {
            const next = k.nextElementSibling;
            if (next) ans.push((next.textContent || '').trim());
        });
        if (!ans.length) {
            $('.lib-edit-score span[data-type="1"]').forEach(el => ans.push((el.textContent || '').trim()));
        }
        if (ans.length && await clickRetry()) {
            await sleep(rnd(500, 1200));
            const inputs2 = $('.lib-textarea-container textarea, .img-blank-answer input');
            for (let i = 0; i < inputs2.length; i++) { fill(inputs2[i], ans[i] || rw()); await sleep(rnd(100, 250)); }
            await sleep(rnd(300, 800));
            await submitSmart();
        }
        return 'done';
    }

    // ================= 练习页主流程 =================
    async function doExercise() {
        // 关闭可能的弹窗
        closeModals();
        const type = detectType();
        status('题型: ' + type);
        let result = 'unknown';
        try {
            switch (type) {
                case 'single': result = await solveChoice(false); break;
                case 'multiple': result = await solveChoice(true); break;
                case 'judge': result = await solveJudge(); break;
                case 'dropdown': result = await solveDropdown(); break;
                case 'fill': result = await solveFill(); break;
                case 'listen_repeat': result = await solveListenRepeat(); break;
                case 'oral': result = await solveOral(); break;
                case 'roleplay': result = await solveRoleplay(); break;
                case 'drag': result = await solveDrag(); break;
                case 'video': result = await solveVideo(); break;
                case 'listen_fill': result = await solveListenFill(); break;
                default: {
                    // 无题型组件：可能只有按钮（纯展示页/听力页），直接点下一步
                    if (isAnsweringState()) await clickSubmit();
                    else result = 'no-type';
                }
            }
        } catch (e) {
            status('错误: ' + e.message);
            result = 'error:' + e.message;
        }
        return result;
    }

    function closeModals() {
        // 关闭 antd 弹窗（自由模式提示等）
        $('.ant-modal:not(.ant-modal-confirm) .ant-modal-close').forEach(b => b.click());
        // 确认弹窗：仅自动确认无害文案；"系统繁忙"类反作弊弹窗不自动点（交给 detectBusy 冷却处理）
        $('.ant-modal-confirm .ant-btn-primary').forEach(b => {
            if (/^(知道了|好的|确定|继续|OK|关闭)$/i.test((b.textContent || '').trim())) b.click();
        });
    }

    // 轮询等待 URL path 变化（Angular 路由跳转可能较慢），返回是否切换成功
    async function waitUrlChange(from, timeoutMs) {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            await sleep(500);
            if (location.href.split('?')[0] !== from) return true;
        }
        return false;
    }

    // ================= 课程主页导航（入口：从主页进入练习页，右箭头接管后续全部翻页/跨任务） =================
    async function navigateFromHome() {
        const urlBefore = location.href.split('?')[0];
        // 若在课程列表页（studentcourse），先点进课程主页（注意：绑定在 .course-title 子级，.course-list-item 父级点击无效）
        if (/\/studentcourse/.test(location.pathname)) {
            const card = $1('.course-title');
            if (card) clickSeq(card);
            if (!await waitUrlChange(urlBefore, 10000)) {
                const card2 = $1('.course-title');
                if (card2) clickSeq(card2);
                if (!await waitUrlChange(urlBefore, 10000)) {
                    status('未进入课程主页，请在课程列表页手动点开课程');
                    return false;
                }
            }
        }
        // 点"继续学习"进入上次学习位置（右箭头会自动推进后续所有任务/单元，无需目录导航）
        const cont = $('.topBtn button, .course-top button, button.btn.ant-btn');
        for (const b of cont) {
            if ((b.textContent || '').includes('继续学习')) {
                click(b);
                await waitUrlChange(location.href.split('?')[0], 8000);
                if (isExercisePage()) return true;
                break;
            }
        }
        status('未进入练习页，请在课程页手动点开一个练习后点"开始刷课"');
        return false;
    }


    // ================= 练习页翻页（右箭头，全自动核心） =================
    // 右上角 .page-next 右箭头：JS 点击有效，自动跨任务/跨单元前进（实测 42/42 → 1/41 跨 Unit）
    // 注意：翻页会触发 record_for_detail 等 POST（限流约 1 次/秒），间隔必须 ≥4 秒
    async function clickNextArrow() {
        const arrows = $('.page-next');
        if (!arrows.length) return false;
        const next = arrows[arrows.length - 1]; // 最后一个 = 右箭头（tx_page_right）
        const st = getComputedStyle(next);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        const urlBefore = location.href.split('?')[0];
        click(next);
        await sleep(rnd(4000, 6000)); // 降频：翻页触发 POST 加载，间隔 4~6s 规避限流
        // 以 URL 变化判定翻页生效（比"箭头隐藏"可靠）；慢路由再轮询 8s 兑底
        if (location.href.split('?')[0] !== urlBefore) return true;
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
            await sleep(500);
            if (location.href.split('?')[0] !== urlBefore) return true;
        }
        return false; // URL 未变化 → 视为最后一页/点击无效（调用方做 3 轮容错）
    }

    // ================= 主循环 =================
    let running = false;
    let timer = null;
    let noBtnRounds = 0; // 连续无翻页轮次（页面加载/最后一页确认计数）
    let roundCount = 0; // 总轮次（反作弊保护）
    let rateLimited = false; // 疑似触发频率限制（HTTP 530 / 系统繁忙）
    let invalidRounds = 0; // 脚本有效性检测：连续失效轮数
    let cooldownUntil = 0; // 限流冷却截止时间戳（实测冷却约 60s，取 90s 余量）
    const MAX_ROUNDS = 1000; // 右箭头模式轮次放宽（刷完整门课 300+ 页 + 提交重试余量）

    // 触发限流冷却：不停止，冷却 90 秒后自动继续（实测 530 冷却约 1 分钟）
    function enterCooldown(msg) {
        cooldownUntil = Date.now() + 90000;
        status(msg + '，冷却 90 秒后自动继续');
    }

    // 检测页面出现"系统繁忙"等反作弊拦截提示（HTTP 530 或业务提示）
    function detectBusy() {
        return !!Array.from(document.querySelectorAll('body *')).some(el =>
            el.children.length === 0 && /系统繁忙|频繁|操作失败|请稍后|访问过于|请求过快|530/.test(el.textContent || ''));
    }

    // 停止并提示（无未完成项/反作弊拦截等场景，避免无限空转）
    function stopRun(msg) {
        running = false;
        if (timer) clearTimeout(timer);
        const b = $1('#b6-start');
        if (b) b.textContent = '开始刷课';
        setBusy(false);
        if (msg) status(msg); // 空消息：保留调用方已设置的状态提示
    }

    async function doOneRound() {
        closeModals();
        // 限流冷却中：等待自动恢复（不停止）
        if (cooldownUntil > Date.now()) {
            const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
            status('限流冷却中 ' + left + 's，稍后自动继续');
            return;
        }
        if (detectBusy()) { enterCooldown('检测到"系统繁忙"（限流拦截）'); return; }
        // 脚本有效性检测：连续 5 轮核心 DOM 全缺 → 站点改版 → 上报 issue + 停止
        if (isCourseHome() || isExercisePage()) {
            if (!checkScriptValidity()) {
                invalidRounds++;
                if (invalidRounds >= 10) {
                    const reported = await reportIssue('核心 DOM 探针连续 10 轮未命中');
                    stopRun('脚本可能已失效（站点结构不匹配），' + (reported ? '已自动上报 issue' : '请检查/更新脚本'));
                    return;
                }
                status('检测到页面结构异常（' + invalidRounds + '/10），等待确认...');
            } else {
                invalidRounds = 0;
            }
        }
        roundCount++;
        if (roundCount > MAX_ROUNDS) { stopRun('达到最大轮次保护(' + MAX_ROUNDS + ')，已停止'); return; }
        if (isExercisePage()) {
            if (isAnsweringState()) {
                // 有题可答：答题（AI/试错+提交）
                noBtnRounds = 0;
                await doExercise();
                if (rateLimited) { rateLimited = false; enterCooldown('提交疑似触发限流'); return; }
                // 提交后仍可作答（锁定/未生效）→ 翻页跳过（3 轮容错，防加载瞬间误停）
                if (isAnsweringState()) {
                    status('提交未生效，翻下一页');
                    if (!await clickNextArrow()) {
                        noBtnRounds++;
                        if (noBtnRounds >= 3) { noBtnRounds = 0; stopRun(); }
                    }
                }
                return;
            }
            // 已答/展示/无按钮状态：翻下一页（右箭头自动跨任务跨单元）
            status('翻下一页');
            if (!await clickNextArrow()) {
                // 无箭头/URL 未变：可能是页面渲染中（Angular 懒加载），连续 3 轮（约 30~45s）才判最后一页
                noBtnRounds++;
                if (noBtnRounds >= 3) { noBtnRounds = 0; stopRun('已到最后一页，全部完成'); }
                else status('未检测到下一页（' + noBtnRounds + '/3），等待后重试');
            }
            return;
        }
        if (isCourseHome()) {
            status('课程主页：进入任务');
            const ok = await navigateFromHome();
            if (!ok) stopRun(); // navigateFromHome 已设置具体状态
            return;
        }
        status('非课程页面');
    }

    async function loop() {
        if (!running) return;
        setBusy(true);
        try {
            await doOneRound();
        } catch (e) {
            status('循环错误: ' + e.message);
        }
        setBusy(false);
        if (running) timer = setTimeout(loop, rnd(8000, 12000)); // 降频：右箭头翻页模式，拉长循环间隔规避限流
    }

    // ================= 状态/UI =================
    let statusEl = null;
    function status(m) {
        if (statusEl) statusEl.textContent = m;
        try { console.log('[刷课]', m); } catch (e) {}
    }
    function setBusy(b) {
        const btns = $('#b6-root button');
        btns.forEach(btn => { btn.disabled = b; btn.style.opacity = b ? '0.6' : '1'; });
    }

    function mkUI() {
        if ($1('#b6-root')) return;
        const root = document.createElement('div');
        root.id = 'b6-root';
        // 莱茵生命风格：冷白 + 墨蓝灰 + 钢蓝强调（无渐变、扁平、科研工程感）
        const css = document.createElement('style');
        css.textContent = [
            '#b6-root * { box-sizing: border-box; margin: 0; padding: 0; }',
            '#b6-root { font: 13px/1.7 "Microsoft YaHei", system-ui, sans-serif; }',
            '#b6-panel { position: fixed; top: 80px; right: 16px; width: 320px; background: #F4F6F8; border: 1px solid #CBD6E0; border-radius: 10px; box-shadow: 0 6px 20px rgba(43,58,73,.15); z-index: 2147483647; overflow: hidden; }',
            '#b6-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #33475C; color: #F0F4F7; cursor: move; user-select: none; }',
            '#b6-hex { width: 22px; height: 22px; flex: 0 0 22px; background: #7C93A8; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #F4F7FA; }',
            '#b6-hd-title { font-size: 13.5px; font-weight: 600; letter-spacing: 1px; }',
            '#b6-hd-sub { font-size: 9px; opacity: .72; letter-spacing: 2px; }',
            '#b6-x { cursor: pointer; padding: 0 2px; font-size: 14px; color: #9FB4C6; }',
            '#b6-x:hover { color: #fff; }',
            '#b6-set-btn { cursor: pointer; padding: 2px 6px; font-size: 11px; border: 1px solid #7C93A8; border-radius: 4px; color: #D6E3EC; }',
            '#b6-set-btn:hover { background: #46607A; color: #fff; }',
            '#b6-guide-btn { cursor: pointer; padding: 0 5px; font-size: 13px; color: #D6E3EC; border: 1px solid #7C93A8; border-radius: 50%; }',
            '#b6-guide-btn:hover { background: #46607A; color: #fff; }',
            '#b6-reopen { position: fixed; top: 80px; right: 16px; width: 28px; height: 28px; background: #33475C; color: #F0F4F7; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); display: none; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; cursor: pointer; z-index: 2147483647; }',
            '#b6-reopen:hover { background: #46607A; }',
            '#b6-bd { padding: 12px; user-select: text; -webkit-user-select: text; }',
            '#b6-status { text-align: center; padding: 8px 10px; margin-bottom: 12px; background: #E8EDF3; border: 1px solid #D5DEE6; border-radius: 6px; font-size: 12px; font-weight: 600; color: #2B3A49; word-break: break-all; user-select: text; -webkit-user-select: text; }',
            '.b6-group { margin-bottom: 13px; }',
            '.b6-glabel { display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700; letter-spacing: 1.5px; color: #4A6A85; margin-bottom: 7px; text-transform: uppercase; user-select: none; }',
            '.b6-glabel::before { content: ""; width: 6px; height: 6px; background: #7C93A8; clip-path: polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); }',
            '.b6-btn { display: block; width: 100%; padding: 9px; border-radius: 6px; cursor: pointer; font-size: 13px; border: 1px solid; transition: all .15s; user-select: none; }',
            '#b6-start { background: #3D6B99; color: #fff; border-color: #3D6B99; font-weight: 600; margin-bottom: 6px; }',
            '#b6-start:hover { background: #33587E; }',
            '#b6-one, #b6-score, #b6-farm { background: #fff; color: #33587E; border-color: #CBD6E0; margin-bottom: 6px; }',
            '#b6-one:hover, #b6-score:hover, #b6-farm:hover { background: #E9EEF3; }',
            '#b6-score-out { margin-top: 6px; padding: 8px 9px; background: #F7F9FB; border: 1px dashed #CBD6E0; border-radius: 6px; font: 11.5px/1.6 Consolas,monospace; white-space: pre-wrap; word-break: break-all; color: #2B3A49; display: none; user-select: text; -webkit-user-select: text; }',
            '.b6-in { width: 100%; padding: 6px 8px; font-size: 12px; margin-bottom: 5px; border: 1px solid #D5DEE6; border-radius: 4px; background: #fff; color: #2B3A49; }',
            '.b6-in:focus { outline: none; border-color: #4A7BA6; }',
            '.b6-label { display: flex; align-items: center; gap: 4px; margin-bottom: 6px; font-size: 12px; color: #33587E; cursor: pointer; user-select: none; }',
            '.b6-sm-btn { padding: 6px; border-radius: 4px; cursor: pointer; font-size: 12px; border: 1px solid #CBD6E0; background: #fff; color: #33587E; user-select: none; }',
            '.b6-sm-btn:hover { background: #E9EEF3; }',
            '.b6-row { display: flex; gap: 4px; }'
        ].join('\n');
        root.appendChild(css);

        const panel = document.createElement('div');
        panel.id = 'b6-panel';
        panel.innerHTML =
            '<div id="b6-hd">' +
            '  <div id="b6-hex">R</div>' +
            '  <div style="flex:1">' +
            '    <div id="b6-hd-title">TSH AUTO STUDY</div>' +
            '    <div id="b6-hd-sub">自动刷课</div>' +
            '  </div>' +
            '  <div id="b6-guide-btn" title="使用引导">?</div>' +
            '  <div id="b6-set-btn" title="设置">设置</div>' +
            '  <div id="b6-x">&times;</div>' +
            '</div>' +
            '<div id="b6-reopen" title="展开面板">R</div>' +
            '<div id="b6-bd">' +
            '  <div id="b6-status">就绪</div>' +
            '  <div class="b6-group">' +
            '    <div class="b6-glabel">Operation · 执行</div>' +
            '    <button id="b6-start" class="b6-btn">开始刷课</button>' +
            '    <button id="b6-one" class="b6-btn">做一题</button>' +
            '  </div>' +
            '  <div class="b6-group">' +
            '    <div class="b6-glabel">Data · 数据</div>' +
            '    <button id="b6-score" class="b6-btn">查成绩</button>' +
            '    <button id="b6-farm" class="b6-btn">刷学习时长</button>' +
            '    <pre id="b6-score-out"></pre>' +
            '  </div>' +
            '</div>';
        root.appendChild(panel);

        // 独立设置面板（从主面板"设置"按钮打开）
        const sp = document.createElement('div');
        sp.id = 'b6-settings';
        sp.style.cssText = 'position:fixed;top:80px;right:350px;width:320px;background:#F4F6F8;border:1px solid #CBD6E0;border-radius:10px;box-shadow:0 6px 20px rgba(43,58,73,.15);z-index:2147483647;overflow:hidden;display:none';
        sp.innerHTML =
            '<div id="b6-s-hd" style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#33475C;color:#F0F4F7;cursor:move;user-select:none">' +
            '  <div style="flex:1;font-size:13.5px;font-weight:600;letter-spacing:1px">CONFIG · 设置</div>' +
            '  <div id="b6-s-x" style="cursor:pointer;padding:0 2px;font-size:14px;color:#9FB4C6">&times;</div>' +
            '</div>' +
            '<div style="padding:12px">' +
            '  <div class="b6-glabel">AI · 答题引擎</div>' +
            '  <label class="b6-label"><input type="checkbox" id="b6-ai-en" style="margin:0"> 启用 AI 答题</label>' +
            '  <input id="b6-ai-url" class="b6-in" placeholder="API Base URL（如 deepseek v1）">' +
            '  <input id="b6-ai-key" class="b6-in" type="password" placeholder="API Key">' +
            '  <input id="b6-ai-model" class="b6-in" placeholder="模型名（如 deepseek-chat）">' +
            '  <button id="b6-ai-save" class="b6-sm-btn" style="width:100%">保存 AI 设置</button>' +
            '  <div class="b6-glabel" style="margin-top:12px">Report · 失效上报</div>' +
            '  <div id="b6-rp-auth" style="display:none">' +
            '    <p style="font-size:12px;color:#7A8EA0;margin-bottom:6px">失效自动上报未授权（默认关闭）。</p>' +
            '    <button id="b6-rp-consent" class="b6-sm-btn" style="width:100%">查看知情同意书并授权</button>' +
            '  </div>' +
            '  <div id="b6-rp-form" style="display:none">' +
            '    <label class="b6-label"><input type="checkbox" id="b6-rp-en" style="margin:0"> 失效自动上报 issue</label>' +
            '    <input id="b6-rp-owner" class="b6-in" placeholder="GitHub 用户名">' +
            '    <input id="b6-rp-repo" class="b6-in" placeholder="仓库名">' +
            '    <input id="b6-rp-token" class="b6-in" type="password" placeholder="GitHub Token（Issues: write）">' +
            '    <div class="b6-row">' +
            '      <button id="b6-rp-save" class="b6-sm-btn" style="flex:1">保存设置</button>' +
            '      <button id="b6-rp-test" class="b6-sm-btn" style="flex:1;color:#B3544B">发测试 issue</button>' +
            '    </div>' +
            '  </div>' +
            '</div>';
        root.appendChild(sp);
        document.body.appendChild(root);

        // 元素引用
        const hd = $1('#b6-hd'), xb = $1('#b6-x');
        const setBtn = $1('#b6-set-btn'), sPanel = $1('#b6-settings'), sX = $1('#b6-s-x');
        statusEl = $1('#b6-status');
        const startBtn = $1('#b6-start'), oneBtn = $1('#b6-one');
        const scoreBtn = $1('#b6-score'), farmBtn = $1('#b6-farm'), scoreOut = $1('#b6-score-out');

        // 拖动
        let dragging = false, dx = 0, dy = 0, px = 0, py = 0;
        hd.addEventListener('pointerdown', e => {
            dragging = true; dx = e.clientX; dy = e.clientY;
            px = panel.offsetLeft; py = panel.offsetTop;
            e.preventDefault();
        });
        document.addEventListener('pointermove', e => {
            if (!dragging) return;
            panel.style.left = (px + e.clientX - dx) + 'px';
            panel.style.top = (py + e.clientY - dy) + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('pointerup', () => { dragging = false; });

        startBtn.addEventListener('click', () => {
            if (running) {
                running = false; if (timer) clearTimeout(timer);
                if (studyTimer) stopStudyFarm();
                startBtn.textContent = '开始刷课';
                status('已停止');
            } else {
                running = true;
                roundCount = 0;
                rateLimited = false;
                cooldownUntil = 0;
                startBtn.textContent = '停止';
                status('运行中');
                loop();
            }
        });
        oneBtn.addEventListener('click', async () => {
            status('执行...');
            await doOneRound();
            status('完成');
        });
        xb.addEventListener('click', () => { if (studyTimer) stopStudyFarm(); panel.style.display = 'none'; $1('#b6-reopen').style.display = 'flex'; });
        $1('#b6-reopen').addEventListener('click', () => {
            $1('#b6-reopen').style.display = 'none';
            panel.style.display = 'block';
        });
        // 设置面板：打开/关闭 + 拖动
        setBtn.addEventListener('click', () => {
            sPanel.style.display = sPanel.style.display === 'none' ? 'block' : 'none';
        });
        sX.addEventListener('click', () => { sPanel.style.display = 'none'; });
        {
            let dragging = false, dx = 0, dy = 0, px = 0, py = 0;
            const sHd = $1('#b6-s-hd');
            sHd.addEventListener('pointerdown', e => {
                dragging = true; dx = e.clientX; dy = e.clientY;
                px = sPanel.offsetLeft; py = sPanel.offsetTop;
                e.preventDefault();
            });
            document.addEventListener('pointermove', e => {
                if (!dragging) return;
                sPanel.style.left = (px + e.clientX - dx) + 'px';
                sPanel.style.top = (py + e.clientY - dy) + 'px';
                sPanel.style.right = 'auto';
            });
            document.addEventListener('pointerup', () => { dragging = false; });
        }
        // 上报授权入口：重新弹出知情同意书
        $1('#b6-rp-consent').addEventListener('click', () => showConsentModal(true));
        // 使用引导入口
        $1('#b6-guide-btn').addEventListener('click', () => showGuide());

        // 查成绩（POST 有频率限制：点击后冷却 3 秒，防止连续查询触发 HTTP 530 反作弊拦截）
        let scoreCooldown = false;
        scoreBtn.addEventListener('click', async () => {
            if (scoreCooldown) { status('查询冷却中，请稍候...'); return; }
            scoreCooldown = true;
            scoreBtn.disabled = true;
            scoreBtn.style.opacity = '0.6';
            status('查询中...');
            const data = await fetchScore();
            scoreOut.textContent = formatScore(data);
            scoreOut.style.display = 'block';
            status(data && data.blocked ? '触发频率限制，已停止查询' : '成绩查询完成');
            setTimeout(() => { scoreCooldown = false; scoreBtn.disabled = false; scoreBtn.style.opacity = '1'; }, 3000);
        });
        // 刷学习时长（挂机累计；后端按真实时间节奏去重，无法加速）
        farmBtn.addEventListener('click', () => {
            if (studyTimer) {
                stopStudyFarm();
                farmBtn.textContent = '刷学习时长';
                farmBtn.style.background = '#fff';
            } else {
                if (!isExercisePage()) { status('请先进入练习页再刷时长'); return; }
                startStudyFarm();
                farmBtn.textContent = '停止刷时长';
                farmBtn.style.background = '#E9EEF3';
            }
        });

        // AI 设置：加载 + 保存
        loadAiConfig();
        $1('#b6-ai-en').checked = aiConfig.enabled;
        $1('#b6-ai-url').value = aiConfig.baseUrl;
        $1('#b6-ai-key').value = aiConfig.apiKey;
        $1('#b6-ai-model').value = aiConfig.model;
        $1('#b6-ai-save').addEventListener('click', () => {
            aiConfig.enabled = $1('#b6-ai-en').checked;
            aiConfig.baseUrl = $1('#b6-ai-url').value.trim();
            aiConfig.apiKey = $1('#b6-ai-key').value.trim();
            aiConfig.model = $1('#b6-ai-model').value.trim();
            saveAiConfig();
            status('AI 设置已保存' + (aiConfig.enabled ? '（已启用）' : '（未启用）'));
        });

        // 失效上报设置：加载 + 保存 + 测试（上报区显隐由知情同意书授权控制，默认不允许）
        loadReportConfig();
        syncReportArea();
        $1('#b6-rp-en').checked = reportConfig.enabled;
        $1('#b6-rp-owner').value = reportConfig.owner;
        $1('#b6-rp-repo').value = reportConfig.repo;
        $1('#b6-rp-token').value = reportConfig.token;
        $1('#b6-rp-save').addEventListener('click', () => {
            reportConfig.enabled = $1('#b6-rp-en').checked;
            reportConfig.owner = $1('#b6-rp-owner').value.trim();
            reportConfig.repo = $1('#b6-rp-repo').value.trim();
            reportConfig.token = $1('#b6-rp-token').value.trim();
            saveReportConfig();
            status('失效上报设置已保存' + (reportConfig.enabled ? '（已启用）' : '（未启用）'));
        });
        $1('#b6-rp-test').addEventListener('click', async () => {
            reportConfig.enabled = $1('#b6-rp-en').checked;
            reportConfig.owner = $1('#b6-rp-owner').value.trim();
            reportConfig.repo = $1('#b6-rp-repo').value.trim();
            reportConfig.token = $1('#b6-rp-token').value.trim();
            saveReportConfig();
            status('发送测试 issue...');
            const ok = await reportIssue('手动测试上报');
            status(ok ? '测试 issue 已发送' : '测试失败（检查 owner/repo/token 权限）');
        });

        // 首次启用：未按当前版本同意书授权则弹知情同意书（引导在其关闭后弹出）；已授权用户直接看引导
        if (reportConfig.consent !== true || reportConfig.consentVersion !== '1.0') {
            showConsentModal();
        } else {
            maybeShowGuide();
        }
    }

    setTimeout(mkUI, 1500);

}

// ============================================================================
// 双引擎分发器
// ============================================================================
//
// 本站点是双轨运行：/legacy/ 为 Angular 旧站，/course_center/ 为 Vue3 新版。
// 登录时由统一认证中心按账号属性分流，因此不同用户看到的是两套完全不同的前端。
//
// 本脚本同时内置两套引擎，按当前路径只启动其中一套：
//   - 新版引擎 → /course_center/
//   - 旧站引擎 → /legacy/
//
// 两个引擎各自包在独立 function 内，作用域完全隔离，因此 ~20 处同名符号
// （detectType / doOneRound / mkUI / click / status 等）不会互相覆盖。
// 存储键保持共用：两版的 aiConfig / reportConfig 结构完全一致，属共享配置。

(function () {
    'use strict';

    var path = location.pathname;

    // 新版：整个 /course_center/ 命名空间（含 reader 与课程中心各页）。
    // 不能只匹配 /course_center/reader/ —— 用户进入章节前的过渡页同属新版，
    // 引擎应在这些页面就绪并在进入章节后接管。
    var isNewSite = /^\/course_center\//i.test(path);

    // 旧站：/legacy/ 前缀。同时兼顾 /legacy 无尾斜杠的边界情况。
    var isLegacySite = /^\/legacy(\/|$|\?)/.test(path);

    // 供排错使用：在 Console 里执行 window.__TSH_BRUSH__ 可查看状态
    globalThis.__TSH_BRUSH__ = {
        version: '2.3.1-local78',
        engine: isNewSite ? 'new' : (isLegacySite ? 'legacy' : 'idle'),
        path: path
    };

    if (isNewSite) {
        try { console.log('[刷课] 检测到新版站点，启动新版引擎 v2.3.1-local78（完整日志在本控制台，筛选 [刷课]）'); } catch (e) {}
        __TSH_NEW_ENGINE__();
        return;
    }

    if (isLegacySite) {
        try { console.log('[刷课] 检测到旧站 /legacy/，启动旧站引擎 v2.3.1-local78（完整日志在本控制台，筛选 [刷课]）'); } catch (e) {}
        __TSH_OLD_ENGINE__();
        return;
    }

    try { console.log('[刷课] 非教材/课程页面，脚本待命（进入阅读器后自动启用）'); } catch (e) {}
})();
