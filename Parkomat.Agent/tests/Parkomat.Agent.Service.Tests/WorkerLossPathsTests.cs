using System.Reflection;
using System.Text.RegularExpressions;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// מסלולים ב-<c>Worker</c> שבהם נתון נוצר — ונעלם בלי שורה אחת בלוג.
///
/// <para>⚠️ <b>רוב הבדיקות כאן מבניות, ובמפורש.</b> הלולאה של
/// <c>ExecuteAsync</c> דורשת PLC, ברוקר, רשת ושעון, ואי אפשר להריץ אותה
/// כאן. מה שנבדק הוא <b>החיווט</b> — שהקוד שמונע את האובדן קיים במקום
/// שבו הוא פועל. אותו שיקול כמו <c>DualWriteWiringTests</c> ו-
/// <c>PlcErrorDirectPathTests</c>. ההחלטות עצמן, כשהן ניתנות להפרדה,
/// נבדקות התנהגותית בקבצים שלהן (<c>DirectLinkStatusTests</c>,
/// <c>DetectorStateSaverTests</c>).</para>
///
/// <para>⚠️ <b>ההערות נשלפות לפני כל בדיקה.</b> ההערות בקובץ הזה מצטטות
/// את הקוד שהן מסבירות, ושער שמוצא את העוגן בהערה צובע את עצמו ירוק על
/// קוד שאינו קיים — הדפוס שכבר הכשיל שערים בפרויקט הזה.</para>
/// </summary>
public class WorkerLossPathsTests
{
    private static string WorkerSource()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Service", "Worker.cs");
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllText(path).Replace("\r\n", "\n");
    }

    /// <summary>
    /// הקוד בלי הערות <c>//</c>. ⚠️ מודע למחרוזות: <c>//</c> בתוך גרשיים
    /// (כתובת URL בהודעת לוג) אינו הערה, וחיתוך שם היה משאיר סוגריים
    /// מסולסלים לא מאוזנים ומשבש את סריקת הבלוקים למטה.
    /// </summary>
    private static string Code()
    {
        var lines = WorkerSource().Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string l = lines[i];
            bool inString = false;
            for (int j = 0; j < l.Length - 1; j++)
            {
                if (l[j] == '"' && (j == 0 || l[j - 1] != '\\')) inString = !inString;
                if (!inString && l[j] == '/' && l[j + 1] == '/') { lines[i] = l[..j]; break; }
            }
        }
        return string.Join("\n", lines);
    }

    // ============================================================
    // A — שתי מערכות, קובץ זיכרון אחד
    // ============================================================
    // `DetectorStateFile` הוא `...\detector-state` — **בלי סיומת**. הנתיב
    // של המערכת השנייה נגזר ב-`Replace(".json", "-2.json")`, שלא מצא דבר
    // להחליף, ולכן שתי המערכות כתבו לאותו קובץ. מערכת 2 נכתבה אחרונה בכל
    // דגימה, וכל עלייה שחזרה את מצבה **לתוך מערכת 1** — MODE וכרטיס של
    // מערכת אחרת: תפעול פיקטיבי, או תפעול אמיתי שנסגר עם כרטיס זר.
    //
    // ⚠️ נבדק על הנתיב שה-Worker **באמת** מחשב (reflection על המאפיין
    // עצמו), לא על עותק של הנוסחה בבדיקה — עותק היה ירוק גם כשהמקור שגוי.
    // הקריאה אינה נוגעת בדיסק: היא מחשבת מחרוזת.
    [Fact]
    public void TheSecondSystemHasItsOwnDetectorStateFile()
    {
        PropertyInfo? prop = typeof(Worker).GetProperty("SecondDetectorFile",
            BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Static);
        Assert.NotNull(prop);

        string second = (string)prop!.GetValue(null)!;

        Assert.False(
            string.Equals(second, AgentPaths.DetectorStateFile, StringComparison.OrdinalIgnoreCase),
            $"שתי המערכות כותבות לאותו קובץ ({second}) — עלייה משחזרת את מערכת 2 לתוך מערכת 1");

        // ⚠️ ובאותה תיקייה: קובץ שנכתב למקום אחר לא היה מנוקה בהסרה
        // ולא היה נמצא בידי מי שמאבחן לפי AgentPaths.
        Assert.Equal(Path.GetDirectoryName(AgentPaths.DetectorStateFile),
                     Path.GetDirectoryName(second));
    }

    // ⚠️ **ולא בכל דגימה.** הבלוק הדו-מערכתי כתב את שני הקבצים בלי תנאי —
    // ארבע פעולות דיסק בשנייה על מחשב שמריץ גם את המחסום, בשביל ערך שלא
    // זז. כל כתיבה עוברת עכשיו דרך `DetectorStateSaver`, שמחליט מתי.
    [Fact]
    public void DetectorStateIsWrittenOnlyThroughTheSaver()
    {
        string code = Code();
        Assert.DoesNotMatch(new Regex(@"new\s+DetectorState\s*\([^;]*\)\s*\.Save\("), code);
        Assert.Contains("DetectorStateSaver", code);
    }

    // ============================================================
    // E — מצבים שלא נשלחו ולא נכנסו לתור
    // ============================================================
    // `mirrored` מתנקה בתחילת כל סבב, ונכנס לתור **רק** בענף הכשל של
    // השליחה. אבל יש עוד שתי דרכים לא לשלוח: חלון הריסון סגור
    // (`supaNextAttempt` בעתיד), או חריגה בשלב הישיר. בשתיהן הבלוק מדולג,
    // והסבב הבא מוחק את המצב.
    //
    // ⚠️ באתר שבו MQTT כבוי זה אובדן מוחלט של שינוי מצב: אין מסלול אחר
    // שנשא אותו, ומצב שאבד אינו חוזר עד השינוי הבא — שעלול לא להגיע שעות.
    [Fact]
    public void UnsentMirroredStatesAreQueuedBeforeTheCycleEnds()
    {
        string code = Code();
        int caught = code.IndexOf("Direct write cycle failed", StringComparison.Ordinal);
        Assert.True(caught > 0, "לא נמצא ה-catch של השלב הישיר");
        int end = code.IndexOf("Worker stopped.", caught, StringComparison.Ordinal);
        Assert.True(end > caught, "לא נמצא סוף הלולאה");

        // ⚠️ **אחרי** ה-catch ולא בתוך שער השליחה: זה מה שמכסה גם שער
        // סגור וגם חריגה. בתוך השער זה היה מכסה רק את מה שכבר כוסה.
        string tail = code[caught..end];
        Assert.Matches(new Regex(@"mirrored\.Count\s*>\s*0"), tail);
        Assert.Matches(new Regex(@"supaQueue\.Enqueue\(\s*m\s*\)"), tail);
    }

    // ============================================================
    // F — "אין קשר לבקר": שליחה חוזרת כל ארבע שניות, לנצח
    // ============================================================
    private static string FailurePath()
    {
        string code = Code();
        int from = code.IndexOf("var errorState = new StateMessage", StringComparison.Ordinal);
        Assert.True(from >= 0, "נתיב כשל ה-PLC לא נמצא");
        int to = code.IndexOf("continue;", from, StringComparison.Ordinal);
        Assert.True(to > from, "ה-continue שמסיים את הנתיב לא נמצא");
        return code[from..to];
    }

    // ⚠️ באתר ישיר-בלבד אין ברוקר מקומי. `TryPublishAsync` ניסה להתחבר
    // ל-localhost:1883 בכל סבב ורשם **אזהרה** — שקרית: היא שולחת את מי
    // שקורא את הלוג לתקן ברוקר שכובה בכוונה.
    [Fact]
    public void TheFaultIsNotPublishedToABrokerThatIsSwitchedOff()
    {
        string path = FailurePath();
        int publish = path.IndexOf("TryPublishAsync", StringComparison.Ordinal);
        Assert.True(publish > 0, "הפרסום ל-MQTT נעלם מהנתיב — הבדיקה מסתכלת על קוד שהשתנה");
        Assert.Contains("if (config.MqttEnabled)", path[..publish]);
    }

    // ⚠️ תור הוא מסירה. כתיבה שנכשלה ונכנסה לתור **כבר דווחה** — התור
    // ישלח אותה בחותם המקורי. השארת הדגל false גרמה לכל סבב (~4 שניות:
    // timeout של הבקר + דגימה) להתחבר, לשלוח, להיכשל, **ולהכניס עוד עותק
    // לתור** — אלפי כפילויות ביום על תקלה אחת.
    [Fact]
    public void AQueuedFaultCountsAsReported()
    {
        string path = FailurePath();
        var enqueues = Regex.Matches(path, @"supaQueue\.Enqueue\(\s*item\s*\)");
        Assert.True(enqueues.Count > 0, "אין הכנסה לתור בנתיב — הבדיקה חסרת ערך");

        foreach (Match m in enqueues)
        {
            string after = path[m.Index..Math.Min(path.Length, m.Index + 400)];
            Assert.Matches(new Regex(@"errorReported\s*=\s*true\s*;"), after);
        }
    }

    // ⚠️ וחלון הריסון חל גם כאן. בלעדיו נתיב הכשל עקף את הריסון שנבנה אחרי
    // 78,000 הבקשות ביום באתר 1326 — ודווקא כשהכול נופל יחד.
    [Fact]
    public void TheFailurePathRespectsTheRetryWindow()
    {
        Assert.Contains("supaNextAttempt", FailurePath());
    }

    // ============================================================
    // G — סמל הענן באתר ישיר-בלבד היה אפור 50 שניות מכל דקה
    // ============================================================
    // הקובץ נכתב רק אחרי שליחה מוצלחת — כלומר פעם בדקה באתר שקט — וה-Tray
    // מחשיב אותו טרי max(10, 3×poll) שניות. הסמל הבהב, וסמל שמהבהב לבד
    // מלמד את הטכנאי להתעלם ממנו.
    //
    // ⚠️ הסטטוס נכתב עכשיו **בכל סבב**, כמו באתר MQTT — ומחושב מהשליחה
    // האחרונה שהצליחה. ההחלטה עצמה ב-DirectLinkStatus (בדיקות התנהגות שם).
    [Fact]
    public void TheDirectLinkStatusIsWrittenEveryCycle()
    {
        string code = Code();
        int loop = code.IndexOf("while (!stoppingToken.IsCancellationRequested)\n        {\n            mirrored.Clear();",
            StringComparison.Ordinal);
        if (loop < 0) loop = code.IndexOf("mirrored.Clear();", StringComparison.Ordinal);
        Assert.True(loop > 0, "הלולאה הראשית לא נמצאה");

        int beat = code.IndexOf("WriteHeartbeat();", loop, StringComparison.Ordinal);
        int recovered = code.IndexOf("if (plcJustRecovered)", beat, StringComparison.Ordinal);
        Assert.True(beat > 0 && recovered > beat, "לא נמצא בלוק הקריאה המוצלחת");

        string block = code[beat..recovered];
        Assert.Matches(new Regex(@"WriteHiveMqStatus\(\s*DirectLinkStatus\.IsUp\("), block);
    }

    // ============================================================
    // J — חריגת דיסק בהכנסה לתור הפילה את השירות כולו
    // ============================================================
    // `PendingQueue.Enqueue` כותב קובץ, ויכול לזרוק (דיסק מלא, הרשאות,
    // אנטי-וירוס). בנקודת ההפקה ובנתיב כשל ה-PLC הקריאה לא הייתה עטופה:
    // החריגה ברחה מ-ExecuteAsync, וב-.NET ברירת המחדל היא **לעצור את
    // ה-host**. ה-Tray מפעיל מחדש, הסבב הראשון נופל שוב — ובינתיים אתר
    // שהבקר שלו תקין אינו מדווח כלום.
    //
    // ⚠️ **הבדיקה אוסרת את התבנית, לא סופרת מקומות.** כל קריאה ל-Enqueue
    // בקובץ חייבת לשבת בתוך try. קריאה שביעית שתתווסף מחר נבדקת בלי שאיש
    // יזכור להוסיף אותה לרשימה.
    [Fact]
    public void EveryEnqueueInTheWorkerIsInsideATry()
    {
        string code = Code();
        var sites = Regex.Matches(code, @"\.Enqueue\(");

        // ⚠️ בלי רצפה השער עיוור: שינוי שם היה משאיר אפס התאמות וירוק.
        Assert.True(sites.Count >= 4, $"נמצאו רק {sites.Count} קריאות Enqueue — השער אינו בודק דבר");

        var unguarded = new List<string>();
        foreach (Match m in sites)
        {
            if (IsInsideTry(code, m.Index)) continue;
            int lineStart = code.LastIndexOf('\n', m.Index) + 1;
            int lineEnd = code.IndexOf('\n', m.Index);
            unguarded.Add(code[lineStart..lineEnd].Trim());
        }

        Assert.True(unguarded.Count == 0,
            "הכנסה לתור בלי try — חריגת דיסק תעצור את השירות:\n" + string.Join("\n", unguarded));
    }

    // האם אחד הבלוקים שעוטפים את המיקום נפתח ב-`try`. סריקה לאחור על
    // סוגריים מסולסלים; מחרוזות לוג מאוזנות ({Count}) ולכן אינן משבשות.
    private static bool IsInsideTry(string code, int index)
    {
        int depth = 0;
        for (int i = index; i >= 0; i--)
        {
            char ch = code[i];
            if (ch == '}') depth++;
            else if (ch == '{')
            {
                if (depth > 0) { depth--; continue; }
                if (Regex.IsMatch(code[..i], @"\btry\s*$")) return true;
            }
        }
        return false;
    }

    // ============================================================
    // K — תור שאינו ניתן לקריאה לא יפתח לולאת פעימות חמה
    // ============================================================
    // מרגע שקובץ תור שנתקל בשגיאת IO **נשמר** (ולא נמחק), `supaWaiting`
    // נשאר חיובי בזמן ש-`LoadAll` מחזיר ריק. השער נפתח בכל סבב, `outgoing`
    // ריק — והקוד שלח `BeatAsync` **בכל שנייה**. זו בדיוק הלולאה של אתר
    // 1326 (78,000 בקשות ביום), מדלת אחרת.
    [Fact]
    public void AnEmptyBatchGoesOutOnlyAsADueBeat()
    {
        Assert.Matches(new Regex(
            @"if\s*\(\s*outgoing\.Count\s*>\s*0\s*\|\|\s*DateTimeOffset\.UtcNow\s*-\s*lastBeat\s*>=\s*HeartbeatInterval\s*\)"),
            Code());
    }
}
