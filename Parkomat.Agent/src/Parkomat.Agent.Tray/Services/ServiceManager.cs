using System.Diagnostics;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Tray.Services;

/// <summary>
/// מצב ה-Agent מנקודת מבט ה-Tray.
/// </summary>
public enum AgentServiceState
{
    /// <summary>ה-Agent רץ ומצליח לקרוא מה-PLC (פעימת לב טרייה).</summary>
    Running,
    /// <summary>מותקן אך אינו פעיל (כבוי או נכשל בקריאות).</summary>
    Stopped,
    /// <summary>לא מותקן (קובץ ה-Agent לא נמצא).</summary>
    NotInstalled,
    /// <summary>מצב ביניים / לא ידוע.</summary>
    Pending
}

/// <summary>
/// מנהל את ה-Agent ו-Mosquitto כ*תהליכים רגילים* (לא כשירותי Windows) —
/// כדי שההתקנה תהיה למשתמש בלבד, בלי הרשאת מנהל ובלי UAC.
///
/// ה-Tray הוא זה שמפעיל, משגיח ומכבה את שני התהליכים:
///  - Parkomat.Agent.Service.exe  (הלב — קורא PLC, כותב bridge.conf, משדר)
///  - mosquitto.exe               (הגשר ל-HiveMQ, קורא את bridge.conf)
///
/// המצב "רץ" נקבע לפי פעימת לב טרייה — כלומר האם ה-Agent באמת קורא מה-PLC,
/// ולא רק אם התהליך חי.
/// </summary>
public class ServiceManager
{
    // שמות התהליכים (בלי סיומת .exe) — לזיהוי אם הם כבר רצים.
    private const string AgentProcName = "Parkomat.Agent.Service";
    private const string MosquittoProcName = "mosquitto";

    // חלון רעננות ה-heartbeat, מותאם לקצב הדגימה: max(10s, 3×poll). קבוע של 10s היה
    // גורם לסמל להראות "אין קשר לבקר" ברגע שהדגימה איטית מ-10s (הטופס מתיר עד 600s),
    // למרות שהסוכן קורא PLC מצוין. נקרא בכל בדיקה כי הקצב ניתן לשינוי בזמן ריצה.
    private static int FreshnessWindowSeconds()
    {
        int pollMs;
        try { pollMs = ConfigStore.Load().PollIntervalMs; }
        catch { pollMs = 1000; }
        return HeartbeatPolicy.FreshnessWindowSeconds(pollMs);
    }

    // שורש ההתקנה = תיקיית ה-Tray מעלה אחת ({app}\tray -> {app}).
    private static string InstallRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."));

    private static string AgentExe =>
        Path.Combine(InstallRoot, "service", "Parkomat.Agent.Service.exe");

    private static string MosquittoExe =>
        Path.Combine(InstallRoot, "mosquitto", "mosquitto.exe");

    // ===== מצב =====

    /// <summary>בודק את מצב ה-Agent הנוכחי.</summary>
    public AgentServiceState GetState()
    {
        if (!File.Exists(AgentExe))
            return AgentServiceState.NotInstalled;

        return IsHeartbeatFresh() ? AgentServiceState.Running : AgentServiceState.Stopped;
    }

    /// <summary>האם תהליך ה-Agent חי (בלי קשר לפעימת לב).</summary>
    public bool IsProcessRunning() => IsRunning(AgentProcName);

    /// <summary>
    /// האם הגשר ל-HiveMQ מחובר *כרגע* — לפי קובץ הסטטוס שה-Agent כותב.
    /// דורש גם ערך "1" וגם שהחותם יהיה טרי (אחרת זה שריד ישן).
    /// </summary>
    public bool IsHiveMqConnected()
    {
        try
        {
            if (!File.Exists(AgentPaths.HiveMqStatusFile))
                return false;

            string[] parts = ReadAllTextShared(AgentPaths.HiveMqStatusFile)
                .Trim()
                .Split(' ', StringSplitOptions.RemoveEmptyEntries);

            if (parts.Length < 2 || parts[0] != "1")
                return false;
            if (!long.TryParse(parts[1], out long ts))
                return false;

            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            return (now - ts) <= FreshnessWindowSeconds();
        }
        catch
        {
            return false;
        }
    }

