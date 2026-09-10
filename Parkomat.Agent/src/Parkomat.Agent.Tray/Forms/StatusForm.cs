using System.Drawing;
using System.Windows.Forms;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray.Services;

namespace Parkomat.Agent.Tray.Forms;

/// <summary>
/// חלון "בדוק חיבור": מריץ על-פי דרישה שתי בדיקות — PLC ו-HiveMQ —
/// ומציג לכל אחת "מתחבר..." ואז ✓/✗ עם הסיבה בעברית (RTL).
/// כולל כפתור "בדוק שוב". הבדיקות עטופות ב-try/catch ולא מפילות את החלון.
/// </summary>
public class StatusForm : Form
{
    private readonly Label _siteResult = new();
    private readonly Label _plcResult = new();
    private readonly Label _hiveResult = new();
    private readonly Label _supaResult = new();
    private readonly Button _checkAgain = new();

    public StatusForm()
    {
        // --- הגדרות החלון ---
        Text = "בדיקת חיבור — Parkomat Agent";
        RightToLeft = RightToLeft.Yes;
        RightToLeftLayout = true;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        AutoScaleMode = AutoScaleMode.Font;
        ClientSize = new Size(520, 280);

        // --- כפתורים (למטה, תמיד גלויים) ---
        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            Dock = DockStyle.Bottom,
            AutoSize = true,
            Padding = new Padding(12)
        };
        _checkAgain.Text = "בדוק שוב";
        _checkAgain.Width = 110;
        _checkAgain.Height = 32;
        _checkAgain.Click += (s, e) => RunChecks();

        var close = new Button { Text = "סגור", Width = 90, Height = 32 };
        close.Click += (s, e) => Close();

        buttons.Controls.Add(_checkAgain);
        buttons.Controls.Add(close);

