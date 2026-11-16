# TSH自动刷课 · 本地补丁说明

上游基线：`WASD258-jpg/tsh-auto-brush` v2.3.0（2026-10-08，234859 字节 / 4507 行）
本地版本：**2.3.1-local32**（293988 字节）
原始备份：`tsh-auto-brush.user.js.bak`

所有结论都来自真机日志或站点构建产物，不是推测。每条都注明「现象 → 根因 → 改法」。

---

## 一、汇总表

| # | 现象 | 根因 | 版本 |
|---|---|---|---|
| 1 | 听力填空题被当成语音题整节跳过 | `cardNeedsSpeech` 用后代查询匹配 `.listen-repeat-view`，而音频视图复用了该包装类 | local1/2/4 |
| 2 | 纯音频卡被判语音题 | 兜底 `isSpeechType(detectType(el))` 把音频卡判成 `oral_follow_along` | local4 |
| 3 | 控件已禁用仍被判「可写」 | `ensureEditableState` 只看元素存在，不看 `disabled` / `-disabled` | local11 |
| 4 | 客观题被送 AI、然后跳过 | `isSubjective()` 只信 `obSub === 'sub'`，站点给客观题也标了 sub | local12 |
| 5 | 一题填不进去，整节放弃 | 占位循环末尾 `questions.some(!hasUserAnswer)` 直接 return | local15 |
| 6 | judge_advanced 一次提交都不发 | `fillPlaceholder` 没有该题型分支 | local6 |
| 7 | judge_advanced 填不进 | 真实结构是 `.judge-option-item` + radio，`value` 即 option idx；`q.extension` 是 **JSON 字符串** | local8/9/10 |
| 8 | 报「已作答完成」但页面还是「提交」 | 占位写进 `currentResp` 后 `hasUserAnswer()` 当真，服务端其实没记 | local7 |
| 9 | 提交被拒但日志无提示 | 占位值每轮相同 → 服务端视为重复提交，`errorNumShow` 不涨 | local29 |
| 10 | 整页反复自动刷新 | 自动刷课跨节靠 `location.href` 整页跳转，状态存 localStorage 自动恢复 | local14（加上限与提示） |
| 11 | 点「做一轮」两秒结束、什么都没做 | URL 只有 `catalogId` 没有 `contentId`，`loadCurrentExercise()` 静默 return null | local16/21 |
| 12 | 取到别的节的数据 | `performance` 里最后一条 `/answer` 请求未必对应屏上这节 | local21（DOM id 校验） |
| 13 | 组合题永远填 0 | 父卡零可写控件，答案在子题；`applyAnswer` 无组合题分支 | local17/31/32 |
| 14 | 组合题提交时子题答案丢失 | 提交时只收集顶层 doRecord | local17 |
| 15 | 点「重做」无反应 | Retry/Submit 是 `div.right-button`，不是 `button`；合成点击落在包装层上 | local25/27/28/30 |
| 16 | 拿到标准答案却不回填、继续试错 | `usable()` 只看父题 answer，组合题答案在子题 → 永远判「未齐」 | local32 |
| 17 | 错题（红叉）永远不被纠正 | 只判「有没有作答」，有就报完成 | local22/23/24 |
| 18 | 站点提示「操作过于频繁」后整步被吞 | 只认 HTTP 429；业务文案（"操作过于频繁"）返回 200，被当成正常返回 | local33 |
| 19 | 请求太密，反而更容易被限流 | 每轮 contentId 探测 2~5 次额外请求，且无全局间隔控制 | local33 |

---

## 二、关键结构事实（改版时优先核对）

阅读器页（`/course_center/reader/student_course/{bizId}?catalogId=…`）：

