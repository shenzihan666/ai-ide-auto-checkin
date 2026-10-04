# 卸载 trae-cn-auto-checkin 计划任务
$TaskName = 'TraeCnAutoCheckin'
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[OK] 已删除计划任务 $TaskName"
