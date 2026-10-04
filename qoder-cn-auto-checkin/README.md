# qoder-cn-auto-checkin —— Qoder CN 每日领取 Credits 自动化

> 仿照 [workbuddy-auto-signin](../workbuddy-auto-signin) / [trae-cn-auto-checkin](../trae-cn-auto-checkin) 的思路：**不走 UI，复用本机客户端登录态，直接调用官方 API**。零第三方依赖（Node.js >= 18 + Windows 自带 PowerShell），幂等安全，token 永不落日志。

## 一、背景

Qoder CN（阿里 AI IDE）启动时弹出的"**专属活动权益，立即查查收 ✨ / 每日领 100 credits**"弹窗，本质是 app 内嵌的远程活动页（`https://openapi.qoder.com.cn/growth-page/activity-iframe`，托管在 Alicdn）。每天手动点太繁琐，本项目把它变成每天自动领取。

## 二、逆向结论（Qoder CN 0.3.3）

### 2.1 领取接口（sash campaigns）

弹窗页面（g.alicdn.com 上的 JS）桌面端走相对路径直连 `openapi`，请求头由 app 通过 webRequest 拦截注入（`registerSurface` + `authorize`，见 `app.asar` 的 `nativeCampaignRequestService`）：

| 接口 | 说明 |
|---|---|
| `GET {openapi}/sash/api/v1/me/campaigns` | 活动列表：`campaigns[].{campaignId, actionType, claimStatus, benefit}` |
| `POST {openapi}/sash/api/v1/me/campaigns/{campaignId}/claim` | 领取；响应 `{status:"CLAIMED", replayed:false, benefit:{amount:100,...}}` |

- `openapi` = `https://openapi.qoder.com.cn`（来自 `~/.qoder-cn/.cache/endpoint-cache.json`）
- 每日签到即列表里 `actionType=CLAIM_BENEFIT && claimStatus=CLAIMABLE && benefit.kind=CREDITS` 的活动
- 请求头：`Authorization: Bearer <token>` + **`Cosy-ClientType: 10`** + `Accept: application/json` + `User-Agent: Qoder`，外加**设备身份头**（与官方 webRequest 注入一致）：`Cosy-MachineOS: x86_64_win32`、`Cosy-MachineHostname`、`Cosy-MachineId`（`~/.qoder-cn/.auth/machine_id`）、`Cosy-Version`，以及 `Cosy-MachineToken/Code/Type`——三者由客户端自带的风控程序 `resources\umid\runtime-info.exe <prod> --account-stdin`（stdin 喂 `{"account":<uid>}`）实时生成，脚本会自动调用
- 幂等：服务端 `replayed` 防重放，重复 claim 不会重复发放；`claimStatus` 为准

### 2.2 登录态存储与解密

凭据在 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`，**标准 Chromium v10 信封**（比 Trae 的自定义信封简单）：

```text
文件 = "v10" ‖ 12B nonce ‖ AES-256-GCM 密文 ‖ 16B auth tag
密钥 = Local State 的 os_crypt.encrypted_key（"DPAPI" 前缀 + DPAPI 块）
       → Windows DPAPI CryptUnprotectData(CurrentUser) → 32 字节 AES key
