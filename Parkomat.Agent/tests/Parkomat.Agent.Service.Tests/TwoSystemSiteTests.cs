using System.Net;
using System.Net.Sockets;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Modbus;
using Parkomat.Agent.Tray.Services;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>אתר פלורנטין: שתי מערכות בבקר אחד.</b>
///
/// <para>שני <c>ParkManager</c>, כל אחד עם מצב ורכב משלו, ומונה מחזורים
/// אחד משותף:</para>
///
/// <code>
/// 290 = ParkManager1.CurrentState      293 = ParkManager2.CurrentState
/// 291 = ParkManager1.Car               294 = ParkManager2.Car
/// 292 = CycleCounter (משותף)
/// </code>
///
/// <para>⚠️ <b>הטענה החשובה כאן היא שזו בקשה אחת.</b> 290..294 הם טווח של
/// חמישה, מתחת לתקרת השמונה, ולכן שתי המערכות נדגמות באותו רגע. שתי
/// בקשות היו מאפשרות שמצב של מערכת 1 יזווג עם רכב של מערכת 2 —
/// כלומר רשומת כניסה שגויה, נתון לקוח שנשמר לתמיד.</para>
/// </summary>
public class TwoSystemSiteTests
{
    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    // ערכי הבקר כפי שנצפו בצילום המסך של פלורנטין.
    private static readonly Dictionary<int, ushort> Florentin = new()
    {
        [290] = 5,       // מערכת 1 — תקלה
        [291] = 42,      // רכב 42
        [292] = 20234,   // מונה משותף
        [293] = 1,       // מערכת 2 — המתנה
        [294] = 0,       // אין רכב
    };

    private static PlcConfig Cfg(int port, bool second) => new()
    {
        IpAddress = "127.0.0.1",
        Port = port,
        Transport = "udp",
        FunctionCode = 3,
        ModeRegister = 290,
        CardRegister = 291,
        CycleRegister = 292,
        ModeRegister2 = second ? 293 : 0,
        CardRegister2 = second ? 294 : 0,
    };

    // משיב UDP שסופר בקשות — הספירה היא הטענה, לא רק הערכים.
    private sealed class Controller : IDisposable
    {
        private readonly UdpClient _sock;
        private readonly CancellationTokenSource _cts = new();
        public int Requests;

        // ⚠️ `refuseOutside` מייצג בקר אמיתי שאין בו הכתובת: הוא מחזיר
        // תשובת שגיאה של Modbus. מאגר שמחזיר אפס לכל כתובת אינו יכול
        // לייצג "הכתובת אינה קיימת" — וזו בדיוק הטעות שהפילה בדיקה
        // קודמת בפרויקט הזה, כשמוטציה עברה ירוקה בגללה.
        public Controller(int port, IReadOnlyDictionary<int, ushort> registers, bool refuseOutside = false)
        {
            _sock = new UdpClient(port);
            Task.Run(() =>
            {
                var ep = new IPEndPoint(IPAddress.Any, 0);
                while (!_cts.IsCancellationRequested)
                {
                    byte[] req;
                    try { req = _sock.Receive(ref ep); } catch { return; }

                    Interlocked.Increment(ref Requests);

                    int start = (req[8] << 8) | req[9];
                    int count = (req[10] << 8) | req[11];

                    bool missing = false;
                    for (int i = 0; i < count && refuseOutside; i++)
                        if (!registers.ContainsKey(start + i)) missing = true;

                    List<byte> body;
                    if (missing)
                    {
                        // תשובת שגיאה: הביט העליון של קוד הפונקציה, וקוד 02
                        // (IllegalDataAddress) — מה שבקר אמיתי מחזיר.
                        body = new List<byte> { 0, 0, 0, 0, 0, 0, 0x01, (byte)(req[7] | 0x80), 0x02 };
                    }
                    else
                    {
                        body = new List<byte> { 0, 0, 0, 0, 0, 0, 0x01, req[7], (byte)(count * 2) };
                        for (int i = 0; i < count; i++)
                        {
                            ushort v = registers.TryGetValue(start + i, out ushort f) ? f : (ushort)0;
                            body.Add((byte)(v >> 8));
                            body.Add((byte)(v & 0xFF));
                        }
                    }

                    byte[] answer = body.ToArray();
                    _sock.Send(answer, answer.Length, ep);
                }
            });
        }

