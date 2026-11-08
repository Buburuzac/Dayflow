// C# source of the UI Automation helper, compiled by PowerShell's Add-Type (C# 5: no string
// interpolation, no ?., no out var). Kept in a .ts module so it ships inside the bundle.
//
// Protocol (UTF-8, one line each way):
//   request  "<id>|<cmd>|<arg>|…"            response {"id":<id>,"ok":true,…}
//   events   {"ev":"md"|"mu","x":…,"y":…,"r":0|1}  mouse down / up (physical px)
//            {"ev":"kd","k":"ret"|"esc"|"key"}       Return, Escape, any other key (no character!)
//            {"ev":"kd","k":"sc","vk":67,"m":1,"np":0} shortcut candidate (Ctrl, Alt or Win held): virtual
//                                                     key, modifier bits (1 Ctrl, 2 Alt, 4 Shift, 8 Win), np = numpad
//                                                     key. keys.ts decides whether it is logged (strict allowlist).
//            {"ev":"wheel"}  {"ev":"fg"}  {"ev":"ready"}
// Commands:
//   fg                         foreground window: hwnd, pid, process, exe path, title, class, locked
//   snap|hwnd|web|rootKey|ms   tree of a window as items [depth, keyHash, text, noId]
//   focus                      focused element: pid, process, label, value (password → [secure field])
//   hit|x|y                    element under a point, described (own windows → own:true)
//   Elements of blocked processes and of Dayflow itself are never read, also when nested in another app.
//   block|a,b,c                process names (lowercase, no .exe) never read
//   hooks|1 / hooks|0          install / remove the low-level input hooks
// Every command runs on a worker thread with a timeout so a hung app can't stall the helper.

