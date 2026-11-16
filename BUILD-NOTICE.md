# 本仓库说明（与上游的差异）

本仓库 fork 自 [WASD258-jpg/tsh-auto-brush](https://github.com/WASD258-jpg/tsh-auto-brush)（GPL-3.0）。

## 一句话

**`tsh-auto-brush.user.js` 是唯一真相，不要跑构建脚本。**

## 为什么

上游的产物是由 `test/build-dual.js` 从 `engines/legacy-engine.user.js` + `engines/new-engine.user.js`
构建出来的。本仓库的产物**不是**这份构建结果，而是在 v2.3.0 产物上逐条打补丁得到的
`2.3.1-local73`，含 **35 处针对线上站点实测的修复**（明细见 `CHANGELOG-local.md`）。

这些修复**只存在于产物里**，`engines/` 仍是上游原样。所以：

```
node test/build-dual.js            → 被拦住，退出码 1
node test/build-dual.js --force    → 会覆盖产物，35 处修复全部丢失
```

构建脚本已内置拦截，并在写入前打印警告。`--force` 只在你确实决定放弃补丁时才用。

## 已修与未修

| 题型 | 状态 |
|---|---|
| 填空 / 单选 / 多选 / 单行判断 / 问答 | ✅ 实测判对（`answerStatus: 1`） |
| `judge_advanced`（多行对错） | ⚠️ 只能取反一次，正确率 1/2ⁿ；穷举已停用 |
| 拖拽题 | ❌ 未适配（站点疑为指针拖拽） |
| 语音题（口语/跟读/角色扮演） | ❌ 需真人录音，跳过 |
| 被锁提交的节 | ⚠️ 提交返回 200 但状态不变 → 标记「需手工」后跳过 |

判断某题到底做对没有，看日志里的 `提交后回查 [{st:…}]`：`st:1` 才算成。

## 目录

```
tsh-auto-brush.user.js        手工维护的产物（2.3.1-local73）—— 唯一真相
CHANGELOG-local.md            35 条修复的现象/根因/版本 + 判据速查 + 站点契约
docs/部署文档.md              可交给 AI 执行的部署流程
docs/elt-log-shim.user.js     日志采集器（回传本机，不联网外发）
docs/logsrv.py                本机日志接收器，仅绑 127.0.0.1
engines/                      上游原版引擎（原样，未含本地修复）
test/                         上游测试与构建脚本（构建已被拦截）
```

## 跟上游同步的正确姿势

**不要** `git merge upstream/main` 后直接构建——产物会被重新生成。

推荐：

1. `git fetch upstream && git log upstream/main --oneline` 看上游改了什么
2. 若上游只是改 `engines/`，用 `git diff` 看差异，**手工**把有价值的改动搬进产物
3. 搬完 `node --check tsh-auto-brush.user.js` 自检，再 commit

如果哪天决定回到「源码维护」，就把产物里的 35 处修复分批回移到
`engines/new-engine.user.js`，每批一个 commit，之后才能恢复构建流程。
