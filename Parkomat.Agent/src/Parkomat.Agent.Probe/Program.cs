// ParkomatProbe — צופה ברגיסטרים של הבקר, ולא עושה שום דבר אחר.
//
// ============================================================
// ⚠️ למה הכלי הזה קיים
// ============================================================
// נמדד במסד: בבקרי מצבט/שאטל מונה המחזורים עולה **פעמיים לכניסה** ופעם
// אחת ליציאה, בעוד שבדולי ו-xy הוא עולה פעם אחת תמיד. העלייה הנוספת
// אינה בתוך הפעולה — היא קורית **אחריה**, כשאין אף אחד.
//
// מהמסד אי אפשר להתקדם מכאן: הסוכן מדווח רק על **שינוי MODE**, ולכן
// עלייה של המונה בזמן מנוחה אינה מייצרת הודעה ואינה נראית בשום מקום.
// היא משוחזרת רק בדיעבד, מהפרש בין שתי פעולות. הכלי הזה מסתכל על
// הרגיסטר עצמו, כל רבע שנייה, ורואה את הרגע.
//
// ============================================================
// מה הוא **לא** עושה, ובכוונה
// ============================================================
// - **אינו כותב ל-config.json ואינו נוגע ב-C:\ProgramData\Parkomat.**
//   הוא קורא את הקובץ כטקסט ומפרש אותו; אין נתיב קוד שכותב. כלי אבחון
//   שמשנה את מה שהוא בא לאבחן הוא מלכודת.
// - **אינו כותב לבקר.** קריאה בלבד (ReadInputRegisters).
// - **אינו עוצר את הסוכן.** הוא פותח חיבור Modbus נוסף ורץ לצדו, כדי
//   שהאתר ימשיך לדווח כרגיל בזמן הבדיקה. אם הבקר מרשה חיבור אחד בלבד,
//   הכלי ייכשל מיד ויאמר זאת — ואז יש לעצור את השירות לרגע הבדיקה.
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Service.Modbus;

// כל רבע שנייה. הסוכן דוגם כל שנייה; כאן צריך צפוף יותר, כי המטרה היא
// לתפוס את הרגע שבו המונה עולה ביחס לשינוי ה-MODE.
const int PollMs = 250;

Console.OutputEncoding = System.Text.Encoding.UTF8;

// ------------------------------------------------------------
// הגדרות — קריאה בלבד
// ------------------------------------------------------------
// ⚠️ במפורש **לא** ConfigStore.Load() ולא LoadAtStartup(): הראשונה עלולה
// לכתוב, והשנייה צורכת את דגל האיפוס שהמתקין מניח — כלומר הרצת כלי אבחון
// הייתה מבטלת איפוס אמיתי שאמור לקרות בעליית הסוכן.
// ⚠️ **דגלים בשורת הפקודה גוברים על הקובץ, ואינם רק נוחות.** בקר שהסוכן
// עדיין לא הוגדר מולו איננו ניתן לבדיקה בלי זה — כלומר הכלי לא היה זמין
// דווקא בהתקנה, הרגע שבו הוא הכי שימושי.
//   ParkomatProbe --ip 192.168.1.3 [--udp] [--port 502] [--mode 290] [--card 291] [--cycle 292]
string? Arg(string name)
{
    int i = Array.IndexOf(args, "--" + name);
    return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
}

// דגל בלי ערך (--udp), להבדיל מ-Arg שדורש ערך אחריו.
bool Flag(string name) => Array.IndexOf(args, "--" + name) >= 0;

int ArgInt(string name, int fallback) =>
    int.TryParse(Arg(name), out int v) ? v : fallback;

string siteId;
PlcConfig plc;

if (Arg("ip") is string ip)
{
    siteId = Arg("site") ?? "(ידני)";
    plc = new PlcConfig
    {
        IpAddress = ip,
        Port = ArgInt("port", 502),
        ModeRegister = ArgInt("mode", 290),
        CardRegister = ArgInt("card", 291),
        CycleRegister = ArgInt("cycle", 292),

        // ⚠️ **וזו הסיבה העיקרית שהמצב הידני קיים.** בקר שלא ידוע על מה
        // הוא עונה הוא ניחוש: מגדירים UDP בקובץ, הסוכן שותק, ואין דרך
        // להבחין בין "הבקר לא תומך" ל"הכתובת שגויה" ל"הרגיסטר אחר".
        // כאן אפשר לנסות את שתי התעבורות בזו אחר זו, בשתי פקודות, לפני
        // שנוגעים בהגדרות של אתר חי.
        Transport = Flag("udp") ? "udp" : "tcp",
    };
}
else
{
    if (!File.Exists(AgentPaths.ConfigFile))
    {
        Console.WriteLine($"לא נמצא קובץ הגדרות: {AgentPaths.ConfigFile}");
        Console.WriteLine("אפשר לתת כתובת ידנית:  ParkomatProbe --ip 192.168.1.3");
        return 1;
    }

    SiteConfig? config;
    try
    {
        config = ConfigStore.FromJson(File.ReadAllText(AgentPaths.ConfigFile));
    }
    catch (Exception ex)
    {
        Console.WriteLine($"קובץ ההגדרות אינו קריא: {ex.Message}");
        return 1;
    }

    if (config is null)
    {
        Console.WriteLine("קובץ ההגדרות ריק או פגום.");
        return 1;
    }

    siteId = config.SiteId;
    plc = config.Plc;
}