export const UIA_HELPER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public static class DfA11y {
  // ---------- Win32 ----------
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

  delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, HookProc fn, IntPtr mod, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod, WinEventProc fn, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr h);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);

  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint msg; public IntPtr w, l; public uint time; public POINT pt; }
  [StructLayout(LayoutKind.Sequential)] struct KBD { public uint vk, scan, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSLL { public POINT pt; public uint data, flags, time; public IntPtr extra; }

  // ---------- output ----------
  static Stream stdout;
  static readonly object outLock = new object();
  static readonly Queue<string> events = new Queue<string>();
  static readonly AutoResetEvent eventSignal = new AutoResetEvent(false);
  static int ownPid;
  static volatile HashSet<string> blocked = new HashSet<string>();

  static void Write(string line) {
    byte[] b = new UTF8Encoding(false).GetBytes(line + "\n");
    lock (outLock) { stdout.Write(b, 0, b.Length); stdout.Flush(); }
  }

  // Hooks never block on the pipe: they queue, a writer thread drains.
  static void Event(string json) {
    lock (events) { if (events.Count < 2000) events.Enqueue(json); }
    eventSignal.Set();
  }

  static void EventWriter() {
    while (true) {
      eventSignal.WaitOne();
      while (true) {
        string e = null;
        lock (events) { if (events.Count > 0) e = events.Dequeue(); }
        if (e == null) break;
        try { Write(e); } catch { Environment.Exit(0); }
      }
    }
  }

  static string Q(string s) {
    if (s == null) return "null";
    StringBuilder sb = new StringBuilder(s.Length + 2);
    sb.Append('"');
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4")); else sb.Append(c);
          break;
      }
    }
    sb.Append('"');
    return sb.ToString();
  }
  static string B(bool b) { return b ? "true" : "false"; }

  // ---------- main loop ----------
  public static void Run(int dayflowPid) {
    ownPid = dayflowPid;
    try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch {} }
    stdout = Console.OpenStandardOutput();
    TextReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    Thread w = new Thread(EventWriter); w.IsBackground = true; w.Start();
    Write("{\"ev\":\"ready\"}");
    int abandoned = 0;
    string line;
    while ((line = input.ReadLine()) != null) {
      int bar = line.IndexOf('|');
      if (bar <= 0) continue;
      string id = line.Substring(0, bar);
      string[] a = line.Substring(bar + 1).Split('|');
      string cmd = a[0];
      if (cmd == "hooks") {
        SetHooks(a.Length > 1 && a[1] == "1");
        Write("{\"id\":" + id + ",\"ok\":true,\"kb\":" + B(kbHook != IntPtr.Zero) + ",\"mouse\":" + B(msHook != IntPtr.Zero)
          + ",\"err\":" + hookError + "}");
        continue;
      }
      if (cmd == "block") {
        HashSet<string> set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (a.Length > 1) foreach (string n in a[1].Split(',')) if (n.Trim().Length > 0) set.Add(n.Trim());
        blocked = set;
        Write("{\"id\":" + id + ",\"ok\":true}");
        continue;
      }
      if (cmd == "quit") break;
      string result = null;
      string[] args = a;
      int timeout = cmd == "snap" ? 4000 : 1500;
      Thread t = new Thread(delegate() {
        try { result = Handle(args); }
        catch (Exception ex) { result = "\"ok\":false,\"err\":" + Q(ex.GetType().Name + ": " + ex.Message); }
      });
      t.IsBackground = true;
      t.Start();
      if (t.Join(timeout)) {
        Write("{\"id\":" + id + "," + (result ?? "\"ok\":false") + "}");
      } else {
        Write("{\"id\":" + id + ",\"ok\":false,\"err\":\"timeout\"}");
        abandoned++;
        if (abandoned >= 4) Environment.Exit(3); // the host restarts the helper
      }
    }
    SetHooks(false);
  }

  static string Handle(string[] a) {
    switch (a[0]) {
      case "fg": return Foreground();
      case "snap": return Snapshot(new IntPtr(long.Parse(a[1])), a[2] == "1", a[3], int.Parse(a[4]), a.Length > 5 && a[5] == "1");
      case "focus": return Focus();
      case "hit": return Hit(int.Parse(a[1]), int.Parse(a[2]));
      case "ping": return "\"ok\":true";
    }
    return "\"ok\":false,\"err\":\"unknown command\"";
  }

  // ---------- processes ----------
  // No pid -> path cache: pids are reused, and a stale entry would report (and log) an excluded
  // app under the name of the process that had the pid before. The query is cheap.
  static readonly Dictionary<string, string> descCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

  static string ProcessPath(uint pid) {
    string path = "";
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) {
      StringBuilder sb = new StringBuilder(1024); int size = sb.Capacity;
      if (QueryFullProcessImageName(h, 0, sb, ref size)) path = sb.ToString();
      CloseHandle(h);
    }
    return path;
  }

  static string ProcessName(uint pid) {
    string path = ProcessPath(pid);
    if (path.Length == 0) {
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
    }
    return Path.GetFileNameWithoutExtension(path);
  }

  static string Description(string path) {
    if (path.Length == 0) return "";
    lock (descCache) { string d; if (descCache.TryGetValue(path, out d)) return d; }
    string desc = "";
    try { desc = FileVersionInfo.GetVersionInfo(path).FileDescription ?? ""; } catch {}
    lock (descCache) { if (descCache.Count > 400) descCache.Clear(); descCache[path] = desc.Trim(); }
    return desc.Trim();
  }

  static bool IsBlocked(uint pid) {
    if (pid == (uint)ownPid) return true;
    return blocked.Contains(ProcessName(pid));
  }

  [DllImport("wtsapi32.dll")] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr p);

  // Locked: the session's lock flag (WTSSessionInfoEx; also right for locked RDP sessions,
  // where the input desktop stays open), or no access to the input desktop (secure desktop).
  static bool Locked() {
    try {
      IntPtr buf; int bytes;
      if (WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buf, out bytes)) {
        // WTSINFOEXW: DWORD Level; then (8-aligned) WTSINFOEX_LEVEL1_W { SessionId, SessionState, SessionFlags, … }
        int level = Marshal.ReadInt32(buf, 0);
        int flags = Marshal.ReadInt32(buf, 16);
        WTSFreeMemory(buf);
        if (level == 1 && flags == 0) return true; // WTS_SESSIONSTATE_LOCK
      }
    } catch {}
    IntPtr d = OpenInputDesktop(0, false, 0x0100);
    if (d == IntPtr.Zero) return true;
    CloseDesktop(d);
    return false;
  }

  static string Text(IntPtr h, bool cls) {
    StringBuilder sb = new StringBuilder(1024);
    if (cls) GetClassName(h, sb, sb.Capacity); else GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static string Foreground() {
    bool locked = Locked();
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "\"ok\":true,\"hwnd\":0,\"locked\":" + B(locked);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string name = ProcessName(pid);
    if (string.Equals(name, "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) {
      // UWP: the frame belongs to ApplicationFrameHost; the app is the child window's process.
      uint framePid = pid, appPid = 0;
      EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
        uint p; GetWindowThreadProcessId(c, out p);
        if (p != framePid) { appPid = p; return false; }
        return true;
      }, IntPtr.Zero);
      if (appPid != 0) { pid = appPid; name = ProcessName(pid); }
    }
    string path = ProcessPath(pid);
    return "\"ok\":true,\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid + ",\"p\":" + Q(name) + ",\"path\":" + Q(path)
      + ",\"desc\":" + Q(Description(path)) + ",\"t\":" + Q(Text(h, false)) + ",\"c\":" + Q(Text(h, true))
      + ",\"locked\":" + B(locked);
  }

  // ---------- UIA ----------
  // Not exposed as fields by the .NET Framework client; looked up by UIA property id.
  static readonly AutomationProperty AriaRole = Lookup(30101);
  static readonly AutomationProperty AriaProperties = Lookup(30102);
  static AutomationProperty Lookup(int id) { try { return AutomationProperty.LookupById(id); } catch { return null; } }

  static CacheRequest MakeCache(TreeScope scope) {
    CacheRequest cr = new CacheRequest();
    cr.TreeScope = scope;
    cr.TreeFilter = Automation.ControlViewCondition;
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.ClassNameProperty);
    cr.Add(AutomationElement.FrameworkIdProperty);
    if (AriaRole != null) cr.Add(AriaRole);
    if (AriaProperties != null) cr.Add(AriaProperties);
    cr.Add(AutomationElement.IsPasswordProperty);
    cr.Add(AutomationElement.HasKeyboardFocusProperty);
    cr.Add(AutomationElement.IsEnabledProperty);
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.HelpTextProperty);
    cr.Add(AutomationElement.NativeWindowHandleProperty);
    cr.Add(AutomationElement.ProcessIdProperty);
    cr.Add(AutomationElement.IsTextPatternAvailableProperty);
    cr.Add(ValuePattern.ValueProperty);
    cr.Add(SelectionItemPattern.IsSelectedProperty);
    cr.Add(TogglePattern.ToggleStateProperty);
    return cr;
  }

  static object C(AutomationElement e, AutomationProperty p) {
    try {
      object v = e.GetCachedPropertyValue(p, true);
      if (v == AutomationElement.NotSupported) return null;
      return v;
    } catch { return null; }
  }

  static readonly char[] invisible = new char[] { ' ', '\t', '\n', '\r', '\f', '\v', '\u00A0', '\u2028', '\u2029',
    '\u200B', '\u200C', '\u200D', '\uFEFF', '\uFFFC', '\u0085', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003',
    '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', '\u202F', '\u205F', '\u3000' };

  static string T(object v) {
    if (v == null) return null;
    if (v is bool) return null;
    string s = v as string;
    if (s == null) s = Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture);
    s = s.Trim(invisible);
    return s.Length == 0 ? null : s;
  }

  const int MaxText = 10000;
  public static string Clip(string s) {
    string one = s.Replace("\r\n", "\n").Replace('\r', '\n').Replace("\n", " ⏎ ");
    if (one.Length <= MaxText) return one;
    int cut = MaxText;
    if (char.IsHighSurrogate(one[cut - 1])) cut--;
    return one.Substring(0, cut) + "…(+" + (one.Length - cut) + ")";
  }

  class Info {
    public string role, label, value, url, placeholder;
    public bool focused, selected, disabled, secure, web;
    public Rect rect;
    public int pid;
  }

  static readonly HashSet<string> dropRoles = new HashSet<string> { "scrollbar", "splitter", "valueindicator", "menubar",
    "image", "titlebar", "separator", "thumb", "tooltip" };
  static readonly HashSet<string> labelKeyed = new HashSet<string> { "button", "link", "radiobutton", "checkbox", "row",
    "menuitem", "popupbutton", "menubutton", "textfield", "textarea", "combobox" };

  static string MapRole(ControlType ct, string aria, string ariaProps, string cls, string fw, string value, bool textPattern, object hwnd) {
    if (ct == null) return "group";
    string a = (aria ?? "").ToLowerInvariant();
    if (a == "heading" && (ct == ControlType.Text || ct == ControlType.Group || ct == ControlType.Custom)) return "heading";
    if (ct == ControlType.Button || ct == ControlType.SplitButton) return "button";
    if (ct == ControlType.Hyperlink) return "link";
    if (ct == ControlType.Edit) return IsMultiline(ariaProps, cls, value, hwnd) ? "textarea" : "textfield";
    if (ct == ControlType.Document) {
      if (fw == "Chrome" || fw == "Gecko") return a == "textbox" ? "textarea" : "webarea";
      return (textPattern || value != null) ? "textarea" : "group";
    }
    if (ct == ControlType.Text) return "statictext";
    if (ct == ControlType.List) return "list";
    if (ct == ControlType.ListItem || ct == ControlType.DataItem || ct == ControlType.TreeItem) return "row";
    if (ct == ControlType.Table || ct == ControlType.DataGrid) return "table";
    if (ct == ControlType.Tree) return "outline";
    if (ct == ControlType.Tab) return "tabgroup";
    if (ct == ControlType.TabItem || ct == ControlType.RadioButton) return "radiobutton";
    if (ct == ControlType.CheckBox) return "checkbox";
    if (ct == ControlType.ComboBox) return "combobox";
    if (ct == ControlType.MenuItem) return "menuitem";
    if (ct == ControlType.Menu) return "menu";
    if (ct == ControlType.MenuBar) return "menubar";
    if (ct == ControlType.ToolBar) return "toolbar";
    if (ct == ControlType.ScrollBar) return "scrollbar";
    if (ct == ControlType.Thumb) return "thumb";
    if (ct == ControlType.Separator) return "separator";
    if (ct == ControlType.Image) return "image";
    if (ct == ControlType.TitleBar) return "titlebar";
    if (ct == ControlType.ToolTip) return "tooltip";
    if (ct == ControlType.Header || ct == ControlType.HeaderItem) return "heading";
    if (ct == ControlType.Window) return "window";
    if (ct == ControlType.Slider) return "slider";
    if (ct == ControlType.ProgressBar) return "progressindicator";
    if (ct == ControlType.Spinner) return "incrementor";
    return "group"; // Group, Pane, Custom, StatusBar, Calendar, SemanticZoom, …
  }

  static bool IsMultiline(string ariaProps, string cls, string value, object hwnd) {
    if (ariaProps != null && ariaProps.IndexOf("multiline=true", StringComparison.OrdinalIgnoreCase) >= 0) return true;
    if (value != null && value.IndexOf('\n') >= 0) return true;
    if (cls != null && (cls.StartsWith("RichEdit", StringComparison.OrdinalIgnoreCase) || cls == "Scintilla")) return true;
    if (cls == "Edit" && hwnd is int && (int)hwnd != 0) {
      try { return (GetWindowLong(new IntPtr((int)hwnd), -16) & 0x4) != 0; } catch {}
    }
    return false;
  }

  static Info Read(AutomationElement e) {
    Info i = new Info();
    ControlType ct = C(e, AutomationElement.ControlTypeProperty) as ControlType;
    string name = T(C(e, AutomationElement.NameProperty));
    string aria = AriaRole == null ? null : C(e, AriaRole) as string;
    string ariaProps = AriaProperties == null ? null : C(e, AriaProperties) as string;
    string cls = C(e, AutomationElement.ClassNameProperty) as string;
    string fw = C(e, AutomationElement.FrameworkIdProperty) as string;
    object rawValue = C(e, ValuePattern.ValueProperty);
    string value = rawValue as string;
    bool textPattern = true.Equals(C(e, AutomationElement.IsTextPatternAvailableProperty));
    i.secure = true.Equals(C(e, AutomationElement.IsPasswordProperty));
    i.focused = true.Equals(C(e, AutomationElement.HasKeyboardFocusProperty));
    i.disabled = false.Equals(C(e, AutomationElement.IsEnabledProperty));
    object pid = C(e, AutomationElement.ProcessIdProperty);
    i.pid = pid is int ? (int)pid : 0;
    i.web = fw == "Chrome";
    object r = C(e, AutomationElement.BoundingRectangleProperty);
    i.rect = r is Rect ? (Rect)r : Rect.Empty;
    i.role = MapRole(ct, aria, ariaProps, cls, fw, value, textPattern, C(e, AutomationElement.NativeWindowHandleProperty));
    bool selected = true.Equals(C(e, SelectionItemPattern.IsSelectedProperty));
    object toggle = C(e, TogglePattern.ToggleStateProperty);

    i.label = name;
    if (i.role == "statictext") {
      // macOS static text carries its text as the value.
      i.label = null;
      i.value = name;
    } else if (i.role == "link" || i.role == "webarea") {
      i.url = T(value);
    } else if (i.role == "radiobutton") {
      i.value = selected ? "1" : "0";
    } else if (i.role == "checkbox") {
      if (toggle is ToggleState) i.value = ((ToggleState)toggle) == ToggleState.On ? "1" : "0";
    } else if (i.role != "heading" && i.role != "window") {
      i.value = T(value);
      if (i.value == null && i.role == "textarea" && textPattern && i.focused) i.value = T(DocumentText(e, 20000));
    }
    if (i.role != "radiobutton") i.selected = selected;
    if (i.secure) i.value = "[secure field]";
    if (i.value != null && i.value == i.label) i.value = null;
    if (i.role == "textfield" || i.role == "textarea") i.placeholder = T(C(e, AutomationElement.HelpTextProperty));
    return i;
  }

  static string DocumentText(AutomationElement e, int max) {
    try {
      object p;
      if (!e.TryGetCurrentPattern(TextPattern.Pattern, out p)) return null;
      TextPattern tp = (TextPattern)p;
      TextPatternRange[] vis = tp.GetVisibleRanges();
      if (vis != null && vis.Length > 0) {
        StringBuilder sb = new StringBuilder();
        foreach (TextPatternRange r in vis) { sb.Append(r.GetText(max - sb.Length)); if (sb.Length >= max) break; }
        return sb.ToString();
      }
      return tp.DocumentRange.GetText(max);
    } catch { return null; }
  }

  static string Line(Info i) {
    StringBuilder sb = new StringBuilder(i.role);
    if (i.label != null) sb.Append(" \"").Append(Clip(i.label)).Append('"');
    List<string> states = new List<string>();
    if (i.focused) states.Add("focused");
    if (i.selected) states.Add("selected");
    if (i.disabled) states.Add("disabled");
    if (states.Count > 0) sb.Append(" (").Append(string.Join(",", states)).Append(')');
    if (i.value != null) sb.Append(" = \"").Append(Clip(i.value)).Append('"');
    else if (i.placeholder != null) sb.Append(" placeholder=\"").Append(Clip(i.placeholder)).Append('"');
    if (i.url != null) sb.Append(" <").Append(Clip(i.url)).Append('>');
    return sb.ToString();
  }

  static string Hash(string s) {
    ulong h = 14695981039346656037UL;
    foreach (char c in s) { h ^= c; h *= 1099511628211UL; }
    return h.ToString("x16");
  }

  class Walker {
    public StringBuilder items = new StringBuilder();
    public int lines;
    public bool truncated;
    public Stopwatch sw;
    public int budgetMs;
    public int maxChildren;
    public bool web;
    public Rect window;
    public CacheRequest cr;
    public int tabStripDepth;
    public int hiddenTabs;
    public Condition cond = Automation.ControlViewCondition;
    public bool subtree;
    public int rootPid;
    // Per walk only (a few seconds at most), so pid reuse can't make it stale.
    readonly Dictionary<int, bool> blockedPids = new Dictionary<int, bool>();

    // Elements hosted from another process (embedded windows, plug-ins, a Dayflow window
    // parented into the app) are checked on their own.
    bool Blocked(int pid) {
      if (pid == 0 || pid == rootPid) return false;
      bool b;
      if (!blockedPids.TryGetValue(pid, out b)) { b = IsBlocked((uint)pid); blockedPids[pid] = b; }
      return b;
    }

    void Add(int depth, string key, string text, bool noId) {
      if (items.Length > 0) items.Append(',');
      items.Append('[').Append(depth).Append(',').Append(Q(Hash(key))).Append(',').Append(Q(text)).Append(',').Append(noId ? '1' : '0').Append(']');
      lines++;
    }

    public void Walk(AutomationElement e, Info i, int depth, string parentKey, string slot, string parentLabel) {
      if (lines >= 1500 || depth > 60) return;
      if (sw.ElapsedMilliseconds > budgetMs) { truncated = true; return; }
      if (dropRoles.Contains(i.role)) return;
      Rect f = i.rect;
      if (!f.IsEmpty && f.Width > 0 && f.Height > 0 && !window.IsEmpty && !f.IntersectsWith(window)) return; // off-screen
      string key = parentKey + "/" + slot;

      if (tabStripDepth > 0 && i.role == "radiobutton" && i.value != "1") { hiddenTabs++; return; }

      string text = i.value ?? i.label;
      bool redundant = i.role == "statictext" && text != null && text == parentLabel;
      bool informative = !redundant && (i.label != null || i.value != null || i.url != null || i.role != "group");
      int childDepth = depth;
      if (informative) {
        Add(depth, key, Line(i), false);
        childDepth = depth + 1;
      }

      AutomationElementCollection children;
      try { children = subtree ? e.CachedChildren : e.FindAll(TreeScope.Children, cond); } catch { return; }
      if (children == null || children.Count == 0) return;

      bool isTabStrip = i.role == "tabgroup" && web;
      if (isTabStrip) { tabStripDepth++; hiddenTabs = 0; }
      Dictionary<string, int> slots = new Dictionary<string, int>();
      for (int n = 0; n < children.Count; n++) {
        if (n >= maxChildren) {
          Add(childDepth, key + "/more", "… " + (children.Count - maxChildren) + " more", true);
          break;
        }
        if (lines >= 1500) break;
        AutomationElement child = children[n];
        Info ci;
        try { ci = Read(child); } catch { continue; }
        if (Blocked(ci.pid)) continue;
        string childLabel = ci.label ?? "";
        string bas = (childLabel.Length == 0 || !labelKeyed.Contains(ci.role)) ? ci.role
          : ci.role + ":" + (childLabel.Length > 40 ? childLabel.Substring(0, 40) : childLabel);
        int count; slots.TryGetValue(bas, out count); slots[bas] = count + 1;
        Walk(child, ci, childDepth, key, bas + "#" + count, i.label ?? parentLabel);
      }
      if (isTabStrip) {
        tabStripDepth--;
        if (hiddenTabs > 0) Add(childDepth, key + "/tabs", "(+" + hiddenTabs + " other tabs)", true);
      }
    }
  }

  static string Snapshot(IntPtr hwnd, bool web, string rootKey, int budgetMs, bool subtree) {
    Stopwatch sw = Stopwatch.StartNew();
    CacheRequest cr = MakeCache(subtree ? TreeScope.Subtree : TreeScope.Element);
    AutomationElement root;
    using (cr.Activate()) {
      root = AutomationElement.FromHandle(hwnd);
      Walker w = new Walker();
      w.subtree = subtree;
      // The budget limits the walk; with a subtree cache the fetch above already did the slow part.
      w.sw = subtree ? Stopwatch.StartNew() : sw;
      w.budgetMs = budgetMs; w.web = web; w.cr = cr; w.maxChildren = web ? 40 : 100;
      Info ri = Read(root);
      if (ri.pid != 0 && IsBlocked((uint)ri.pid)) return "\"ok\":true,\"blocked\":true,\"pid\":" + ri.pid;
      w.rootPid = ri.pid;
      w.window = ri.rect.IsEmpty || ri.rect.Width <= 0 ? Rect.Empty : ri.rect;
      w.Walk(root, ri, 0, rootKey, "win", null);
      return "\"ok\":true,\"title\":" + Q(Text(hwnd, false)) + ",\"ms\":" + sw.ElapsedMilliseconds + ",\"trunc\":" + B(w.truncated)
        + ",\"items\":[" + w.items.ToString() + "]";
    }
  }

  static string Focus() {
    CacheRequest cr = MakeCache(TreeScope.Element);
    using (cr.Activate()) {
      AutomationElement e = AutomationElement.FocusedElement;
      if (e == null) return "\"ok\":true,\"none\":true";
      Info i = Read(e);
      uint pid = (uint)i.pid;
      if (IsBlocked(pid)) return "\"ok\":true,\"blocked\":true,\"pid\":" + pid;
      string label = i.label ?? i.placeholder ?? i.role;
      string value = i.secure ? "[secure field]" : (i.role == "statictext" ? null : i.value);
      if (!i.secure && value == null && (i.role == "textarea" || i.role == "textfield")) value = T(DocumentText(e, 20000));
      return "\"ok\":true,\"pid\":" + pid + ",\"p\":" + Q(ProcessName(pid)) + ",\"role\":" + Q(i.role)
        + ",\"label\":" + Q(label) + ",\"value\":" + Q(value) + ",\"secure\":" + B(i.secure);
    }
  }

  // Process of the top-level window actually under the point (0: none).
  static uint RootPidAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = WindowFromPoint(p);
    if (h == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(h, 2); // GA_ROOT
    if (root != IntPtr.Zero) h = root;
    uint pid; GetWindowThreadProcessId(h, out pid);
    return pid;
  }

  static string Hit(int x, int y) {
    uint rootPid = RootPidAt(x, y);
    if (rootPid == (uint)ownPid) return "\"ok\":true,\"own\":true";
    if (rootPid != 0 && IsBlocked(rootPid)) return "\"ok\":true,\"blocked\":true,\"pid\":" + rootPid;
    CacheRequest cr = MakeCache(TreeScope.Element);
    using (cr.Activate()) {
      AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
      if (e == null) return "\"ok\":true,\"none\":true";
      Info first = Read(e);
      uint pid = (uint)first.pid;
      if (IsBlocked(pid)) return "\"ok\":true,\"blocked\":true,\"pid\":" + pid;
      string clicked = "";
      TreeWalker walker = TreeWalker.ControlViewWalker;
      AutomationElement cur = e;
      for (int n = 0; n < 6 && cur != null; n++) {
        Info i = n == 0 ? first : Read(cur);
        if (i.pid != first.pid) break; // never describe an ancestor owned by another process
        if (clicked.Length == 0) clicked = i.role;
        string value = i.secure ? null : i.value;
        string label = i.role == "statictext" ? (i.value ?? i.label) : (i.label ?? value);
        if (label != null) {
          string suffix = i.role == clicked ? "" : " (clicked " + clicked + " inside it)";
          return "\"ok\":true,\"pid\":" + pid + ",\"p\":" + Q(ProcessName(pid)) + ",\"desc\":" + Q(i.role + " \"" + Clip(label) + "\"" + suffix);
        }
        if (i.role == "window") break;
        try { cur = walker.GetParent(cur, cr); } catch { cur = null; }
      }
      if (clicked.Length == 0) return "\"ok\":true,\"none\":true";
      return "\"ok\":true,\"pid\":" + pid + ",\"p\":" + Q(ProcessName(pid)) + ",\"desc\":" + Q(clicked + " (no label)");
    }
  }

  // ---------- input hooks ----------
  static Thread hookThread;
  static uint hookThreadId;
  static HookProc kbProc = KeyboardProc;
  static HookProc msProc = MouseProc;
  static WinEventProc fgProc = ForegroundProc;
  static IntPtr kbHook, msHook, fgHook;
  static int hookError;
  static long lastWheel;

  static void SetHooks(bool on) {
    if (on && hookThread == null) {
      ManualResetEvent started = new ManualResetEvent(false);
      hookThread = new Thread(delegate() {
        hookThreadId = GetCurrentThreadId();
        IntPtr mod = GetModuleHandle(null);
        kbHook = SetWindowsHookEx(13, kbProc, mod, 0);
        if (kbHook == IntPtr.Zero) hookError = Marshal.GetLastWin32Error();
        msHook = SetWindowsHookEx(14, msProc, mod, 0);
        fgHook = SetWinEventHook(3, 3, IntPtr.Zero, fgProc, 0, 0, 0x2);
        started.Set();
        MSG m;
        while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) {}
        if (kbHook != IntPtr.Zero) UnhookWindowsHookEx(kbHook);
        if (msHook != IntPtr.Zero) UnhookWindowsHookEx(msHook);
        if (fgHook != IntPtr.Zero) UnhookWinEvent(fgHook);
        kbHook = msHook = fgHook = IntPtr.Zero;
      });
      hookThread.IsBackground = true;
      hookThread.Priority = ThreadPriority.AboveNormal;
      hookThread.Start();
      started.WaitOne(3000);
    } else if (!on && hookThread != null) {
      PostThreadMessage(hookThreadId, 0x0012, IntPtr.Zero, IntPtr.Zero);
      hookThread.Join(2000);
      hookThread = null;
    }
  }

  static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

  static IntPtr KeyboardProc(int code, IntPtr w, IntPtr l) {
    try {
      int msg = w.ToInt32();
      if (code >= 0 && (msg == 0x100 || msg == 0x104)) {
        KBD k = (KBD)Marshal.PtrToStructure(l, typeof(KBD));
        uint vk = k.vk;
        bool modifier = (vk >= 0x10 && vk <= 0x12) || (vk >= 0xA0 && vk <= 0xA5) || vk == 0x5B || vk == 0x5C
          || vk == 0x14 || vk == 0x90 || vk == 0x91;
        if (!modifier) {
          if (vk == 0x0D) { Event("{\"ev\":\"kd\",\"k\":\"ret\"}"); }
          else {
            bool ctrl = Down(0x11), alt = Down(0x12), shift = Down(0x10), win = Down(0x5B) || Down(0x5C);
            // Numpad: 0x60-0x6F, and the navigation keys without the extended flag (numpad, NumLock off).
            bool nav = (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E || vk == 0x0C;
            bool numpad = (vk >= 0x60 && vk <= 0x6F) || (nav && (k.flags & 0x01) == 0);
            bool fkey = vk >= 0x70 && vk <= 0x87;
            // Pre-filter only; keys.ts decides what is logged. Ctrl+Alt (either Alt) is AltGr, which
            // types characters on many layouts; Alt+numpad types characters (Alt codes); Alt + a
            // character key is at best a menu accelerator. All of that counts as typing.
            bool candidate = ctrl || win || alt;
            if (!win && ctrl && alt && vk != 0x09) candidate = false;
            if (!win && !ctrl && alt && (numpad || !(fkey || nav || vk == 0x09 || vk == 0x1B || vk == 0x20))) candidate = false;
            if (candidate) {
              int m = (ctrl ? 1 : 0) | (alt ? 2 : 0) | (shift ? 4 : 0) | (win ? 8 : 0);
              Event("{\"ev\":\"kd\",\"k\":\"sc\",\"vk\":" + vk + ",\"m\":" + m + ",\"np\":" + (numpad ? "1" : "0") + "}");
            } else if (vk == 0x1B) {
              Event("{\"ev\":\"kd\",\"k\":\"esc\"}");
            } else {
              Event("{\"ev\":\"kd\",\"k\":\"key\"}");
            }
          }
        }
      }
    } catch {}
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  static IntPtr MouseProc(int code, IntPtr w, IntPtr l) {
    try {
      int msg = w.ToInt32();
      if (code >= 0 && msg != 0x200) {
        if (msg == 0x201 || msg == 0x202 || msg == 0x204) {
          MSLL m = (MSLL)Marshal.PtrToStructure(l, typeof(MSLL));
          string ev = msg == 0x202 ? "mu" : "md";
          Event("{\"ev\":\"" + ev + "\",\"x\":" + m.pt.X + ",\"y\":" + m.pt.Y + ",\"r\":" + (msg == 0x204 ? "1" : "0") + "}");
        } else if (msg == 0x20A || msg == 0x20E) {
          long now = Environment.TickCount;
          if (now - lastWheel > 200) { lastWheel = now; Event("{\"ev\":\"wheel\"}"); }
        }
      }
    } catch {}
    return CallNextHookEx(IntPtr.Zero, code, w, l);
  }

  static void ForegroundProc(IntPtr hook, uint ev, IntPtr hwnd, int obj, int child, uint thread, uint time) {
    Event("{\"ev\":\"fg\"}");
  }
}
`
