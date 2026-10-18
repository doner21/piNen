param([string]$PipeName)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Round9 owned cooperative cleanup fixture'
$form.Width = 360
$form.Height = 120
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
$inputReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$cancelConnect = New-Object System.Threading.CancellationTokenSource
$worker = $null
$reader = $null
$writer = $null
try {
  # Console.In.ReadLineAsync on Framework's synchronized reader is synchronous.
  # Use the raw redirected stream, so early EOF can release even ConnectAsync.
  $inputDone = $inputReader.ReadLineAsync()
  $connection = $pipe.ConnectAsync($cancelConnect.Token)
  $which = [System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($connection, $inputDone))
  if ($which -eq 1) {
    $cancelConnect.Cancel()
    try { $connection.GetAwaiter().GetResult() } catch [System.OperationCanceledException] {}
  } else {
    $connection.GetAwaiter().GetResult()
    $reader = New-Object System.IO.StreamReader($pipe)
    $writer = New-Object System.IO.StreamWriter($pipe)
    $writer.AutoFlush = $true
    $closeForm = [System.Action]{ $form.Close() }
    $worker = [PowerShell]::Create()
    # Close is dispatched to the UI thread, not synchronously cross-thread.
    # The existing pipe OR redirected stdin EOF cooperatively releases it.
    $null = $worker.AddScript('param($form,$reader,$inputDone,$closeForm) $pipeDone=$reader.ReadLineAsync(); $null=[System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]@($pipeDone,$inputDone)); $null=$form.BeginInvoke($closeForm)').AddArgument($form).AddArgument($reader).AddArgument($inputDone).AddArgument($closeForm)
    $form.Add_Shown({
      $script:completion = $worker.BeginInvoke()
      $writer.WriteLine('{"role":"window","pid":' + $PID + ',"handle":"' + $form.Handle.ToInt64() + '"}')
    })
    $null = $form.ShowDialog()
    if ($script:completion) { $worker.EndInvoke($script:completion) }
  }
} finally {
  if ($worker) { $worker.Dispose() }
  $form.Dispose()
  if ($writer) { $writer.Dispose() }
  if ($reader) { $reader.Dispose() }
  $pipe.Dispose()
  $inputReader.Dispose()
  $cancelConnect.Dispose()
}
