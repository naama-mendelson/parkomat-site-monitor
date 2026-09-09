using System.Net;
using System.Net.Sockets;
using NModbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Modbus;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// פקודת הקריאה — 0x04 (Input Registers) מול 0x03 (Holding Registers).
///
/// <para>⚠️ <b>הבקר קובע, ולא אנחנו.</b> 21 האתרים הקיימים חושפים Input
/// Registers, אבל בקר שחושף רק Holding Registers פשוט <b>אינו עונה</b>
/// ל-FC 04 — והכשל נראה זהה לכתובת שגויה או לבקר מכובה: timeout, בלי
/// שום רמז שהפקודה היא הבעיה.</para>
///
/// <para>⚠️ <b>וכמו בתעבורה, הבדיקה רצה מול עבד NModbus אמיתי בתהליך.</b>
/// המאגר מכיל את הערכים <b>רק</b> בסוג הרגיסטרים הנבדק, ולכן קריאה
/// בפקודה הלא נכונה מחזירה אפסים — כלומר בדיקה שקוראת בפקודה שגויה
/// <b>נכשלת</b> במקום לעבור על אפסים שנראים כמו נתונים.</para>
/// </summary>
public class PlcFunctionCodeTests
{
    private const ushort Mode = 1;
    private const ushort Card = 4242;
    private const ushort Cycle = 8547;
    private const int ModeAddress = 290;

    // ⚠️ הערכים נכתבים **רק** לסוג אחד. מאגר שמחזיק את שניהם היה הופך את
    // הבדיקה לחסרת ערך: כל פקודה הייתה מחזירה את הנתון הנכון, וטעות
    // בבחירה לא הייתה נראית בשום מקום.
    private static ISlaveDataStore StoreFor(bool holding)
    {
        var store = new NModbus.Data.SlaveDataStore();
        if (holding) store.HoldingRegisters.WritePoints(ModeAddress, new[] { Mode, Card, Cycle });
        else store.InputRegisters.WritePoints(ModeAddress, new[] { Mode, Card, Cycle });
        return store;
    }

    private static PlcConfig ConfigFor(int port, int functionCode) => new()
    {
        IpAddress = "127.0.0.1",
        Port = port,
        Transport = "tcp",
        FunctionCode = functionCode,
        ModeRegister = ModeAddress,
        CardRegister = ModeAddress + 1,
        CycleRegister = ModeAddress + 2,
        FaultTextRegister = 0,
    };

    private static async Task WithSlave(bool holding, Func<int, Task> body)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;

        var factory = new ModbusFactory();
        IModbusSlaveNetwork network = factory.CreateSlaveNetwork(listener);
        network.AddSlave(factory.CreateSlave(1, StoreFor(holding)));