    // ===== הפעלה / כיבוי =====

    /// <summary>
    /// מפעיל את ה-Agent, וכן את Mosquitto אם יש פרטי HiveMQ תקינים.
    /// מחזיר null בהצלחה, או הודעת שגיאה בעברית.
    /// </summary>
    public string? Start()
    {
        // פעולה מפורשת של המשתמש מאפסת את הריסון: מי שלחץ "הפעל" מבקש ניסיון
        // *עכשיו*, ולא אחרי ההמתנה שהצטברה מקריסות קודמות.
        _agentRestarts.Reset();

        // התנעה נקייה: קודם הורגים כל שארית (תהליך תקוע/זומבי שנשאר "רץ" בשם אך
        // אינו מתפקד). בלי זה, StartAgent/StartMosquitto היו מדלגים על ההפעלה בגלל
        // בדיקת IsRunning על שארית כזו — והשירות לא היה עולה אחרי "הפעל את השירות".
        KillByName(MosquittoProcName);
        KillByName(AgentProcName);

        string? error = StartAgent();
        if (error != null)
            return error;

        // Mosquitto רק אם bridge.conf תקין (remote_username לא ריק) — אחרת הוא ייכשל.
        if (BridgeConfigHasUsername())
        {
            WaitForValidBridgeConfig(TimeSpan.FromSeconds(10));
            return StartMosquitto();
        }
        return null;
    }

    /// <summary>עוצר את שני התהליכים. מחזיר null (best-effort).</summary>
    public string? Stop()
    {
        _agentRestarts.Reset();   // עצירה יזומה — ההפעלה הבאה מתחילה מדף חלק
        KillByName(MosquittoProcName);
        KillByName(AgentProcName);

        // מוחקים את קבצי הסטטוס כדי שהמצב ישקף *מיד* "מכובה". אחרת ה-heartbeat
        // שנכתב רגע לפני הכיבוי נשאר טרי, ו-GetState היה מראה "פועל" עוד ~10 שניות
        // בסתירה לכפתור "הפעל את השירות". הסוכן כותב אותם מחדש בעלייתו.
        try { File.Delete(AgentPaths.HeartbeatFile); } catch { /* best-effort */ }
        try { File.Delete(AgentPaths.HiveMqStatusFile); } catch { /* best-effort */ }
        // גם קובץ החיוּת, מאותו טעם ובאותה נשימה: אחרת נשאר קובץ "alive" ישן
        // אחרי עצירה יזומה. הוא אמנם לא היה מזיק (התקיעה נבדקת רק על תהליך
        // *חי*, וסוכן חי כותב אותו בסבב הראשון), אבל שריד סותר בתיקייה הוא
        // בדיוק מה שמבלבל את מי שיאבחן תקלה הבאה.
        try { File.Delete(AgentPaths.LivenessFile); } catch { /* best-effort */ }
        return null;
    }

    /// <summary>
    /// מיישם שינוי הגדרות מיד (בלי restart ידני): מפעיל מחדש בסדר הנכון.
    ///  1. עוצר את Mosquitto.
    ///  2. מפעיל מחדש את ה-Agent (בעלייתו כותב bridge.conf תקין).
    ///  3. אם יש פרטי HiveMQ — ממתין ל-bridge.conf תקין ומפעיל את Mosquitto.
    /// </summary>
    public string? ApplyConfigChange(bool startMosquitto)
    {
        // הגדרות חדשות = תקלה קודמת אולי נפתרה. לא מחילים עליהן המתנה שהצטברה.
        _agentRestarts.Reset();
        KillByName(MosquittoProcName);
        KillByName(AgentProcName);

        string? error = StartAgent();
        if (error != null)
            return error;

        if (!startMosquitto)
            return null;

        WaitForValidBridgeConfig(TimeSpan.FromSeconds(10));
        return StartMosquitto();
    }

    // ריסון ההפעלות-מחדש של הסוכן. מצב, ולכן שדה מופע ולא סטטי — ל-TrayContext
    // יש ServiceManager אחד לכל אורך חייו.
    private readonly RestartThrottle _agentRestarts = new();

