# trae-cn-auto-checkin —— Trae CN 每日签到自动化（API 直连版）

> 仿照 [workbuddy-auto-signin](../workbuddy-auto-signin) 的思路：**不走 UI，复用本机客户端登录态，直接调用官方签到 HTTP 接口**。零第三方依赖（Node.js >= 18），幂等安全，token 永不落日志。

## 一、背景

前作 [trae-daily-checkin](../trae-daily-checkin) 用 CDP 控制 Trae 桌面端点"签到"按钮。Trae CN 升级到 1.107.x 后按钮类名变化，UI 自动化失效（2026-10-03 实测：`未找到每日签到按钮，可能类名已变化`）。

WorkBuddy 项目证明了更稳的路子：客户端再怎么改 UI，底层的**登录凭据文件 + HTTP 接口**不会变。本项目把这条路套到 Trae CN 上。

## 二、逆向结论（Trae CN 1.107.1）

### 2.1 签到接口

渲染进程里的签到按钮只是发 IPC，真正请求由主进程发出（`resources\app\out\main.js`，代码未打包可直接读）：

| 接口 | 说明 |
|---|---|
| `POST {host}/trae/api/v2/ug/checkin_credits/status` | 查状态：`{enable, checked_in, credits, extra_credits}` |
| `POST {host}/trae/api/v2/ug/checkin_credits/claim` | 领取，body `{req_source: 1}`（1=Trae IDE，2=SOLO） |

- `host` = `https://api.trae.cn`（存在凭据 JSON 的 `host` 字段，不写死）
- 请求头：`Content-Type: application/json` + **`Authorization: Cloud-IDE-JWT <token>`**（注意不是 Bearer）+ **`x-device-id`**（必须）+ `x-user-id` + `X-User-Region: CN`
- **`x-device-id` 必须是服务端签发的真实设备号**：从 storage.json 的键名 `iCubeAuthInfo://icube-dc:<id>` 取。错误代价：缺失 → 9004（参数错误）；假的/服务端不认的值 → **9074**（文案误导性地写成"当前参与用户太多"）。实测 machineid 文件、telemetry.machineId 等"看起来合法"的本地 ID 全部 9074，换 icube-dc 设备号后第一次调用即成功
- 幂等性：`checked_in` 为准；已签状态下重复 claim 服务端返回业务码 9004，不会重复发积分 → status 失败重试、claim 网络错误重试 1 次都是安全的
- 门槛：仅 `account.scope === "marscode"`（CN 个人版账号）开放签到

### 2.2 登录态存储与解密

凭据在 `%APPDATA%\Trae CN\User\globalStorage\storage.json`，键 `iCubeAuthInfo://icube.cloudide`，值为自定义信封（逆向自 `out\main.js` 的 `RUe/Moe/PUe` 函数族）：

```text
base64( magic "tc\x05\x10\x00\x00" ‖ 32B 密钥材料 ‖ AES-128-CBC 密文 )
密钥派生：SHA512( SHA512(密钥材料) ‖ Q⊕Z ) 的前 16 字节为 key、后 16 字节为 iv
       （Q、Z 为代码内两组 64 字节常量，见 checkin.mjs）
明文 = 64 字节 SHA512 校验头 ‖ UserInfo JSON
```

解出的 `UserInfo` 含 `token`（JWT，约 14 天有效）、`refreshToken`、`expiredAt`、`host`、`account`。

### 2.3 token 生命周期与失效自动恢复

**脚本不做网络续期**，但也不需要人工介入：token 14 天有效，Trae CN 每次启动/唤醒会自动刷新并回写 storage.json。

**auto/silent 模式下若 token 已过期**（连续两周多没开过 Trae 的情形），脚本会自动执行：

```text
检测到过期 → 启动 Trae CN（若未在运行）→ 轮询凭据文件等待续期（最长 3 分钟）
→ 续期成功 → 关闭自己拉起的 Trae（先优雅后强制，绝不碰用户自己开的实例）→ 继续签到
→ 续期失败 → 保留客户端窗口，报告需要重新登录
```

效果：只要开机（计划任务登录触发器），十几分钟内自动恢复，无需任何手动操作。相关配置：