| 项 | 实测值 |
|---|---|
| URL | **只有 `catalogId`，没有 `contentId`**（站点用 SPA 状态渲染，不回写 URL） |
| 顶层题卡 | `div.exercise-item`；子题是**嵌套的** `.exercise-item[data-child-question-id]` |
| 组合题 | 父卡 `div.combination-question-course-done` / `…-do`，父卡自身零可写控件 |
| 填空（作答态） | `span.zty-exercise-item-fill-blank-do`，`contenteditable` |
| 填空（已判态） | `span.zty-exercise-item-fill-blank-done`，附 `-done-right` / `-done-wrong` + `<img src="/img/wrong.svg">` |
| 听力填空 | 音频视图复用 `.zty-exercise-view-main.listen-repeat-view` 包装类 |
| 口语题 | `div.oral-brief-course-do / -done`，含录音按钮 |
| `judge_advanced` | 行 `.judge-topic-item`、选项 `.judge-option-item`（`ant-radio-group`），`input[value]` 就是 option idx |
| `q.extension` | **字符串**，需 `JSON.parse` |
| Retry / Submit | `div.right-button`（自绘），文字 `Retry` / `Submit`；`document` 里另有同名但不可见的 `button` |
| 提交节流 | 过频返回 `请勿重复提交，请稍后重试` |
| 判分口径 | `learnMode=1` 自由模式记末次；`errorNumShow` 答错次数阈值 |

---

## 三、修复要点（按机制归类）

### 1. 题型判定
- 语音题必须存在**录音/播报控件**（`img[title="录音"]`、`.lib-oral-img`、`[class*="record"]`、`.avatar-view-container`、`.role-play-course-container`）才算；`.listen-repeat-view` 单独出现不算
- 客观题型白名单 `KNOWN_OBJECTIVE_TYPES` 压过 `obSub` 标签
- `detectType` 按 `.judge-option-item` 行数区分 `judge_basic` / `judge_advanced`

### 2. 卡片 ↔ 题目配对
```js
findCardForQuestion(items, q, i)
// 1) card.dataset.questionId === q.id
// 2) card 内含 [data-child-question-id="<子题id>"]
// 3) card 内含 .exercise-item[data-child-question-id="<q.id>"]
// 4) 兜底 items[i]
```
> 之前用 `items[i]`，题少卡多时会把口语卡当成组合题卡，所有诊断数字都是错的。

### 3. contentId 解析
```
① r.contentId（URL 里有就用）
② performance 里 /content/<id>/answer 的候选
③ 本 catalog 的内容项列表
→ 逐个取题，题目 id（含子题）与 DOM 的 data-child-question-id 求交集，命中才采用
→ 全不中：日志列出 domIds 后退回第一个候选
```

### 4. 点击
```js
realClick(el, label)
// scrollIntoView → 取中心坐标 → document.elementFromPoint 拿最顶层真实元素
// → 派 pointerover/pointerdown/mousedown/pointerup/mouseup/click → 再 .click()
// → 命中元素、目标本身、父元素各来一套
```
按钮查找：全页扫 `div,button,span,a,i`，文本精确匹配 + **最内层**（子元素无同文本）+ **可见**（有宽高、非 hidden/none、opacity≠0）。

### 5. 占位试错
- 占位值**每轮不同**（`z1`、`z2`…），否则服务端视为重复提交
- 只要求「至少一题能写入」，个别题写不进不再拖垮整节
- `PLACEHOLDER_IDS` 记录本地占位；宣布完成前核对，只有本地占位就重做
- 提交遇到 `重复提交|稍后重试|频繁|429` 时退避重试（5/9/13 秒，最多 3 次）

### 6. 组合题
- 占位：逐子题按子卡填，写入前若为 done 态先 `realClick` 重做
- 回填：`applyCompositeAnswers()` 按子题 id 取答案（`lastAnswerMap` → `child.answer` → 父题映射）
- 提交：`collectAnswers()` 递归收集子题 doRecord
- 「答案是否齐」：组合题要求**每个子题**都有答案

### 7. 错题纠正
页面存在 `span.…fill-blank-done-wrong` 时，即使接口说「已作答」，也进入重做流程：
`realClick 重做` → 强制覆盖写不同占位 → 提交若干轮 → 取标准答案 → 回填 → 提交。