    /// <summary>לאבחון ולתצוגה: כמה הפעלות-מחדש רצופות בוצעו לסוכן.</summary>
    public int AgentConsecutiveRestarts => _agentRestarts.ConsecutiveRestarts;

    /// <summary>
    /// שומר על ריצה: מפעיל כל תהליך שמת, ומפעיל מחדש סוכן שתקוע (watchdog).
    /// נקרא מדי כמה שניות מה-Tray. לא עוצר כלום מיוזמתו חוץ מהמקרה התקוע.
    ///
    /// ==========================================================
    /// שני שינויים שהיו חסרים כאן, ושניהם עלו בסקירת השדה
    /// ==========================================================
    /// 1. **ריסון.** קודם כל טיק שראה תהליך מת הפעיל אותו מיד, כל 5 שניות, ללא
    ///    גבול. מ-1.0.15 זה מנפח נתונים: כל עלייה של הסוכן באמצע מחזור MODE
    ///    פותחת פעולה חדשה בשרת (ראה RestartPolicy). עכשיו כל ניסיון עובר דרך
    ///    RestartThrottle, וההמתנה מוכפלת עד תקרה של 5 דקות.
    ///
    /// 2. **זיהוי תקיעה.** קודם נבדק *קיום התהליך* בלבד. סוכן שנתקע — thread
    ///    שמת, קריאת PLC תלויה, deadlock — נשאר "רץ" לנצח, והאתר היה חשוך
    ///    בשקט עד שטכנאי היה מבחין באייקון אפור על מחשב בחניון. פעימת הלב כבר
    ///    הייתה קיימת ומחושבת נכון, אבל שימשה רק לצביעת האייקון. עכשיו היא
    ///    מפעילה החלטה.
    ///
    /// 3. **מקור המדידה תוקן.** קודם נכתב כאן שהסתמכות על פעימת הלב היא
    ///    "מגבלה רועשת אך לא מזיקה", בנימוק שבנתק PLC "המצב 'error' ממילא
    ///    כבר דווח". **הנימוק היה שגוי, וזה נמדד:** כשל קריאה עולה ~3.2
    ///    שניות, ולכן 10 הכשלונות שנדרשים לשידור error לוקחים ~42 שניות —
    ///    מול סף תקיעה של 30. הסוכן נהרג לפני הדיווח, ההריגה איפסה את המונה,
    ///    ולכן error לא שודר לעולם. התקיעה נמדדת עכשיו מול AgentPaths.
    ///    LivenessFile, שנכתב בכל סבב של הלולאה ולא רק אחרי קריאה מוצלחת.
    /// </summary>
    public void EnsureRunning()
    {
        // ההחלטה עצמה חיה ב-WatchdogPolicy — פונקציה טהורה שמכוסה ב-unit tests.
        // כאן רק אוספים את הקלט מהעולם האמיתי ומבצעים. זה בדיוק הדפוס של
        // RestartPolicy ו-ResyncPolicy, והוא הסיבה שהבאג הזה ניתן לבדיקה עכשיו.
        WatchdogAction action = WatchdogPolicy.Decide(
            processAlive: IsRunning(AgentProcName),
            heartbeatAgeSeconds: FileAgeSeconds(AgentPaths.HeartbeatFile),
            livenessAgeSeconds: FileAgeSeconds(AgentPaths.LivenessFile),
            pollIntervalMs: ConfiguredPollIntervalMs());

        switch (action)
        {
            case WatchdogAction.NoteHealthy:
                // אחרי שהות בריאה מספקת הריסון מתאפס, כדי שתקלה עתידית תטופל
                // מיד ולא תירש את ההמתנה הארוכה מהתקלה הקודמת.
                _agentRestarts.NoteHealthy();
                break;

            case WatchdogAction.KillAndStart:
                // הריגה ואז הפעלה — StartAgent מדלג כשהתהליך הישן עוד קיים,
                // ולכן ההריגה חייבת לקרות לפניה.
                if (_agentRestarts.TryTake())
                {
                    KillByName(AgentProcName);
                    StartAgent();
                }
                break;

            case WatchdogAction.Start:
                if (_agentRestarts.TryTake())
                    StartAgent();
                break;

            case WatchdogAction.None:
                // חי, הלולאה מסתובבת, אבל הבקר לא נענה — נתק PLC. לא נוגעים:
                // הסוכן צריך את השניות האלה כדי לשדר state=error בעצמו.
                break;
        }

        // Mosquitto אינו מרוסן: הוא לא מייצר פעולות, ולכן הפעלה חוזרת שלו אינה
        // משחיתה נתונים — והוא כן צריך לעלות מהר כשהוא נופל.
        if (BridgeConfigHasUsername() && !IsRunning(MosquittoProcName))
            StartMosquitto();
    }

