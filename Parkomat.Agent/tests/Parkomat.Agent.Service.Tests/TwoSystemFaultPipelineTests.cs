using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Protocol;
using Parkomat.Agent.Core.Supabase;
using Parkomat.Agent.Service.Logic;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// 1.0.58 — טקסט התקלה של מערכת אחת, **מהבקר עד הגוף שיוצא לרשת**, מול בקר Modbus אמיתי בתוך התהליך
/// (UDP ו-TCP, פקודה 0x03, כמו פלורנטין). אותה שרשרת שה-Worker מריץ: Read → SystemFaultLatch → ReadFaultText
/// → TwoSystemDetector.Snapshot → BatchPayload. ה-Worker עצמו אינו רץ כאן: הוא כותב ל-ProgramData.
///
/// ⚠️ ושני הצדדים נעולים לאותו קובץ: shared/contracts/beat-two-systems.sample.json — הסוכן מייצר בדיוק
/// אותו, ו-master/tests/beat-two-systems.test.js שולח אותו ל-ingest_batch ובודק שהטקסט מגיע לכרטיס.
/// </summary>
public class TwoSystemFaultPipelineTests
{
    private const string Fault = "מנהל דולים - דלתות חניון פתוחות:";

    private static int FreePort(bool udp)
    {
        if (udp) { using var u = new UdpClient(0); return ((IPEndPoint)u.Client.LocalEndPoint!).Port; }
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    // הבקר: מונה 105, MODE1 106, כרטיס1 107, MODE2 108, כרטיס2 109; טקסט התקלה מכתובת 2 (תו לרגיסטר, אפס בסוף)
    private static NModbus.Data.SlaveDataStore Store(ushort mode1, ushort mode2, string? fault)
    {
        var st = new NModbus.Data.SlaveDataStore();
        st.HoldingRegisters.WritePoints(105, new ushort[] { 9000, mode1, 0, mode2, 133 });
        var text = new List<ushort>();
        foreach (char c in fault ?? "") text.Add(c);
        while (text.Count < 80) text.Add(0);
        st.HoldingRegisters.WritePoints(2, text.ToArray());
        return st;
    }

    private static PlcConfig Cfg(int port, bool udp) => new()
    {
        IpAddress = "127.0.0.1", Port = port, Transport = udp ? "udp" : "tcp", FunctionCode = 3,
        CycleRegister = 105, ModeRegister = 106, CardRegister = 107, ModeRegister2 = 108, CardRegister2 = 109,
        FaultTextRegister = 2, FaultTextMaxChars = 80,
    };

    private static void WithSlave(bool udp, NModbus.Data.SlaveDataStore store, Action<int> body)
    {
        int port = FreePort(udp);
        var factory = new ModbusFactory();
        if (udp)
        {
            var sock = new UdpClient(port);
            IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);
            net.AddSlave(factory.CreateSlave(1, store));
            _ = net.ListenAsync();
            try { body(port); } finally { net.Dispose(); sock.Dispose(); }
        }
        else
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            IModbusSlaveNetwork net = factory.CreateSlaveNetwork(listener);
            net.AddSlave(factory.CreateSlave(1, store));
            _ = net.ListenAsync();
            try { body(port); } finally { net.Dispose(); listener.Stop(); }
        }
    }

    // הצעד של ה-Worker, בלי ה-Worker: קריאה, החלטה אם לקרוא טקסט, תצלום, גוף
    private static (PlcReading r, string body) Step(PlcReader reader, SystemFaultLatch latch, DateTimeOffset now)
    {
        PlcReading r = reader.Read()!;
        bool anyErr = ModeTranslator.FromMode(r.Mode) == SiteState.Error
                   || ModeTranslator.FromMode(r.Mode2 ?? 4) == SiteState.Error;
        if (latch.Due(anyErr, now))
        {
            string t = reader.ReadFaultText().Text;
            latch.Set(string.IsNullOrEmpty(t) ? null : t);
        }
        var snap = TwoSystemDetector.Snapshot(r.Mode, r.CardNumber, r.Mode2 ?? 4, r.CardNumber2 ?? "", latch.Text);
        return (r, BatchPayload.Serialize(Array.Empty<BatchItem>(), "1.0.0-contract", BatchPayload.Systems(snap)));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void System2InFault_TheTextFromThePlc_RidesOnTheBeat_OnlyForSystem2(bool udp)
    {
        var store = Store(1, 5, Fault);
        WithSlave(udp, store, port =>
        {
            using var reader = new PlcReader(Cfg(port, udp));
            var latch = new SystemFaultLatch();
            var t0 = DateTimeOffset.UtcNow;

            var (r, body) = Step(reader, latch, t0);
            Assert.Equal(1, r.Mode);
            Assert.Equal(5, r.Mode2);
            using var doc = JsonDocument.Parse(body);
            var sys = doc.RootElement.GetProperty("p_systems");
            Assert.False(sys[0].TryGetProperty("fault", out _));                 // מערכת 1 עובדת — בלי טקסט
            Assert.Equal(Fault, sys[1].GetProperty("fault").GetString());       // מערכת 2 — הטקסט מהבקר

            // ⚠️ המצב המאוחד של האתר — "הטוב מבין השתיים" — לא השתנה: מוכן. זו הצגה בלבד.
            Assert.Equal(SiteState.Ready, SiteStateAggregator.Combine(
                ModeTranslator.FromMode(r.Mode), ModeTranslator.FromMode(r.Mode2!.Value)));

            // מערכת 2 חוזרת לעבוד — הטקסט יורד מהפעימה
            store.HoldingRegisters.WritePoints(108, new ushort[] { 1 });
            var (_, body2) = Step(reader, latch, t0.AddSeconds(1));
            Assert.DoesNotContain("fault", body2);
        });
    }

    [Fact]
    public void ThePlcHasNotWrittenTheTextYet_NoText_ThenItAppearsOnTheRetry()
    {
        var store = Store(1, 5, null);
        WithSlave(true, store, port =>
        {
            using var reader = new PlcReader(Cfg(port, true));
            var latch = new SystemFaultLatch();
            var t0 = DateTimeOffset.UtcNow;
            var (_, b1) = Step(reader, latch, t0);
            Assert.DoesNotContain("fault", b1);                                  // לא ממציאים טקסט
            var text = new List<ushort>(); foreach (char c in Fault) text.Add(c); text.Add(0);
            store.HoldingRegisters.WritePoints(2, text.ToArray());
            var (_, b2) = Step(reader, latch, t0.AddSeconds(5));
            Assert.DoesNotContain("fault", b2);                                  // לא בכל דגימה — 30 שניות
            var (_, b3) = Step(reader, latch, t0 + SystemFaultLatch.Retry);
            Assert.Contains(Fault, b3);
        });
    }

    [Fact]
    public void TheAgentProducesExactlyTheSharedContract()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "shared", "contracts"))) dir = dir.Parent;
        Assert.NotNull(dir);
        string path = Path.Combine(dir!.FullName, "shared", "contracts", "beat-two-systems.sample.json");

        string actual = BatchPayload.Serialize(Array.Empty<BatchItem>(), "1.0.0-contract",
            BatchPayload.Systems(TwoSystemDetector.Snapshot(1, "", 5, "133", Fault)));
        using var a = JsonDocument.Parse(actual);
        using var e = JsonDocument.Parse(File.ReadAllText(path));
        Assert.Equal(Norm(e.RootElement), Norm(a.RootElement));
        // ⚠️ עברית כמו שהיא, לא \uXXXX — מי שיקרא את ingest_drops או את alive.systems בעוד חצי שנה
        Assert.Contains(Fault, actual);
    }

    private static string Norm(JsonElement e) => e.ValueKind switch
    {
        JsonValueKind.Object => "{" + string.Join(",", e.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal)
                                    .Select(p => $"{JsonSerializer.Serialize(p.Name)}:{Norm(p.Value)}")) + "}",
        JsonValueKind.Array => "[" + string.Join(",", e.EnumerateArray().Select(Norm)) + "]",
        _ => e.GetRawText(),
    };
}
