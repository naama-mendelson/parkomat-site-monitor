using System.Text.Json;
using System.Text;
using System.Net.Http;
using System.Net.Sockets;
using NModbus;
using Parkomat.Agent.Core.Modbus;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Core.Supabase;

namespace Parkomat.Agent.Tray.Services;

/// <summary>
/// תוצאת בדיקת חיבור: הצלחה/כשל + הודעה קריאה בעברית לטכנאי.
/// </summary>
public class TestResult
{
    public bool Success { get; init; }
    public string Message { get; init; } = "";
}

/// <summary>
/// בודק על-פי דרישה, מתוך ה-Tray, את מה שחשוב לטכנאי:
///  1. מזהה האתר.
///  2. ה-PLC (Modbus) — האם הבקר בכלל נגיש וקורא.
///  3. הדיווח לדשבורד (Supabase) — הזדהות אמיתית, בלי לכתוב דבר.
/// הבדיקות אף פעם לא זורקות — הן תמיד מחזירות TestResult.
///
/// ⚠️ **בדיקת HiveMQ הוסרה (1.0.57).** ‏master — השרת היחיד שקרא מ-HiveMQ —
/// כבוי מ-17/09/2026, ו-MQTT כבוי ממילא בכל אתר עם סיסמת Supabase. באתר
/// 2431 (04/10) היא הציגה שגיאת DNS באדום על מסלול שאיש אינו קורא, ובאותו
/// חלון בדיקת Supabase — החשובה — נחתכה מתחתית המסך.
/// </summary>
public static class ConnectionTester
{
    private const int PlcTimeoutSeconds = 5;

    // ============================================================
    // מזהה האתר — הבדיקה שהייתה חסרה, וזו שעלתה הכי ביוקר
    // ============================================================
    // ⚠️ שתי הבדיקות האחרות ירוקות **גם כשהמזהה ריק.** הן בודקות רשת:
    // האם הבקר עונה, והאם יש חיבור לענן (אז HiveMQ). אף אחת מהן אינה נוגעת
    // בנושא (topic) שאליו ההודעות ישודרו — ולכן שתיהן מצליחות בכנות בזמן
    // שההודעות הולכות ל-`sites//state` ואיש אינו מקשיב שם.
    //
    // זהו הכשל הגרוע ביותר במערכת הזו: **כל שכבה מדווחת הצלחה אמיתית,
    // ואף אחת לא בודקת לאן.** בשטח הוא נראה כתעלומה ולא כתקלה — "בבקר
    // כתוב שיש תקשורת, בדשבורד כתוב שאין".
    //
    // הבדיקה כאן היא סינכרונית ומיידית: אין מה לחכות לו, וזו בדיוק
    // הסיבה שאין שום תירוץ לא להריץ אותה.
    // ⚠️ הכלל עצמו חי ב-SiteIdRule (Core) ולא כאן — אותו כלל בדיוק משמש
    // את השירות בעלייה ואת טופס ההגדרות. כאן רק עוטפים אותו בצורה שהחלון
    // יודע להציג.
    public static TestResult TestSiteId(SiteConfig config)
    {
        SiteIdCheck check = SiteIdRule.Check(config.SiteId);
        return new TestResult { Success = check.IsValid, Message = check.Message };
    }

