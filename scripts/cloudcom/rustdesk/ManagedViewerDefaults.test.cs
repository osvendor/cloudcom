using System;
using System.IO;
internal static class DefaultsTests
{
    static void Check(bool condition, string name) { if (!condition) throw new Exception(name); }
    public static int Main()
    {
        foreach (string input in new[] { "", "[options]", "name = 'staff'\n[options]\nother='x'\n", "[another]\nx=1\n" }) {
            string result = ManagedViewerDefaults.WithUdpDefault(input);
            Check(result.Contains("enable-udp-punch = 'Y'"), "missing default");
            Check(ManagedViewerDefaults.WithUdpDefault(result) == result, "idempotence");
        }
        foreach (string key in new[] { "enable-udp-punch", "'enable-udp-punch'", "\"enable-udp-punch\"" }) {
            string input = "[options]\n" + key + " = 'N'\nforce-relay = 'Y'\n";
            Check(ManagedViewerDefaults.WithUdpDefault(input) == input, "explicit preference");
        }
        string other = "[options]\nforce-relay='Y'\n[peer]\nenable-udp-punch='N'\n";
        string changed = ManagedViewerDefaults.WithUdpDefault(other);
        Check(changed.Contains("force-relay='Y'\n[peer]\nenable-udp-punch='N'"), "unrelated values preserved");
        string path = Path.Combine(Path.GetTempPath(), "viewer-default-test-" + Guid.NewGuid(), "RustDesk_local.toml");
        ManagedViewerDefaults.EnsureUdpDefault(path);
        string first = File.ReadAllText(path);
        ManagedViewerDefaults.EnsureUdpDefault(path);
        Check(File.ReadAllText(path) == first, "repeat launch");
        File.WriteAllText(path, "[options]\nforce-relay='Y'\n");
        ManagedViewerDefaults.EnsureUdpDefault(path);
        Check(File.ReadAllText(path).Contains("force-relay='Y'"), "disk relay retained");
        Check(File.ReadAllText(path + ".before-udp-default") == "[options]\nforce-relay='Y'\n", "backup");
        File.Delete(path);
        ManagedViewerDefaults.EnsureUdpDefault(path);
        Check(File.ReadAllText(path) == first, "deleted profile recovery");
        Console.WriteLine("PASS: missing/existing profiles, explicit opt-out, relay preservation, section scope, idempotence, backup and deleted profile recovery");
        return 0;
    }
}