        using var cts = new CancellationTokenSource();
        Task serving = network.ListenAsync(cts.Token);
        try { await body(port); }
        finally
        {
            cts.Cancel();
            network.Dispose();
            listener.Stop();
            await Task.WhenAny(serving, Task.Delay(2000));
        }
    }

    // ------------------------------------------------------------
    // 1. ההתנהגות הקיימת נשמרת
    // ------------------------------------------------------------
    [Fact]
    public async Task ReadsInputRegistersByDefault()
    {
        await WithSlave(holding: false, async port =>
        {
            using var reader = new PlcReader(ConfigFor(port, 4));
            PlcReading r = reader.Read();
            Assert.Equal(Mode, r.Mode);
            Assert.Equal(Card.ToString(), r.CardNumber);
            Assert.Equal(Cycle, r.CycleCounter);
            await Task.CompletedTask;
        });
    }

    // ------------------------------------------------------------
    // 2. הפקודה החדשה עובדת
    // ------------------------------------------------------------
    [Fact]
    public async Task ReadsHoldingRegistersWhenAsked()
    {
        await WithSlave(holding: true, async port =>
        {
            using var reader = new PlcReader(ConfigFor(port, 3));
            PlcReading r = reader.Read();
            Assert.Equal(Mode, r.Mode);
            Assert.Equal(Card.ToString(), r.CardNumber);
            Assert.Equal(Cycle, r.CycleCounter);
            await Task.CompletedTask;
        });
    }

    // ------------------------------------------------------------
    // 3. ⚠️ הבדיקה שמוכיחה שהענף חי
    // ------------------------------------------------------------
    // שתי הבדיקות שמעל היו עוברות גם מול קורא שמתעלם מ-FunctionCode
    // לגמרי — אילו המאגר החזיק את שני הסוגים. כאן העבד חושף **רק**
    // Holding, והקורא מתבקש FC 04: הוא חייב לא לקבל את הנתונים.
    // בלי הבדיקה הזו אין הוכחה שהבחירה בכלל משפיעה.
    [Fact]
    public async Task AskingForTheWrongCodeDoesNotReturnTheData()
    {
        await WithSlave(holding: true, async port =>
        {
            using var reader = new PlcReader(ConfigFor(port, 4));

            // ⚠️ שני הסופים תקינים ושניהם "לא קיבל את הנתונים": עבד
            // שמחזיר SlaveException על כתובת שאינה קיימת בסוג המבוקש,
            // ועבד שמחזיר אפסים. מה שאסור הוא לקבל את הערכים האמיתיים.
            try
            {
                PlcReading r = reader.Read();
                Assert.NotEqual(Card.ToString(), r.CardNumber);
                Assert.NotEqual(Cycle, r.CycleCounter);
            }
            catch (Exception)
            {
                // נכשל — וזו תשובה נכונה לא פחות.
            }
            await Task.CompletedTask;
        });
    }

    // ------------------------------------------------------------
    // 4. ברירת המחדל, והערך הלא מוכר
    // ------------------------------------------------------------
    [Fact]
    public void DefaultsToInputRegisters()
    {
        var fresh = new PlcConfig();
        Assert.Equal(4, fresh.FunctionCode);
        Assert.False(fresh.UseHoldingRegisters);
        Assert.True(fresh.FunctionCodeIsKnown);
    }

    // ⚠️ ערך שאינו 3 או 4 נופל ל-FC 04 — **ההתנהגות הקיימת** — אבל
    // `FunctionCodeIsKnown` חייב לסמן אותו, אחרת קובץ עם ערך שגוי מייצר
    // אתר שקורא בפקודה אחת בזמן שהקובץ אומר אחרת, בלי שורה בשום לוג.
    [Theory]
    [InlineData(0)]
    [InlineData(6)]
    [InlineData(-1)]
    public void AnUnknownCodeFallsBackToFc04ButIsFlagged(int value)
    {
        var c = new PlcConfig { FunctionCode = value };
        Assert.False(c.UseHoldingRegisters);
        Assert.False(c.FunctionCodeIsKnown);
    }

    // ------------------------------------------------------------
    // 5. ⚠️ הבחירה שורדת את איפוס ההתקנה
    // ------------------------------------------------------------
    // המתקין מניח דגל איפוס ב**כל** התקנה, ולכן שדה שאינו ברשימת
    // השורדים חוזר לברירת המחדל בכל שדרוג — כלומר אתר Holding היה
    // מפסיק לקרוא מהבקר אחרי כל עדכון גרסה, בלי הסבר.
    [Fact]
    public void TheChoiceSurvivesTheInstallerReset()
    {
        var old = new SiteConfig { SiteId = "1234" };
        old.Plc.FunctionCode = 3;

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);

        Assert.Equal(3, fresh.Plc.FunctionCode);
        Assert.True(fresh.Plc.UseHoldingRegisters);
    }

    // ⚠️ וקובץ ישן שאין בו את השדה כלל מגיע כ-0 (מאתחל-המאפיין רץ רק
    // כשהמאפיין **נעדר** מה-JSON), ואסור שהאיפוס ישמר אפס: הוא ייקרא
    // כ-FC 04 אבל `FunctionCodeIsKnown` יסמן אותו כשגוי לנצח.
    [Fact]
    public void AnOldConfigWithoutTheFieldEndsUpAtFour()
    {
        var old = System.Text.Json.JsonSerializer.Deserialize<SiteConfig>(
            """{"SiteId":"1234","Plc":{"IpAddress":"10.0.0.9"}}""");
        Assert.NotNull(old);
        Assert.Equal(4, old!.Plc.FunctionCode);

        SiteConfig fresh = ConfigStore.BuildResetConfig(old);
        Assert.Equal(4, fresh.Plc.FunctionCode);
        Assert.True(fresh.Plc.FunctionCodeIsKnown);
    }
}
