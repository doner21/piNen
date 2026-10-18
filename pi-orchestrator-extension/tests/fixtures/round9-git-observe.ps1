# Retain a creation-bound Git process handle, not a post-exit PID assertion.
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Snapshot {
    @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -gt 0} | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='parentPid';e={[int]$_.ParentProcessId}},@{n='born';e={$_.CreationDate.ToUniversalTime().ToString('o')}})
}
function Descendants($rows, $root) {
    $ids = @{}; $ids[[int]$root] = $true
    do {
        $added = $false
        foreach ($row in $rows) {
            $parent = $rows | Where-Object {$_.pid -eq $row.parentPid} | Select-Object -First 1
            if ($parent -and $ids.ContainsKey([int]$parent.pid) -and !$ids.ContainsKey([int]$row.pid) -and [DateTime]$row.born -ge [DateTime]$parent.born) {
                $ids[[int]$row.pid] = $true; $added = $true
            }
        }
    } while ($added)
    @($rows | Where-Object {$_.pid -ne $root -and $ids.ContainsKey([int]$_.pid)})
}
$initial = Snapshot
$selfIdentity = $initial | Where-Object {$_.pid -eq $PID} | Select-Object -First 1
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = (Get-Command $request.executable -CommandType Application | Select-Object -First 1).Source
$info.Arguments = $request.arguments
$info.WorkingDirectory = $request.cwd
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$p = New-Object Diagnostics.Process
$p.StartInfo = $info
$p.EnableRaisingEvents = $true
$started = $p.Start()
$identity = @{pid=$p.Id;parentPid=$PID;born=$p.StartTime.ToUniversalTime().ToString('o')}
$out = $p.StandardOutput.ReadToEndAsync()
$err = $p.StandardError.ReadToEndAsync()
$rows = Snapshot
$children = Descendants $rows $p.Id
$p.WaitForExit()
$stdout = $out.GetAwaiter().GetResult()
$stderr = $err.GetAwaiter().GetResult()
$code = $p.ExitCode
$after = Snapshot
$remaining = @($children | Where-Object {$g=$_; $after | Where-Object {$_.pid -eq $g.pid -and $_.born -eq $g.born}})
$git = @{pid=$identity.pid;identity=$identity;descendants=@($children);code=$code;signal=$null;creationBinding='waited-process-handle';executable=$info.FileName}
if ($remaining.Count) {$git.coverageError='git_descendant_survived'}
$result = @{git=$git;wrapper=@{pid=$PID;identity=$selfIdentity;descendants=@(Descendants $initial $PID);code=0;signal=$null};stdout=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stdout));stderr=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stderr))}
$p.Dispose()
ConvertTo-Json -Depth 12 -Compress -InputObject $result
