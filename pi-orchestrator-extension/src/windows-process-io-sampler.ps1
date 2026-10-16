param(
  [switch]$ExitAfterReady,
  [int]$ExitAfterSamples = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PiIoSamplerNative {
  public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern SafeWaitHandle OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool QueryFullProcessImageName(SafeWaitHandle process, uint flags, System.Text.StringBuilder path, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessTimes(SafeWaitHandle process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessIoCounters(SafeWaitHandle process, out IO_COUNTERS counters);
}
'@

$handles = @{}
$sampleCount = 0
function Emit($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 6
  if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 4096) { throw 'output frame exceeds 4096 bytes' }
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}
function NativeError($name) {
  $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  return "$name failed with Win32 error $code"
}
function Normalize-PathText($value) {
  return [IO.Path]::GetFullPath([string]$value).TrimEnd('\').ToLowerInvariant()
}

function Read-BoundedLine {
  $buffer = New-Object char[] 4096
  $count = 0
  $byteCount = 0
  while ($true) {
    $value = [Console]::In.Read()
    if ($value -lt 0) {
      if ($count -eq 0) { return $null }
      throw 'unterminated request frame at EOF'
    }
    if ($value -eq 10) {
      if ($count -gt 0 -and $buffer[$count - 1] -eq [char]13) { $count -= 1 }
      return New-Object string($buffer, 0, $count)
    }
    $byteCount += [Text.Encoding]::UTF8.GetByteCount([string][char]$value)
    if ($byteCount -gt 4096 -or $count -ge $buffer.Length) {
      while ($value -ge 0 -and $value -ne 10) { $value = [Console]::In.Read() }
      throw 'request frame exceeds 4096 characters'
    }
    $buffer[$count] = [char]$value
    $count += 1
  }
}

try {
  Emit @{ type='service_ready'; desiredAccess=[PiIoSamplerNative]::PROCESS_QUERY_LIMITED_INFORMATION; pid=$PID }
  if ($ExitAfterReady) { return }
  while (($line = Read-BoundedLine) -ne $null) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
      if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 4096) { throw "request frame exceeds 4096 bytes" }
      $request = $line | ConvertFrom-Json
      $id = [string]$request.transportId
      if ($id -notmatch '^[a-f0-9]{32}$') { throw "transport id invalid" }
      $bindingGeneration = [string]$request.bindingGeneration
      if ($bindingGeneration -notmatch '^[a-f0-9]{32}$') { throw "binding generation invalid" }
      if ($request.action -eq 'register') {
        if ($handles.ContainsKey($id)) { throw "duplicate invocation registration" }
        if ($handles.Count -ge 200) { throw "process registration limit reached" }
        $handle = [PiIoSamplerNative]::OpenProcess([PiIoSamplerNative]::PROCESS_QUERY_LIMITED_INFORMATION, $false, [uint32]$request.pid)
        if ($handle.IsInvalid) { throw (NativeError 'OpenProcess') }
        try {
          $capacity = [uint32]32768
          $builder = New-Object Text.StringBuilder ([int]$capacity)
          if (-not [PiIoSamplerNative]::QueryFullProcessImageName($handle, 0, $builder, [ref]$capacity)) { throw (NativeError 'QueryFullProcessImageName') }
          [long]$creation=0; [long]$exit=0; [long]$kernel=0; [long]$user=0
          if (-not [PiIoSamplerNative]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { throw (NativeError 'GetProcessTimes') }
          $creationUtc = [DateTime]::FromFileTimeUtc($creation)
          $epochUtc = [DateTime]::Parse('1970-01-01T00:00:00Z').ToUniversalTime()
          $creationUnixMs = ($creationUtc.Ticks - $epochUtc.Ticks) / [TimeSpan]::TicksPerMillisecond
          $actualPath = Normalize-PathText $builder.ToString()
          $expectedPath = Normalize-PathText $request.expectedExecutable
          if ($actualPath -ne $expectedPath) { throw "executable identity mismatch" }
          if ($creationUnixMs -lt ([double]$request.earliestCreationUnixMs - 2000) -or $creationUnixMs -gt ([double]$request.latestCreationUnixMs + 2000)) { throw "creation identity mismatch" }
          $handles[$id] = @{ handle=$handle; sequence=[uint64]0; lastRequestGeneration=[int64]0; executable=$builder.ToString(); creationUnixMs=$creationUnixMs; bindingGeneration=$bindingGeneration }
          $handle = $null
          Emit @{ type='registered'; transportId=$id; bindingGeneration=$bindingGeneration; executable=$builder.ToString(); creationUnixMs=$creationUnixMs; desiredAccess=[PiIoSamplerNative]::PROCESS_QUERY_LIMITED_INFORMATION }
        } finally {
          if ($null -ne $handle) { $handle.Dispose() }
        }
      } elseif ($request.action -eq 'sample') {
        if (-not $handles.ContainsKey($id)) { throw "unknown invocation" }
        $item = $handles[$id]
        $requestId = [string]$request.requestId; $requestGeneration = [int64]$request.requestGeneration
        if ($requestId -notmatch '^[a-f0-9]{32}$' -or $requestGeneration -le [int64]$item.lastRequestGeneration) { throw "counter request id/generation invalid" }
        $item.lastRequestGeneration = $requestGeneration
        $counters = New-Object PiIoSamplerNative+IO_COUNTERS
        if (-not [PiIoSamplerNative]::GetProcessIoCounters($item.handle, [ref]$counters)) { throw (NativeError 'GetProcessIoCounters') }
        $item.sequence = [uint64]$item.sequence + 1
        if ([string]$request.bindingGeneration -ne [string]$item.bindingGeneration) { throw "binding generation mismatch" }
        Emit @{
          type='sample'; transportId=$id; bindingGeneration=$item.bindingGeneration; requestId=([string]$request.requestId); requestGeneration=([int64]$request.requestGeneration); sequence=$item.sequence; sampledUnixMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();
          readOperations=$counters.ReadOperationCount; writeOperations=$counters.WriteOperationCount; otherOperations=$counters.OtherOperationCount;
          readTransfer=$counters.ReadTransferCount; writeTransfer=$counters.WriteTransferCount; otherTransfer=$counters.OtherTransferCount
        }
        $sampleCount += 1
        if ($ExitAfterSamples -gt 0 -and $sampleCount -ge $ExitAfterSamples) { return }
      } elseif ($request.action -eq 'unregister') {
        if ($handles.ContainsKey($id)) { $handles[$id].handle.Dispose(); $handles.Remove($id) }
        Emit @{ type='unregistered'; transportId=$id; bindingGeneration=$bindingGeneration }
      } else { throw "unknown action" }
    } catch {
      Emit @{ type='error'; transportId=([string]$request.transportId); bindingGeneration=([string]$request.bindingGeneration); requestId=([string]$request.requestId); message=$_.Exception.Message }
    }
  }
} finally {
  foreach ($item in $handles.Values) { try { $item.handle.Dispose() } catch {} }
  $handles.Clear()
}
