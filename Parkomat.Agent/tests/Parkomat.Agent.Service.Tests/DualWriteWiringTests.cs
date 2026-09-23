using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// השידור הכפול מחווט דרך <b>תפר אחד</b>, ולא בשכפול בכל אתר שידור.
///
/// ⚠️ <b>הבעיה שזה מונע.</b> <c>Worker</c> משדר משישה מקומות שונים, וחלקם
/// בונים את ההודעה בתוך הקריאה עצמה. שכפול הכתיבה ל-Supabase בכל אחד מהם
/// היה עניין של זיכרון: <b>אתר שביעי שיתווסף מחר לא יימסר לשום מקום</b>,
/// בלי שגיאה ובלי סימן — ההודעה תגיע ל-MQTT ותיעדר מהמסלול הישיר, וזה
/// יתגלה רק ביום שבו MQTT ייכבה.
///
/// ⚠️ <b>ולכן זו בדיקה מבנית ולא התנהגותית.</b> אין כאן DOM ואין רשת;
/// היא מוכיחה את החיווט, לא את הריצה. אותו שיקול בדיוק כמו
/// <c>admin-gate.test.js</c> ו-<c>client-ip.test.js</c> בשרת.
/// </summary>
public class DualWriteWiringTests
{
    private static string Read(params string[] parts)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine([dir!.FullName, "src", .. parts]);
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllText(path);
    }

    private static string Publisher() =>
        Read("Parkomat.Agent.Service", "Mqtt", "MqttPublisher.cs");

    private static string Worker() =>
        Read("Parkomat.Agent.Service", "Worker.cs");

    [Fact]
    public void EveryPublishFlowsThroughTheSingleFunnel()
    {
        string src = Publisher();

        // ⚠️ שתי המתודות הציבוריות **חייבות** לנתב ל-PublishAsync ולא לפרסם
        // בעצמן. הרגע שאחת מהן תפרסם ישירות היא הרגע שבה הצופה מפספס אותה.
        Assert.Matches(new Regex(@"PublishStateAsync[^\n]*\n?\s*=>\s*PublishAsync\("), src);
        Assert.Matches(new Regex(@"PublishOperationAsync[^\n]*\n?\s*=>\s*PublishAsync\("), src);
    }

    [Fact]
    public void TheSentAuditStaysAfterThePublish()
    {
        // ⚠️ ו-`SentAuditLog` **לא** עבר למעלה עם הצופה, ובכוונה: הוא עונה
        // על "מה שודר ב-MQTT", וזו שאלה אחרת מ"מה נמסר". ערבוב השניים היה
        // הופך את `agent-sent-*.jsonl` לחסר משמעות בדיוק כשחוקרים נתק —
        // הקובץ היה מראה הודעות ששודרו, בזמן שהברוקר היה מנותק.
        string src = Publisher();
        int publish = src.IndexOf("await _client.PublishAsync", StringComparison.Ordinal);
        int audit = src.IndexOf("SentAuditLog.Log", StringComparison.Ordinal);

        Assert.True(publish > 0 && audit > 0, "לא נמצאו שני העוגנים");
        Assert.True(audit > publish,
            "לוג השידורים נכתב לפני הפרסום — הוא יתעד הודעות שלא שודרו");
    }

    [Fact]
    public void TheBatchIsClearedAtTheStartOfEveryCycle()
    {
        // ⚠️ סבב שזורק לפני השליחה מדלג על הניקוי שבסוף. בלי ניקוי בתחילת
        // הסבב האצווה גדלה עד שהיא חורגת מתקרת 200 של השרת — ואז **כל**
        // שליחה נדחית לנצח בגלל סבב אחד שנכשל לפני שעה.
        string src = Worker();
        int loop = src.IndexOf("--- הלולאה הראשית ---", StringComparison.Ordinal);
        int clear = src.IndexOf("mirrored.Clear();", loop > 0 ? loop : 0, StringComparison.Ordinal);
        int send = src.IndexOf("supabase.SendAsync", StringComparison.Ordinal);

        Assert.True(loop > 0, "לא נמצאה הלולאה הראשית");
        Assert.True(clear > loop, "אין ניקוי בתוך הלולאה");
        Assert.True(clear < send, "הניקוי אינו קודם לשליחה — האצווה תגדל בכל סבב שנכשל");
    }

    [Fact]
    public void DirectWriteIsOffWhenNotConfigured()
    {
        // ⚠️ זה מה שמאפשר לשגר את הגרסה ל-16 אתרים בלי לשנות דבר. הכותב
        // כלל אינו נוצר, ולכן גם הצופה אינו נרשם ואין עלות בכלל.
        string src = Worker();
        Assert.Contains("config.Supabase.Enabled", src);
        Assert.Matches(new Regex(@"config\.Supabase\.Enabled\s*\n?\s*\?\s*new SupabaseWriter"), src);
    }

    [Fact]
    public void TheWorkerMirrorsOperationsWhenItQueuesThem()
    {
        // ⚠️ ואם זה נופל — תפעולים לא ייכתבו ל-Supabase **בכלל**, כי
        // PublishOperationAsync כבר אינו מודיע לצופה. שתי השורות האלה הן
        // מנגנון אחד, ומחיקת אחת מהן משתיקה חצי מהנתונים בשקט.
        string w = Worker();
        Assert.Contains("pendingOps.Enqueue(op);", w);
        Assert.Contains("supaQueue.Enqueue(BatchPayload.From(op));", w);

        // ⚠️ והמרכוז חייב להיות **אחרי** ההכנסה לתור ובאותה לולאה: שורה
        // שהתנתקה משם היא שורה שמישהו יזיז בלי לשים לב שהיא חצי ממנגנון.
        int enq = w.IndexOf("pendingOps.Enqueue(op);", StringComparison.Ordinal);
        int mir = w.IndexOf("supaQueue.Enqueue(BatchPayload.From(op));", StringComparison.Ordinal);
        Assert.True(mir > enq && mir - enq < 1600,
            "המרכוז אינו צמוד להכנסה לתור — שני חצאים של מנגנון אחד");
    }

    [Fact]
    public void TheStartupLineNamesTheIdentityItActuallyUses()
    {
        // ⚠️ נמדד באתר 2438, ולא חשש: השורה יצאה כ-
        //     Direct Supabase write is ON for  ->
        // כי היא הדפיסה את שדות ה**עקיפה**, שריקים בכל 18 האתרים מתוכנן
        // (ריק = ברירת המחדל הצרובה). זו השורה היחידה שעונה "באיזו זהות,
        // מול איזה שרת", והיא לא ענתה דבר — בדיוק כשקוראים אותה כדי לברר
        // למה אתר אינו כותב. והריקנות אף נראית כמו תקלת הגדרה, ושולחת
        // לחפש בכיוון שבו אין דבר.
        // ⚠️ העוגן כולל את שדות התבנית `{Email}`, שקיימים **רק בקריאה**.
        // בלעדיהם ההתאמה הראשונה נופלת על ההערה שמעל, שמצטטת את הפלט
        // השגוי מהשטח — והחלון הנקרא הוא הערה ולא קוד.
        string w = Worker();
        int line = w.IndexOf("Direct Supabase write is ON for {Email} -> {Url}",
                             StringComparison.Ordinal);
        Assert.True(line > 0, "לא נמצאה שורת הפתיחה של המסלול הישיר");

        string args = w[line..(line + 260)];
        Assert.Contains("EffectiveEmail", args);
        Assert.Contains("EffectiveUrl", args);
    }

    [Fact]
    public void AnOffDirectPathSaysSoInsteadOfSayingNothing()
    {
        // ============================================================
        // ⚠️ היעדר שורה אינו ראיה — נמדד בחקירה אמיתית
        // ============================================================
        // ב-06/09/2026 היו שתי עליות באותו קובץ לוג, ובאחת מהן המסלול היה
        // כבוי. זה נודע **רק מכך שהשורה השנייה חסרה** — והיעדר נראה זהה
        // לגרסה שאינה יודעת להדפיס אותה בכלל. חקירה שנשענת על היעדר היא
        // ניחוש עם ביטחון עצמי.
        //
        // ו-`Enabled` נגזר משלושה תנאים, אז "כבוי" לבדו אינו תשובה: השורה
        // חייבת לומר איזה מהם נכשל.
        string w = Worker();
        int off = w.IndexOf("Direct Supabase write is OFF", StringComparison.Ordinal);
        Assert.True(off > 0, "מצב כבוי אינו מדפיס דבר — היעדר שורה יילמד כראיה");

        string args = w[off..(off + 420)];
        Assert.Contains("Password", args);          // האם קיימת
        Assert.Contains("EffectiveUrl", args);
        Assert.Contains("EffectiveEmail", args);

        // ⚠️ ורק *האם* קיימת. סיסמת אתר בקובץ לוג היא סיסמה שנשלחת
        // בצילום מסך בוואטסאפ ברגע שמישהו מבקש "תשלחי את הלוג".
        Assert.DoesNotContain("{Password}", args);
    }

    [Fact]
    public void TheStartupLineNamesTheVersion()
    {
        // ⚠️ הגרסה דווחה רק דרך `alive.agent_version`, כלומר **רק כשהמסלול
        // הישיר דולק**. באתר שבו משהו השתבש — בדיוק המקרה שחוקרים — הלוג
        // לא ידע לומר איזו גרסה רצה. שאלה שאי אפשר לענות עליה מהלוג היא
        // שאלה שעונים עליה בניחושים.
        string w = Worker();
        Assert.Contains("=== Parkomat Agent {Version} starting ===", w);
    }

    // ============================================================
    // עצמאות מ-MQTT — הקבוצה שנולדה מניסוי בשטח
    // ============================================================

    [Fact]
    public void TheDirectPathIsNotInsideTheBrokerTry()
    {
        // ============================================================
        // ⚠️ הבאג שביטל את כל המסלול הישיר, ושלוש בדיקות ירוקות פספסו
        // ============================================================
        // הכתיבה ל-Supabase ישבה בתוך ה-try שנפתח ב-EnsureConnectedAsync.
        // ברוקר מקומי שאינו זמין זורק בשורה הראשונה — ואז **הכול מדלג**:
        // הכתיבה הישירה, וגם הפעימה. כלומר המסלול שנבנה כדי לשרוד את
        // נפילת MQTT יכול היה לרוץ רק בסבב שבו MQTT דווקא עבד.
        //
        // ⚠️ נמדד פעמיים: בלוג של אתר 2438 כל שש הכתיבות הישירות הופיעו
        // מיד אחרי חיבור-מחדש; ובניסוי מבוקר ב-06/09/2026 סוכן שהורץ בלי
        // ברוקר כלל לא כתב דבר בשלוש דקות — לא הודעה, ואפילו לא פעימה.
        // ⚠️ **הטענה היא "לא בתוך ה-try", ולא "אחרי המחרוזת הזו".** הגרסה
        // הראשונה השוותה מיקומים ודרשה `send > lost`, כלומר הניחה שיש
        // בקובץ כתיבה ישירה **אחת**. ברגע שנוספה כתיבה ישירה בנתיב כשל
        // ה-PLC — שיושב *לפני* שלב הברוקר, ולכן בטוח בדיוק כפי שנדרש —
        // ‏`IndexOf` תפס דווקא אותה והשער האדים על קוד תקין.
        //
        // עכשיו נבדק מה שבאמת חשוב: גוף ה-try של הברוקר עצמו.
        string w = Worker();
        int connect = w.IndexOf("await mqtt.EnsureConnectedAsync", StringComparison.Ordinal);
        int lost = w.IndexOf("Broker connection lost", StringComparison.Ordinal);
        Assert.True(connect > 0 && lost > connect, "לא נמצאו העוגנים של שלב הברוקר");

        string brokerTry = w[connect..lost];
        Assert.DoesNotContain("supabase.SendAsync", brokerTry);
        Assert.DoesNotContain("supabase.BeatAsync", brokerTry);

        // ⚠️ ובלי זה הבדיקה ריקה: קובץ בלי שום כתיבה ישירה היה עובר אותה.
        Assert.Contains("supabase.SendAsync", w[lost..]);
        Assert.Contains("supabase.BeatAsync", w[lost..]);
    }

    [Fact]
    public void TheDirectPathHasItsOwnCatch()
    {
        // ⚠️ ו-catch משלו, לא שיתוף עם MQTT: כשל ברשת ל-Supabase אינו כשל
        // ברוקר, וערבובם היה מדווח "הברוקר נפל" על תקלה אחרת לגמרי —
        // כלומר שולח את מי שמאבחן למקום הלא נכון, שוב.
        string w = Worker();
        Assert.Contains("Direct write cycle failed", w);
    }

    [Fact]
    public void StatesAreMirroredAtProductionToo()
    {
        // ⚠️ **וזה החצי השני של אותו באג.** המצב מורכז דרך הצופה, שיושב
        // ב-PublishAsync — ולכן היה תלוי בכך שהמתודה בכלל נקראת. היא
        // נמצאת אחרי EnsureConnectedAsync, כך שברוקר מת פירושו מצב שלא
        // נכתב ל-Supabase.
        //
        // ⚠️ ומצב הוא הדבר שהכי חשוב שיגיע כשהברוקר למטה: תקלה שנוצרה
        // בזמן נתק MQTT היא בדיוק המקרה שהמסלול השני קיים בשבילו.
        // ============================================================
        // ⚠️ **התנאי נבדק, ולא רק הקריאה — וזה נמדד**
        // ============================================================
        // בבדיקת מוטציות (22/09/2026) הפכתי את התנאי ל-`supabase is null`.
        // כלומר מצב לא היה מגיע ל-Supabase **לעולם** — והחבילה נשארה
        // ירוקה, כי המחרוזת שחיפשנו עדיין שם. שלוש מוטציות מאותו סוג
        // עברו כך: מצב, resync, ותיאור התקלה המאוחר.
        //
        // בדיקה מבנית שמחפשת קריאה בלבד מוכיחה שהשורה קיימת, לא שהיא
        // רצה. לכן נבדק המשפט השלם עם השומר שלו.
        string w = Squish(Worker());
        Assert.Contains(Squish("if (result.State is not null && supabase is not null) mirrored.Add(BatchPayload.From(result.State));"), w);

        // וגם ה-resync, שנולד בתוך שלב ג' — בלי מרכוז מפורש שם הוא לא
        // היה מגיע ל-Supabase כלל, כי הצופה כבר אינו קיים.
        Assert.Contains(Squish("if (supabase is not null) mirrored.Add(BatchPayload.From(resyncMessage));"), w);
    }

    // ⚠️ השוואה בלי רגישות לרווחים ולשורות: הטענה היא על **הקוד**, ועימוד
    // מחדש אינו שינוי התנהגות. בלי זה כל בדיקה כזו נשברת על עריכה תמימה,
    // ובדיקה שנשברת סתם היא בדיקה שמוחקים.
    private static string Squish(string s) => Regex.Replace(s, @"\s+", " ");

    [Fact]
    public void TheLateFaultTextGoesOutOnTheDirectPathToo()
    {
        // ============================================================
        // ⚠️ התיאור של התקלה נעלם מהמסך — נמדד, ולא הוסק
        // ============================================================
        // הבקר כותב את תיאור התקלה **אחרי** ה-MODE, ולכן רוב התקלות
        // משודרות בלי תיאור והוא נשלח בשידור משלים. השידור המשלים ישב על
        // <c>TryPublishAsync(mqtt, …)</c> בלבד — כלומר MQTT ותו לא.
        //
        // כל עוד השרת רץ הוא קלט אותו ומילא (<c>fillFaultTextIfMissing</c>),
        // ולכן הפער היה בלתי נראה. ב-17/09/2026 השרת כובה לצמיתות, ומאז
        // נמדד בייצור: **1 מתוך 51 תקלות עם תיאור**, מול 135 מתוך 243 לפני.
        // 117 הודעות תקלה ישירות בלי תיאור מול 17 עם.
        //
        // ⚠️ וזה בדיוק אותו כשל שכבר תועד כאן פעמיים — נתיב שמשדר דרך
        // <c>mqtt</c> ואינו מוסיף ל-<c>mirrored</c>. לכן הבדיקה שומרת על
        // הנתיב הזה בשמו, ולא על "איזשהו mirrored.Add בקובץ".
        //
        // הצד השני כבר מוכן: <c>app.ingest_state</c> ממלאת תיאור חסר
        // למקטע הפתוח גם כשהמצב לא השתנה (ingest.postgres.sql).
        string w = Worker();
        int late = w.IndexOf("Fault text arrived", StringComparison.Ordinal);
        Assert.True(late > 0, "לא נמצא השידור המשלים של תיאור התקלה");

        // חלון עד תחילת הסעיף הבא (ריקון תור הפעולות) — כלומר גוף השידור המשלים בלבד.
        int next = w.IndexOf("pendingOps.LoadAll", late, StringComparison.Ordinal);
        Assert.True(next > late, "לא נמצא סוף הסעיף של השידור המשלים");

        // ⚠️ הטקסט עצמו, ולא רק השדה: מוטציה ל-`FaultText = null` השאירה את
        // המילה "FaultText" במקומה והבדיקה נשארה ירוקה — כלומר התיקון של
        // היום היה מתבטל בלי שאיש יראה. נמדד בבדיקת מוטציות.
        string block = Squish(w[late..next]);
        Assert.Contains("FaultText = late.Text", block);
        Assert.Contains(Squish("if (supabase is not null) mirrored.Add(BatchPayload.From(lateState));"), block);
    }

    [Fact]
    public void TheObserverSeamIsGoneEntirely()
    {
        // ============================================================
        // ⚠️ תפר אחד שנשמע נכון וייצר שני באגים בלתי תלויים
        // ============================================================
        // הרעיון — מקום אחד שרואה כל שידור, במקום שכפול בשישה אתרים —
        // נכון. המימוש ישב על **ניסיון השידור** ולא על **הפקת ההודעה**,
        // ומשם:
        //   1. תפעול שנכשל משודר בכל סבב, כלומר נשלח ל-Supabase שוב ושוב
        //      לאורך כל הנתק.
        //   2. וכשהברוקר למטה, המתודה כלל אינה נקראת — כלומר המנגנון
        //      שנבנה כדי שלא נפספס דבר שתק בדיוק במצב שהוא קיים בשבילו.
        //
        // ההגנה מפני "אתר שידור שביעי שיישכח" נשמרת בבדיקות שמעל, על
        // נקודות ההפקה — ולא בתפר שאפשר לעקוף בלי לשים לב.
        // ⚠️ נבדק על **קוד**, לא על טקסט: ההערות שמתעדות למה התפר הוסר הן
        // החלק היקר של השינוי, ובדיקה שאוסרת את המילה הייתה מכריחה למחוק
        // בדיוק אותן — כלומר להשאיר את הקוד נקי ואת הסיבה אבודה.
        foreach (string src in new[] { Publisher(), Worker() })
        {
            Assert.DoesNotContain("OnPublished?.Invoke", src);
            Assert.DoesNotContain("OnPublished =", src);
            Assert.DoesNotContain("OnPublished { get;", src);
            Assert.DoesNotContain("notifyObserver:", src);
            Assert.DoesNotContain("bool notifyObserver", src);
        }
    }

    // ============================================================
    // ⚠️ תיאור התקלה נקרא לפני המירור — אחרת המסלול הישיר מקבל עותק ריק
    // ============================================================
    // נמדד בייצור 23/09/2026: **אפס תיאורי תקלה מאז 17/09**, היום שבו `master`
    // כובה, מול 165 מתוך 348 בחודש שלפניו. `BatchPayload.From` מעתיק את השדות
    // ברגע הקריאה, והתיאור הוצמד להודעה רק בשלב ג' — כלומר MQTT קיבל טקסט
    // והמסלול הישיר קיבל עותק בלי. כל עוד השרת רץ הוא מילא את החסר, ולכן זה
    // נראה תקין ונחשף רק כשהוא כובה.
    //
    // ⚠️ הבדיקה היא על **סדר** ולא על קיום: שתי השורות היו קיימות גם כשהבאג
    // היה חי, ובדיקה שמחפשת מחרוזת הייתה ירוקה לאורך כל התקופה.
    [Fact]
    public void FaultTextIsAttachedBeforeTheDirectPathCopiesTheMessage()
    {
        string src = Worker();

        int read = src.IndexOf("result.State.FaultText = await ReadFaultTextOrNullAsync", StringComparison.Ordinal);
        int mirror = src.IndexOf("mirrored.Add(BatchPayload.From(result.State))", StringComparison.Ordinal);

        Assert.True(read > 0, "הקריאה של תיאור התקלה נעלמה");
        Assert.True(mirror > 0, "המירור למסלול הישיר נעלם");
        Assert.True(read < mirror,
            "תיאור התקלה מוצמד אחרי שההודעה הועתקה למסלול הישיר — העותק ייצא בלי טקסט");

        // ואין הצמדה נוספת אחרי המירור: היא הייתה מועילה ל-MQTT בלבד ומחזירה
        // בדיוק את הפער שנמדד.
        int later = src.IndexOf("result.State.FaultText = ", mirror, StringComparison.Ordinal);
        Assert.True(later < 0, "יש הצמדת תיאור נוספת אחרי המירור — המסלול הישיר יישאר בלעדיה");
    }
}
