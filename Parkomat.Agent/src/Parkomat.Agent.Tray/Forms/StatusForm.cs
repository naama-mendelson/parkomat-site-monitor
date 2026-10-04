using System.Drawing;
using System.Windows.Forms;
using Parkomat.Agent.Core.Configuration;
using Parkomat.Agent.Tray.Services;

namespace Parkomat.Agent.Tray.Forms;

/// <summary>
/// חלון "בדוק חיבור": מריץ על-פי דרישה שלוש בדיקות — זהות האתר, PLC,
/// ודיווח לדשבורד (Supabase) — ומציג לכל אחת "מתחבר..." ואז ✓/✗ עם הסיבה
/// בעברית (RTL). כולל כפתור "בדוק שוב". הבדיקות לא מפילות את החלון.
///
/// ⚠️ **אין כאן HiveMQ (1.0.57).** ‏master כבוי מ-17/09/2026, ו-MQTT כבוי
/// בכל אתר עם סיסמת Supabase. באתר 2431 (04/10) הבדיקה הציגה שגיאת DNS
/// באדום על מסלול שאיש אינו קורא — ובאותו חלון בדיקת Supabase נחתכה.
/// </summary>
public class StatusForm : Form
{
    private readonly Label _siteResult = new();
    private readonly Label _plcResult = new();
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
        // ============================================================
        // ⚠️ גודל לפי התוכן — לא גובה קבוע
        // ============================================================
        // כאן היה `ClientSize = new Size(520, 280)` — מקום לשלוש קבוצות מתוך
        // ארבע. הרביעית, "מסלול ישיר (Supabase)", נחתכה מתחתית החלון, וזו
        // בדיוק הבדיקה שקובעת אם האתר מגיע לדשבורד. נצפה באתר 2431 (04/10):
        // הטכנאי ראה רק את HiveMQ האדום. והודעה שגולשת לשתי שורות מגדילה
        // קבוצה — גובה קבוע היה חותך שוב, רק במקום אחר.
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        MinimumSize = new Size(540, 0);

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

        // --- תוכן: שלוש קבוצות בדיקה ---
        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 3,
            Padding = new Padding(12)
        };
        // ⚠️ **זהות האתר ראשונה, ובכוונה.** היא התנאי המקדים לשתי האחרות:
        // בלעדיה שתיהן יכולות להיות ירוקות והאתר עדיין לא יופיע בדשבורד.
        // מי שקורא מלמעלה למטה צריך לפגוש קודם את מה שמבטל את השאר.
        content.Controls.Add(BuildCheckGroup("זהות האתר", _siteResult), 0, 0);
        content.Controls.Add(BuildCheckGroup("בדיקת PLC (בקר)", _plcResult), 0, 1);
        content.Controls.Add(BuildCheckGroup("דיווח לדשבורד (Supabase)", _supaResult), 0, 2);

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

        Task supa = ShowWhenDone(ConnectionTester.TestSupabaseAsync(config), _supaResult);

        try { await Task.WhenAll(plc, supa); }
        catch { /* כל בדיקה כבר טופלה בנפרד ב-ShowWhenDone */ }

        _checkAgain.Enabled = true;
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
}