### 7. 限流与冷却（local33）

站点除了 HTTP 429，还会用**业务文案**限流：`操作过于频繁` / `请稍后重试` / `请勿重复提交`。
这类响应 http 和 `code` 往往是 **200**，只看 429 会把提示当成正常返回 —— 表现就是「这一步被吞了」。

```js
const THROTTLE_RE = /操作过于频繁|过于频繁|请稍后|稍后重试|请勿重复提交|频繁|too\s*many|rate\s*limit|429/i;
enterRateLimit();       // 冷却 60s
minGapMs *= 1.6;        // 每次限流后请求间隔自动放慢，上限 3.5s
```

- 所有请求前统一 `waitGap()`，保证最小间隔
- 命中限流文案 → 冷却 60s + 日志 + 面板提示；随后自动重发一次该请求（`_waited` 标记防死循环）
- **contentId 校验结果按 `bizId|catalogId` 缓存**，同一节不再每轮重复探测（探测是最吃配额的）

---

## 四、排错顺序（下次失效时照这个查）

1. `contentId` 有没有解析对：日志 `contentId 经 DOM 校验命中` / `未能与 DOM 校验一致`
2. `取题成功：题目 N，已答 M` —— N 与页面卡片数是否一致
3. `按钮扫描 {matched, visible}` —— 可见数是否为 1
4. `realClick 落点 {hit}` —— 是否落到内层 `SPAN`
5. `子题答案 {gotAnswer}` —— 服务端有没有下发答案
6. `组合题回填 {filled}` —— 实际写入了几个子题

---

## 五、已知边界

- **语音题**（口语/跟读/角色扮演/词汇）走驰声实时评测，必须真人录音，脚本只跳过
- **提交锁**：部分节的提交被服务端限流/锁定，表现为 `请勿重复提交`；脚本会退避重试，仍失败则跳过
- **自由模式记末次**：反复提交同一错误答案不会更差；拿到答案后的那次才是最终成绩
- 站点无客户端隔离的校园网环境下，课堂网的访问受限与脚本无关

---

## 六、local34–local65：多选题与"提交了但不认"（第二阶段）

这一段的共同主题：**UI 能填 ≠ 服务端认账**，必须先有"提交后回查"才能判断修好没有。

| # | 现象 | 根因 | 版本 |
|---|---|---|---|
| 20 | 整节跳过，日志 `domIds:0` | 页面题号只出现在 `id="do_<题号>"`，不读这个来源 → contentId 只能盲选 | local49 |
| 21 | 取题数与卡片数对不上 | 一个 catalog 挂多个 content-item，预加载项也是 `display:none` 的题卡 | local35/41/44 |
| 22 | `domIds:0` 时快时慢 | 接口返回 ≠ 页面渲染，读 DOM 太早（竞态） | local44（等挂载） |
| 23 | `domIds:0` 又被误杀 | 用 `getBoundingClientRect` 尺寸判可见性，虚拟滚动时真实卡片是 0×0 | local41（改判祖先 display:none） |
| 24 | 选择题答错当完成 | 判错标记只认填空 `-done-wrong`，选择题是 `radio-group-wrong` | local36/37 |
| 25 | 嵌套子题的红叉数不到 | 判错统计只扫顶层卡片 | local47 |
| 26 | 点"重做"变成点"提交" | XPath 兜底返回了 Submit 节点 | local39（校验文案） |
| 27 | 点重做无反应 | 同一按钮多份节点：`div.right-button` 里的 span 按坐标点无效，而 `rect:[0,0]` 的 antd button 原生 `click()` 有效 | local50（候选轮流试） |
| 28 | 进了作答态却判不能答 | `firstEditableControl()` 查整页，撞到别张卡的控件 | local53 |
| 29 | 明明能答却判不能答（反向） | 类名含 `disabled` 就排除；站点作答态仍保留 `ant-checkbox-wrapper-disabled` | local50/54/64 |
| 30 | 22 个 input 里 1 个 disabled 就判死整节 | 用"存在 disabled"否定整页可写 | local64（改数可用控件） |
| 31 | 问答题标准答案写不进去 | `essay_questions_answers` 不在 `AI_FILL_TYPES`，答案又被 `{"annex":[],"answer":"…"}` 包着 | local39/42/46 |
| 32 | 拿到答案却回填 0 题 | 子题卡片嵌套在组合题父卡里，顶层集合里没有 | local43/45 |
| 33 | 接口提交 200 但成绩没变 | 只验 HTTP 状态，没验服务端是否记录 | local56（提交后回查） |
| 34 | 多选只勾上 1 个 | 按**下标**点选项，卡片里有 12 个选项元素而答案只有 9 个 → 下标错位 | local63（按 uuid 匹配） |
| 35 | 点多选"勾上了又变没" | `clickSeq` 同步触发 v-model → Vue 重建整组选项，手里 input 变成脱离文档的死节点 | local65（点击→等重建→重取节点→置位→验证） |

