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
    public void ObserverRunsOnlyAfterASuccessfulPublish()
    {
        // ⚠️ הודעה שנכשלה ב-MQTT אסור שתיכתב במקום אחר כאילו נמסרה.
        // הקריאה חייבת להיות **אחרי** ה-await של הפרסום.
        string src = Publisher();
        int publish = src.IndexOf("await _client.PublishAsync", StringComparison.Ordinal);
        int notify = src.IndexOf("OnPublished?.Invoke", StringComparison.Ordinal);

        Assert.True(publish > 0 && notify > 0, "לא נמצאו שני העוגנים");
        Assert.True(notify > publish,
            "הצופה נקרא לפני הפרסום — הודעה שנכשלה תיכתב כאילו נמסרה");
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
        string src = Worker();
        Assert.Contains("is StateMessage", src);
        Assert.Contains("is OperationMessage", src);
        Assert.Contains("BatchPayload.From", src);
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
}
