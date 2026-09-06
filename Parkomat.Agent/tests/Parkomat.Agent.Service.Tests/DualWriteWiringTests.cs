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
    public void TheFunnelNotifiesTheObserver()
    {
        string src = Publisher();

        Assert.Contains("OnPublished", src);
        Assert.Contains("OnPublished?.Invoke(payload)", src);
    }

    [Fact]
    public void TheObserverRunsEvenWhenTheBrokerIsDown()
    {
        // ============================================================
        // ⚠️ הבדיקה הזו **הפוכה** ממה שהיא הייתה, וזו החלטה שנמדדה
        // ============================================================
        // היא דרשה שהצופה ייקרא **אחרי** הפרסום, בנימוק "הודעה שנכשלה
        // ב-MQTT אסור שתיכתב במקום אחר כאילו נמסרה". הנימוק היה נכון כל
        // עוד MQTT הוא ערוץ המסירה וה-Supabase רק משקף אותו.
        //
        // ⚠️ **אבל זו בדיוק הסיבה שאי אפשר היה לכבות את MQTT.** ברוקר מת
        // פירושו אפס פרסומים → אפס קריאות לצופה → אפס כתיבה ל-Supabase,
        // בזמן שהדופק ממשיך לפעום ומראה אתר תקין לחלוטין.
        //
        // ⚠️ **ונמדד בשטח באתר 2438**, ולא רק נקרא בקוד: כל שש הכתיבות
        // הישירות בלוג התרחשו אחרי שהברוקר חזר —
        //     14:14:37  Broker connection lost
        //     14:14:39  reconnected
        //     14:14:40  -> Supabase: 1 message written directly
        // אף אחת מהן לא קרתה בזמן שהברוקר היה למטה.
        //
        // הכתיבה הישירה היא **ערוץ מסירה שני**, לא רישום של מסירת MQTT.
        string src = Publisher();
        int publish = src.IndexOf("await _client.PublishAsync", StringComparison.Ordinal);
        int notify = src.IndexOf("OnPublished?.Invoke", StringComparison.Ordinal);

        Assert.True(publish > 0 && notify > 0, "לא נמצאו שני העוגנים");
        Assert.True(notify < publish,
            "הצופה נקרא אחרי הפרסום — ברוקר מת ישתיק גם את הכתיבה הישירה");
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
    public void AFailingObserverNeverBreaksAPublish()
    {
        // ⚠️ הכתיבה הישירה היא הצד המשני. חריגה ממנה שמפילה שידור MQTT
        // הופכת מסלול חדש שנכשל לשבירה של המסלול הישן שעובד.
        string src = Publisher();
        var m = Regex.Match(src, @"try\s*\{\s*OnPublished\?\.Invoke\(payload\);\s*\}\s*\n?\s*catch");
        Assert.True(m.Success, "הקריאה לצופה אינה עטופה ב-try/catch");
    }

    [Fact]
    public void WorkerMirrorsBothMessageKinds()
    {
        // ⚠️ סוג שנשכח כאן נעלם מהמסלול הישיר בשקט: הוא עדיין מגיע ל-MQTT,
        // ולכן שום דבר לא ייראה שבור עד שיכבו את MQTT.
        //
        // ⚠️ **שני מסלולים ולא ענף אחד עם שני סוגים**, וזו החלטה: מצב עובר
        // דרך הצופה (זיכרון, מתקן את עצמו ב-resync), תפעול עובר דרך התור
        // שעל הדיסק (חד-פעמי, אינו ניתן לזיהוי מחדש).
        string src = Worker();
        Assert.Contains("is StateMessage sm", src);                    // מצב → הצופה
        Assert.Contains("supaQueue.Enqueue(BatchPayload.From(op))", src); // תפעול → הדיסק
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
    public void SupabaseIsSentAfterMqttNotBefore()
    {
        // ⚠️ MQTT הוא מקור האמת בשלב הזה, ואסור שכשל ברשת החדשה יעכב אותו.
        string src = Worker();
        int drain = src.IndexOf("await mqtt.PublishOperationAsync(op", StringComparison.Ordinal);
        int send = src.IndexOf("supabase.SendAsync", StringComparison.Ordinal);

        Assert.True(drain > 0 && send > 0);
        Assert.True(send > drain, "השליחה ל-Supabase קודמת לריקון תור ה-MQTT");
    }

    [Fact]
    public void OperationsAreMirroredAtProductionNotAtEveryPublishAttempt()
    {
        // ============================================================
        // ⚠️ תפעולים **אינם** מודיעים לצופה, וזה לא חוסר עקביות
        // ============================================================
        // הם נכנסים ל-PendingQueue לפני השידור ומשודרים משם, וכשל משאיר
        // אותם בתור לניסיון הבא. כלומר הודעה אחת עוברת ב-PublishAsync
        // **פעם אחת לכל ניסיון**, לא פעם אחת בחיים.
        //
        // ⚠️ מרכוז שם היה שולח אותה ל-Supabase שוב ושוב לאורך כל הנתק —
        // עשרות בקשות לדקה בדיוק במצב שהמסלול השני קיים בשבילו, ועל
        // חשבון מכסת תעבורה שכבר חורגת.
        // ⚠️ השוואת מחרוזת ולא רג'קס: שני ניסיונות קודמים כאן נכתבו כרג'קס
        // ואיבדו את הבקסלאשים בדרך לקובץ — `\s` הפך ל-`s`, התבנית לא התאימה,
        // והבדיקה נכשלה על הכתיב ולא על הקוד. מחרוזת אין לה בעיה כזו.
        string src = Publisher();
        Assert.Contains("PublishAsync(OperationTopic, message, ct, notifyObserver: false)", src);
    }

    [Fact]
    public void StatesStillNotifyTheObserver()
    {
        // ⚠️ הצד השני של אותה החלטה: מצבים **אינם** בתור, ולכן הם עוברים
        // ב-PublishAsync פעם אחת לכל שינוי — וזו בדיוק נקודת ההפקה שלהם.
        // ברירת המחדל true היא מה שמשאיר אותם ממורכזים.
        string src = Publisher();
        Assert.Contains("bool notifyObserver = true", src);
        Assert.Contains("PublishAsync(StateTopic, message, ct)", src);
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
    public void OperationsAreMirroredToDiskNotToAnInMemoryList()
    {
        // ============================================================
        // ⚠️ חלון האובדן שהמעבר לנקודת ההפקה יצר, ונסגר כאן
        // ============================================================
        // ‎`mirrored` היא רשימה בזיכרון ונמחקת עם התהליך. תפעול שהופק
        // ונפל בו החשמל לפני שליחה מוצלחת היה **נמחק מ-Supabase לתמיד**:
        // הוא שורד ב-pendingOps ל-MQTT, אבל השידור החוזר משם כבר אינו
        // מודיע לצופה, ולכן לא היה ממורכז שוב לעולם.
        //
        // ⚠️ וזו בדיוק הנפילה שבגללה הפרויקט הזה קיים — DELL008 איבד חשמל
        // ולקח 2.5 ימים. מסלול ישיר שאינו שורד הפסקת חשמל אינו פותר אותה.
        string w = Worker();

        // התפעול נכנס לתור שעל הדיסק, ולא לרשימה
        Assert.Contains("supaQueue.Enqueue(BatchPayload.From(op));", w);

        // ⚠️ **והצופה חייב להתעלם מתפעולים לגמרי** — נבדק על גוף הלמבדה
        // ולא על שם משתנה. ניסוח קודם השווה למחרוזת `...From(op)` בלבד,
        // ומוטציה שהחזירה את הענף בשם `om` עברה אותה בשלמות: הצופה נקרא
        // בכל **ניסיון שידור**, ולכן ענף כזה מחזיר את מטח הכפילויות בנתק
        // ארוך — ובנוסף לו, התפעול כבר יושב בתור. פעמיים.
        int lambda = w.IndexOf("mqtt.OnPublished = payload =>", StringComparison.Ordinal);
        Assert.True(lambda > 0, "לא נמצא הצופה");
        int end = w.IndexOf("};", lambda, StringComparison.Ordinal);
        string body = w[lambda..end];
        Assert.DoesNotContain("OperationMessage", body);

        // ⚠️ ומצבים דווקא **כן** נשארים בזיכרון, ובכוונה: מצב מתקן את עצמו
        // ב-resync עם חותם טרי, ולכן שמירתו לדיסק היא עבודה שתוצאתה דחייה
        // על ידי שומר ה-backfill. אותה הבחנה בדיוק שעליה בנוי pendingOps.
        Assert.Contains("mirrored.Add(BatchPayload.From(sm))", body);
    }

    [Fact]
    public void AQueuedOperationTriggersASendInsteadOfWaitingForTheBeat()
    {
        // ⚠️ בלי `supaWaiting` בשער, תפעול שנכנס לתור היה יושב שם עד
        // הפעימה הבאה — עד **60 שניות** של עיכוב באתר שקט, ואצווה שנכנסה
        // לתור רק כדי להמתין. לא אובדן, אבל גם לא מה שנבנה.
        string w = Worker();
        int gate = w.IndexOf("if (supabase is not null && (mirrored.Count > 0",
                             StringComparison.Ordinal);
        Assert.True(gate > 0, "לא נמצא שער השליחה");
        Assert.Contains("supaWaiting > 0", w[gate..(gate + 200)]);
    }

    [Fact]
    public void TheWaitingCounterIsResyncedFromDiskAndNotDerived()
    {
        // ⚠️ מונה שמחסיר את מה שנמחק סוטה כלפי מעלה, כי התקרה של
        // PendingQueue מוחקת את הישן ביותר בחריגה בלי שאיש יספור. ומונה
        // שאינו יורד לאפס פירושו **ניסיון שליחה בכל סבב, לנצח** — פעימה
        // כל שתי שניות במקום כל דקה, על מכסת תעבורה שכבר חורגת.
        string w = Worker();
        Assert.Contains("supaWaiting = supaQueue.Count;", w);

        // והסנכרון אחרי השליחה, לא לפניה
        int send = w.IndexOf("supabase.SendAsync", StringComparison.Ordinal);
        int resync = w.LastIndexOf("supaWaiting = supaQueue.Count;", StringComparison.Ordinal);
        Assert.True(resync > send, "המונה מסונכרן לפני השליחה — הוא ימדוד את המצב הישן");
    }
}