### 判据速查（排错顺序）

```
1. 等待题卡挂载 {ms, cards, domIds}        ms=-1 → 选择器对不上这页；domIds 应 > 0
2. contentId 经 DOM 打分命中 {cid, score}   score 与 domIds 相等才算准
3. 题目对账 {domIds, apiIds, overlap}      overlap < domIds → 接口没覆盖全部卡片
4. 作答态探测 {inCard, inPage, enabled*}   enabledTotal>0 即可写
5. 多选回填 {wantN, checkedMatched}        checkedMatched 必须等于 wantN
6. 提交后回查 {st, domWrong, domRight}     st=1 或 domRight>0 才算成功
```

### 站点前端契约（实测，bundle `src-CpDRg9di.js`）

```js
// 站点自己的提交（UnitExercisePreview.vue 编译产物）
de(exercise)         // 是否有作答
fe(list, answerMap)  // 展平组合题 → [{questionId, userAnswer}]
payload = { catalogId, contentId, questionItemList: fe(o.value, new Map(l.value.map(e=>[e.questionId, e.userAnswer]))) }
```

- 客户端会先做门禁：`请完成所有习题后再提交（已完成 X 题，未完成 Y 题）`——**这句是前端拦的，不是服务端**
- 服务端 `answerStatus`：`1` = 已判对，`2` = 判错，`-1` = 主观题不判分（但仍可能下发标准答案）

---

## 七、已知边界（2026-11-16 实测，不再投入）

| 题型 | 状态 | 说明 |
|---|---|---|
| 填空 / 单行判断 / 单选 / 多选 / 问答题 | ✅ 可用 | 已实测判对（`st:1`） |
| `judge_advanced`（多行对错，n 个 topic × 2 选项） | ⚠️ 只能取反一次 | 正确率 1/2ⁿ；穷举 2ⁿ 次提交太慢太吵，**已停用**（`BRUTE_JUDGE_ENABLED = false`）。这类题建议手工 |
| 拖拽题（type 10/11） | ❌ 未适配 | 已加结构诊断 `拖拽结构 {...}` 与占位投放，但实测无效；站点疑似用指针拖拽而非 HTML5 DnD。**暂不投入** |
| 语音题（口语/跟读/角色扮演） | ❌ 不可解 | 走第三方实时评测，必须真人录音，脚本留空跳过 |
| 被锁提交的节 | ⚠️ 需手工 | 表现为提交返回 200 但 `st` 不变；脚本会 `本节需手工` 并跳过 |

### 当前推荐用法

1. 「开始刷课」让脚本跑，能答的题型都会自动做对
2. 遇到 `judge_advanced` / 拖拽 / 语音题，脚本跳过，手工补
3. 判断某节是否真的做对，看日志 `提交后回查 [{st:…}]`：`st:1` 才算成
