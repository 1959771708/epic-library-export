# Epic 库存导出

一个油猴（Tampermonkey）脚本，导出 Epic Games 账号的**真实游戏库存**，输出 JSON / CSV 给任意第三方工具（如小黑盒小程序）导入。

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
3. 点开面板 → 「开始导出」→ 等待进度条走完（约 426 个游戏耗时 30 秒左右，状态行右侧有实时秒数）。
4. 点「下载 JSON」或「下载 CSV」。

导出过程中共发起约 435 个请求：1 次换令牌、6 次读库、1 次读权益、426 次查游戏名（24 并发）。

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

- `name` —— 真实游戏名，由 `catalogItemId` 查 catalog 接口解析得到。库里的 `sandboxName` 经常是代号（实测 426 个里有 247 个是 `Live`、20 个是 `* Production`），直接用会得到一堆同名条目。
- `namespace` —— **稳定主键**，同一游戏的多平台 / 多条目共享它。跨设备、跨脚本对账请用它。
- `platforms` —— 该游戏入库到的平台集合，取值 `Windows` / `Win32` / `Mac` / `Android` / `iOS`。
- `acquiredAt` —— 最早一次入库时间（ISO 8601，UTC）。
- `recordCount` —— 该 namespace 在库里占几条记录（同一游戏多平台会 > 1）。
- `entitled` —— 是否在 `entitlement-public-service` 里能查到 `ACTIVE` 权益。正常账号全部为 `true`。
- `resolved` —— 游戏名是否从 catalog 成功解析。为 `false` 时 `name` 回落到 `sandboxName` 或 namespace，实测正常账号为 0。

### CSV

9 列，UTF-8 带 BOM（Excel 直接打开不乱码），CRLF 换行，按游戏名排序：

```
gameName,platforms,acquiredAt,namespace,catalogItemId,productId,sandboxName,inLibraryRecords,entitled
```

`platforms` 用 `|` 分隔（如 `Mac|Windows`），避免与逗号冲突。含逗号的游戏名按 RFC 4180 用双引号包裹。

## 实现要点

脚本顺序做四件事，每一步都在前面的响应里取下一跳需要的参数：

1. **取授权码** —— `GET https://www.epicgames.com/id/api/redirect?clientId=…&responseType=code`。本站同源，所以用原生 `fetch(…, {credentials:'include'})` 直接拿，靠浏览器已有 cookie。未登录时接口返回 `authorizationCode: null`，脚本据此提示先登录。
2. **换令牌** —— `POST account-public-service-prod03…/account/api/oauth/token`，`grant_type=authorization_code` + `token_type=eg1`，Basic 认证用公开的 EGS 启动器客户端凭据（与 legendary 等项目同一组，非私人密钥）。**授权码一次性，每次导出都重新取。**
3. **读库存与权益** —— `library-service…/library/api/public/items`（翻页游标是 base64 的 `{"offset":N}`，可按步长派生并发拉取，实测 6 页 532 条 0 重复）与 `entitlement-public-service…/entitlements`（`count=1000` 一次取全 559 条）。
4. **解析游戏名** —— `catalog-public-service…/catalog/api/shared/namespace/{ns}/bulk/items?id={catalogItemId}`，24 并发。**必须用 `catalogItemId` 查，用 `productId` 会返回 `{}`**（这个坑实测过）。

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

在 426 款游戏的账号上跑完整流程：

| 项目 | 结果 |
|---|---|
| 总耗时 | 约 30 秒（28.9–33.8 秒，随网络波动） |
| 请求数 | 435（令牌 1 / 库 6 / 权益 1 / catalog 426） |
| 导出游戏数 | 426 |
| 库记录数 | 532（6 页，0 重复） |
| 权益记录数 | 559（单次 `count=1000` 取全） |
| 解析失败 | 0 |
| `name` 回落到 namespace | 0 |
| `entitled: false` | 0 |
| 与独立脚本结果比对 | namespace 集合完全一致（缺失 0 / 多出 0） |
| CSV 列数异常行 | 0 |

提速前后对比（同一账号、同一网络）：

| 阶段 | 优化前 | 优化后 |
|---|---|---|
| 解析游戏名 | 约 25 秒（6 并发） | 约 7 秒（24 并发） |
| 读取游戏库 | 约 18 秒（6 页串行） | 约 5 秒（按 offset 并发） |
| 读取权益 | 约 12 秒（2 页串行） | 约 9 秒（单页取全） |
| 合计 | 47.6 秒 | 约 30 秒 |

## 许可

MIT