Console.WriteLine(new string('=', 64));
// ⚠️ התעבורה מוצגת תמיד, גם ב-TCP. מי שמריץ את הכלי כדי לברר למה
// אתר לא קורא מהבקר חייב לראות **על מה הסוכן באמת מדבר**, ולא להסיק
// זאת מהיעדר המילה UDP.
Console.WriteLine($"  אתר {siteId}   בקר {(plc.UseUdp ? "UDP" : "TCP")} {plc.IpAddress}:{plc.Port}");
if (!plc.TransportIsKnown)
    Console.WriteLine($"  ⚠️ הערך '{plc.Transport}' אינו מוכר — נופל ל-TCP");
Console.WriteLine($"  רגיסטרים: MODE={plc.ModeRegister}  כרטיס={plc.CardRegister}  מונה={plc.CycleRegister}");
Console.WriteLine($"  דגימה כל {PollMs} מילישניות · Ctrl+C לעצירה");
Console.WriteLine(new string('=', 64));

// הפלט נשמר ליד קובץ ההרצה, לא תחת ProgramData — כדי שלא נוסיף קובץ
// לתיקייה שהמתקין מנהל.
string logPath = Path.Combine(
    AppContext.BaseDirectory, $"probe-{siteId}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
Console.WriteLine($"נשמר גם ל: {logPath}");
Console.WriteLine();

var lines = new List<string>();

// ⚠️ **כל שורה נשמרת מיד, וזה לא בזבוז.** הגרסה הראשונה שמרה
// רק בנתיב השינוי, ולכן הרצה שראתה **רק כשלי חיבור** לא השאירה קובץ
// כלל — נמדד בבדיקה. זה בדיוק המצב שבו הפלט הכי נחוץ, והטכנאי
// שבא לאסוף אותו היה מוצא תיקייה ריקה. השורות נכתבות רק על
// שינוי, כלומר עשרות בודדות לשעה — כתיבה מחדש היא זולה לחלוטין.
void Emit(string text)
{
    Console.WriteLine(text);
    lines.Add(text);
    Flush();
}

// שמירה גם ביציאה בכל דרך — Ctrl+C הוא הדרך הצפויה לעצור, וכלי שמאבד
// את מה שאסף כשעוצרים אותו הוא כלי חסר תועלת.
void Flush()
{
    try { File.WriteAllLines(logPath, lines); } catch { /* אין מה לעשות */ }
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
AppDomain.CurrentDomain.ProcessExit += (_, _) => Flush();

using var reader = new PlcReader(plc);

int prevMode = int.MinValue, prevCycle = int.MinValue;
string prevCard = "\u0000";
DateTime lastChange = DateTime.Now;
int failures = 0;

Emit($"{"שעה",-13}{"MODE",6}{"כרטיס",9}{"מונה",8}   מה השתנה");
Emit(new string('-', 64));

while (!cts.IsCancellationRequested)
{
    PlcReading reading;
    try
    {
        reading = reader.Read();
        if (failures > 0)
        {
            Emit($"{DateTime.Now:HH:mm:ss.fff}  החיבור לבקר חזר");
            failures = 0;
        }
    }
    catch (Exception ex)
    {
        // רק הכשל הראשון נרשם — אחרת נתק ממושך ממלא את המסך בשורה לרבע שנייה.
        if (failures == 0)
            Emit($"{DateTime.Now:HH:mm:ss.fff}  כשל בקריאה מהבקר: {ex.Message}");
        failures++;
        try { await Task.Delay(PollMs, cts.Token); } catch (OperationCanceledException) { }
        continue;
    }

    string card = reading.CardNumber ?? "";
    bool first = prevMode == int.MinValue;
    bool modeChanged = reading.Mode != prevMode;
    bool cycleChanged = reading.CycleCounter != prevCycle;
    bool cardChanged = card != prevCard;

    // ⚠️ מדפיסים **רק על שינוי**. דגימה כל רבע שנייה במשך שעה היא 14,400
    // שורות; מה שמעניין הוא כמה עשרות. פלט שצריך לסנן אינו פלט.
    if (first || modeChanged || cycleChanged || cardChanged)
    {
        var what = new List<string>();
        if (first) what.Add("קריאה ראשונה");
        else
        {
            if (modeChanged) what.Add($"MODE {prevMode}→{reading.Mode}");
            if (cardChanged) what.Add($"כרטיס '{prevCard}'→'{card}'");
            if (cycleChanged)
            {
                int d = reading.CycleCounter - prevCycle;
                // זה הקו התחתון של כל הבדיקה: מונה שעולה **בלי** ששום דבר
                // אחר זז הוא בדיוק התנועה שאיננו רואים במסד.
                what.Add(modeChanged
                    ? $"מונה +{d}"
                    : $"⚠️ מונה +{d} בלי שינוי MODE");
            }
        }

        double since = (DateTime.Now - lastChange).TotalSeconds;
        Emit($"{DateTime.Now:HH:mm:ss.fff}  {reading.Mode,5}{card,9}{reading.CycleCounter,8}   "
           + $"{string.Join(" · ", what)}   (+{since:F1} שנ')");

        lastChange = DateTime.Now;
    }

    prevMode = reading.Mode;
    prevCycle = reading.CycleCounter;
    prevCard = card;

    try { await Task.Delay(PollMs, cts.Token); } catch (OperationCanceledException) { break; }
}

Flush();
Console.WriteLine();
Console.WriteLine($"נעצר. {lines.Count} שורות נשמרו ב-{logPath}");
return 0;