    // אלה שני העזרים היחידים שההחלטה צריכה. **הכלל עצמו — מתי סוכן נחשב
    // תקוע, ולמה זה נמדד מול החיוּת ולא מול פעימת הלב — חי ב-WatchdogPolicy**,
    // ושם גם ההסבר וגם הטסטים. כאן רק איסוף הקלט.

    // גיל הקובץ בשניות לפי החותם שכתוב *בתוכו*, או null אם אינו קיים/קריא.
    // null אומר "אין ממה למדוד", ו-WatchdogPolicy מתייחס לזה כאל "לא לגעת".
    private static long? FileAgeSeconds(string path)
    {
        try
        {
            if (!File.Exists(path))
                return null;

            string text = ReadAllTextShared(path).Trim();
            if (!long.TryParse(text, out long stampUnix))
                return null;

            return DateTimeOffset.UtcNow.ToUnixTimeSeconds() - stampUnix;
        }
        catch
        {
            return null;   // לא ניתן לקרוא — לא מחליטים על ספק
        }
    }

    private static int ConfiguredPollIntervalMs()
    {
        try { return ConfigStore.Load().PollIntervalMs; }
        catch { return 1000; }
    }

    // ===== עזרים =====

    // ============================================================
    // ⚠️ המרוץ שהפעיל שני סוכנים — ומה בדיוק מונע אותו
    // ============================================================
    // הגרסה הקודמת הייתה "בדוק ואז הפעל" בלי נעילה:
    //
    //     if (IsRunning(AgentProcName)) return null;
    //     return LaunchHidden(...);
    //
    // ‏`Process.Start` חוזר **מיד**, אבל התהליך החדש מופיע ב-
    // `GetProcessesByName` רק אחרי מאות מילישניות. ושני קוראים רצים
    // בתהליכונים שונים: `ApplyConfigChange` (מסך ההגדרות) והשומר
    // (`WatchdogAction.Start`) — שרואה `processAlive: false` בדיוק אחרי
    // ה-KillByName שקדם להפעלה.
    //
    // ⚠️ נמדד באתר 1284 ב-26/08/2026 22:23:07: שני מופעים, אותה שנייה,
    // אותו Tray אב. הם ניתקו זה את זה ב-MQTT במשך ארבעה ימים.
    //
    // הנעילה לבדה **אינה מספיקה** — הקורא השני היה נכנס מיד אחרי שחרורה
    // ועדיין רואה "לא רץ". לכן ההמתנה היא בתוך הנעילה: יוצאים ממנה רק
    // כשהתהליך כבר גלוי למי שיבדוק אחרינו.
    private static readonly object _startGate = new();

    private static string? StartAgent()
    {
        lock (_startGate)
        {
            if (IsRunning(AgentProcName))
                return null;
            if (!File.Exists(AgentExe))
                return "קובץ ה-Agent לא נמצא. ייתכן שההתקנה לא הושלמה — התקן מחדש.";

            string? error = LaunchHidden(AgentExe, arguments: null, "ה-Agent");
            if (error != null)
                return error;

            WaitUntilRunning(AgentProcName, TimeSpan.FromSeconds(5));
            return null;
        }
    }

