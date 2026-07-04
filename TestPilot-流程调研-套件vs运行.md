# TestPilot 流程调研:Project → Explore → 用例 → 套件 → 运行

> 目的:(1) 厘清 项目→探索→测试用例→套件→运行 这条流水线每一环的职责;(2) 回答「**套件(Suite)和运行(Runs)是不是重复了**」;(3) 给出从头测试系统前的数据清理方案。
> 方法:对照**目标流水线**与**当前代码实现**(端点 / 数据表 / 页面),而非凭印象。

---

## 0. 结论速览(TL;DR)

- **套件 ≠ 运行,职责根本不同**,不是重复:
  - **套件(Suite)= 编排 + CI 门禁 + 批次汇总** —— "把一组用例跑一遍,给一个 pass/fail 门禁"。
  - **运行(Runs)= 单次执行的取证明细** —— "这一次跑,Midscene 报告 / oracle / 性能 / 视觉 / 日志 / 截图 长什么样"。
- 但当前实现有 **3 个真实断点**,让两者"看起来割裂/重复":
  1. **Runs 是全局的,不按项目作用域**(其他页面都是项目作用域)→ 切项目 Runs 列表不变,直觉上会怀疑"和套件重复"。
  2. **批次↔运行的链接只存在于数据层**(`batch_runs.runId`),**UI 没连通** —— 在套件里点某条用例,进不去它那一次运行的完整报告。
  3. **单跑的 run 和套件产生的 run 混在同一个 Runs 列表**,没有"来自哪个批次"的归属标记。
- 修掉这 3 点,套件与运行的分工就清晰了(见 §4)。

---

## 1. 目标流水线(每一环应该干什么)

```
Projects → Explore → Test cases → Suite → Runs → Trends
  被测目标    AI 规划    用例资产      批量门禁   单次取证   趋势
```

| 环节 | 一句话职责 | 产物 |
|---|---|---|
| **Projects** | 定义"测谁"(被测站点/应用)+ 环境/密钥 | project、environment、secret |
| **Explore** | AI 看页面 → 规划出带方法论的用例(P0/P1/P2、功能/负面/边界/e2e) | 一批 test_cases(草案) |
| **Test cases** | 用例资产管理:编辑/精修(问 AI)/生成代码/**单跑**/**可视化调试** | 成熟的 test_cases |
| **Suite** | 把一组用例(P0/all)**批量跑**,过 CI 门禁(pass/fail),自愈+隔离 | 一个 batch + N 次 run |
| **Runs** | 看**每一次执行**的深度取证(报告/oracle/性能/视觉/日志/截图) | —(消费 run) |
| **Trends** | 通过率/抖动率/MTTR/覆盖率**随时间**的聚合 | —(消费 run + batch) |

关键点:**Suite 是"入口/触发/门禁",Runs 是"出口/明细/取证"。** 一次套件运行会**产生**多条 run 记录,这些 run 记录正是 Runs 页要展示的对象 —— 两者是**生产者/消费者**关系,不是并列的重复。

---

## 2. 当前实现对比(逐环,对照代码)

| 环节 | 端点 | 数据 | 页面 | 作用域 | 现状 |
|---|---|---|---|---|---|
| Projects | `GET/POST /api/projects` | `projects` | Projects | — | ✅ |
| Explore | `POST /api/projects/:id/explore` | 写 `test_cases` | Explore | 项目 | ✅ 方法论提示词已验证 |
| Test cases | cases CRUD · `/run` · `/refine` · `/debug`(SSE) · `/generate-code` | `test_cases` | CasesBoard | 项目 | ✅ 单跑/调试/问AI 齐全 |
| **Suite** | `POST /api/projects/:id/suite` · `GET /api/projects/:id/batches` | `batches` + `batch_runs` | Suite | **项目** | ✅ 门禁/自愈/隔离 |
| **Runs** | `GET /api/runs`(**无 projectId 过滤**) | `runs` | RunReport | **全局** ⚠️ | ⚠️ 见 §3 |
| Trends | `GET /api/projects/:id/trends` | 聚合 `runs`+`batches`+`flakiness` | Trends | 项目 | ✅ |

当前数据量(用于清理参考):**13 projects / 88 test_cases / 45 runs / 6 batches / 18 batch_runs / 12 flakiness / 41 baselines / 12 perf_baselines / 5 environments / 3 secrets** + `artifacts/`(截图/报告/diff) + `midscene_run/`(缓存/报告)。

---

## 3. 「套件 vs 运行」深度对比(核心问题)

### 3.1 各自定位(不重复)

