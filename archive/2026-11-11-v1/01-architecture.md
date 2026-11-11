# 01 · 架构总览与决策记录

| 项 | 值 |
|---|---|
| 状态 | 设计稿，未实施 |
| 日期 | 2026-11-11 |
| 适用 | `mem_new` 重构设计；原仓库 `mem` 只读 |
| 关联 | [02 数据模型](02-data-model.md) · [03 源文件规范](03-source-documents.md) · [04 一致性](04-consistency.md) |

## 1. 为什么要改

现有系统能回答「哪天学了多久、哪卷做了多少题、正确率多少」，但答不好「这道题我做过几次、每次错在哪一步」「某个错因跨卷复发了几次、销账没销账」「同一方法为什么一场之内一成一败」。原因不是没有数据，而是**最有价值的推演过程与错因分析只存在于 Markdown 正文里**，`index.json` 只抽了 14 个错因标签和 12 条 `errorNote`，跨题归纳（如「第 2、3 题是同一个毛病的两张脸」）完全沉在自由文本中，无法查询、无法聚合。

第二个动机是录入方式：现在依赖 agent 读写 Markdown + 手工 `git push`，希望通过 API 录入题目、试卷、答题记录，并支持多端。

## 2. 现状架构

```text
本地 Markdown（唯一真源）
  ├─ data/volumes.json          手写：卷元数据、知识树、逐题考点
  ├─ paper.md / answer*.md     题干、作答、批改、总结
  └─ scripts/build_index.py    957 行，按卷硬编码解析
          ↓
     data/index.json           自动生成（勿手改），328 题 / 40 场 / 317 作答
          ↓ git push
服务器 /www/mem 每 5 分钟 pull
          ↓
     myWebsite 静态构建 → nginx → geyuqi.me/study/
```

站点还读取 **git 提交历史** 计算提交活动、连续天数与热力图（`scripts/build/lib/aggregate.mjs`）。原卷 PDF 与草稿照片约 100 MB，被 `.gitignore` 排除，只留本地。

`mem/doc/question-bank.md` §1.3 曾把「不引入 SQLite / 任何运行时数据库」列为非目标，理由是二进制、不能 `git diff`、agent 不能直接读。

## 3. 目标架构

```text
① 文件系统 · 唯一可写的真源
   Markdown，每份带稳定 file_id；git 提供版本 / diff / blame / 回滚
        │ 读文件，算 sha256
        ▼
② 数据库 · 只读派生层
   documents 注册表 + questions / sessions / attempts
   + reasoning_blocks（块定位，含跨题归纳）/ diagnoses（含待重做状态）
   + overrides / validation_reports / snapshots（实际建表清单见 [02](02-data-model.md) §1.1）
   每条派生记录带 file_id + source_sha256 + parser_version
        │ 导出
        ▼
③ 导出视图 · 可丢弃重建
   index.json（带 snapshot_id）/ 只读 .md / 站点静态页
```

数据库从「存储系统」变成「**索引与关系系统**」。这与原仓库「Markdown 是唯一真源、索引是自动生成的导航层」的哲学一致，只是把导航层从一份 JSON 升级为数据库 + API。

改动面因此从「重写整条流水线」缩小为「换掉索引层」：站点构建、git 部署、`AGENTS.md` 的 agent 工作流基本不动。

## 4. 关键决策

### ADR-01 · Markdown 文件保留为唯一可写的真源

- **决策**：文件是唯一允许人 / agent 写入的地方；数据库派生表只读。
- **理由**：单人 + agent 驱动 + 以 Markdown 创作为核心。文件自带 `git diff` / blame / 回滚 / 离线可读 / agent 直接编辑，且 LaTeX 与长推演本来就该写在 md 里。
- **否决**：把 `raw_md` 全文搬进数据库、文件降级为自动导出的只读视图。那样为了消除「双真源」扔掉了五个真实好处，且 `content_md` 的 diff / 回滚要自己实现。
- **影响**：一致性改由「只有一处能写 + hash 绑定 + 可重放」保证，见 [04](04-consistency.md)。

