using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ============================================================
/// התיאור שהגיע באיחור — ההחלטה, בהרצה
/// ============================================================
/// <para>הבקר כותב את טקסט התקלה <b>אחרי</b> ה-MODE, ולכן כמחצית מהודעות
/// ה-error יוצאות בלי תיאור. המנגנון הזה ממשיך לדגום ומשלים אותו.</para>
///
/// <para>⚠️ <b>למה הקובץ הזה קיים.</b> שתי גרסאות רצופות — 1.0.53 ו-1.0.55 —
/// נשלחו לשטח עם הבאג הזה חי, בזמן שכל 587 הבדיקות היו ירוקות. נמדד
/// בביקורת 23/09/2026: <b>117 מתוך 587 הבדיקות קוראות קוד מקור כטקסט</b>,
/// ו-<c>Worker.cs</c> — שבו יושבת כל ההחלטה אם אתר מדווח — אינו מורץ אף
/// פעם. הבדיקות כאן <b>מריצות</b> את ההחלטה.</para>
/// </summary>
public class LateFaultTextTrackerTests
{
    // ============================================================
    // דריכה
    // ============================================================

    [Fact]
    public void ErrorWithoutTextArmsTheWait()
    {
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);
        Assert.True(t.Awaiting);
    }

    [Fact]
    public void ErrorWithTextDoesNotArm()
    {
        // ⚠️ אין מה להשלים. דריכה כאן הייתה מייצרת שידור משלים מיותר,
        // ובמקרה הגרוע דורסת תיאור קיים בתיאור שנקרא מאוחר יותר.
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, "דלת החניון פתוחה");
        Assert.False(t.Awaiting);
    }

    [Fact]
    public void EmptyStringCountsAsNoText()
    {
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, "");
        Assert.True(t.Awaiting);
    }

    [Theory]
    [InlineData(SiteState.Ready)]
    [InlineData(SiteState.Operating)]
    [InlineData(SiteState.Maintenance)]
    public void ANonErrorStateDisarmsAPreviousWait(SiteState state)
    {
        // ⚠️ הבקר התאושש. הטקסט שהיה נקרא עכשיו שייך לתקלה שנגמרה,
        // ושליחתו הייתה מדביקה תיאור שגוי למקטע הבא.
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);
        Assert.True(t.Awaiting);

        t.OnStateProduced(state, null);
        Assert.False(t.Awaiting);
    }

    // ============================================================
    // דגימה
    // ============================================================

    [Fact]
    public void WhileErrorContinuesTheTrackerAsksForAread()
    {
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);

        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));
        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));
        Assert.Equal(2, t.Polls);
    }

    [Fact]
    public void NotArmedMeansIdleAndNoCounting()
    {
        var t = new LateFaultTextTracker();
        Assert.Equal(LateFaultTextStep.Idle, t.Next(SiteState.Error));
        Assert.Equal(LateFaultTextStep.Idle, t.Next(SiteState.Error));
        Assert.Equal(0, t.Polls);
    }

    [Fact]
    public void RecoveryMidWaitGivesUpAndStaysGivenUp()
    {
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);
        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));

        Assert.Equal(LateFaultTextStep.GiveUp, t.Next(SiteState.Ready));
        // ⚠️ ולא חוזר מעצמו: הסבב הבא כבר Idle, לא ReadNow.
        Assert.Equal(LateFaultTextStep.Idle, t.Next(SiteState.Error));
    }

    [Fact]
    public void AnUnknownModeGivesUpToo()
    {
        // ⚠️ `ModeTranslator.FromMode` מחזיר null על MODE שאינו מוכר — בקר
        // באתחול, או כתובת רגיסטר שהוקלדה שגוי. אין תקלה ידועה שאפשר
        // להשלים לה תיאור, ואין טעם לדגום 80 רגיסטרים מבקר שממילא לא בריא.
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);

        Assert.Equal(LateFaultTextStep.GiveUp, t.Next(null));
        Assert.False(t.Awaiting);
    }

    [Fact]
    public void TheCounterOnlyMovesWhileTheStateIsStillError()
    {
        // ⚠️ סדר הבדיקות ב-`Next` אינו אדיש: `||` מקצר, ולכן `++_polls`
        // מתבצע רק כשהמצב תקלה. בדיקה הפוכה הייתה שורפת את התקרה על
        // סבבים שבהם ממילא אין מה לקרוא.
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);
        t.Next(SiteState.Error);
        Assert.Equal(1, t.Polls);

        t.Next(SiteState.Ready);
        Assert.Equal(1, t.Polls);
    }

    [Fact]
    public void TheCeilingStopsTheWaitAfterExactlyMaxPolls()
    {
        var t = new LateFaultTextTracker(maxPolls: 3);
        t.OnStateProduced(SiteState.Error, null);

        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));   // 1
        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));   // 2
        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));   // 3
        Assert.Equal(LateFaultTextStep.GiveUp, t.Next(SiteState.Error));    // 4 — מעבר לתקרה
        Assert.False(t.Awaiting);
    }

    [Fact]
    public void TheDefaultCeilingIsTheDocumentedOne()
    {
        // התקרה היא כשתי דקות בקצב ברירת המחדל. מספר שנעלם בשקט הוא
        // בדיוק מה שהופך "לא מצאנו תיאור" ל"הפסקנו לחפש מוקדם מדי".
        Assert.Equal(120, LateFaultTextTracker.DefaultMaxPolls);
    }

    [Fact]
    public void FindingTheTextEndsTheWait()
    {
        var t = new LateFaultTextTracker();
        t.OnStateProduced(SiteState.Error, null);
        t.Next(SiteState.Error);

        t.OnTextFound();
        Assert.False(t.Awaiting);
        Assert.Equal(LateFaultTextStep.Idle, t.Next(SiteState.Error));
    }

    [Fact]
    public void ASecondFaultRestartsTheCounter()
    {
        // ⚠️ בלי האיפוס, תקלה שנייה באותו יום הייתה יורשת מונה כמעט מלא
        // ומוותרת אחרי סבב אחד — כלומר תיאור שאבד בלי סיבה נראית.
        var t = new LateFaultTextTracker(maxPolls: 3);
        t.OnStateProduced(SiteState.Error, null);
        t.Next(SiteState.Error);
        t.Next(SiteState.Error);
        Assert.Equal(2, t.Polls);

        t.OnStateProduced(SiteState.Error, null);
        Assert.Equal(0, t.Polls);
        Assert.Equal(LateFaultTextStep.ReadNow, t.Next(SiteState.Error));
    }

    // ============================================================
    // ⚠️ והחיווט — היכן הוא יושב ב-Worker
    // ============================================================
    // זו בדיקה מבנית, ובמפורש: אי אפשר להריץ את הלולאה של Worker. אבל
    // היא אינה מחפשת מחרוזת — היא **סופרת סוגריים**, ומוכיחה שהקריאה
    // יושבת מחוץ לכל בלוק `if (config.MqttEnabled)`.
    //
    // ⚠️ זה בדיוק הבאג: כל המנגנון ישב בתוך שלב ג', כלומר באתר עם
    // `Mqtt.Disabled = true` הוא לא רץ מעולם. הבדיקה הקודמת השוותה
    // **מיקום של מחרוזות** והייתה ירוקה גם כשהבלוק היה בפנים.

    private static string[] WorkerLines()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "src")))
            dir = dir.Parent;
        Assert.NotNull(dir);

        string path = Path.Combine(dir!.FullName, "src", "Parkomat.Agent.Service", "Worker.cs");
        Assert.True(File.Exists(path), $"קובץ חסר: {path}");
        return File.ReadAllLines(path);
    }

    /// <summary>
    /// השורה בלי הערות ובלי מחרוזות — כלומר קוד בלבד.
    ///
    /// <para>⚠️ <b>הגרסה הראשונה של הבדיקה הזו נכשלה על עצמה</b>, ושווה
    /// לזכור למה: היא חיפשה <c>if (config.MqttEnabled)</c> בשורה גולמית,
    /// ותפסה את ה<b>הערה</b> שמסבירה את התיקון — הערה שמצטטת את הביטוי.
    /// כלומר השער היה אדום על קוד תקין. אותו כשל בדיוק מתועד ב-
    /// <c>check-agent-email</c>: עוגן שתופס אזכור במקום שימוש.</para>
    ///
    /// <para>⚠️ ומחרוזות נמחקות גם הן, כי תבניות הלוג מכילות סוגריים
    /// מסולסלים (<c>"{State}"</c>) — ספירת סוגריים שתכלול אותן תסטה.</para>
    /// </summary>
    private static string CodeOnly(string line)
    {
        var sb = new System.Text.StringBuilder(line.Length);
        bool inString = false;
        for (int i = 0; i < line.Length; i++)
        {
            char c = line[i];

            if (inString)
            {
                if (c == '\\') { i++; continue; }         // תו נמלט — לדלג על הבא
                if (c == '"') inString = false;
                continue;                                  // תוכן המחרוזת אינו קוד
            }

            if (c == '"') { inString = true; continue; }
            if (c == '/' && i + 1 < line.Length && line[i + 1] == '/') break;   // הערה עד סוף השורה

            sb.Append(c);
        }
        return sb.ToString();
    }

    /// <summary>טווחי השורות של כל בלוק <c>if (config.MqttEnabled)</c>.</summary>
    private static List<(int from, int to)> MqttBlocks(string[] raw)
    {
        string[] lines = raw.Select(CodeOnly).ToArray();
        var spans = new List<(int, int)>();
        for (int i = 0; i < lines.Length; i++)
        {
            if (!lines[i].Contains("if (config.MqttEnabled)")) continue;

            // הסוגר הפותח הוא בשורה הזו או באחת הבאות.
            int depth = 0;
            bool opened = false;
            for (int j = i; j < lines.Length; j++)
            {
                foreach (char c in lines[j])
                {
                    if (c == '{') { depth++; opened = true; }
                    else if (c == '}') depth--;
                }
                if (opened && depth == 0) { spans.Add((i, j)); break; }
                // תנאי בלי סוגריים — שורה אחת ותו לא.
                if (!opened && lines[j].TrimEnd().EndsWith(';')) { spans.Add((i, j)); break; }
            }
        }
        Assert.NotEmpty(spans);
        return spans;
    }

    /// <summary>
    /// ⚠️ גם כאן דרך <c>CodeOnly</c>: אזכור של הקריאה בתוך הערה אינו
    /// קריאה, ולתפוס אותו פירושו לבדוק את השורה הלא נכונה.
    /// </summary>
    private static int LineOf(string[] raw, string needle)
    {
        int at = Array.FindIndex(raw, l => CodeOnly(l).Contains(needle));
        Assert.True(at >= 0, $"לא נמצא ב-Worker.cs כקוד (לא כהערה): {needle}");
        return at;
    }

    /// <summary>
    /// אותה שורה אינה נמצאת בתוך בלוק MQTT — <b>ואינה מותנית בו בעצמה</b>.
    ///
    /// <para>⚠️ <b>החלק השני נולד ממוטציה ששרדה.</b> הגרסה הראשונה בדקה רק
    /// "בתוך בלוק", ומוטציה שהוסיפה <c>&amp;&amp; config.MqttEnabled</c> על
    /// אותה שורה השאירה את כל הבדיקות ירוקות — כלומר השער היה עיוור בדיוק
    /// לצורה הקלה ביותר להחזיר את הבאג.</para>
    /// </summary>
    private static void AssertNotGatedOnMqtt(string[] lines, int at, string what)
    {
        var inside = MqttBlocks(lines).Where(s => at >= s.from && at <= s.to).ToList();
        Assert.True(
            inside.Count == 0,
            $"{what} יושב בשורה {at + 1}, בתוך `if (config.MqttEnabled)` " +
            $"שמשתרע על שורות {string.Join(", ", inside.Select(s => $"{s.from + 1}–{s.to + 1}"))}. " +
            "באתר עם Mqtt.Disabled=true הוא לא ירוץ מעולם — וזה הבאג שהבדיקה הזו נכתבה בשבילו.");

        Assert.False(
            CodeOnly(lines[at]).Contains("config.MqttEnabled"),
            $"{what} בשורה {at + 1} מותנה ב-`config.MqttEnabled` על אותה שורה. " +
            "זו אותה תוצאה בדיוק: באתר ישיר-בלבד הוא לא ירוץ.");
    }

    [Theory]
    [InlineData("lateFaultText.OnStateProduced(")]
    [InlineData("lateFaultText.Next(")]
    public void TheLateFaultTextWiringSitsOutsideEveryMqttBlock(string call)
    {
        string[] lines = WorkerLines();
        AssertNotGatedOnMqtt(lines, LineOf(lines, call), $"`{call}`");
    }

    [Fact]
    public void TheMirrorOfTheLateMessageIsNotGatedOnMqttEither()
    {
        // ⚠️ המירור הוא מה שמגיע ל-Supabase. גם אם הקריאה תרוץ, מירור
        // שנשאר בתוך בלוק ה-MQTT היה משאיר את האתר הישיר בלי תיאור.
        string[] lines = WorkerLines();
        AssertNotGatedOnMqtt(lines,
            LineOf(lines, "mirrored.Add(BatchPayload.From(lateState))"),
            "המירור של ההודעה המשלימה");
    }
}