        public void Dispose() { _cts.Cancel(); _sock.Dispose(); }
    }

    [Fact]
    public void BothSystemsAreReadFromTheSameController()
    {
        int port = FreePort();
        using var plc = new Controller(port, Florentin);
        using var reader = new PlcReader(Cfg(port, second: true));

        PlcReading r = reader.Read()!;

        Assert.Equal(5, r.Mode);            // מערכת 1 — תקלה
        Assert.Equal("42", r.CardNumber);
        Assert.Equal(20234, r.CycleCounter);
        Assert.Equal(1, r.Mode2);           // מערכת 2 — המתנה
        Assert.Equal("", r.CardNumber2);    // אין רכב
    }

    // ⚠️ **הטענה שאי אפשר להסיק מהערכים.** מעל loopback גם חמש בקשות
    // נפרדות היו מחזירות בדיוק אותם מספרים; ההבדל נראה רק בספירה.
    [Fact]
    public void TheTwoSystemsCostOneRequestNotTwo()
    {
        int port = FreePort();
        using var plc = new Controller(port, Florentin);
        using var reader = new PlcReader(Cfg(port, second: true));

        reader.Read();

        Assert.Equal(1, plc.Requests);
    }

    // ⚠️ **ו-21 האתרים האחרים אינם משתנים כלל.** בלי רגיסטרים שניים
    // הקריאה חייבת להישאר בדיוק מה שהייתה, והמערכת השנייה **null** —
    // לא 0, שהוא MODE חוקי (תחזוקה).
    [Fact]
    public void ASingleSystemSiteReadsExactlyAsBefore()
    {
        int port = FreePort();
        using var plc = new Controller(port, Florentin);
        using var reader = new PlcReader(Cfg(port, second: false));

        PlcReading r = reader.Read()!;

        Assert.Equal(5, r.Mode);
        Assert.Equal("42", r.CardNumber);
        Assert.Equal(20234, r.CycleCounter);
        Assert.Null(r.Mode2);
        Assert.Null(r.CardNumber2);
        Assert.Equal(1, plc.Requests);
    }

    // ============================================================
    // ⚠️ הלוג אומר אם המערכת השנייה מוגדרת — אחרת אין דרך לדעת
    // ============================================================
    // אתר דו-מערכתי שאחד משני השדות נשכח בו עולה בשקט מוחלט ומדווח
    // מערכת אחת. שורת היעד היא הדבר היחיד בלוג שיכול לחשוף את זה.
    [Fact]
    public void TheLogLineNamesTheSecondSystemWhenItIsConfigured()
    {
        var cfg = new SiteConfig { PollIntervalMs = 1000 };
        cfg.Plc = Cfg(502, second: true);

        string line = PlcTargetLine.Format(cfg);

        Assert.Contains("system2 MODE=293 Card=294", line);
    }

    // ⚠️ ובאתר חד-מערכתי השורה חייבת להישאר **בדיוק** מה שהייתה: 21
    // אתרים משווים אותה מול modpoll, וכל תוספת היא עוד דבר לפרש.
    [Fact]
    public void ASingleSystemSiteKeepsTheExactSameLogLine()
    {
        var cfg = new SiteConfig { PollIntervalMs = 1000 };
        cfg.Plc = Cfg(502, second: false);

        string line = PlcTargetLine.Format(cfg);

        Assert.DoesNotContain("system2", line);
        Assert.EndsWith("poll=1000ms", line);
    }

    // ============================================================
    // ⚠️ "בדוק חיבור" קורא **את שני הרגיסטרים** של המערכת השנייה
    // ============================================================
    // בדיקה שקוראת רק את ה-MODE הראשון מחזירה ירוק על אתר שהוקלדה בו
    // כתובת שגויה ל-293/294 — כלומר מערכת שלמה שלא תדווח לעולם, ודווקא
    // ברגע היחיד שבו מישהו עומד באתר ויכול לתקן.
    [Fact]
    public async Task TheConnectionTestFailsWhenTheSecondSystemAddressIsWrong()
    {
        int port = FreePort();
        // בקר שחושף רק 290..292 — בדיוק מה שקורה כשמקלידים כתובת שגויה.
        using var plc = new Controller(port, new Dictionary<int, ushort>
        {
            [290] = 5, [291] = 42, [292] = 20234,
        }, refuseOutside: true);

        var cfg = Cfg(port, second: true);
        TestResult r = await ConnectionTester.TestPlcAsync(cfg);

        Assert.False(r.Success, "כתובת שגויה למערכת השנייה דווחה כחיבור תקין");
    }