### ADR-02 · 引入稳定 `file_id`，与路径解耦

- **决策**：ULID 作为文件身份；`documents.current_path` 只是定位提示。
- **理由**：站点现在按路径判定场次，重命名 `answer` 文件就会被当成新场次；路径当主键会让所有回链随目录调整断裂。
- **否决**：路径作主键；题目 ID 兼作文件 ID（一份文件含多题）。
- **影响**：改名 / 移动只更新 `current_path`；所有派生记录的 `source_file_id` 不变。落地方式见 ADR-10。

### ADR-03 · 数据库不复制全文

- **决策**：`reasoning_blocks` 只存 `file_id + anchor + kind + seq + 语义标签`，全文按需回读文件；`diagnoses` 的 `root_cause` / `correction_rule` 等抽取出的**短字段**仍入库（否则无法查询与建复发链）。
- **理由**：避免同一段推演在文件与库里各存一份，从根上消除内容漂移。
- **否决**：`reasoning_blocks.content_md` 复制全文；只存摘要而把全文留在外部文件（都是双份内容）。
- **影响**：全文检索若需要，加一个从文件灌入、可随时重建的 FTS 索引，仍不算第二份真源。

### ADR-04 · 引入运行时数据库（与原 §1.3 的关系）

- **决策**：引入数据库，但**只放派生的结构化数据**，不放原文。
- **理由**：§1.3 的三条理由（二进制、不能 diff、agent 不能直读）约束的是**原文**；原文留在 git 后这三条依然成立，数据库里放的是可丢弃重建的派生层，因此不是简单推翻，而是分层后各自归位。
- **同时推翻**：§1.3 的「不做在线编辑 / CMS」中的 API 录入部分——但 P0–P3 不做录入 UI 与账号系统，只提供 API，范围不放大。
- **保留**：不手写索引、不把题干搬进索引、不改写题目原文、不重排题号、不做组卷产品。

### ADR-05 · 站点继续读导出的 `index.json`

- **决策**：新增 `GET /api/export/index.json` 产出同格式文件，站点构建逻辑不改；导出物带 `snapshot_id`。
- **理由**：站点是纯静态、构建期读文件、无后端进程。直连数据库要引入运行时依赖，收益不抵风险。
- **否决**：站点改读数据库 / API 实时渲染。
- **影响**：`deploy.sh` 增加 snapshot 校验闸门，见 [04](04-consistency.md) §6。

### ADR-06 · SQLite + WAL 起步

- **决策**：单文件 SQLite，服务端与站点同栈（Node + `better-sqlite3`）或沿用 Python（FastAPI + SQLAlchemy）均可；SQL 尽量写标准方言，避免锁死。
- **理由**：328 题 / 317 作答 / 单用户 / 单机，PostgreSQL 属于为架构而非为规模；SQLite 零运维、单文件备份、可随 git 副本一起恢复。
- **否决**：一上来部署 PostgreSQL。
- **影响**：若未来要多用户并发写或复杂全文检索，再迁移；DDL 用关联表而非数组类型，降低迁移成本。

### ADR-07 · 推演过程按「可寻址块 + 结构化诊断」建模

- **决策**：推演原文切成有稳定定位的块（`my_work` / `correct_solution` / `error_step` / `contrast` / `insight` / `correction_pair` / `summary_review`），错因另建 `diagnoses`（标签、根因、订正规则、待重做状态、销账）；**只建 2 张表**——跨题归纳并入 `reasoning_blocks` 的 `kind=insight|contrast`，复发次数 `JOIN attempts` 按 `(question_id, date)` 计算，都不另建表。
- **理由**：推演有稳定骨架但血肉是 LaTeX 和自然语言，拆成「步骤 / 变量 / 公式」细粒度表会丢语义且让录入变成地狱；而错因是可结构化事实 + 跨题关系，正是数据库比 Markdown 强的地方。
- **否决**：整段塞进一个 `content` 大字段（等于没搬）；全量拆成关系字段；按概念名词拆出 `insights` / `redo_items` 等低频独立表（见 [02](02-data-model.md) §2.4）。
- **影响**：解析协议见 [03](03-source-documents.md)，表结构见 [02](02-data-model.md)。

