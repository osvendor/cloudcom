using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Windows.Forms;

internal static class ManagedViewerLauncher
{
    // Build-time substitutions contain public routing and verified payload hashes only.
    private const string Route = @@ROUTE@@;
    private static readonly Dictionary<string, string> Files = new Dictionary<string, string> {
@@FILES@@
    };

    [STAThread]
    private static int Main(string[] args)
    {
        bool verifyOnly = args.Length == 1 && args[0] == "--verify";
        try {
            if (args.Length != 0 && !verifyOnly) throw new Exception("Unsupported launcher arguments.");
            string root = AppDomain.CurrentDomain.BaseDirectory;
            foreach (var entry in Files) {
                string file = Path.Combine(root, entry.Key);
                using (var stream = File.OpenRead(file))
                using (var sha = SHA256.Create()) {
                    string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
                    if (!String.Equals(actual, entry.Value, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("Application files have changed. Repair OS Consultants - Remote Access using its installer.");
                }
            }
            if (verifyOnly) return 0;
            string exe = Path.Combine(root, "rustdesk.exe");
            foreach (var process in Process.GetProcessesByName("rustdesk")) {
                string path = null;
                using (process) {
                    try { path = process.MainModule.FileName; } catch (System.ComponentModel.Win32Exception) { } catch (InvalidOperationException) { }
                }
                if (String.Equals(path, exe, StringComparison.OrdinalIgnoreCase))
                    throw new Exception("OS Consultants - Remote Access is already open. Close its window before starting it again.");
            }
            var start = new ProcessStartInfo(exe) { WorkingDirectory = root, UseShellExecute = false };
            start.EnvironmentVariables["RUSTDESK_APPNAME"] = Route;
            start.EnvironmentVariables["RUST_LOG"] = "info";
            using (var process = Process.Start(start)) { }
            return 0;
        } catch (Exception error) {
            if (!verifyOnly) MessageBox.Show(error.Message, "OS Consultants - Remote Access", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