```

解出的 JSON 含 `token`（`dt-` 开头不透明 token，约 16 天有效）、`refreshToken`、`expiresAt`、`user`。脚本用 PowerShell（`System.Security.ProtectedData`）做 DPAPI、`node:crypto` 做 AES-GCM，无第三方依赖。

### 2.3 token 生命周期与失效自动恢复

**脚本不做网络续期**，但也不需要人工介入：token 约半个月有效，Qoder CN 启动时会自动刷新并回写 auth.v1.dat。

**auto/silent 模式下若 token 已过期**（连续两周多没开过 Qoder 的情形），脚本会自动执行：

```text
检测到过期 → 启动 Qoder CN（若未在运行）→ 轮询凭据文件等待续期（最长 3 分钟）
→ 续期成功 → 关闭自己拉起的 Qoder（先优雅后强制，绝不碰用户自己开的实例）→ 继续领取
→ 续期失败 → 保留客户端窗口，报告需要重新登录
```

效果：只要开机（计划任务登录触发器），十几分钟内自动恢复，无需任何手动操作。相关配置：

| 环境变量 | 作用 |
|---|---|
| `QODERCN_EXE` | Qoder CN 可执行文件路径（默认自动探测 LOCALAPPDATA/Program Files） |
| `QODERCN_KEEP_APP` | `1` = 续期后不关闭客户端（默认关闭） |

## 三、使用

```bash
node checkin.mjs            # auto：列出活动，领取所有可领的（默认）
node checkin.mjs status     # 只读查看活动与领取状态
node checkin.mjs doctor     # 离线自检（node/凭据/解密/过期时间）
node checkin.mjs silent     # 同 auto，结果写 checkin.log（计划任务用）
```

输出一行 JSON（`report` 是人话；`needs_attention: true` 表示需要人工处理）：

```json
{"result":"SUCCESS","report":"领取成功：100 Credits"}
{"result":"ALREADY","report":"今日无可领取的活动（已领完或暂无活动）"}
```

| result | 含义 |
|---|---|
| `SUCCESS` | 领取成功（多个活动全部领到） |
| `ALREADY` | 今日无可领取活动 |
| `PARTIAL` | 多活动中部分领取失败 |
| `AUTH_EXPIRED` | token 过期，打开一次 Qoder CN 自动续期 |
| `AUTH_REJECTED` | 服务端 401/403，需重新登录 |
| `NO_AUTH / DECRYPT_FAILED / RUNTIME_UNAVAILABLE` | 本地凭据/DPAPI 问题 |
| `NETWORK` | 网络不可达（自动退避重试后仍失败，等下次） |

环境变量：`QODERCN_AUTH_FILE`、`QODERCN_LOCAL_STATE`、`QODERCN_OPENAPI_BASE`、`QODERCN_CHECKIN_LOG`。

## 四、每日自动（Windows 计划任务）

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

注册任务 `QoderCnAutoCheckin`，三个触发器：每天 **00:10** + **每 2 小时补跑**（当天的 Credits 活动往往上午才发布，00:10 常查不到，靠补跑轮询领到）+ 每次登录补跑，`StartWhenAvailable` 错过自动补。`wscript + checkin-silent.vbs` 零闪窗，日志 `checkin.log`（本地时间，UTF-8）。

卸载：`powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1`。

> 移动项目目录或更换 node 位置后重跑 install（VBS 里烘焙了绝对路径）。与 Trae CN 任务错开 5 分钟（00:05/00:10），互不干扰。

## 五、验证记录

| 日期 | 验证项 | 结果 |
|---|---|---|
| 10-03 | auth.v1.dat 解密（DPAPI + AES-256-GCM）/ campaigns 列表 | ✅ |
| 10-03 | **真实领取** | ✅ `POST .../claim` → `{status:"CLAIMED", benefit:{amount:100}}`，当日 100 Credits 到账 |
| 10-04 | 事故：开机补跑领取 401 TOKEN_INVALID | 双因：脚本 claim 传参 bug（把 auth 对象当 token）+ 补齐官方设备身份头（runtime-info.exe）后修复，当日 Credits 已领 |
| 10-04 | doctor / status / auto / silent、计划任务端到端 | ✅ LastTaskResult=0 |

## 六、已知限制

1. **活动是运营配置的**：如果哪天没有 CLAIMABLE 活动，返回 ALREADY 属正常；接口/信封随版本变化时，`doctor` 可定位问题层（解密失败→重逆向；401→重新登录）。
2. DPAPI 与用户绑定：脚本换用户/换机器运行会 `DECRYPT_FAILED`，属预期（凭据只在本机本用户下可解）。
3. 非官方个人自动化工具，接口系从客户端逆向，仅供自己账号使用。
