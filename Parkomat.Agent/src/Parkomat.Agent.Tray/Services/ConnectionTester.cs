using System.Text.Json;
using System.Text;
using System.Net.Http;
using System.Net.Sockets;
using MQTTnet;
using NModbus;
using Parkomat.Agent.Core.Configuration;

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
/// בודק על-פי דרישה, מתוך ה-Tray, את שני החיבורים שחשובים לטכנאי:
///  1. ה-PLC (Modbus/TCP) — האם הבקר בכלל נגיש וקורא.
///  2. ה-HiveMQ (MQTT + TLS) — חיבור *ישיר* לענן, כי זה מה שהטכנאי צריך לאמת
///     (ה-Agent עצמו עובד דרך Mosquitto מקומי, אז נתק ל-HiveMQ לא נראה משם).
/// שתי הבדיקות אף פעם לא זורקות — הן תמיד מחזירות TestResult.
/// </summary>
public static class ConnectionTester
{
    private const int PlcTimeoutSeconds = 5;
    private const int HiveTimeoutSeconds = 10;

    // ============================================================
    // מזהה האתר — הבדיקה שהייתה חסרה, וזו שעלתה הכי ביוקר
    // ============================================================
    // ⚠️ שתי הבדיקות האחרות ירוקות **גם כשהמזהה ריק.** הן בודקות רשת:
    // האם הבקר עונה, והאם יש חיבור מוצפן ל-HiveMQ. אף אחת מהן אינה נוגעת
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
                    // ⚠️ ל-UDP אין לחיצת יד: `Connect` רק קובע יעד ברירת מחדל
                    // ומצליח גם מול כתובת שאין מאחוריה דבר. הכישלון האמיתי
                    // מתגלה בקריאה עצמה, כ-timeout — ולכן ההודעה למטה מפרידה
                    // בין השניים.
                    udp = new UdpClient();
                    udp.Connect(plc.IpAddress, plc.Port);
                    udp.Client.ReceiveTimeout = PlcTimeoutSeconds * 1000;
                    udp.Client.SendTimeout = PlcTimeoutSeconds * 1000;
                    master = factory.CreateMaster(udp);
                }
                else
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

        if (!sb.Enabled)
            return new TestResult
            {
                Success = false,
                Message = "המסלול הישיר כבוי — לא הוזנה סיסמת Supabase בהגדרות."
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
            return new TestResult { Success = false, Message = "פסק זמן: אין תגובה מ-Supabase תוך 15 שניות." };
        }
        catch (Exception ex)
        {
            return new TestResult { Success = false, Message = $"החיבור ל-Supabase נכשל: {Describe(ex)}" };
        }
    }

    /// <summary>בודק חיבור *ישיר* ל-HiveMQ עם TLS ופרטי ההתחברות מההגדרות, timeout ~10 שניות.</summary>
    public static async Task<TestResult> TestHiveMqAsync(MqttConfig mqtt)
    {
        if (string.IsNullOrWhiteSpace(mqtt.Host))
            return new TestResult { Success = false, Message = "לא הוגדרה כתובת HiveMQ בהגדרות." };

        IMqttClient? client = null;
        try
        {
            client = new MqttClientFactory().CreateMqttClient();

            var optionsBuilder = new MqttClientOptionsBuilder()
                .WithTcpServer(mqtt.Host, mqtt.Port)
                .WithCredentials(mqtt.Username, mqtt.Password)
                .WithClientId("parkomat-connection-tester")
                .WithTimeout(TimeSpan.FromSeconds(HiveTimeoutSeconds));

            // TLS תמיד — הבדיקה חייבת לבדוק את אותו חיבור שהמערכת באמת עושה.
            // אילו הייתה בודקת חיבור לא מוצפן, היא הייתה מדווחת "הצליח" על נתיב
            // שאינו הנתיב האמיתי — והטכנאי היה עוזב את האתר בטוח שהכול תקין.
            optionsBuilder = optionsBuilder.WithTlsOptions(o =>
            {
                o.UseTls(true);

                // זו בדיקת אבחון (נגישות + פרטי-התחברות), לא גבול אבטחה.
                // הנתיב האמיתי מאמת את תעודת HiveMQ דרך cacert.pem של Mosquitto;
                // כאן אין לנו את שרשרת התעודות, אז לא נכשלים *רק* על אימות התעודה —
                // אחרת הבדיקה מציגה "נכשל" בזמן שהמערכת עובדת (false negative).
                // שאר הכשלים האמיתיים (host שגוי, סיסמה שגויה, אין רשת, סירוב חיבור)
                // עדיין נכשלים כרגיל: הם אינם קשורים לאימות התעודה.
                o.WithCertificateValidationHandler(_ => true);
            });

            var options = optionsBuilder.Build();

            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(HiveTimeoutSeconds));
            var response = await client.ConnectAsync(options, cts.Token);

            if (response.ResultCode == MqttClientConnectResultCode.Success)
            {
                return new TestResult
                {
                    Success = true,
                    Message = $"החיבור ל-HiveMQ בכתובת {mqtt.Host}:{mqtt.Port} הצליח (TLS)."
                };
            }

            return new TestResult
            {
                Success = false,
                Message = $"HiveMQ דחה את החיבור: {response.ResultCode}" +
                          (string.IsNullOrEmpty(response.ReasonString) ? "" : $" ({response.ReasonString})")
            };
        }
        catch (OperationCanceledException)
        {
            return new TestResult
            {
                Success = false,
                Message = $"פסק זמן: אין תגובה מ-HiveMQ תוך {HiveTimeoutSeconds} שניות."
            };
        }
        catch (Exception ex)
        {
            return new TestResult { Success = false, Message = $"החיבור ל-HiveMQ נכשל: {Describe(ex)}" };
        }
        finally
        {
            try { if (client is { IsConnected: true }) await client.DisconnectAsync(); }
            catch { /* ניתוק שקט */ }
            client?.Dispose();
        }
    }

    // מחלץ סיבה קריאה מהחריגה (כולל חריגות מקוננות, כמו SocketException מתחת ל-TLS).
    private static string Describe(Exception ex) => ex.GetBaseException().Message;
}
