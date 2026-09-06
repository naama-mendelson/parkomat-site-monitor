using System.Globalization;
using System.Reflection;
using System.Text.RegularExpressions;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// שלושה אינווריאנטים שהיו <b>מתועדים ולא מכוסים</b>.
///
/// ⚠️ הם נמצאו בסריקת מוטציות שיטתית, לא בקריאת קוד: שלוש שבירות עברו את
/// כל 332 הבדיקות בלי שאף אחת הצביעה. זה בדיוק מה שהכלל בפרויקט אומר —
/// <b>שער שמעולם לא עבר מוטציה הוא שער שהכיסוי שלו לא ידוע</b> — ובמקרה
/// הזה הכיסוי היה אפס, בזמן שההערות בקוד מסבירות באריכות למה זה חשוב.
/// </summary>
public class UncoveredInvariantsTests
{
    private static string Worker()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        return File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Service", "Worker.cs"));
    }

    [Fact]
    public void TheReportedVersionCarriesNoCommitSha()
    {
        // ============================================================
        // ⚠️ מוטציה שעברה: הסרת Split('+') משתי נקודות
        // ============================================================
        // `AssemblyInformationalVersion` הוא "1.0.36+<40 תווי גיבוב>".
        // הערך הזה נכתב לעמודה `alive.agent_version` ולשורת העלייה בלוג,
        // ושתיהן קיימות כדי לענות על שאלה אחת: **איזו גרסה רצה באיזה
        // אתר**. ארבעים תווי גיבוב בעמודה כזו הופכים אותה לבלתי קריאה
        // בדיוק במקום שבו קוראים אותה.
        //
        // ההערות בקוד מסבירות את זה בשתי הנקודות — ואף בדיקה לא אכפה אותו.
        string real = typeof(Worker).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()!
            .InformationalVersion;
        Assert.Contains("+", real);   // ⚠️ אחרת הבדיקה חסרת ערך

        string w = Worker();
        int hits = w.Split(".InformationalVersion").Length - 1;
        Assert.True(hits >= 2, $"נמצאו {hits} קריאות לגרסה — צפויות שתיים");

        // כל קריאה חייבת להיחתך ב-'+'
        foreach (string part in w.Split(".InformationalVersion").Skip(1))
            Assert.StartsWith(".Split('+')[0]", part.TrimStart());
    }

    [Fact]
    public void TheQueueFileNameSortsChronologically()
    {
        // ============================================================
        // ⚠️ מוטציה שעברה: הריפוד D13 הוסר משם הקובץ
        // ============================================================
        // `PendingQueue` מסתמך על **מיון לקסיקלי** של שמות הקבצים כדי לרוקן
        // את התור בסדר כרונולוגי. בלי ריפוד לאורך קבוע "9" גדול מ-"10"
        // לקסיקלית — כלומר התור מתרוקן **בסדר הפוך** סביב כל גבול ספרות.
        //
        // ⚠️ וזה כשל שקט לחלוטין: כל ההודעות מגיעות, אף אחת אינה אובדת,
        // ורק הסדר משתבש — מה שמזיז משכים ואת שומר ה-backfill בשרת.
        //
        // ⚠️ **התבנית נקראת מהמקור ולא משוכפלת כאן.** בדיקה שמחזיקה עותק
        // משלה הייתה עוברת גם אחרי ששינו את המקור — כלומר בודקת את עצמה.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);
        string src = File.ReadAllText(Path.Combine(dir!.FullName, "src",
            "Parkomat.Agent.Core", "Queue", "PendingQueue.cs"));

        var m = Regex.Match(src, @"string\.Format\([^,]+,\s*""([^""]+)""");
        Assert.True(m.Success, "לא נמצאה תבנית שם הקובץ ב-PendingQueue");
        string fmt = m.Groups[1].Value;

        // ⚠️ חוצים גבול ספרות בשני השדות: 999→1000 בזמן, ו-9→10 ברץ.
        long[] times = { 9L, 10L, 99L, 100L, 999L, 1000L, 1_788_000_000_000L };
        var names = times.Select(t => string.Format(CultureInfo.InvariantCulture, fmt, t, 7)).ToList();

        Assert.Equal(names.OrderBy(x => x, StringComparer.Ordinal).ToList(), names);

        // ואותו דבר לשדה הרץ, שקיים כי מעבר MODE אחד מייצר שתי פעולות
        // באותה מילישנייה — ובלעדיו השנייה הייתה דורסת את הראשונה.
        int[] seqs = { 1, 2, 9, 10, 99, 100, 4095 };
        var bySeq = seqs.Select(q => string.Format(CultureInfo.InvariantCulture, fmt, 1_788_000_000_000L, q)).ToList();
        Assert.Equal(bySeq.OrderBy(x => x, StringComparer.Ordinal).ToList(), bySeq);
    }
}