### ADR-08 · 人工覆写隔离到 `overrides`

- **决策**：`SUBSTANTIVE_OK`（利润 3 算对填错）、形式逻辑卷二 `answerOverrides`（E→C）、Q25 题干修订等人工判断进 `overrides(reason, verified_by)`，优先级高于解析器，自动重算永不覆盖。
- **理由**：这些是「独立复算后的人的判断」，不是解析错误；自动重算一旦盖掉，历史结论会被静默改写。
- **影响**：校验时先应用 overrides 再比对期望值。

### ADR-09 · 二进制不入库

- **决策**：约 100 MB 的真题 PDF / 草稿扫描 / HEIC 继续留本地或进对象存储；库里只存 key + hash + 时间，且为可选项。
- **理由**：不可变、不参与解析事务、体积远大于文本。
- **影响**：库里不建 `assets` 表（空表无意义，见 [02](02-data-model.md) §1.2），真上云时再加；「图片里的批改结论必须写进 Markdown」的原约定继续有效。

### ADR-10 · `file_id` 两阶段落地，当前不写原仓库

- **决策**：目标形态是文件 front-matter 带 `id:`；但**过渡期 `file_id` 只存在于 `documents` 注册表**，由确定性规则从路径派生，原文件一个字节不动。给文件补 `id:` 属于切换动作，需用户单独授权，且只对新项目的数据副本执行。
- **理由**：兼顾「文件带唯一 id」的设计目标与「不破坏原数据」的硬约束。
- **影响**：原型阶段允许把样本复制进 `mem_new/fixtures/` 跑 `add_ids.py`；原仓库保持只读归档。阶段划分见 [06](06-migration-plan.md)。

## 5. 非目标（本阶段不做）

- 不做录入 UI / CMS / 账号与权限系统；只提供 API 与校验。
- 不改站点页面、不改 `myWebsite` 构建逻辑（只加 snapshot 校验）。
- 不把题干搬进数据库、不改写题目原文、不重排题号。
- 不做组卷产品、不做面向多用户的并发写。
- 不迁移二进制资产上云（除非第 4 节待拍板第 4 项确认）。
- 不在 P0–P3 修改原仓库任何文件。

## 6. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 站点「提交活动 / 连续天数 / 热力图」依赖 git 提交历史，API 录入后不再产生 commit | 首页与周报静默失真 | 服务端写文件 + 自动 commit 保留历史；重建事件落在 `snapshots`，见 [02](02-data-model.md) §1.2 |
| 文件写入与 DB 重建跨两个系统，无法单事务 | 短暂滞后 | 最终一致 + 显式滞后状态 + hash 校验 + 可重放，见 [04](04-consistency.md) |
| 多端同时写文件导致 git 冲突 | 录入失败或覆盖 | 服务端单点写 + fast-forward 失败即拒绝并要求 rebase；或推迟多端 |
| 解析器升级后历史派生与新规则不一致 | 统计口径漂移 | `parser_version` + 全量重建 + 双跑对账 |
| 人工判断被自动重算覆盖 | 历史结论被改写 | `overrides` 隔离，见 ADR-08 |
| 规范化过程洗掉原始写法（合并题号、中文简称、答案单元格说明） | 回链与复核失效 | 原始字符串与规范化值双列保存，见 [03](03-source-documents.md) §6 |

## 7. 待定事项

更新机制已在 [07-update-mechanism.md](07-update-mechanism.md) 定稿。其余见 [README](../README.md)「待拍板」五项，其中数据库选型与站点消费方式会影响 [05-api.md](05-api.md) 的实现细节，但不影响本文件的数据分层结论。
