using System.Net;
using System.Net.Sockets;
using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>אתר 2222, 10/09/2026: <c>Index was outside the bounds of the array</c>.</b>
///
/// <para>הרגיסטרים שם הם <c>MODE=106 Card=107 Cycle=105</c> — <b>אותם
/// שלושה רגיסטרים צמודים</b> כמו בכל אתר אחר, רק בסדר אחר. התנאי לקריאה
/// בבלוק היה <c>cardAddr == modeAddr + 1 &amp;&amp; cycleAddr == modeAddr + 2</c>,
/// כלומר <b>הסידור העולה המדויק בלבד</b>, ולכן האתר נפל למסלול של שלוש
/// קריאות נפרדות.</para>
///
/// <para>⚠️ <b>ושלוש קריאות רצופות מעל UDP הן בדיוק מה שהתיעוד מזהיר
/// מפניו:</b> אין הבטחת סדר, תשובה מאוחרת מגיעה כשהבאה בדרך, NModbus
/// פוסלת לפי מזהה הטרנזקציה — ובסוף מחזירה מערך ריק. <c>values[0]</c>
/// זרק, וההודעה לא רמזה על בקר, רגיסטר או רשת.</para>
///
/// <para><b>הטווח, ולא הסדר, הוא מה שקובע.</b></para>
/// </summary>
public class PlcRegisterOrderTests
{
    private const ushort Mode = 3, Card = 77, Cycle = 4321;

