const { execFile } = require('node:child_process')
const { join } = require('node:path')

const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace QuickNote -Name Acrylic -MemberDefinition @'
  [StructLayout(LayoutKind.Sequential)]
  public struct AccentPolicy {
    public int State, Flags;
    public uint Color;
    public int Animation;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct CompositionAttribute {
    public int Attribute;
    public IntPtr Data;
    public UIntPtr Size;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindow(string className, string title);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool SetWindowCompositionAttribute(IntPtr window, ref CompositionAttribute attribute);
  [DllImport("dwmapi.dll")]
  public static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

  public static bool Enable(string title, uint owner) {
    IntPtr window = FindWindow("Chrome_WidgetWin_1", title);
    uint processId;
    if (window == IntPtr.Zero || GetWindowThreadProcessId(window, out processId) == 0 || processId != owner)
      return false;

    const int AcrylicBlurBehind = 4;
    const int AccentPolicyAttribute = 19;
    const int SystemBackdropType = 38;
    AccentPolicy policy = new AccentPolicy { State = AcrylicBlurBehind, Flags = 2, Color = 0x4080a0c0 };
    int size = Marshal.SizeOf(policy);
    IntPtr data = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(policy, data, false);
      CompositionAttribute accent = new CompositionAttribute { Attribute = AccentPolicyAttribute, Data = data, Size = (UIntPtr)size };
      int noBackdrop = 1;
      // The caller restores Electron's Acrylic if the accent cannot be applied.
      return DwmSetWindowAttribute(window, SystemBackdropType, ref noBackdrop, sizeof(int)) == 0
        && SetWindowCompositionAttribute(window, ref accent);
    } finally {
      Marshal.FreeHGlobal(data);
    }
  }
'@
$title, $owner = [Console]::ReadLine().Split(' ')
if ([QuickNote.Acrylic]::Enable($title, [uint32]$owner)) { exit 0 }
exit 1
`
const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

function applyWindowsAcrylic(title) {
  const windows = process.env.SystemRoot
  const owner = process.ppid
  if (process.platform !== 'win32' || !windows || owner <= 0 || !/^quick-note-[0-9a-f]{32}$/.test(title)) return Promise.resolve(false)

  return new Promise(resolve => {
    const powershell = join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      windowsHide: true,
      timeout: 3000,
    }, error => resolve(!error))
    child.stdin.on('error', () => {})
    child.stdin.end(`${title} ${owner}\n`)
  })
}

module.exports = { applyWindowsAcrylic }
