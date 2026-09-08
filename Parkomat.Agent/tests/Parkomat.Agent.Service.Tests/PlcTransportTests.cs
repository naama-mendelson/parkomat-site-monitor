using System.Net;
using System.Net.Sockets;
using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// קריאה אמיתית מ-PLC — מעל TCP ומעל UDP — מול עבד Modbus שרץ בתוך הבדיקה.
///
/// ============================================================
/// ⚠️ למה זו בדיקה התנהגותית ולא מבנית, בניגוד לרוב הקובץ הזה
/// ============================================================
/// NModbus יודעת להיות גם <b>עבד</b> (<c>CreateSlaveNetwork</c>), ולכן אפשר
/// להרים PLC מדומה על localhost ולקרוא ממנו — בלי חומרה ובלי אתר. זו
/// ההזדמנות היחידה בפרויקט הזה לבדוק את <c>PlcReader</c> באמת.
///
/// ⚠️ <b>ולנתיב ה-TCP לא הייתה עד היום שום בדיקה בכלל</b> — הוא הנתיב
/// שכל 21 האתרים רצים עליו. הוספת UDP היא מה שאילץ להרים את התשתית הזו,
/// והרווח הראשון הוא דווקא כיסוי למה שכבר עובד: מעכשיו שינוי ב-PlcReader
/// שישבור את TCP ייתפס כאן ולא באתר.
///
/// ⚠️ <b>שלושת הרגיסטרים נקראים בסיבוב אחד</b> כשהכתובות רצופות (ראה
/// <c>PlcReader.Read</c>), וזה נבדק כאן ממש: הערכים חייבים לחזור כשלישייה
/// עקבית. ב-UDP זה קריטי במיוחד, כי שם אין הבטחת סדר והספרייה היא זו
/// שמתאימה תשובות לפי מזהה הטרנזקציה.
/// </summary>
public class PlcTransportTests
{
    // MODE=1 (ready), כרטיס 4242, מונה 8547 — ערכים מובחנים זה מזה, כדי
    // שהחלפה בין רגיסטרים תיראה מיד ולא תתחבא מאחורי אפסים.
    private const ushort Mode = 1;
    private const ushort Card = 4242;
    private const ushort Cycle = 8547;

    private const int ModeAddress = 290;

    /// <summary>
    /// בונה מאגר נתונים של עבד עם שלושת הרגיסטרים במקומם.
    /// ⚠️ <c>InputRegisters</c> ולא <c>HoldingRegisters</c>: הסוכן קורא
    /// ב-FC 04, ומאגר שגוי היה מחזיר אפסים — כלומר בדיקה "עוברת" על
    /// קריאה שאינה קוראת דבר.
    /// </summary>
    private static ISlaveDataStore BuildStore()
    {
        var store = new NModbus.Data.SlaveDataStore();
        store.InputRegisters.WritePoints(ModeAddress, new[] { Mode, Card, Cycle });
        return store;
    }

    private static PlcConfig ConfigFor(int port, string transport) => new()
    {
        IpAddress = "127.0.0.1",
        Port = port,
        Transport = transport,
        ModeRegister = ModeAddress,
        CardRegister = ModeAddress + 1,
        CycleRegister = ModeAddress + 2,
        // ⚠️ טקסט התקלה מכובה: העבד המדומה אינו מחזיק את המחרוזת, וקריאה
        // ממנו הייתה מכשילה את הבדיקה על משהו שאינו נושא הבדיקה.
        FaultTextRegister = 0,
    };

    // פורט פנוי שהמערכת מקצה, כדי ששתי בדיקות במקביל לא יתנגשו זו בזו.
    private static int FreeTcpPort()
    {
        var l = new TcpListener(IPAddress.Loopback, 0);
        l.Start();
        int port = ((IPEndPoint)l.LocalEndpoint).Port;
        l.Stop();
        return port;
    }

