# ai-ide-auto-checkin

三个 AI 编程工具的**每日签到/积分领取自动化**合集。共同思路：不走 UI，复用本机桌面客户端写下的登录态，直接调用客户端官方使用的 HTTP 接口；系统计划任务定时静默运行；幂等安全，token 过期时自动拉起客户端续期后继续。

| 子项目 | 客户端 | 领取内容 | 实现要点 |
|---|---|---|---|
| [workbuddy-auto-signin](./workbuddy-auto-signin) | WorkBuddy（腾讯） | 每日签到积分 | Python 标准库单文件，读桌面端凭据直连接口 |
| [trae-cn-auto-checkin](./trae-cn-auto-checkin) | Trae CN（字节跳动） | 每日签到 100 积分 | Node 零依赖，解 Trae 自有信封加密的登录态 |
| [qoder-cn-auto-checkin](./qoder-cn-auto-checkin) | Qoder CN（阿里） | 每日领 100 Credits | Node 零依赖，DPAPI + AES-GCM 解 Chromium v10 凭据 |

每个子目录都有独立 README（原理、逆向记录、安装与卸载方式、排错表）。

## 快速开始（Windows）

```powershell
# 任选你使用的客户端对应目录：
cd trae-cn-auto-checkin   # 或 qoder-cn-auto-checkin / workbuddy-auto-signin
node checkin.mjs          # 或 python signin.py auto（WorkBuddy）
# 手动跑通后一键注册每日计划任务：
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

前置条件：对应客户端已在本机**登录过**（脚本只读取本机登录态，不含也不需要任何密码）；Trae/Qoder 两项需要 Node.js >= 18，WorkBuddy 需要 Python 3。

## token 失效自动恢复

访问 token 约两周有效，正常使用客户端时会被自动续期。若长期未打开客户端导致过期，脚本（auto/silent 模式）会**自动启动对应客户端 → 等待其续期 → 关闭 → 继续签到**，无需人工介入；仅在 refreshToken 也失效（约半年完全未登录）时才需要重新扫码登录。

## 致谢与许可

- **[workbuddy-auto-signin](https://github.com/88lin/workbuddy-auto-signin)** 由 [88lin](https://github.com/88lin) 开发并以 [MIT License](./workbuddy-auto-signin/LICENSE) 开源，本仓库的 `workbuddy-auto-signin/` 目录为其完整副本（未修改），其版权与许可声明保留在该目录内。本仓库的另外两个项目（trae-cn-auto-checkin、qoder-cn-auto-checkin）在**设计思路上参考**了该项目——"复用本机登录态 + 直连官方接口 + 系统计划任务"的模式，代码为独立实现，未使用其源码。
- 其余部分（`trae-cn-auto-checkin/`、`qoder-cn-auto-checkin/` 及本 README）以 [MIT License](./LICENSE) 开源。

## 免责声明

> 本仓库为**非官方**个人自动化工具集，与腾讯、字节跳动、阿里及上述各产品无任何隶属关系。签到/领取接口系对各客户端本地文件的逆向分析所得，可能随时变动且不另行通知。仅建议用于领取自己账号的每日权益，请遵守相关服务条款，使用风险自负。