    [Fact]
    public async Task TheConnectionTestSaysBothSystemsWhenBothAnswer()
    {
        int port = FreePort();
        using var plc = new Controller(port, Florentin);

        TestResult r = await ConnectionTester.TestPlcAsync(Cfg(port, second: true));

        Assert.True(r.Success, r.Message);
        Assert.Contains("שתי מערכות", r.Message);
    }

    // ⚠️ **שני הרגיסטרים נדרשים יחד.** מצב בלי רכב אינו חצי-תכונה אלא
    // הגדרה שבורה — תפעול היה נרשם בלי מספר כרטיס, בשקט.
    [Theory]
    [InlineData(293, 0)]
    [InlineData(0, 294)]
    public void HalfAConfigurationIsNotASecondSystem(int mode2, int card2)
    {
        var cfg = new PlcConfig { ModeRegister2 = mode2, CardRegister2 = card2 };

        Assert.False(cfg.HasSecondSystem);
    }
}

/// <summary>
/// ⚠️ <b>המטען שיוצא לרשת</b> — ולא החיווט שמוביל אליו.
///
/// <para>הדופק שנבנה בעבר "הצליח" בלי ששום בקשה יצאה, ושלוש בדיקות
/// מבניות עברו כי כולן קראו את <c>Worker.cs</c> במקום לספור בקשות. כאן
/// נבדק הגוף עצמו.</para>
/// </summary>
public class TwoSystemPayloadTests
{
    private static readonly Parkomat.Agent.Core.Protocol.SystemState[] Both =
    {
        new() { Unit = 1, State = Parkomat.Agent.Core.Protocol.SiteState.Error, Car = "42" },
        new() { Unit = 2, State = Parkomat.Agent.Core.Protocol.SiteState.Ready, Car = "" },
    };

    [Fact]
    public void TheHeartbeatCarriesBothSystems()
    {
        string body = Parkomat.Agent.Core.Supabase.BatchPayload.Serialize(
            Array.Empty<Parkomat.Agent.Core.Supabase.BatchItem>(), "1.0.50",
            Parkomat.Agent.Core.Supabase.BatchPayload.Systems(Both));

        Assert.Contains("p_systems", body);
        Assert.Contains("\"unit\":1", body);
        Assert.Contains("\"unit\":2", body);
        Assert.Contains("42", body);

        // ⚠️ **בשמות ולא במספרי enum.** מספרים היו הופכים כל תוספת ערך
        // באמצע `SiteState` לשינוי משמעות של כל הכרטיסים במסך, בלי שום
        // שגיאה בשום מקום. זה אותו חוזה שכל שאר המצבים נוסעים בו.
        Assert.Contains("\"state\":\"error\"", body);
        Assert.Contains("\"state\":\"ready\"", body);
        Assert.DoesNotContain("\"state\":2", body);
    }

    // ⚠️ **וזו הטענה שמגנה על 21 האתרים האחרים.** גוף הפעימה שלהם חייב
    // להישאר בדיוק מה שהיה — בית-בבית. שדה חדש שמופיע תמיד היה משנה את
    // החוזה מול השרת בשביל אתר אחד.
    [Fact]
    public void ASingleSystemSiteSendsExactlyWhatItAlwaysSent()
    {
        string before = Parkomat.Agent.Core.Supabase.BatchPayload.Serialize(
            Array.Empty<Parkomat.Agent.Core.Supabase.BatchItem>(), "1.0.50");

        string with = Parkomat.Agent.Core.Supabase.BatchPayload.Serialize(
            Array.Empty<Parkomat.Agent.Core.Supabase.BatchItem>(), "1.0.50", null);

        Assert.Equal(before, with);
        Assert.DoesNotContain("p_systems", before);
    }
}
