using System.Net;
using System.Net.Sockets;
using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray.Services;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>"בדוק חיבור" דיבר TCP ו-FC04 תמיד — גם באתר שמוגדר אחרת.</b>
///
/// <para>נצפה באתר 2222 ב-10/09/2026: <c>No connection could be made
/// because the target machine actively refused it</c> — Windows 10061.
/// זו התשובה של בקר <b>UDP-בלבד</b> לניסיון חיבור TCP: המכונה נגישה, אף
/// אחד לא מאזין על הפורט, והיא שולחת RST.</para>
///
/// <para>⚠️ <b>ובשני המקרים הסוכן עצמו עובד.</b> <c>PlcReader</c> מכבד
/// גם את <c>Transport</c> וגם את <c>FunctionCode</c>; רק המסך שאמור
/// לאמת אותו שיקר. אזהרה שקרית ששולחת טכנאי לחפש תקלה שאינה קיימת.</para>
///
/// <para>⚠️ <b>והבדיקה כאן מול סלייב אמיתי בתוך התהליך</b>, לא מול טקסט:
/// שער שקורא את המקור היה עובר גם על מימוש ששכח את אחד משני הענפים.
/// אותו דפוס כמו <c>PlcTransportTests</c>.</para>
/// </summary>
public class PlcTestTransportTests
{
    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    private static PlcConfig Cfg(int port, string transport, int fc) => new()
    {
        IpAddress = "127.0.0.1",
        Port = port,
        Transport = transport,
        FunctionCode = fc,
        ModeRegister = 106,
        CardRegister = 107,
        CycleRegister = 105,
    };

    // סלייב UDP בתוך התהליך, עם ערכים בשתי טבלאות הרגיסטרים.
    private static (IModbusSlaveNetwork net, UdpClient sock, Task run) StartUdpSlave(int port)
    {
        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);
        ISlaveDataStore store = new NModbus.Data.SlaveDataStore();
        store.InputRegisters.WritePoints(106, new ushort[] { 1 });
        store.HoldingRegisters.WritePoints(106, new ushort[] { 1 });
        net.AddSlave(factory.CreateSlave(1, store));
        return (net, sock, net.ListenAsync());
    }

    // ============================================================
    // ⚠️ המקרה מהשטח: אתר UDP
    // ============================================================
    [Fact]
    public async Task AUdpSiteIsTestedOverUdp()
    {
        int port = FreePort();
        var (net, sock, _) = StartUdpSlave(port);
        try
        {
            TestResult r = await ConnectionTester
                .TestPlcAsync(Cfg(port, "udp", 4));

            Assert.True(r.Success, "בדיקת UDP נכשלה מול סלייב UDP חי: " + r.Message);
            Assert.Contains("UDP", r.Message);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // ⚠️ **וזו הבדיקה שמוכיחה שהענף חי.** שתי הבדיקות שמעליה ומתחתיה
    // היו עוברות גם מול מימוש שמתעלם מ-`Transport` לגמרי — זו לא:
    // הסלייב מגיש UDP בלבד, ובקשת TCP על אותו פורט **חייבת** להיכשל.
    [Fact]
    public async Task AskingForTcpAgainstAUdpOnlyControllerFails()
    {
        int port = FreePort();
        var (net, sock, _) = StartUdpSlave(port);
        try
        {
            TestResult r = await ConnectionTester
                .TestPlcAsync(Cfg(port, "tcp", 4));

            Assert.False(r.Success, "TCP מול בקר UDP-בלבד היה אמור להיכשל");
            // ⚠️ וההודעה מציעה את הכיוון הנכון: זו בדיוק הטעות שאי אפשר
            // לנחש מהטקסט "החיבור נכשל".
            Assert.Contains("UDP", r.Message);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // ============================================================
    // ⚠️ ופקודת הקריאה — בקר שחושף רק Holding Registers
    // ============================================================
    [Fact]
    public async Task AHoldingRegisterSiteIsReadWithFunctionCodeThree()
    {
        int port = FreePort();
        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);

        // ⚠️ **בקר שדוחה FC 04, לא בקר שפשוט לא נכתב לו.** הגרסה הראשונה
        // השתמשה ב-`SlaveDataStore` רגיל וכתבה רק ל-Holding — אבל NModbus
        // מחזיר **אפס** לרגיסטר Input שלא נכתב במקום שגיאה, ולכן קריאת
        // FC04 "הצליחה" ומוטציה שקיבעה את הקוד ל-FC04 עברה ירוקה.
        // בקר אמיתי שאינו חושף Input Registers מחזיר IllegalFunction.
        ISlaveDataStore store = new HoldingOnlyStore();
        net.AddSlave(factory.CreateSlave(1, store));
        _ = net.ListenAsync();

        try
        {
            TestResult r = await ConnectionTester
                .TestPlcAsync(Cfg(port, "udp", 3));

            Assert.True(r.Success, "FC 0x03 נכשל מול בקר שחושף Holding Registers: " + r.Message);
            Assert.Contains("FC=0x03", r.Message);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // ============================================================
    // ⚠️ בקר שחושף Holding Registers בלבד
    // ============================================================
    // `SlaveDataStore` הרגיל מחזיר אפס לכל כתובת שלא נכתבה, ולכן הוא
    // אינו יכול לייצג "הפקודה הזו אינה נתמכת". כאן ה-Input Registers
    // זורק IllegalFunction, כמו הבקר האמיתי.
    private sealed class HoldingOnlyStore : ISlaveDataStore
    {
        private readonly NModbus.Data.SlaveDataStore _inner = new();

        public HoldingOnlyStore() => _inner.HoldingRegisters.WritePoints(106, new ushort[] { 1 });

        public IPointSource<ushort> InputRegisters { get; } = new Refusing();
        public IPointSource<ushort> HoldingRegisters => _inner.HoldingRegisters;
        public IPointSource<bool> CoilDiscretes => _inner.CoilDiscretes;
        public IPointSource<bool> CoilInputs => _inner.CoilInputs;

        private sealed class Refusing : IPointSource<ushort>
        {
            public ushort[] ReadPoints(ushort startAddress, ushort numberOfPoints)
                => throw new InvalidModbusRequestException(SlaveExceptionCodes.IllegalFunction);

            public void WritePoints(ushort startAddress, ushort[] points)
                => throw new InvalidModbusRequestException(SlaveExceptionCodes.IllegalFunction);
        }
    }

    // ⚠️ וההודעה נושאת את **מה שנוסה**, לא רק את הכישלון. "החיבור נכשל"
    // לבדו שולח לבדוק כתובת, בזמן שהסיבה הנפוצה היא תעבורה או FC.
    [Fact]
    public async Task TheMessageSaysWhatWasAttempted()
    {
        TestResult r = await ConnectionTester
            .TestPlcAsync(Cfg(FreePort(), "udp", 3));

        Assert.False(r.Success);
        Assert.Contains("UDP", r.Message);
        Assert.Contains("FC=0x03", r.Message);
        Assert.Contains("register 106", r.Message);
    }
}
