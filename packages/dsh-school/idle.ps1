# How many seconds the keyboard/mouse have been idle.
# Kept as a file so we never have to nest quotes inside -Command.
$code = '
using System;
using System.Runtime.InteropServices;
public static class IdleProbe {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    public static uint Seconds() {
        LASTINPUTINFO info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
        if (!GetLastInputInfo(ref info)) return uint.MaxValue;
        uint idle = (uint)Environment.TickCount - info.dwTime;
        return idle / 1000;
    }
}
'

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    [Console]::Out.Write([IdleProbe]::Seconds())
} catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
}
