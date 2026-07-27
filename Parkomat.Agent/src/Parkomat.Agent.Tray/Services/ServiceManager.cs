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
    /// ⚠️ מגבלה מוכרת, מתועדת בכוונה: הסוכן כותב פעימת לב רק אחרי קריאת PLC
    /// *מוצלחת* (Worker.WriteHeartbeat). לכן נתק PLC ממושך נראה מכאן זהה
    /// לתקיעה, וייגרום להפעלה מחדש. זה רועש אך לא מזיק — בנתק PLC אין קריאות
    /// ולכן אין פעולות שיינפחו, המצב 'error' ממילא כבר דווח, והריסון מוריד את
    /// זה לניסיון אחד ל-5 דקות. התיקון השלם הוא פעימת לב שמשקפת חיוּת של
    /// הלולאה ולא הצלחת הקריאה; הוא נוגע ב-Worker ולכן לא נכלל כאן.
    /// </summary>
    public void EnsureRunning()
    {
        bool alive = IsRunning(AgentProcName);

        if (alive && IsHeartbeatFresh())
        {
            // בריא. אחרי שהות בריאה מספקת מאפסים את הריסון, כדי שתקלה עתידית
            // תטופל מיד ולא תירש את ההמתנה הארוכה מהתקלה הקודמת.
            _agentRestarts.NoteHealthy();
        }
        else if (alive && IsAgentWedged())
        {
            // חי אך לא מדווח מזמן. הריגה ואז הפעלה — StartAgent מדלג כשהתהליך
            // הישן עוד קיים, ולכן ההריגה חייבת לקרות לפניה.
            if (_agentRestarts.TryTake())
            {
                KillByName(AgentProcName);
                StartAgent();
            }
        }
        else if (!alive)
        {
            if (_agentRestarts.TryTake())
                StartAgent();
        }
        // בין חלון אחד לשלושה בלי פעימה — לא עושים כלום. זה עוד יכול להיות
        // דגימה איטית או כמה קריאות שנכשלו, ולהרוג על זה גרוע מלחכות.

        // Mosquitto אינו מרוסן: הוא לא מייצר פעולות, ולכן הפעלה חוזרת שלו אינה
        // משחיתה נתונים — והוא כן צריך לעלות מהר כשהוא נופל.
        if (BridgeConfigHasUsername() && !IsRunning(MosquittoProcName))
            StartMosquitto();
    }

    // האם הסוכן חי אך פעימת הלב שלו מיושנת מעבר לסף התקיעה.
    // בלי קובץ פעימה כלל (סוכן שרק עלה ועדיין לא קרא PLC) — *לא* מכריזים על
    // תקיעה: אין ממה למדוד, וכל התקנה טרייה הייתה נכנסת ללופ הריגה.
    private static bool IsAgentWedged()
    {
        try
        {
            if (!File.Exists(AgentPaths.HeartbeatFile))
                return false;

            string text = ReadAllTextShared(AgentPaths.HeartbeatFile).Trim();
            if (!long.TryParse(text, out long beatUnix))
                return false;

            long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            long age = now - beatUnix;

            // פעימה מהעתיד (שעון שקפץ אחורה) אינה תקיעה — מתעלמים, אחרת שינוי
            // שעון היה מפעיל את הסוכן מחדש בלי סיבה.
            if (age < 0)
                return false;

            return age > WedgedAfterSeconds();
        }
        catch
        {
            return false;   // לא ניתן לקרוא — לא הורגים על ספק
        }
    }

    private static int WedgedAfterSeconds()
    {
        int pollMs;
        try { pollMs = ConfigStore.Load().PollIntervalMs; }
        catch { pollMs = 1000; }
        return RestartPolicy.WedgedAfterSeconds(pollMs);
    }

    // ===== עזרים =====

    private static string? StartAgent()
    {
        if (IsRunning(AgentProcName))
            return null;
        if (!File.Exists(AgentExe))
            return "קובץ ה-Agent לא נמצא. ייתכן שההתקנה לא הושלמה — התקן מחדש.";

        return LaunchHidden(AgentExe, arguments: null, "ה-Agent");
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
