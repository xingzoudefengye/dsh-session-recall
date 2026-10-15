# dsh-session-recall

给 DeepSeek Harness 补上"会话历史"的两块能力：一块是**有界史书**（纯本地折叠，零模型调用，渲染文本硬上限 6000 字符），另一块是**把 harness 自带、但出厂关闭的工作区授权历史工具按你的版本打开**。

## 为什么需要它

Harness 里其实已经有四样相近的东西，但都差一步：

| 已有 | 缺的那一步 |
|---|---|
| `dsh-session-turn-outline`：每回合 prompt + response 折叠 | 只给客户端导航，**模型永远看不到**，而且**没有容量上限**（随会话线性增长） |
| `ctx.sessionQuery` + `dsh-session-query-sqlite`：跨会话读取与全文检索 | 默认 `openAt: never`，而且只是服务层，模型调不到 |
| `@deepseek-ai/dsh-tool-session-query`：5 个模型可调用的只读历史工具 | 出厂关闭（每次请求有固定开销），且没被 CLI 收进依赖树 |
| 压缩：旧历史替换成一条 summary | 被遮蔽的内容虽在日志里，但模型不会主动回头读 |

补上的就是这两步：**一个便宜、有界、模型读得懂的史书**，以及**一条把它和上游现成工具接上的正确接线**。

## 组成

| 部分 | 是什么 | 每次请求的固定开销 |
|---|---|---|
| `session_chronicle` 工具 | 一次调用返回本会话逐回合的 状态 / 目标 / 结论 | 一个 tool schema |
| `ctx.sessionChronicle` 服务 | 同一个折叠，供其他插件消费（[dsh-compaction-local-handoff](../dsh-compaction-local-handoff) 会把它写进压缩交接） | 无 |
| `scripts/enable-read-tools.sh` | 按你 harness 的**精确版本**安装并挂载上游那 5 个历史工具 | 固定引导段 + 5 个 tool schema |

史书本身**不新增任何存储**：它是会话自己那份不可变日志的纯函数投影，冷恢复重算一遍就是同一个结果，因此没有 schema、没有迁移、没有后台任务、没有索引。

## 安装

```bash
# 1) 史书（本仓库）
dsh plugin --profile web add github:xingzoudefengye/dsh-session-recall

# 2) 可选：打开上游的 5 个历史工具
~/.dsh/profiles/web/node_modules/dsh-session-recall/scripts/enable-read-tools.sh web
```

第 2 步做的事：读出你 profile 里 `@deepseek-ai/dsh-base` 的版本 → 用它去 npm 装 `@deepseek-ai/dsh-tool-session-query` 和 `@deepseek-ai/dsh-session-query-sqlite`（**同版本，零漂移**）→ 往 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加一个隔离组（照抄上游 `dsh-experimental-session-search` bundle 的挂载方式）。脚本幂等，会先备份，只改用户自己的 patch 文件。

装完重启（`dsh web`）。

### 验证

```bash
scripts/check.sh web
```

它检查两个史书 row 是否在合成树里、以及（若已挂载）上游两个包的版本是否和 harness 一致。

自检：

```bash
node --test          # 10 个用例，纯离线
```

## 史书长什么样

模型调用 `session_chronicle`，拿到的是这样一段（真实运行输出）：

```
会话史书（本地生成，未调用模型）：3/3 条回合记录
- #1 09:02 回合完成（目标未核验）；目标：把超时改成 30 秒；回复：已改完并跑过测试
- #2 09:15 回合取消（未完成）；目标：再跑一遍全量测试
- #3 09:20 回合进行中；目标：给这次改动补个 README
（需要原文时用 session_event_search / session_event_read 按回合或 seq 定位。）
```

## 容量与规则

| 规则 | 取值 |
|---|---|
| 条目上限 | 22 条（超出先粗化，再逐层丢弃） |
| 文本上限 | 6000 字符（**渲染出来的史书**，也只有这个决定了读者会失去什么） |
| 取值上限 | 12000 字符（API 返回的对象本身，含与文本重复的 `goal`/`response` 字段；它是传输上限，不会拿读者的额度去删回合） |
| 分层 | recent 12 / earlier 6 / oldest 4，每层摘要 160 / 100 / 60 字符 |
| 压缩顺序 | 额度紧张时**先丢样板、最后才丢内容**：`回合完成（目标未核验）` → `完成`，目标最后才被截断 |
| 合并粒度 | 4 条并 1 条，摘要取首/中/尾抽样 |
| 只记录 | **真人开过的回合**（`source.kind === "user"`）。注入的上下文、工具结果、子 agent 消息都不算，也不会被当成"目标" |
| 终态 | 用 DSH 自己的 `TurnEndReason`：`completed` / `aborted` / `blocked` / `error` / `max-tokens` / `interrupted`，另加"进行中" |
| 结论 | **只有 `completed` 回合才记回复**：取消/失败的半截回复可能自称成功，不能当结论 |

安全：私钥、认证头、token/密钥/密码、邮箱、代码块都会被替换（`[已脱敏]` / `[代码省略]`）。**路径和 URL 刻意保留**——它们是编码会话真正的产物，容量已经由条目预算兜住。

## 与 ComeCode 史书的差异（有意为之）

| | ComeCode | 这里 | 原因 |
|---|---|---|---|
| 存储 | SessionStore 里一个覆盖写的 entry，定长 tuple，兼容 7 元组旧格式 | 不落盘，从不可变日志重算 | 省掉一套 schema、版本兼容和迁移；冷恢复天然一致 |
| 终态 | 成功/取消/失败/阻止 | DSH 的 6 种 `TurnEndReason` + 进行中 | 用宿主自己的词汇，不另造一套 |
| 脱敏 | 路径、URL、邮箱全部省略 | 只脱敏密钥/代码块，保留路径和 URL | 跨项目史书需要抹掉路径；本会话史书不需要，路径是有用信息 |
| 分支 | 带 `branchGeneration`，跨分支按锚点严格过滤 | 无 | DSH 的会话日志是线性的 |

它保留下来的核心设计：**纯本地零模型**、**近期细/旧层粗/容不下就丢**、**只记真人回合**、**取消的回复不算结论**、**只由工具按需读、不每轮注入**。

## 已知限制

- 史书**只覆盖本会话**。跨会话检索是上游那 5 个工具的事（`session_search` 等），本仓库不重复实现。
- 上游 5 个工具要求目标会话与调用方 **cwd 精确相等**；没有 cwd 的调用方只能看自己。
- 上游工具如需要**有界输出**，得另装 `@deepseek-ai/dsh-spill-policy`——它自己不做字节截断。
- 用**本地路径**安装（`dsh plugin add /abs/path`）时，pnpm 会软链到仓库真实路径，ESM 便找不到 `@deepseek-ai/cordis`。开发时先跑 `scripts/dev-link.sh`；正常安装请用 git 地址。
- 你装的 harness 若升级到新版，第 2 步装的三个包要跟着重跑一次（`scripts/check.sh` 会发现不一致）。**史书那部分与 harness 版本无关，升级不会失效。**

## License

MIT