    private static int FreeUdpPort()
    {
        using var u = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)u.Client.LocalEndPoint!).Port;
    }

    private static void AssertReadsCorrectly(PlcConfig config)
    {
        using var reader = new PlcReader(config);
        PlcReading reading = reader.Read();

        Assert.Equal(Mode, reading.Mode);
        Assert.Equal(Card.ToString(), reading.CardNumber);
        Assert.Equal(Cycle, reading.CycleCounter);
    }

    [Fact]
    public async Task ReadsOverUdp()
    {
        int port = FreeUdpPort();
        using var listener = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));

        var factory = new ModbusFactory();
        IModbusSlaveNetwork network = factory.CreateSlaveNetwork(listener);
        network.AddSlave(factory.CreateSlave(1, BuildStore()));

        using var cts = new CancellationTokenSource();
        Task serving = network.ListenAsync(cts.Token);

        try
        {
            AssertReadsCorrectly(ConfigFor(port, "udp"));
        }
        finally
        {
            cts.Cancel();
            network.Dispose();
            await Task.WhenAny(serving, Task.Delay(2000));
        }
    }

    [Fact]
    public async Task ReadsOverTcp()
    {
        int port = FreeTcpPort();
        var listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();

        var factory = new ModbusFactory();
        IModbusSlaveNetwork network = factory.CreateSlaveNetwork(listener);
        network.AddSlave(factory.CreateSlave(1, BuildStore()));

        using var cts = new CancellationTokenSource();
        Task serving = network.ListenAsync(cts.Token);

        try
        {
            AssertReadsCorrectly(ConfigFor(port, "tcp"));
        }
        finally
        {
            cts.Cancel();
            network.Dispose();
            listener.Stop();
            await Task.WhenAny(serving, Task.Delay(2000));
        }
    }

    /// <summary>
    /// ⚠️ <b>הבדיקה שמוכיחה שהבחירה באמת נאכפת.</b> שתי הבדיקות למעלה היו
    /// עוברות גם אם <c>PlcReader</c> היה מתעלם מ-<c>Transport</c> ופותח TCP
    /// תמיד — כי כל אחת מהן מרימה רק את העבד שהיא בודקת ו"במקרה" מצליחה.
    ///
    /// כאן מרימים עבד <b>UDP בלבד</b> ומבקשים <b>TCP</b> על אותו פורט: אם
    /// הבחירה מכובדת, אין מאזין TCP והקריאה חייבת להיכשל. סוכן שמתעלם
    /// מההגדרה היה מצליח כאן — וזו בדיוק המוטציה שאין דרך אחרת לתפוס.
    /// </summary>
    [Fact]
    public async Task TheTransportChoiceIsActuallyHonoured()
    {
        int port = FreeUdpPort();
        using var listener = new UdpClient(new IPEndPoint(IPAddress.Loopback, port));

        var factory = new ModbusFactory();
        IModbusSlaveNetwork network = factory.CreateSlaveNetwork(listener);
        network.AddSlave(factory.CreateSlave(1, BuildStore()));

        using var cts = new CancellationTokenSource();
        Task serving = network.ListenAsync(cts.Token);

        try
        {
            // UDP עובד — כלומר העבד באמת חי, והכישלון למטה אינו "לא הרמנו כלום".
            AssertReadsCorrectly(ConfigFor(port, "udp"));

            using var tcpReader = new PlcReader(ConfigFor(port, "tcp"));
            Assert.ThrowsAny<Exception>(() => tcpReader.Read());
        }
        finally
        {
            cts.Cancel();
            network.Dispose();
            await Task.WhenAny(serving, Task.Delay(2000));
        }
    }

    // ============================================================
    // תזמון כשל — היחס שכבר עלה לנו פעם אחת
    // ============================================================

    /// <summary>
    /// ⚠️ <b>קריאה שנכשלה ב-UDP חייבת לעלות כמו ב-TCP.</b>
    ///
    /// סימן החיות נכתב בראש כל סבב (<c>Worker.WriteLiveness</c>), ולכן המרווח
    /// בין שני סימני חיים הוא אורך סבב — שנשלט על ידי קריאת PLC
    /// שנכשלת. ה-watchdog מכריז "תקוע" אחרי 30 שניות.
    ///
    /// בלי החלוקה שב-<c>UdpAttemptTimeoutMs</c>, NModbus מנסה 4 פעמים ב-3
    /// שניות כל אחת — <b>נמדד: 12,830ms מול 3,010ms ב-TCP</b>. עדיין מתחת
    /// ל-30, אבל המרווח מצטמצם מ-27 שניות ל-17. וזה בדיוק היחס שכבר
    /// הרג דיווח תקלות פעם אחת (ראה <c>WatchdogVsPlcErrorTests</c>): הסוכן
    /// נהרג 12 שניות לפני שהספיק לדווח, וההריגה איפסה את מונה הכשלים.
    ///
    /// ⚠️ הסף נדיב (פי שניים מהתקרה), כדי שמכונת בנייה עמוסה לא
    /// תצבע אדום על קוד תקין. הוא עדיין תופס את הרגרסיה שהוא קיים
    /// בשבילה — חזרה ל-3 שניות לניסיון מייצרת ~12.8 שניות.
    /// </summary>
    [Fact]
    public void AFailedUdpReadCostsNoMoreThanAFailedTcpRead()
    {
        // כתובת לא ניתנת לניתוב (RFC 5737 היה עדיף, אבל 10.255.255.1
        // נותן התנהגות timeout עקבית ב-Windows).
        var cfg = new PlcConfig
        {
            IpAddress = "10.255.255.1",
            Port = 502,
            Transport = "udp",
            ModeRegister = 290,
            CardRegister = 291,
            CycleRegister = 292,
            FaultTextRegister = 0,
        };

        using var reader = new PlcReader(cfg);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        Assert.ThrowsAny<Exception>(() => reader.Read());
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds < 6000,
            $"קריאה שנכשלה ב-UDP לקחה {sw.ElapsedMilliseconds}ms — הסבב מתארך, "
          + "וה-watchdog עלול להרוג את הסוכן לפני שידווח תקלת PLC");
    }

    // ============================================================
    // פענוח הערך שבקובץ
    // ============================================================

    [Theory]
    [InlineData("udp")]
    [InlineData("UDP")]
    [InlineData(" udp ")]
    [InlineData("Udp")]
    public void UdpIsRecognisedRegardlessOfSpacingAndCase(string value)
    {
        var plc = new PlcConfig { Transport = value };
        Assert.True(plc.UseUdp);
        Assert.True(plc.TransportIsKnown);
    }

    [Theory]
    [InlineData("tcp")]
    [InlineData("TCP")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void EverythingElseKnownMeansTcp(string? value)
    {
        var plc = new PlcConfig { Transport = value! };
        Assert.False(plc.UseUdp);
        Assert.True(plc.TransportIsKnown);
    }

    /// <summary>
    /// ⚠️ ערך פגום נופל ל-TCP — <b>ההתנהגות הקיימת</b> — ולא ל-UDP ולא
    /// לקריסה. אבל <c>TransportIsKnown</c> חייב להיות false, כי זה מה
    /// שגורם ל-<c>Worker</c> לכתוב אזהרה. בלי החלק השני, קובץ שכתוב בו
    /// "tcp/udp" היה מייצר אתר שקורא TCP בשקט מוחלט, ואי אפשר לאבחן
    /// מרחוק פער בין מה שכתוב למה שקורה.
    /// </summary>
    [Theory]
    [InlineData("udp4")]
    [InlineData("tcp/udp")]
    [InlineData("rtu")]
    [InlineData("garbage")]
    public void AnUnknownValueFallsBackToTcpButIsReportedAsUnknown(string value)
    {
        var plc = new PlcConfig { Transport = value };
        Assert.False(plc.UseUdp);
        Assert.False(plc.TransportIsKnown);
    }

    // ============================================================
    // הישרדות התקנה
    // ============================================================

    /// <summary>
    /// ⚠️ <b>הבדיקה החשובה ביותר בקובץ הזה.</b> המתקין מניח
    /// <c>reset-to-defaults.flag</c> בכל התקנה, ולכן שדה שאינו נשמר
    /// במפורש ב-<c>BuildResetConfig</c> נמחק בכל שדרוג.
    ///
    /// אתר UDP שחזר ל-TCP איננו "אתר עם הגדרה ישנה" — הוא אתר
    /// שאינו קורא מהבקר כלל, ולא נשאר בקובץ שום עקב לכך
    /// שמישהו בחר אחרת. זה הכשל שהתכונה הזו חיה או מתה לפיו.
    /// </summary>
    [Fact]
    public void AnUpgradeDoesNotSilentlyPutAUdpSiteBackOnTcp()
    {
        var configuredInTheField = new SiteConfig { SiteId = "3513" };
        configuredInTheField.Plc.Transport = "udp";

        SiteConfig afterUpgrade = ConfigStore.BuildResetConfig(configuredInTheField);

        Assert.True(afterUpgrade.Plc.UseUdp,
            "שדרוג החזיר אתר UDP ל-TCP — הסוכן לא יקרא מהבקר ואיש לא ידע");
    }

    /// <summary>
    /// והצד השני: שאר הגדרות ה-PLC כן מתאפסות, וזו החלטה
    /// מתועדת (<c>installer.iss</c>: "אילוץ ברירות מחדל בכל התקנה").
    /// נבדק כאן כדי שהשינוי לא יורחב בשקט לכל הבלוק.
    /// </summary>
    [Fact]
    public void ButTheAddressStillResets()
    {
        var old = new SiteConfig { SiteId = "3513" };
        old.Plc.IpAddress = "10.0.0.9";
        old.Plc.Transport = "udp";

        SiteConfig afterUpgrade = ConfigStore.BuildResetConfig(old);

        Assert.Equal(new PlcConfig().IpAddress, afterUpgrade.Plc.IpAddress);
        Assert.True(afterUpgrade.Plc.UseUdp);
    }

    /// <summary>
    /// והערך שורד גם את מעבר ה-JSON — כלומר הוא באמת נכתב
    /// לקובץ ונקרא ממנו. <c>UseUdp</c> מסומן <c>JsonIgnore</c>, ובלי הבדיקה
    /// הזו היה אפשר לסמן בטעות גם את <c>Transport</c> עצמו — ואז הבחירה
    /// עובדת עד האתחול הבא ומתאדית אחריו.
    /// </summary>
    [Fact]
    public void TheChoiceSurvivesTheJsonRoundTrip()
    {
        var original = new SiteConfig { SiteId = "3513" };
        original.Plc.Transport = "udp";

        SiteConfig? back = ConfigStore.FromJson(ConfigStore.ToJson(original));

        Assert.NotNull(back);
        Assert.True(back!.Plc.UseUdp);
    }

    [Fact]
    public void TheDefaultIsTcp()
    {
        // אין כאן "ברירת מחדל חכמה": כל 21 האתרים היום הם TCP, ושדרוג
        // גרסה חייב להשאיר אותם בדיוק כפי שהם.
        var plc = new PlcConfig();
        Assert.Equal("tcp", plc.Transport);
        Assert.False(plc.UseUdp);
    }
}
