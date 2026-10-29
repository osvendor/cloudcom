using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class ManagedViewerDefaults
{
    // Run as the interactive viewer user, never from an elevated MSI action.
    internal static void EnsureUdpDefault(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        using (var gate = new FileStream(path + ".defaults.lock", FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None)) {
            bool exists = File.Exists(path);
            string original = exists ? File.ReadAllText(path) : "";
            string updated = WithUdpDefault(original);
            if (updated == original) return;
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                File.WriteAllText(temporary, updated, new UTF8Encoding(false));
                if (exists) File.Replace(temporary, path, path + ".before-udp-default");
                else File.Move(temporary, path);
            } finally {
                if (File.Exists(temporary)) File.Delete(temporary);
            }
        }
    }

    internal static string WithUdpDefault(string text)
    {
        var section = Regex.Match(text, @"(?m)^\[options\][ \t]*(?:#[^\r\n]*)?\r?$");
        if (!section.Success) {
            if (Regex.IsMatch(text, @"(?m)^\s*\[\s*['"" ]?options"))
                throw new InvalidDataException("Unrecognized viewer options section; configuration was preserved.");
            return text + (text.Length == 0 || text.EndsWith("\n") ? "" : "\r\n")
                + "[options]\r\nenable-udp-punch = 'Y'\r\n";
        }
        int start = section.Index + section.Length;
        var next = Regex.Match(text.Substring(start), @"(?m)^\s*\[");
        int end = next.Success ? start + next.Index : text.Length;
        string options = text.Substring(start, end - start);
        // Preserve explicit opt-outs and quoted TOML keys, as well as relay preferences.
        if (Regex.IsMatch(options, @"(?m)^\s*(?:enable-udp-punch|'enable-udp-punch'|""enable-udp-punch"")\s*="))
            return text;
        return text.Insert(start, "\r\nenable-udp-punch = 'Y'");
    }
}