        // --- תוכן: שתי קבוצות בדיקה ---
        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 4,
            Padding = new Padding(12)
        };
        // ⚠️ **זהות האתר ראשונה, ובכוונה.** היא התנאי המקדים לשתי האחרות:
        // בלעדיה שתיהן יכולות להיות ירוקות והאתר עדיין לא יופיע בדשבורד.
        // מי שקורא מלמעלה למטה צריך לפגוש קודם את מה שמבטל את השאר.
        content.Controls.Add(BuildCheckGroup("זהות האתר", _siteResult), 0, 0);
        content.Controls.Add(BuildCheckGroup("בדיקת PLC (בקר)", _plcResult), 0, 1);
        content.Controls.Add(BuildCheckGroup("בדיקת HiveMQ (ענן)", _hiveResult), 0, 2);
        content.Controls.Add(BuildCheckGroup("בדיקת מסלול ישיר (Supabase)", _supaResult), 0, 3);

        Controls.Add(content);
        Controls.Add(buttons);

        // מריצים את הבדיקות אחרי שהחלון מוצג (כדי שהוא יופיע מיד עם "מתחבר...").
        Shown += (s, e) => RunChecks();
    }

    // בונה קבוצה עם כותרת ותווית סטטוס.
    private static GroupBox BuildCheckGroup(string title, Label resultLabel)
    {
        var g = new GroupBox
        {
            Text = title,
            Dock = DockStyle.Top,
            AutoSize = true,
            Padding = new Padding(10),
            Margin = new Padding(0, 0, 0, 10)
        };

        resultLabel.AutoSize = true;
        resultLabel.MaximumSize = new Size(470, 0);   // מאפשר גלישה לכמה שורות
        resultLabel.Dock = DockStyle.Top;
        resultLabel.Font = new Font(resultLabel.Font.FontFamily, 10f);

        g.Controls.Add(resultLabel);
        return g;
    }

    // מפעיל את שתי הבדיקות במקביל. async void בכוונה — זהו מטפל אירוע UI.
    private async void RunChecks()
    {
        _checkAgain.Enabled = false;

        SetPending(_siteResult);
        SetPending(_plcResult);
        SetPending(_hiveResult);
        SetPending(_supaResult);

        SiteConfig config;
        try
        {
            config = ConfigStore.Load();
        }
        catch (Exception ex)
        {
            SetResult(_siteResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            SetResult(_plcResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            SetResult(_hiveResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            SetResult(_supaResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            _checkAgain.Enabled = true;
            return;
        }

        // ⚠️ **רצה תמיד, וגם כשהיא נכשלת השאר ממשיכות.** מפתה להפסיק כאן
        // ולחסוך שתי בדיקות רשת, אבל טכנאי שבא לתקן מזהה ריק ירצה לדעת
        // באותו מסך אם גם הבקר והענן תקינים — אחרת הוא יתקן, ייסע, ויגלה
        // בעיה שנייה מחר.
        TestResult site = ConnectionTester.TestSiteId(config);
        SetResult(_siteResult, site.Success, site.Message);

        // כל בדיקה מעדכנת את התווית שלה ברגע שהיא מסתיימת — עצמאית מהשנייה.
        Task plc = ShowWhenDone(ConnectionTester.TestPlcAsync(config.Plc), _plcResult);

        // ============================================================
        // ⚠️ HiveMQ נבדק רק אם הוא בכלל בשימוש באתר הזה
        // ============================================================
        // הבדיקה רצה תמיד, ולכן אתר שכובה ממנו בכוונה הציג לנצח
        // "החיבור ל-HiveMQ נכשל". **אזהרה שקרית גרועה מאזהרה חסרה** —
        // היא שולחת מישהו לתקן ברוקר שתקין, וזה בדיוק הנימוק שבגללו
        // שלב הברוקר ב-Worker מדולג במקום לזרוק.
        //
        // `MqttEnabled` נגזר (`!(Disabled && Supabase.Enabled)`), ולכן
        // אתר בלי סיסמת Supabase נשאר על MQTT ויבדק — גם אם מישהו כתב
        // `Disabled: true` בקובץ.
        Task hive = config.MqttEnabled
            ? ShowWhenDone(ConnectionTester.TestHiveMqAsync(config.Mqtt), _hiveResult)
            : SetSkipped(_hiveResult, "MQTT כבוי באתר הזה — האתר מדווח ישירות ל-Supabase.");

        Task supa = ShowWhenDone(ConnectionTester.TestSupabaseAsync(config), _supaResult);

        try { await Task.WhenAll(plc, hive, supa); }
        catch { /* כל בדיקה כבר טופלה בנפרד ב-ShowWhenDone */ }

        _checkAgain.Enabled = true;
    }

    // ⚠️ **"מדולג" אינו "נכשל" ואינו "הצליח".** תווית ירוקה על בדיקה
    // שלא רצה היא שקר, ואדומה שולחת לתקן משהו תקין. הטקסט אומר למה.
    private static Task SetSkipped(Label target, string why)
    {
        SetNeutral(target, why);
        return Task.CompletedTask;
    }

    // ממתין לתוצאת בדיקה ומעדכן את התווית — לעולם לא זורק אל ה-UI.
    private async Task ShowWhenDone(Task<TestResult> task, Label target)
    {
        try
        {
            TestResult result = await task;
            SetResult(target, result.Success, result.Message);
        }
        catch (Exception ex)
        {
            SetResult(target, false, "שגיאה בבדיקה: " + ex.Message);
        }
    }

    private static void SetPending(Label label)
    {
        label.ForeColor = Color.DimGray;
        label.Text = "מתחבר...";
    }

    private static void SetResult(Label label, bool success, string message)
    {
        label.ForeColor = success ? Color.Green : Color.Firebrick;
        label.Text = (success ? "✓ " : "✗ ") + message;
    }

    // ⚠️ **צבע שלישי, ולא ירוק ולא אדום.** בדיקה שדולגה אינה הצלחה
    // ואינה כישלון; שני הצבעים הקיימים היו משקרים — ירוק על משהו שלא
    // נבדק, או אדום ששולח לתקן דבר תקין.
    private static void SetNeutral(Label label, string message)
    {
        label.ForeColor = Color.DimGray;
        label.Text = "– " + message;
    }
}
