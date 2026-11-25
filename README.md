# Epic 库存导出

一个油猴（Tampermonkey）脚本，导出 Epic Games 账号的**真实游戏库存**，输出 JSON 给任意第三方工具（如小黑盒小程序）导入。

## 一键安装

装好 [Tampermonkey](https://www.tampermonkey.net/)（Edge 商店 ID `iikmkjmpaadaobahmlepeloendndfphd`）之后，点下面这个链接，浏览器会弹出 Tampermonkey 的安装确认页，点「安装」即可：

### 👉 [点此安装 Epic 库存导出](https://raw.githubusercontent.com/1959771708/epic-library-export/main/epic-library-export.user.js)

安装完成后脚本会**自动检查并接收更新**，无需手动重新安装。

## 自动更新

脚本头部内置了两条指令，都指向本仓库的 raw 地址：

```
@updateURL    https://raw.githubusercontent.com/1959771708/epic-library-export/main/epic-library-export.user.js
@downloadURL  https://raw.githubusercontent.com/1959771708/epic-library-export/main/epic-library-export.user.js
```

工作方式：

- Tampermonkey 会按自己的周期（默认每天一次）去拉 `@updateURL`，比对里面的 `@version` 是否比本地高。
- 发现有新版本时，脚本列表里会出现更新标记，Tampermonkey 自动下载 `@downloadURL` 指向的新文件并替换。
- 想立刻检查：打开 Tampermonkey 面板 → 已安装脚本 → 「检查用户脚本更新」。
- 更新只覆盖代码，不改你的导出结果，也不会重置任何设置。

所以只要仓库里 `epic-library-export.user.js` 的 `@version` 递增并推到 `main` 分支，所有已安装的用户下次检查时就会自动升级。

## 为什么需要它

Epic 商店**没有**自己的库导出功能：`store.epicgames.com/library` 这条路径最终返回 **404**（实测整条重定向链：301 → 302 → 302 → login → callback → 404），不存在可抓的同源库接口。

更关键的是口径问题 —— **交易流水（订单）和库存（library）是两套不同的数据**：

| 口径 | 数量 |
|---|---|
| 真库存（`library-service` 的 namespace） | **426** |
| 交易流水（`ajaxGetOrderHistory` 的 namespace） | 361 |
| 两者交集 | 355 |
| **只在库存里、账单完全没有** | **71** |
| 只在账单里（DLC / 皮肤 / 货币包） | 6 |

Epic 有一大批游戏是通过**促销、捆绑包、Prime、兑换码**直接发放权益的，根本不产生订单。按游戏名归一化后，**只看订单流水会漏掉 67 款**，其中包含 DEATHLOOP、RAGE 2、Ghostwire Tokyo、Farming Simulator 19、Elite Dangerous、High On Life、Tales from the Borderlands、Trine 系列等。

这 71 个 namespace **全部**能在 `entitlement-public-service` 里查到 `ACTIVE` 权益记录 —— 数据一直都在，只是不在订单里。

本脚本查的是 `library-service`，所以能拿到完整库存。

## 使用

1. 先在 <https://www.epicgames.com/> 登录 Epic 账号（登录态是唯一前提，脚本不接触你的密码）。
2. 保持在该站点任意页面，右下角会出现蓝色「Epic 库存导出」按钮。
3. 点开面板 → 「开始导出」→ 等待进度条走完（状态行右侧有实时秒数）。
4. 点「下载 JSON」。

导出过程中的请求数取决于 GraphQL 是否可用：**GraphQL 可用时共 9 个**（1 次取授权码、1 次换令牌、1 次读库、6 次读权益，其中只有 7 个走油猴通道）；**GraphQL 不可用时读库与标题回退到油猴通道，请求数会增加到 30 个**（读库 7 + 标题 15）。回退不影响导出结果。

## 运行环境要求

脚本依赖 Tampermonkey 的两套跨域请求接口之一。**必须是完整版 Tampermonkey**（Chrome / Edge / Firefox 扩展商店版本，或手机端支持扩展的浏览器）：

| 接口 | 说明 |
| --- | --- |
| `GM.xmlHttpRequest` | GM4 API，较新版本的 Tampermonkey 提供，脚本优先使用 |
| `GM_xmlhttpRequest` | 旧版 API，脚本作为后备 |

**不支持的运行环境**：存在一些「油猴」的残缺实现——只有旧接口，甚至回调里给的响应对象连 `status` 字段都没有。这类环境下导出会失败，面板会显示：

> ✗ 失败：没拿到 HTTP 响应（响应对象里没有 status）· … · 脚本管理器可能不是完整版 Tampermonkey

这**与 Epic 账号、登录状态、网络无关**，换一个提供完整 Tampermonkey 的浏览器即可。具体是哪个环境缺失，用下面的自检按钮当场确认，不要靠猜。

### 环境自检

面板底部有「环境自检」按钮，点一下会打印：管理器名称与版本、两套 GM 接口是否可用、以及一次真实请求返回对象的字段清单。导出一旦因环境问题失败，面板会自动跑一次，无需开控制台——手机上也能直接看到结论。

若自检显示「管理器：读不到 GM_info」且「GM.xmlHttpRequest（GM4）：不可用」，就是缺完整 Tampermonkey，装一个即可。

## 输出格式

### JSON

```json
{
  "schemaVersion": 1,
  "source": "epic-library-service",
  "generatedAt": "2026-11-23T11:04:30.316Z",
  "account": { "accountId": "…", "displayName": "…" },
  "summary": {
    "gameCount": 426,
    "recordCount": 532,
    "entitlementCount": 559,
    "unresolvedCount": 0,
    "firstAcquiredAt": "2022-07-08T04:23:15.563Z",
    "lastAcquiredAt": "2026-11-19T15:36:30.316Z"
  },
  "games": [
    {
      "name": "DEATHLOOP",
      "namespace": "7dee3ddeac7d427eb35def472be64d9c",
      "catalogItemId": "b9f16025674b4a4d93c30d666c3c9c9d",
      "productId": "524e461c5cd04677b563cc723f9da02c",
      "sandboxName": "DEATHLOOP",
      "platforms": ["Windows"],
      "acquiredAt": "2023-12-16T12:48:29.549Z",
      "recordCount": 1,
      "entitled": true,
      "resolved": true
    }
  ]
}
```

字段说明：

- `name` —— 真实游戏名，按 `en-US` 语言从 catalog 解析得到，因此**一律是英文原名**。库里的 `sandboxName` 经常是代号（实测 426 个里有 247 个是 `Live`、20 个是 `* Production`），直接用会得到一堆同名条目。实测同一批 426 个条目在 `zh-CN` 下有 44 条是中文名、43 条带 `《》`，而 `en-US` 下中文名与书名号均为 0 条，剩下 18 条非 ASCII 字符是英文原名自带的商标符号（`™` `®`）、破折号与 emoji。脚本仍保留剥书名号的兜底逻辑，但按当前目录数据不会触发。
- `namespace` —— **稳定主键**，同一游戏的多平台 / 多条目共享它。跨设备、跨脚本对账请用它。
- `platforms` —— 该游戏入库到的平台集合，取值 `Windows` / `Win32` / `Mac` / `Android` / `iOS`。
- `acquiredAt` —— 最早一次入库时间（ISO 8601，UTC）。
- `recordCount` —— 该 namespace 在库里占几条记录（同一游戏多平台会 > 1）。
- `entitled` —— 是否在 `entitlement-public-service` 里能查到 `ACTIVE` 权益。正常账号全部为 `true`。
- `resolved` —— 游戏名是否从 catalog 成功解析。为 `false` 时 `name` 回落到 `sandboxName` 或 namespace，实测正常账号为 0。

## 实现要点

脚本顺序做四件事，每一步都在前面的响应里取下一跳需要的参数。四步里只有第 2、4 步走油猴通道，第 1、3 步都在 `epicgames.com` / `store.epicgames.com` 同源内用原生 `fetch` 完成 —— 这条通道没有单请求 6~9 秒的固定开销，是这版提速的关键。

1. **取授权码** —— `GET https://www.epicgames.com/id/api/redirect?clientId=…&responseType=code`。本站同源，所以用原生 `fetch(…, {credentials:'include'})` 直接拿，靠浏览器已有 cookie。未登录时接口返回 `authorizationCode: null`，脚本据此提示先登录。
2. **换令牌** —— `POST account-public-service-prod03…/account/api/oauth/token`，`grant_type=authorization_code` + `token_type=eg1`，Basic 认证用公开的 EGS 启动器客户端凭据（与 legendary 等项目同一组，非私人密钥）。**授权码一次性，每次导出都重新取。**
3. **读库存** —— 走**商城同源 GraphQL** `POST https://store.epicgames.com/graphql`，一次请求带 12 个 `libraryItems(cursor:…)` 分页别名（`cursor` 就是 base64 的 `{"offset":N}`，`"MA=="` = 0），直接拿到全部 532 条库记录连同标题和平台。`libraryItems` 只接受 `cursor`，`limit`/`count`/`offset` 全是 Unknown argument；越界页返回空数组，所以多带几个别名不增加成本。实测一次 2.0~2.5 秒。

    **`platforms` 的来源**：`LibraryItem` 自身没有 platform 字段，但 `catalogItem(locale: "en-US") { title releaseInfo { platform } }` 里的 `releaseInfo[].platform` 就是平台数组，与 REST 库记录的 `platform` **逐条一致**（532 条 `namespace|cid|排序后平台` 的 SHA256，两侧同为 `d5f9f5cc…12df1`；426 个 namespace 的平台并集摘要两侧同为 `840b0126…19e0`）。这正是以前必须留在 REST 的原因，现已解决。

    **locale 必须写在子字段上**：`libraryItems` 不接受 `locale` 参数，要写成 `catalogItem(locale: "en-US")`，不写会退回服务端默认语言。

    这一段失败时自动退回旧的 REST 路径，见下方「兜底路径」。

4. **读权益** —— `entitlement-public-service…/entitlements`，`count=100` 分 6 页并发，共 559 条；单请求 `count=1000` 反而慢——响应 334 KB 在单连接上要下 6.5 秒。

    **这一段为什么仍在 GM 通道**：`entitled` 只能由 `entitlement-public-service` 给出。GraphQL 的 `Entitlements` 根字段存在，但字段名探不出来（试了 40 多个候选全是 `Cannot query field`），`LibraryItem` 上也没有 `entitled`。

### 同一 namespace 下可能有多个 catalogItemId

426 个 namespace 里有 38 个挂着不止一个 `catalogItemId`（典型是主游戏 + DLC / 原声 / 画册 / 壁纸，或者 iOS 与 Android 两条分平台记录），其中 26 个连标题都不同。脚本取**组内第一条**，即服务端返回的顺序。

实测这个顺序是稳定的：连续两次拉取 532 条，426 个 namespace 里 425 个的首条 `catalogItemId` 完全一致。唯一会变的是 `4ff8a9b4…`（《Faily Brakes 2》的 iOS 与 Android 两条记录，`acquisitionDate` 只差 43 毫秒），而**这两条的标题完全相同**，所以导出内容不受影响。

> 试过换成「最早获得」「cid 字典序最小」「标题最短」等确定性规则，结果都会把主游戏换成 `HD Wallpaper`、`Q.U.B.E. 2 Soundtrack`、`Football Manager 2023 Resource Archiver` 这类附加内容（8~19 个游戏会改名），所以仍用组内首条。另外 11 个组的 `acquisitionDate` 完全相同（同一批入库），「最早获得」本身也决不出唯一解。

### 兜底路径

GraphQL 不可用时，读库退回 `library-service…/library/api/public/items`（首屏 + 按固定步长 100 派生并发拉取，7 个请求），标题退回 `catalog-public-service…/catalog/api/shared/bulk/items`。后者参数是**重复的 `id=`**（逗号分隔会返回空对象），且**必须用 `catalogItemId` 查，用 `productId` 会返回 `{}`**（这个坑实测过）。

### 为什么必须是油猴 / 扩展，不能是纯网页脚本

`account-public-service`、`library-service`、`entitlement-public-service` 三个域**都不返回 `Access-Control-Allow-Origin`**（实测 GET 与 OPTIONS 均无），页面内 `fetch` 会被浏览器直接拦掉。只有 `www.epicgames.com/id/api/redirect` 带 `access-control-allow-origin: https://www.epicgames.com`。

油猴的 `GM.xmlHttpRequest` 走扩展背景页，不受同源策略约束，这是整条链路能跑通的前提。书签脚本、纯前端页面都做不到。

## 已知限制

- **只有本体，不含 DLC / 皮肤 / 货币包**。`library-service` 的 `recordType` 全是 `APPLICATION`，这是它的天然口径。想看买过哪些 DLC，得另外调 `ajaxGetOrderHistory`。
- **无法区分入库来源**。`entitlement-public-service` 没有「来自兑换码 / Prime / 促销」的字段（实测 `store` 只有 `EGS`/`None` 两种取值），所以没法标注「这游戏是怎么来的」。
- **`paymentMethod` / 金额不在本脚本范围**。本脚本导的是库存不是账单。账单口径的坑另见下节。

## 关于金额（如果你还想导账单）

Epic 的订单接口在金额上不可靠，实测结论：

- 382 笔订单里 `total`、`subtotal`、`transactions` **全部为空或 0**，`promotions` 恒等于标价之和。
- 这不是接口损坏 —— 该账号是真的全部免费领取（喜加一），标价合计 7,756.11 USD、促销抵扣同额、净支付 0.00。
- 判断依据：没有任何一笔是「打折但没全免」（`0 < promo < list` 的订单数为 0），也没有任何一笔净支付为正。
- Epic 自己的 `accounts.epicgames.com/account/transactions/purchases` 页面显示的也是 `- US$0.00`，与接口一致。

所以账单能拿到「买了什么、什么时候、订单号」，拿不到「实际付了多少钱」。

## 安全

- 脚本**不上传任何数据**。所有请求都直接发往 Epic 自己的域名，导出的文件通过 `Blob` + `URL.createObjectURL` 在本地生成。
- 不读取、不存储、不外传你的密码。全程只用浏览器里已有的登录 cookie 换一个一次性授权码。
- 授权码等价于账号完全访问权，脚本用完即弃、不落盘。
- 脚本源码是纯文本，可自行审计；`@grant` 只声明了 `GM_xmlhttpRequest` / `GM.xmlHttpRequest`，`@connect` 只放行五个 Epic 域名。

## 实测记录

以下数据来自 426 款游戏的账号，同机同网。

**v1.3.1 完整实跑结果**：

| 项目 | 结果 |
|---|---|
| 总耗时 | **14.1 秒** |
| 请求数 | 30（GraphQL 这次返回 401，读库与标题都走了油猴回退路径） |
| 导出游戏数 | 426 |
| 库记录数 | 532（回退路径，7 个油猴请求，0 重复） |
| 权益记录数 | 559（`count=100` 分 6 页并发） |
| 标题解析 | 426/426 |
| `name` 回落到 namespace | 0 |
| `entitled: false` | 0 |
| 与独立脚本结果比对 | namespace 集合完全一致（缺失 0 / 多出 0） |

分阶段耗时（v1.3.1 实跑，注意 GraphQL 被 401，所以读库走的是回退路径）：

| 阶段 | 耗时 | 通道 |
|---|---|---|
| 获取授权码 | 1.0 秒 | 同源 `fetch` |
| 换取令牌 | 1.1 秒 | 油猴 |
| 读取游戏库（532 条，7 请求，**GraphQL 401 回退**） | 3.8 秒 | 油猴 |
| 读取权益（559 条，6 请求） | 2.2 秒 | 油猴 |
| 解析游戏名（15 批，**GraphQL 不可用回退**） | 6.2 秒 | 油猴 |

> 这次 GraphQL 的 `libraryItems` 返回 `401 authentication_failed`。脚本按设计自动回退，导出结果不受影响（426/426、标题全解析）。GraphQL 可用时读库只需 1 个同源请求、约 2 秒，回退路径是 7 个油猴请求、约 4 秒，差异已经不大。

读库改走 GraphQL 的对照（在浏览器控制台里直接发同一条查询测的，与脚本内执行路径一致）：

| 项目 | REST 库接口（回退路径） | 同源 GraphQL |
|---|---|---|
| 请求数 | 7 个油猴请求 | **1 个同源请求** |
| 耗时 | 3.8 秒（回退时） | **2.0~2.5 秒** |
| 响应体积 | 6 页共 193 KB | 213 KB（含标题与平台） |
| 记录数 | 532 | 532（一致） |
| 平台摘要（532 条逐条） | `d5f9f5cc…12df1` | **同值** |
| 平台摘要（426 ns 并集） | `840b0126…19e0` | **同值** |

提速历程（同一账号、同一网络，均为当时实跑）：

| 版本 | 总耗时 | 读库 | 解析游戏名 |
|---|---|---|---|
| v1.1.0 | 203.1 秒 | 18 秒（串行翻页） | 167.0 秒（426 次逐条请求） |
| v1.2.0 | 40.4 秒 | 14.2 秒（7 个油猴请求） | 12.5 秒（批量目录接口） |
| v1.3.0 | 35.8 秒 | 19.5 秒（7 个油猴请求） | 1.5 秒（同源 GraphQL） |
| **v1.3.1** | **14.1 秒** | **3.8 秒（GraphQL 401，回退油猴）** | **6.2 秒（回退目录接口）** |

v1.1.0 → v1.3.1：**快约 14 倍**，请求数 435 → 30。读库与解析游戏名两段合计 185 秒 → 10.0 秒。

## 许可

[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)（署名 4.0 国际）。允许分发、修改、商用，唯一条件是**使用时须注明出处**（署名）。完整法律文本见仓库根目录 [LICENSE](./LICENSE)。