    // ממתין עד שהתהליך גלוי, או עד תום הזמן. ⚠️ פסק זמן ולא המתנה
    // אינסופית: תהליך שנכשל בעלייה לא יופיע לעולם, והחזקת הנעילה לנצח
    // הייתה מקפיאה את ה-Tray כולו — כלומר הופכת באג של כפילות לתקיעה.
    private static void WaitUntilRunning(string procName, TimeSpan timeout)
    {
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            if (IsRunning(procName))
                return;
            Thread.Sleep(100);
        }
    }

    private static string? StartMosquitto()
    {
        if (IsRunning(MosquittoProcName))
            return null;
        if (!File.Exists(MosquittoExe))
            return "קובץ Mosquitto לא נמצא. ייתכן שההתקנה לא הושלמה — התקן מחדש.";

        // מריצים עם קובץ הגישור. הנתיב שלו הוא ASCII (ProgramData), נקי מתווים בעברית.
        string args = $"-c \"{AgentPaths.BridgeConfigFile}\"";
        return LaunchHidden(MosquittoExe, args, "Mosquitto");
    }

    // מפעיל תהליך חבוי (בלי חלון). מחזיר null בהצלחה, או הודעת שגיאה בעברית.
    private static string? LaunchHidden(string exe, string? arguments, string label)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = exe,
                Arguments = arguments ?? "",
                WorkingDirectory = Path.GetDirectoryName(exe)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            Process.Start(psi);
            return null;
        }
        catch (Exception ex)
        {
            return $"הפעלת {label} נכשלה: {ex.Message}";
        }
    }

    private static bool IsRunning(string procName)
    {
        Process[] procs = Array.Empty<Process>();
        try
        {
            procs = Process.GetProcessesByName(procName);
            return procs.Length > 0;
        }
        catch
        {
            return false;
        }
        finally
        {
            foreach (Process p in procs) p.Dispose();
        }
    }

    private static void KillByName(string procName)
    {
        Process[] procs;
        try { procs = Process.GetProcessesByName(procName); }
        catch { return; }

        foreach (Process p in procs)
        {
            try
            {
                p.Kill(entireProcessTree: true);
                p.WaitForExit(5000);
            }
            catch { /* התהליך כבר מת / אין הרשאה — מתעלמים */ }
            finally { p.Dispose(); }
        }
    }

    // בודק אם קובץ פעימת הלב קיים ומעודכן מהשניות האחרונות.
    private static bool IsHeartbeatFresh()
    {
        try
        {
            if (!File.Exists(AgentPaths.HeartbeatFile))
                return false;

            string text = ReadAllTextShared(AgentPaths.HeartbeatFile).Trim();
            if (!long.TryParse(text, out long beatUnix))
                return false;

            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            return (now - beatUnix) <= FreshnessWindowSeconds();
        }
        catch
        {
            return false;
        }
    }

    // קורא קובץ שה-Agent כותב במקביל, בלי להיכשל על "sharing violation": מתיר
    // ל-writer להחליף/למחוק את הקובץ (FileShare.ReadWrite | Delete) בזמן הקריאה.
    // בשילוב עם הכתיבה האטומית של ה-Agent — הקורא תמיד מקבל תוכן שלם.
    private static string ReadAllTextShared(string path)
    {
        using var fs = new FileStream(
            path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete);
        using var reader = new StreamReader(fs);
        return reader.ReadToEnd();
    }

    // ממתין עד ש-bridge.conf קיים ומכיל remote_username לא-ריק, או עד תום הזמן.
    private static void WaitForValidBridgeConfig(TimeSpan timeout)
    {
        DateTime deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            if (BridgeConfigHasUsername())
                return;
            Thread.Sleep(200);
        }
    }

    // קורא את bridge.conf ובודק אם יש שורת remote_username עם ערך לא-ריק.
    private static bool BridgeConfigHasUsername()
    {
        try
        {
            if (!File.Exists(AgentPaths.BridgeConfigFile))
                return false;

            foreach (string line in File.ReadAllLines(AgentPaths.BridgeConfigFile))
            {
                string trimmed = line.Trim();
                if (trimmed.StartsWith("remote_username", StringComparison.OrdinalIgnoreCase))
                {
                    string value = trimmed["remote_username".Length..].Trim();
                    return value.Length > 0;
                }
            }
            return false;
        }
        catch
        {
            return false;
        }
    }
}
