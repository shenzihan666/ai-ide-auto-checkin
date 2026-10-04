# trae-cn-auto-checkin Windows 计划任务安装脚本
# 用法：powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
#
# 注册任务 TraeCnAutoCheckin：
#   - 每天 00:05 运行一次（签到）
#   - 用户登录时补跑一次（错过后开机补签）
#   - StartWhenAvailable：错过时间点（睡眠/关机）后尽快补跑
#   - 通过 wscript + VBS 零闪窗静默运行，结果写入 checkin.log

$ErrorActionPreference = 'Stop'
$TaskName = 'TraeCnAutoCheckin'
$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script = Join-Path $ProjectDir 'checkin.mjs'
$Vbs = Join-Path $ProjectDir 'checkin-silent.vbs'

if (-not (Test-Path $Script)) { throw "找不到 $Script" }

# ---- 定位 node.exe ----
$ManualNode = ''   # 探测失败时在这里填 node.exe 完整路径
$node = $ManualNode
if (-not $node) {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
    foreach ($p in @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        "$env:USERPROFILE\scoop\apps\nodejs\current\node.exe"
    )) { if (Test-Path $p) { $node = $p; break } }
}
if (-not $node) { throw '未找到 node.exe。请安装 Node.js >= 18，或编辑本脚本顶部的 $ManualNode' }
Write-Host "[OK] node: $node ($(& $node --version))"

# ---- 生成零闪窗 VBS 启动器 ----
$vbsContent = @"
' trae-cn-auto-checkin 静默启动器（由 install-windows.ps1 生成，路径变更后请重跑安装脚本）
CreateObject("WScript.Shell").Run """$node"" ""$Script"" silent", 0, False
"@
Set-Content -Path $Vbs -Value $vbsContent -Encoding ASCII
Write-Host "[OK] VBS: $Vbs"

# ---- 注册计划任务 ----
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Vbs`""
$trigger1  = New-ScheduledTaskTrigger -Daily -At '00:05'
$trigger2  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours(2) -RepetitionInterval (New-TimeSpan -Hours 2) -RepetitionDuration (New-TimeSpan -Days 365)  # 每 2 小时补跑（服务端繁忙/网络失败自愈）
$trigger3  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger1, $trigger2, $trigger3) `
    -Settings $settings -Description 'Trae CN 每日自动签到（领积分），结果见项目目录 checkin.log' | Out-Null

$info = Get-ScheduledTask -TaskName $TaskName
$next = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
Write-Host "[OK] 任务 `$TaskName` 已注册（状态: $($info.State)），下次运行: $next"
Write-Host "     触发：每天 00:05 + 每次登录补跑；错过自动补；日志: $ProjectDir\checkin.log"
Write-Host ''
Write-Host '立即试跑一次？(Y/n)'
$ans = Read-Host
if ($ans -notmatch '^[nN]') { & $node $Script silent; Get-Content (Join-Path $ProjectDir 'checkin.log') -Tail 1 }
