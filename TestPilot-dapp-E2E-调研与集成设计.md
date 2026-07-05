# dapp E2E 怎么做:业内调研 + 集成到 TestPilot 的设计

**前提(用户定的原则)**:不能绕过 UI。用户就是和 UI 交互;UI 上的操作最终反映为**钱包里多一条交易记录**。所以 E2E 必须:真实驱动 dapp UI → 交互在链上真实发生 → 断言落到"钱包/链上的最终结果"。

---

## 一、dapp E2E 的三个硬骨头

1. **钱包弹窗**:dapp 点了"连接 / Swap"后,钱包(MetaMask)弹窗要人点"确认"。这是 dapp E2E 最难自动化、也最脆的一环 —— 而且弹窗**不是 dapp 本身的 UI**,是钱包扩展的 UI。
2. **链上状态可见性**:dapp UI 要能读到钱包所在链的余额/状态。多数 dapp 走注入的 provider(`eth_call`)读;少数(如 Uniswap 生产版)走自家后端网关读 —— 后者在 fork 上看不到。
3. **UI 驱动可靠性**:能不能稳定地在真实 dapp 界面上找到并操作元素(输入金额、选代币、点 Swap)。

---

## 二、业内怎么做(主流框架 + 两条路线)

| 方案 | 钱包 | 弹窗处理 | 特点 |
|---|---|---|---|
| **Synpress**(事实标准)| 真 MetaMask 扩展 | 内置命令自动点弹窗(`confirmMetamaskTransaction` / `acceptMetamaskAccess`),缓存钱包 setup | 最真实(测真实弹窗 UX);重、headed、较慢、偶尔脆 |
| **Dappwright**(Playwright)| 真 MetaMask 扩展 | `wallet.approve()` / `wallet.confirmTransaction()` 编程式点弹窗 | Playwright 原生,比 Synpress 轻 |
| **注入式 / mock provider**(越来越主流,Synpress 也出了 wallet-mock)| 注入 EIP-1193/6963 provider,受控私钥 | **无弹窗** —— 连接/签名/交易在页面内**自动确认** | headless、确定性、快;dapp UI 全程真实驱动,只把"钱包弹窗"这步自动化掉 |
| **链** | 都跑在 **fork**(Anvil/Hardhat/Tenderly)或 **testnet**(Sepolia),钱包在链上有资金 |

**关键共识**:业内早已从"真扩展 + 点弹窗"转向"**注入式 provider 自动确认**" —— 因为弹窗自动化又脆又慢,而且弹窗是钱包的 UI、不是被测 dapp 的 UI。**注入式并不算"绕过 UI"**:dapp 自己的界面(连接按钮、金额输入、Swap 按钮)全程是真实点的,只是钱包确认这一步自动放行。

---

## 三、TestPilot 现状对标(其实已经站在主流路线上)

| 能力 | TestPilot 现状 | 对标 |
|---|---|---|
| 注入式钱包(EIP-1193/6963 + fork 代理 + 受控私钥,自动确认)| ✅ `injectedWallet.ts` + `web3Mode=injected` | = Dappwright/Synpress 的 wallet-mock 路线 |
| 真 MetaMask 扩展 + 弹窗自动批准 | ⚠️ 扩展能加载,`startPopupApprover` 脚手架在脚本里有,**但没接进用例运行管线** | = Synpress/Dappwright 主线,未打通 |
| 链上断言(余额)| ✅ `chainAssertions`(余额 增/减/变化)| 对标"验证钱包结果" |
| **捕获本次交互发出的交易(hash/receipt)** | ❌ 注入 provider 已经 `signs+sends` 拿到 hash,但**没上报给 run** | ← **最大缺口** |
| UI 驱动 | ✅ Midscene aiAction 驱真实 UI;❌ 自建 Qwen 驱不动 Uniswap 这种密集 UI | = 模型能力轴 |

---

## 四、关键洞察(回应"钱包多一条记录")

用户说的最终真值 = **这次 UI 交互让钱包多了一条成功交易**。这比"看 dapp 自己弹的成功提示"更硬,应该做成**一等断言**:

> 断言:本次运行中,受控钱包**发出了 ≥1 笔交易,且已上链成功**(receipt.status=1),from = 测试钱包。

我们的注入 provider 在 `eth_sendTransaction` 里已经 `wallet.sendTransaction()` 拿到了 `sent.hash` —— 只要把这些 hash 收集起来上报给 run,运行结束查 receipt,就能断言"钱包多了一条成功记录"。**全程没绕过 UI**:交易是用户在 dapp UI 上点出来的,provider 只是把钱包确认自动放行,并记账。

同时它把"UI 驱动可靠性"和"结果断言"解耦了:即使 dapp 成功 UI 模型读不准,只要交易真发出去并上链,**钱包结果断言就能给出确定性判定**。

---

## 五、集成方案(按优先级)

### P0 —— 交易记录捕获 + 「钱包结果」断言(核心,最高价值)
- 注入 provider 记录本次 run 内所有 `eth_sendTransaction` 的 hash(`page.exposeFunction` 回传 / 共享数组)。
- run 结束:对每个 hash 查 `eth_getTransactionReceipt` → 收集 { hash, status, blockNumber, from }。
- 新断言类型 `txSubmitted`:参数 `count>=N`(默认 1)、`status=success`、可选 `to=合约地址`。并入 oracle。
- 前端:用例的链上断言编辑器加一项「钱包发出成功交易」;run 详情展示交易 hash + 区块 + 状态(= 钱包记录)。
- **意义**:真·through-UI + 真·钱包结果,且不依赖模型读 dapp 成功 UI。

### P1 —— 真 MetaMask 弹窗模式接进运行管线
- `web3Mode=metamask` 时,run 启动 `startPopupApprover`(已有),自动点 MetaMask 的 连接/签名/交易 弹窗。
- 给"必须测真实弹窗 UX"的团队用;比注入式更真实但更脆、headed。

### P2 —— 更多链上断言
- `nonce/txCount 增加`、事件日志(某 event 触发)、`allowance` 授权额度、ERC-721 owner。

### 模型轴(平台之外)
- 自建 Qwen 驱不动 Uniswap 密集 UI 是**模型能力**问题,不是设计缺陷 —— 简单 dapp(/testdapp)能驱动。
- 提升手段:接更强视觉模型;Midscene plan 缓存(跑一次存计划,回归复用);把复杂步骤拆细。
- Uniswap 生产版"UI 读后端"是它自己的架构 → 用 **testnet**(后端有数据)或**自部署**;大多数 dapp 读 provider,fork 就行。

---

## 六、结论
- **不绕过 UI**:注入式自动确认钱包弹窗 ≠ 绕过 dapp UI,这正是业内主流(Synpress-mock / Dappwright)。dapp 自己的界面全程真实驱动。
- **最该补的一块 = 捕获并断言"钱包新增的成功交易"(P0)** —— 这是用户交互的最终真值,且把结果判定从脆弱的 UI 断言里解耦出来。
- 真 MetaMask 弹窗模式(P1)作为"更真实"的可选档。
- UI 驱动成功率是模型轴,靠换模型 / 缓存 / 拆步骤提升,平台设计已到位。
