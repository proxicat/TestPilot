# 给网站绑数据 + 过站点校验 + 登录态：业内调研 & TestPilot 集成设计

面向三个诉求：
1. **用例数据**：批量导入 key-value，**支持数组**（数据驱动 / 参数化）。
2. **固定参数**：在**请求头 / query string / cookie** 等处注入固定参数，用于**过自己站点的校验**（自动化标识、灰度开关、鉴权 token、绕过机器人检测等）。
3. **登录态**：用户如何配置登录 —— 直接给 cookie，还是先跑一个登录用例？

---

## 一、业内是怎么做的

### 1. 测试数据 / 变量
| 工具 | 做法 |
|---|---|
| **Playwright** | 无内置"变量库"，靠 `.env` + `process.env` + fixtures；**数据驱动**用 `for (const row of dataset) test(...)`（参数化，一行数据一个用例）。数据集来自 JSON/CSV。 |
| **Cypress** | `Cypress.env()` + `cypress.env.json`；`cy.fixture('users.json')` 加载数据集；`describe` 里循环做参数化。 |
| **Postman** | **Environments**（键值变量集合）+ **Collection Runner + Data File**（CSV/JSON，一行一次迭代）。这是"批量导入 key-value + 数组"的标准范式。 |
| **k6 / JMeter** | `SharedArray` / CSV Data Set —— 数据行数组，VU 按行取数。 |

**结论**：业内标准 = **命名变量集（环境）** + **`${VAR}` 插值** + **数据集数组（一行一次迭代）**。TestPilot 已有环境变量 + `${env.KEY}` 插值，缺"批量导入"和"数组/数据驱动"。

### 2. 过站点校验（请求头 / query / cookie 注入）
| 工具 | 做法 |
|---|---|
| **Playwright** | `use: { extraHTTPHeaders: { 'X-Test': '1', Authorization: 'Bearer …' } }`（context 级，所有请求都带）；`page.route()` 拦截改 query/body；`context.addCookies([...])`。 |
| **Cypress** | `cy.intercept()` 改请求头/query；`Cypress.config('baseUrl')` + `cy.setCookie()`。 |
| **Selenium** | 靠 CDP `Network.setExtraHTTPHeaders` 或代理（BrowserMob）。 |

**典型用途**：`X-Automation: true` 让后端放行风控 / 跳过验证码；灰度开关 `?feature=x`；预置 `Authorization` 头做 API 式鉴权；固定 cookie 标识测试流量。

**结论**：标准 = **context 级 extraHTTPHeaders + cookies**，query 用**导航 URL 追加**或请求拦截。Puppeteer 对应 API：`page.setExtraHTTPHeaders()`、`page.setCookie()`、URL 追加。

### 3. 登录态（核心）
| 方案 | 代表 | 说明 | 取舍 |
|---|---|---|---|
| **A. storageState 复用（登录一次，缓存复用）** | Playwright `storageState`、Cypress `cy.session` | 全局 setup 里 UI 登录一次 → 保存 cookies + localStorage → 每个用例注入、**跳过登录**。 | ✅ 业内**首选**：快、稳、只维护一处。首次仍需真实登录一次。 |
| **B. 直接贴 cookie / storageState** | 手动导出浏览器 cookie / storageState JSON | 用户已在别处登录，直接把 session 贴进来。 | ✅ 最快，无需跑登录；❌ 会过期、要手动更新。 |
| **C. API 式登录** | POST 账密拿 token → 塞 cookie/header | 跳过 UI，直接打登录接口。 | ✅ 最快最稳；❌ 要知道登录接口细节，非纯 UI。 |
| **D. 每个用例都 UI 登录** | 朴素做法 | 每条用例前重跑登录步骤。 | ❌ 慢、脆、账号可能被风控。TestPilot 现状。 |

**结论**：**A（登录一次 → 缓存 storageState → 复用并跳过登录）是业内最佳实践**，B/C 作为补充。TestPilot 现状是 D（`login.authRequired + steps`，每次都跑）。

---

## 二、TestPilot 集成设计（把最佳实践落到现有模型）

数据都挂在**环境（Environment）**上（已有 `baseUrl / vars / login`），扩展为：

```ts
interface Environment {
  baseUrl: string;
  vars: Record<string, string | string[]>;   // ← 值可为数组（数据驱动/多值）
  headers: Record<string, string>;            // ← 新增：固定请求头（可含 ${secret.KEY}）
  query: Record<string, string>;              // ← 新增：固定 query 参数
  login: {
    authRequired?: boolean;
    steps?: string[];
    session?: StorageState | null;            // ← 新增：缓存的登录态（cookies+localStorage）
    capturedAt?: string;
  };
}
type StorageState = { cookies: Cookie[]; origins: { origin: string; localStorage: {name:string;value:string}[] }[] };
```

### ① 数据：批量导入 + 数组
- **批量导入**：粘贴 `key=value`（每行一条）或 JSON 对象 → 一次 upsert 到 `vars`。数组用 JSON：`terms: ["a","b","c"]`。
- **插值扩展**：`${env.KEY}` 字符串照旧；数组 → `${env.KEY.0}` 取第 N 个（本期）。**"一行数据一个用例"的完整数据驱动**作为下一步（改执行模型，单列）。

### ② 过校验：headers + query（+ cookie）
- 环境上配 `headers` / `query`（键值表，支持 `${env.KEY}` / `${secret.KEY}` 插值，日志脱敏）。
- 在**所有 launchSession**（运行 / 调试 / 探索）里应用：
  - `page.setExtraHTTPHeaders(resolvedHeaders)`
  - query 追加到导航 URL
- 用途直给：`X-Automation-Test: true`、`?e2e=1`、`Authorization: Bearer ${secret.TOKEN}`。

### ③ 登录态：storageState 捕获-复用（方案 A）+ 手贴（方案 B）
- **捕获**：新端点 `POST /environments/:id/capture-session` —— 启浏览器 → 跑 `login.steps`（用 env/secret 注入账密）→ 读 `cookies + localStorage` → 存到 `login.session`。
- **复用**：运行/调试时若 `session` 存在 → 注入 cookies+localStorage、**跳过登录步骤**（快）；无 session → 回退跑登录步骤（现状 D）。
- **手贴**：允许粘贴 storageState JSON / cookie 直接写入 `session`。
- **失效**：`capturedAt` 展示，一键清除重新捕获。

### 导出对齐
`export.ts` 把 `headers → use.extraHTTPHeaders`、`query`、`session → .auth/state.json + storageState` 写进导出的 Playwright 工程，保证"平台里配的 = 导出后能跑"。

---

## 三、本期落地范围（MVP）
1. ✅ 数据批量导入（JSON/行）+ 数组值（`${env.KEY.N}` 索引引用）。
2. ✅ headers + query 固定参数注入（全 session 生效，脱敏）。
3. ✅ 登录态：storageState **捕获→复用→跳过登录** + 手贴 + 清除。
4. ✅ 导出对齐。

**下一步（本期不做，已标注）**：完整数据驱动（一行数据自动展开成一条用例并批量跑）、API 式登录（方案 C）、query 的请求拦截（本期用 URL 追加，覆盖入口导航）。
