# 卸载 qoder-cn-auto-checkin 计划任务
$TaskName = 'QoderCnAutoCheckin'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] 已删除计划任务 $TaskName"