    private static int FreePort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int p = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return p;
    }

    // ⚠️ המיפוי של האתר: 105=Cycle, 106=MODE, 107=Card.
    private static ISlaveDataStore Store()
    {
        var st = new NModbus.Data.SlaveDataStore();
        st.InputRegisters.WritePoints(105, new[] { Cycle, Mode, Card });
        st.HoldingRegisters.WritePoints(105, new[] { Cycle, Mode, Card });
        return st;
    }

    private static SiteConfig Cfg(int port, int mode, int card, int cycle) => new()
    {
        SiteId = "2222",
        PollIntervalMs = 1000,
        Plc = new PlcConfig
        {
            IpAddress = "127.0.0.1", Port = port, Transport = "udp", FunctionCode = 4,
            ModeRegister = mode, CardRegister = card, CycleRegister = cycle,
        },
    };

    private static void WithSlave(int port, Action body)
    {
        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);
        net.AddSlave(factory.CreateSlave(1, Store()));
        _ = net.ListenAsync();
        try { body(); } finally { net.Dispose(); sock.Dispose(); }
    }

    // ============================================================
    // ⚠️ המקרה מהשטח, מילה במילה
    // ============================================================
    [Fact]
    public void TheFieldLayoutIsReadCorrectly()
    {
        int port = FreePort();
        WithSlave(port, () =>
        {
            using var reader = new PlcReader(Cfg(port, 106, 107, 105).Plc);
            PlcReading r = reader.Read()!;

            Assert.Equal(Mode, r.Mode);
            Assert.Equal(Card.ToString(), r.CardNumber);
            Assert.Equal(Cycle, r.CycleCounter);
        });
    }

    // והסידור הרגיל של 21 האתרים האחרים לא נשבר.
    [Fact]
    public void TheOrdinaryAscendingLayoutStillWorks()
    {
        int port = FreePort();
        WithSlave(port, () =>
        {
            using var reader = new PlcReader(Cfg(port, 105, 106, 107).Plc);
            PlcReading r = reader.Read()!;

            Assert.Equal(Cycle, r.Mode);      // 105 מחזיק את Cycle במאגר
            Assert.Equal(Mode.ToString(), r.CardNumber);
            Assert.Equal(Card, r.CycleCounter);
        });
    }

    // ============================================================
    // ⚠️ בקשה **אחת**, לא שלוש — וזה נמדד בספירה, לא בערכים
    // ============================================================
    // ⚠️ **הבדיקות שלמעלה אינן מבחינות בין השניים.** מעל loopback שלוש
    // קריאות נפרדות מחזירות בדיוק אותם ערכים; המרוץ שהפיל את אתר 2222
    // קורה רק ברשת אמיתית, ואי אפשר לשחזר אותו כאן. מוטציה שהחזירה את
    // התנאי המקורי עברה ירוקה בדיוק מהסיבה הזו.
    //
    // מה שכן ניתן למדידה הוא **מספר הבקשות שהגיעו לבקר**. בלוק אחד הוא
    // קריאה אחת של שלושה רגיסטרים; המסלול הישן הוא שלוש קריאות של אחד.
    // וזו גם הטענה האמיתית: תצלום אטומי פירושו בקשה אחת.
    [Fact]
    public void TheThreeRegistersCostOneRequestNotThree()
    {
        int port = FreePort();
        var counting = new CountingStore(105, new[] { Cycle, Mode, Card });

        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);
        net.AddSlave(factory.CreateSlave(1, counting));
        _ = net.ListenAsync();

        try
        {
            // הסידור של אתר 2222 — לא עולה, ובכל זאת טווח של שלושה.
            using var reader = new PlcReader(Cfg(port, 106, 107, 105).Plc);
            reader.Read();

            Assert.Equal(1, counting.Calls);
            Assert.Equal(3, counting.LastCount);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // ⚠️ וטווח רחב **כן** עולה שלוש בקשות — זו התקרה בפעולה, ובלעדיה
    // הסוכן היה מבקש מאה כתובות שאיש לא ביקש.
    [Fact]
    public void AWideSpanCostsThreeRequests()
    {
        int port = FreePort();
        var counting = new CountingStore(105, new[] { Mode, Card });
        counting.Add(205, new[] { Cycle });

        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);
        net.AddSlave(factory.CreateSlave(1, counting));
        _ = net.ListenAsync();

        try
        {
            using var reader = new PlcReader(Cfg(port, 105, 106, 205).Plc);
            reader.Read();

            Assert.Equal(3, counting.Calls);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // מאגר שסופר כמה בקשות קריאה הגיעו וכמה רגיסטרים כל אחת ביקשה.
    private sealed class CountingStore : ISlaveDataStore
    {
        private readonly Dictionary<ushort, ushort> _values = new();
        public int Calls { get; private set; }
        public int LastCount { get; private set; }

        public CountingStore(ushort start, ushort[] values) => Add(start, values);

        public void Add(ushort start, ushort[] values)
        {
            for (ushort i = 0; i < values.Length; i++) _values[(ushort)(start + i)] = values[i];
        }

        private sealed class Src : IPointSource<ushort>
        {
            private readonly CountingStore _o;
            public Src(CountingStore o) => _o = o;

            public ushort[] ReadPoints(ushort startAddress, ushort numberOfPoints)
            {
                _o.Calls++;
                _o.LastCount = numberOfPoints;
                var r = new ushort[numberOfPoints];
                for (ushort i = 0; i < numberOfPoints; i++)
                    r[i] = _o._values.TryGetValue((ushort)(startAddress + i), out ushort v) ? v : (ushort)0;
                return r;
            }

            public void WritePoints(ushort startAddress, ushort[] points) { }
        }

        private IPointSource<ushort>? _src;
        private IPointSource<ushort> Source => _src ??= new Src(this);

        public IPointSource<ushort> InputRegisters => Source;
        public IPointSource<ushort> HoldingRegisters => Source;
        public IPointSource<bool> CoilDiscretes { get; } = new NModbus.Data.SlaveDataStore().CoilDiscretes;
        public IPointSource<bool> CoilInputs { get; } = new NModbus.Data.SlaveDataStore().CoilInputs;
    }

    // ============================================================
    // ⚠️ טווח רחב — חוזרים לקריאות נפרדות, ולא קוראים 200 רגיסטרים
    // ============================================================
    // טווח אינו מספר: `MODE=105 Cycle=205` הם 101 כתובות, מעל תקרת
    // ה-125 של Modbus בחלק מהבקרים, וגם קריאה של מאה כתובות שאיש לא
    // ביקש — שחלקן עלולות לא להיות ממופות ולהחזיר שגיאה.
    [Fact]
    public void AWideSpanFallsBackToSeparateReads()
    {
        int port = FreePort();
        var sock = new UdpClient(port);
        var factory = new ModbusFactory();
        IModbusSlaveNetwork net = factory.CreateSlaveNetwork(sock);

        var st = new NModbus.Data.SlaveDataStore();
        st.InputRegisters.WritePoints(105, new[] { Mode, Card });
        st.InputRegisters.WritePoints(205, new[] { Cycle });
        net.AddSlave(factory.CreateSlave(1, st));
        _ = net.ListenAsync();

        try
        {
            using var reader = new PlcReader(Cfg(port, 105, 106, 205).Plc);
            PlcReading r = reader.Read()!;

            Assert.Equal(Mode, r.Mode);
            Assert.Equal(Card.ToString(), r.CardNumber);
            Assert.Equal(Cycle, r.CycleCounter);
        }
        finally { net.Dispose(); sock.Dispose(); }
    }

    // ============================================================
    // ⚠️ כשל קריאה חייב לומר **מה נוסה** — זו הייתה התלונה מהשטח
    // ============================================================
    // הלוג באתר 2222 אמר בדיוק זאת, שוב ושוב:
    //
    //     [WRN] Worker: PLC read failed: Index was outside the bounds of the array.
    //
    // אין בה בקר, אין כתובת, אין תעבורה, אין FC ואין רגיסטר. שורת
    // ‏"PLC target" נכתבת פעם אחת בעלייה, ובקובץ שהתגלגל היא כבר איננה.
    //
    // ⚠️ **וכאן הייתה בדיקה שלא הוכיחה כלום.** היא הפעילה סלייב שמחזיר
    // פחות רגיסטרים ממה שהתבקש ודרשה שההודעה לא תהיה "Index was outside" —
    // אבל NModbus דוחה מסגרת קצרה בעצמה
    // (`Unexpected byte count. Expected 6, received 2`), ולכן היא עברה
    // ירוקה **גם כשהשומר בקוד בוטל**. מוטציה חשפה את זה.
    //
    // הטענה שכן ניתנת לבדיקה: יעד שאין מאחוריו דבר נכשל ב-timeout, וההודעה
    // שמגיעה ל-Worker נושאת את התעבורה, הכתובת, ה-FC ושלושת הרגיסטרים.
    [Fact]
    public void AFailedReadNamesTheTargetAndTheRegisters()
    {
        // פורט פנוי שאיש אינו מאזין בו — כשל אמיתי, בלי סלייב.
        int port = FreePort();
        using var reader = new PlcReader(Cfg(port, 106, 107, 105).Plc);

        Exception? ex = Record.Exception(() => reader.Read());

        Assert.NotNull(ex);
        Assert.Contains("127.0.0.1:" + port, ex!.Message);
        Assert.Contains("UDP", ex.Message);
        Assert.Contains("FC=0x04", ex.Message);
        Assert.Contains("MODE=106", ex.Message);
        Assert.Contains("Card=107", ex.Message);
        Assert.Contains("Cycle=105", ex.Message);

        // ⚠️ והסיבה המקורית אינה נבלעת — בלעדיה נשאר תיאור יעד בלי כשל.
        Assert.NotNull(ex.InnerException);
    }

    // ⚠️ וכל תמורה של אותן שלוש כתובות חייבת לעבוד — הסדר אינו אמור
    // להיות משמעותי כלל, וזו בדיוק ההנחה שנשברה.
    [Theory]
    [InlineData(105, 106, 107)]
    [InlineData(105, 107, 106)]
    [InlineData(106, 105, 107)]
    [InlineData(106, 107, 105)]
    [InlineData(107, 105, 106)]
    [InlineData(107, 106, 105)]
    public void EveryOrderingOfTheSameThreeAddressesReads(int mode, int card, int cycle)
    {
        int port = FreePort();
        WithSlave(port, () =>
        {
            using var reader = new PlcReader(Cfg(port, mode, card, cycle).Plc);
            PlcReading r = reader.Read()!;

            ushort[] byAddr = { Cycle, Mode, Card };   // 105, 106, 107
            Assert.Equal(byAddr[mode - 105], r.Mode);
            Assert.Equal(byAddr[card - 105].ToString(), r.CardNumber);
            Assert.Equal(byAddr[cycle - 105], r.CycleCounter);
        });
    }
}