| 维度 | 套件 Suite | 运行 Runs |
|---|---|---|
| 回答的问题 | "这组用例整体过不过?能不能合并/发布?" | "**这一次**到底跑成什么样?为什么挂?" |
| 粒度 | 批次(N 条用例的聚合) | 单次执行(1 条 run 记录) |
| 核心产出 | **门禁 pass/fail** + 统计(passed/failed/healed/flaky/quarantined) | **Midscene 报告 + oracle + 性能 + 视觉基线 + 日志 + 截图** |
| 触发者 | 用户/CI(Run suite) | 由套件、或单跑各自产生 |
| 类比 | CI 的"一次 pipeline 运行 + 红绿灯" | 单个 test 的"详细报告页" |

**结论:不重复。** 套件是**编排层/门禁**,运行是**取证层/明细**;套件**生产** run,运行**消费** run。删掉任一个都会丢功能(没套件=没门禁/批量;没运行=没深度定位)。

### 3.2 数据关系(链路是通的,只是 UI 没接上)

```
batches (1) ──< batch_runs (N)  ──1:1──  runs
  gate/统计        status/attempts/healed     报告/oracle/性能/视觉/日志/截图
                   └── runId ─────────────────┘   ← 链接已存在于数据层!
```
`batch_runs.runId` 已经指向具体 run 记录 —— **数据模型是对的**,但**前端没利用**这个链接。

### 3.3 真实断点(为什么"看起来重复/割裂")

1. **Runs 全局,非项目作用域。** `GET /api/runs` 不接受 projectId,返回所有项目最近 200 条;`store.loadData()` 一次性 `getRuns()`。→ 你在项目 A 切到项目 B,Runs 列表不变,直觉上会觉得"它和项目/套件对不上、是不是多余的"。**这是最大的认知混乱来源。**
2. **套件条目进不去运行明细。** Suite 页展示 batch_runs(标题+状态+attempts),但**点它不会打开那一次 run 的 RunReport 抽屉**,尽管 `runId` 就在手边。→ 门禁看到"某条挂了",却要自己跑去 Runs 页大海捞针找那条 run。
3. **单跑 run 与套件 run 混列,无批次归属。** Runs 列表把"手动单跑"和"套件里跑的"混在一起,没有"来自套件 X / 单跑"的标记 → 更强化了"套件和运行是不是重复"的错觉。

---

## 4. 建议(让分工一眼清晰,低成本)

按性价比排序:

1. **Runs 按项目作用域**(P1,最该做)。`GET /api/runs?projectId=` + 前端 `selectProject` 时重载 → 和 Cases/Suite/Trends 一致。消除最大认知混乱。
2. **套件条目 → 点击打开该次运行的 RunReport 抽屉**(复用现成 `runId` + 现成 Drawer)。把"门禁→明细"一键打通,套件与运行从"两个孤岛"变成"总览→下钻"。
3. **Runs 行标注来源**:`单跑` / `套件·<label>` 徽章(数据已有:batch_runs 反查)。可选:Runs 页支持"按批次筛选/分组"。
4. **(可选)概念澄清**:导航/文案上强调 **Suite=触发+门禁**、**Runs=取证明细**、**Trends=趋势**,三者是"总览 / 明细 / 时间线"三视图,不是并列功能。

> 一句话:**套件和运行不是重复,而是"没连起来"。** 补上 §3.3 的 3 个断点(尤其 #1、#2),它们就从"看似重复"变成"总览↔下钻"的自然搭档。

---

## 5. 数据清理方案(为从头测试系统铺垫)

**目标**:清空所有业务数据,回到"全新系统"状态,但保留 schema 与配置。

**清空(business data)**:
- 表:`projects` · `test_cases` · `runs` · `batches` · `batch_runs` · `flakiness` · `baselines` · `perf_baselines` · `environments` · `secrets`
- 目录:`.data/artifacts/`(reports / baselines / current / diff 下的文件)· `midscene_run/`(cache / report / dump / log)

**保留(config, 不动)**:
- 表结构(schema)—— 只清行,不 drop
- 模型配置:`.env`(OPENAI_BASE_URL / 模型名等)
- `.wallets/`(种子、RPC key)、`.data/secret.key`(密钥库主密钥,清了也无妨,因为 secrets 表一并清空)
- 代码 / seed 逻辑

**顺序**:先输出本文档(✅ 当前),再执行清理脚本 → 得到干净库,可从"新建项目 → Explore → 用例 → 套件 → 运行 → 趋势"完整走一遍。

---

*生成:TestPilot 流程调研 · 对照当前实现 · 待清理数据快照见 §2。*