| 环境变量 | 作用 |
|---|---|
| `TRAECN_EXE` | Trae CN 可执行文件路径（默认自动探测 LOCALAPPDATA/Program Files） |
| `TRAECN_KEEP_APP` | `1` = 续期后不关闭客户端（默认关闭） |

## 三、使用

```bash
node checkin.mjs            # auto：查状态，未签才领（默认）
node checkin.mjs status     # 只读查状态
node checkin.mjs claim      # 幂等领取
node checkin.mjs doctor     # 离线自检（node 版本/凭据/过期时间）
node checkin.mjs silent     # 同 auto，结果写 checkin.log（计划任务用）
```

输出一行 JSON，`report` 是人话，`needs_attention: true` 表示需要人工处理：

```json
{"result":"SUCCESS","report":"签到成功，今日积分 +100"}
{"result":"ALREADY","report":"今日已签过（今日积分 100）"}
```

| result | 含义 |
|---|---|
| `SUCCESS` | 本次真实领取成功 |
| `ALREADY` | 今日已签，无需操作 |
| `SERVER_BUSY` | 领取返回 9074：多为设备号未被服务端认可（偶发限流），等下一次自动运行 |
| `INACTIVE` | 签到活动未开启（服务端 `enable:false`） |
| `AUTH_EXPIRED` | token 过期，打开一次 Trae CN 自动续期 |
| `NO_AUTH / NO_SESSION / DECRYPT_FAILED` | 本地凭据问题（未登录过/文件损坏） |
| `UNSUPPORTED_SCOPE` | 非 marscode 账号 |
| `NETWORK` | 网络不可达（自动退避重试后仍失败，等下次） |
| `CLAIM_REJECTED` | 服务端拒绝领取且状态未变，需人工看 |

环境变量：`TRAECN_STORAGE_FILE`（凭据路径）、`TRAECN_CHECKIN_LOG`（日志路径）、`TRAECN_REQ_SOURCE`（默认 1）。

## 四、每日自动（Windows 计划任务）

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

注册任务 `TraeCnAutoCheckin`，三个触发器：

- **每天 00:05** 签到（服务端按北京时间切日）
- **每 2 小时补跑**：9074/网络失败等活动日内自愈，已签时只是一次只读查询
- **每次用户登录补跑** + `StartWhenAvailable`：错过 00:05（关机/睡眠）后开机自动补签

经 `wscript + checkin-silent.vbs` 零闪窗运行，日志追加到 `checkin.log`（**本地时间**，UTF-8；用 `Get-Content -Encoding UTF8` 或 VS Code 查看）。

卸载：`powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1`（只删任务，不动凭据与日志）。

> 移动项目目录或更换 node 安装位置后，重跑一次 install（VBS 里烘焙了绝对路径）。

## 五、验证记录

| 日期 | 验证项 | 结果 |
|---|---|---|
| 10-03 | 解密 storage.json 凭据 | ✅ 校验头匹配，UserInfo 字段齐全 |
| 10-03 | status 接口 / claim 幂等性 | ✅ 已签状态下重复领被拒（9004），积分不重复 |
| 10-03 | doctor / status / auto / silent、计划任务端到端 | ✅ LastTaskResult=0 |
| 10-04 | **事故：00:05 自动签到失败（9004）** | 根因：请求缺 `x-device-id`；补上后发现本地 ID 均不被认（9074） |
| 10-04 | **修复：改用 `iCubeAuthInfo://icube-dc:<id>` 设备号** + `x-user-id` + `X-User-Region` | ✅ 当日 100 积分补领成功（`code:0, checked_in:true`），doctor 新增设备号检查 |

## 六、已知限制

1. **接口/信封格式可能随版本变化**：Trae CN 更新后若失效，先用 `node checkin.mjs doctor` 定位（解密失败→重逆向信封；网络正常但 401→看鉴权头）。代码入口 `resources\app\out\main.js` 未打包，可继续逆向。
2. **node 路径烘焙在 VBS 里**：换 node 位置需重跑 install。
3. 脚本只做"每日签到领积分"这一件事；状态里的 `extra_credits`（额外领取）不在范围内。
4. 与 WorkBuddy 同理：这是非官方个人自动化工具，接口系从客户端逆向，仅供自己账号使用。
