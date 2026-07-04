# TestPilot — web app (interactive mockup)

AI E2E 测试平台的可视化前端。给定网站 → AI 规划带 P0/P1 优先级的用例 → 生成可运行代码 → 可视化管理。当前为**可交互 mockup**：数据在内存，AI 探索/运行/连通检测均为模拟，接口已按真实数据结构（`src/lib/types.ts`）设计，替换 store action 里的模拟逻辑为真实 API 即可。

## 技术栈（构建全部为 Rust 内核）

| 层 | 选型 | 说明 |
|---|---|---|
| 构建/打包 | **Rsbuild**（Rspack, Rust） | 与 Midscene 同为字节 web-infra-dev 出品；生产构建 ~0.3s |
| 转译 | **SWC**（Rust） | 随 Rsbuild 内置，替代 Babel |
| 框架 | React 18 + TypeScript | 类型检查仍用 tsc（Rust 无成熟 TS 类型检查器） |
| 路由 | react-router-dom v6 | hash 路由 |
| 状态 | Zustand | 跨页共享用例/运行/模型状态 |
| 样式 | Tailwind v3 + shadcn 语义 token | 自带暗色模式 |
| 图标 | lucide-react | |

> 关于"TypeScript 的 Rust 版本"：语言本身没有；官方原生编译器（TS 7）是 **Go** 写的。Rust 的是**工具链**——SWC/Oxc（转译）、Rspack/Rolldown（打包）、Biome（lint）。本项目构建/转译已全部在 Rust 上。

## 运行

```bash
pnpm install
pnpm dev        # http://localhost:5300
pnpm build      # 生产构建 → dist/（Rspack, Rust）
pnpm typecheck  # tsc --noEmit
```

## 页面与真实交互

| 路由 | 页面 | 交互 |
|---|---|---|
| `/cases` | 用例看板 | 点卡片选中、下拉改 P0/P1/P2、Generate/Regenerate 代码、Run（模拟通过/失败并写运行记录）、Run all P0 |
| `/explore` | AI 探索 | Start explore：流式日志 + 逐条发现流程并写入用例（跨页可见）|
| `/model` | 模型配置 | 绑定自建 VL endpoint，Test connection 做**多模态检测**（非 VL 家族会红色告警），实时生成 Midscene 环境变量 |
| `/runs` | 运行报告 | 汇总指标、All/Passed/Failed 筛选、master-detail（步骤日志 + 截图占位）|
| `/projects` | 项目列表 | 进入项目 |

## 目录

```
src/
  lib/       types.ts · store.ts(Zustand+模拟AI) · mockData.ts · cn.ts
  components/ Sidebar · TopBar · Layout · ui.tsx(Button/Badge/Pill)
  pages/     CasesBoard · Explore · ModelConfig · RunReport · Projects
  App.tsx    路由
```

## 真实 Midscene 后端（已接）

后端在 [`server/`](server/)（Node + TS + Midscene + Puppeteer），见 [server/README.md](server/README.md)。

```bash
# 终端 1：前端
pnpm dev                    # :5300

# 终端 2：真实执行后端
cd server && pnpm install && pnpm dev   # :5301
```

前端 [`src/lib/api.ts`](src/lib/api.ts) 调用后端；[`src/lib/store.ts`](src/lib/store.ts) 的每个 AI action **在后端离线时自动回退到内置模拟**，所以 UI 可独立运行。启动 `server/` 即切换为真实执行：
- `testConnection` → 真发一张图探测**多模态**（项目头号风险的验证点）
- `startExplore` → Midscene `aiQuery` 让 VL 模型规划流程
- `runCase` → Midscene 无头 Chrome 逐步执行 + 每步真实截图
- `generateCode` → LLM 生成可运行 Midscene 代码

运行真实执行需：你的 VL 模型在 `:8000` 服务中 + Puppeteer 可用的 Chrome。

## dapp 自动化测试 + 链/RPC 配置

**Model config 页**新增 **Chain / RPC** 卡片(读写后端 `GET/POST /api/config`)——配置注入式虚拟钱包连的链:本地 Anvil fork、Tenderly 虚拟测试网、公共测试网,一改即切。见 [server/README.md](server/README.md) 的 "General capability: injected wallet"。

- `POST /api/run` 传 `{ "provider":"injected", "rpcUrl"?, "chainId"? }` → 无头、无 MetaMask,注入钱包自动完成 connect/签名/发交易,Midscene(你的 VL 模型)驱动 dapp UI。
- `POST /api/dapp/verify` → 免模型的能力自检(注入钱包→连接→真实交易→验回执)。