    // ============================================================
    // ⚠️ הבדיקה מדברת את מה שהאתר מדבר — ולא TCP/FC04 תמיד
    // ============================================================
    // היא פתחה `TcpClient` וקראה `ReadInputRegisters` בקשיחות, בלי
    // להסתכל על `Transport` ועל `FunctionCode`. כלומר היא **מובטחת
    // לשקר בדיוק באתרים שבשבילם שתי התכונות האלה נבנו**:
    //
    //   • בקר UDP-בלבד מחזיר לניסיון חיבור TCP את
    //     "No connection could be made because the target machine
    //     actively refused it" — Windows 10061. נצפה באתר 2222.
    //   • בקר שחושף רק Holding Registers דוחה FC 04, גם כשהחיבור תקין.
    //
    // ⚠️ ובשני המקרים **הסוכן עצמו עובד** — `PlcReader` כן מכבד את שתי
    // ההגדרות. רק המסך שאמור לאמת אותו שיקר, וזו בדיוק אזהרה שקרית
    // ששולחת טכנאי לחפש תקלה שאינה קיימת.
    /// <summary>
    /// בודק חיבור ל-PLC בתעבורה ובפקודה שהאתר מוגדר להן, עם timeout ~5 שניות.
    /// </summary>
    public static Task<TestResult> TestPlcAsync(PlcConfig plc)
    {
        // NModbus סינכרוני — מריצים על thread רקע כדי לא לתקוע את ה-UI.
        return Task.Run(() =>
        {
            if (string.IsNullOrWhiteSpace(plc.IpAddress))
                return new TestResult { Success = false, Message = "לא הוגדרה כתובת IP ל-PLC בהגדרות." };

            string how = $"{(plc.UseUdp ? "UDP" : "TCP")} {plc.IpAddress}:{plc.Port}, "
                       + $"FC=0x{(plc.UseHoldingRegisters ? "03" : "04")}, register {plc.ModeRegister}";

            TcpClient? tcp = null;
            UdpClient? udp = null;

            try
            {
                IModbusMaster master;
                var factory = new ModbusFactory();

                if (plc.UseUdp)
                {
                    // ============================================================
                    // ⚠️ אותו ערוץ שהסוכן משתמש בו — ולא NModbus
                    // ============================================================
                    // באתר 2222 הבקר שולח כותרת MBAP עם אורך אפס, ו-NModbus
                    // נשברת עליה. בדיקה שמדברת NModbus הייתה מדווחת כישלון על
                    // חיבור תקין לחלוטין — כלומר בדיוק אותה אזהרה שקרית שכבר
                    // שלחה טכנאי לחפש תקלה שאינה קיימת, רק בשכבה אחרת.
                    //
                    // ⚠️ **הבדיקה חייבת לדבר את מה שהסוכן מדבר.** זו כל תכליתה.
                    using var channel = new ModbusUdpChannel(plc.IpAddress, plc.Port, PlcTimeoutSeconds * 1000);
                    channel.ReadRegisters(1, plc.UseHoldingRegisters, plc.ModeRegister, 1);

                    // ⚠️ **והמערכת השנייה נבדקת בנפרד.** בדיקה שקוראת רק את
                    // ה-MODE הראשון הייתה מחזירה ירוק על אתר שהוקלדה בו
                    // כתובת שגויה ל-293/294 — כלומר מערכת שלמה שלא תדווח
                    // לעולם, ברגע היחיד שבו מישהו עומד באתר ויכול לתקן.
                    if (plc.HasSecondSystem)
                    {
                        channel.ReadRegisters(1, plc.UseHoldingRegisters, plc.ModeRegister2, 1);
                        channel.ReadRegisters(1, plc.UseHoldingRegisters, plc.CardRegister2, 1);
                    }

                    return new TestResult
                    {
                        Success = true,
                        Message = $"מחובר ל-PLC — {how}. הקריאה הצליחה."
                               + (plc.HasSecondSystem
                                    ? $" שתי מערכות: MODE {plc.ModeRegister}/{plc.ModeRegister2}."
                                    : "")
                    };
                }

                {
                    tcp = new TcpClient();
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(PlcTimeoutSeconds));
                    try
                    {
                        tcp.ConnectAsync(plc.IpAddress, plc.Port, cts.Token).AsTask().GetAwaiter().GetResult();
                    }
                    catch (OperationCanceledException)
                    {
                        return new TestResult
                        {
                            Success = false,
                            Message = $"פסק זמן: אין תגובה מ-{plc.IpAddress}:{plc.Port} תוך {PlcTimeoutSeconds} שניות."
                        };
                    }

                    tcp.ReceiveTimeout = PlcTimeoutSeconds * 1000;
                    tcp.SendTimeout = PlcTimeoutSeconds * 1000;
                    master = factory.CreateMaster(tcp);
                }

                master.Transport.ReadTimeout = PlcTimeoutSeconds * 1000;
                master.Transport.WriteTimeout = PlcTimeoutSeconds * 1000;

                // ⚠️ **אותה פקודה שהסוכן ישתמש בה.** בדיקה שקוראת FC 04
                // באתר שמוגדר ל-FC 03 נכשלת על חיבור תקין לחלוטין.
                if (plc.UseHoldingRegisters)
                    master.ReadHoldingRegisters(1, (ushort)plc.ModeRegister, 1);
                else
                    master.ReadInputRegisters(1, (ushort)plc.ModeRegister, 1);

                return new TestResult
                {
                    Success = true,
                    Message = $"מחובר ל-PLC — {how}. הקריאה הצליחה."
                };
            }
            catch (Exception ex)
            {
                // ⚠️ ההודעה נושאת את **מה שנוסה**, לא רק את הכישלון. "החיבור
                // נכשל" לבדו שולח לבדוק כתובת, בזמן שהסיבה הנפוצה היא
                // שהבקר מדבר UDP או FC אחר — ואת זה אי אפשר לנחש מהטקסט.
                string hint = plc.UseUdp
                    ? ""
                    : " — אם הבקר מדבר UDP בלבד, יש לשנות זאת בהגדרות → רגיסטרים.";

                return new TestResult
                {
                    Success = false,
                    Message = $"החיבור ל-PLC נכשל ({how}): {Describe(ex)}{hint}"
                };
            }
            finally
            {
                tcp?.Dispose();
                udp?.Dispose();
            }
        });
    }

    /// <summary>בודק את המסלול הישיר: הזדהות מול Supabase, בלי לכתוב דבר.</summary>
    public static async Task<TestResult> TestSupabaseAsync(SiteConfig config)
    {
        SupabaseConfig sb = config.Supabase;

        // ⚠️ **אדום, ולא "מדולג".** מאז ש-master כבוי (17/09/2026) זה המסלול
        // היחיד שמגיע לדשבורד — אתר בלי סיסמה אינו מדווח לשום מקום, וזה
        // בדיוק מה שהטכנאי צריך לגלות כשהוא עוד עומד באתר.
        if (!sb.Enabled)
            return new TestResult
            {
                Success = false,
                Message = "לא הוזנה סיסמת Supabase — האתר אינו מדווח לדשבורד. " +
                          "יש להזין אותה בהגדרות → Supabase."
            };

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            using var req = new HttpRequestMessage(HttpMethod.Post,
                $"{sb.EffectiveUrl.TrimEnd('/')}/auth/v1/token?grant_type=password");
            req.Headers.Add("apikey", sb.EffectiveAnonKey);
            req.Content = new StringContent(
                JsonSerializer.Serialize(new { email = sb.EffectiveEmail, password = sb.Password }),
                Encoding.UTF8, "application/json");

            using HttpResponseMessage res = await http.SendAsync(req).ConfigureAwait(false);
            string body = await res.Content.ReadAsStringAsync().ConfigureAwait(false);

            if (res.IsSuccessStatusCode)
                return new TestResult
                {
                    Success = true,
                    Message = $"המסלול הישיר תקין — הזדהות כ-{sb.EffectiveEmail} הצליחה."
                };

            // ⚠️ הודעה שמפרידה בין הסיבות. "נכשל" סתם שולח לחפש בכל
            // מקום; קוד האתר השגוי הוא הטעות הנפוצה, כי האימייל נגזר
            // ממנו — וזה בדיוק מה שקרה באתר 1326.
            string hint = body.Contains("invalid_credentials", StringComparison.OrdinalIgnoreCase)
                       || body.Contains("Invalid login", StringComparison.OrdinalIgnoreCase)
                ? $" — הסיסמה שגויה, או שקוד האתר בהגדרות אינו {config.SiteId}."
                : "";

            return new TestResult
            {
                Success = false,
                Message = $"Supabase דחה את ההזדהות ({(int)res.StatusCode}){hint}"
            };
        }
        catch (TaskCanceledException)
        {
            return new TestResult { Success = false, Message = "פסק זמן: אין תגובה מ-Supabase תוך 15 שניות — ייתכן שהרשת חוסמת יציאה ב-443." };
        }
        catch (Exception ex)
        {
            // ⚠️ הסבר לפי קוד ה-Socket (DNS / חומת אש / חסימה), ולא משפט של Winsock.
            return new TestResult { Success = false, Message = $"החיבור ל-Supabase נכשל: {NetworkFailure.Describe(ex)}" };
        }
    }

    // מחלץ סיבה קריאה מהחריגה (כולל חריגות מקוננות, כמו SocketException מתחת ל-TLS).
    private static string Describe(Exception ex) => ex.GetBaseException().Message;
}
