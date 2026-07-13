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
    private readonly Label _plcResult = new();
    private readonly Label _hiveResult = new();
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
            RowCount = 2,
            Padding = new Padding(12)
        };
        content.Controls.Add(BuildCheckGroup("בדיקת PLC (בקר)", _plcResult), 0, 0);
        content.Controls.Add(BuildCheckGroup("בדיקת HiveMQ (ענן)", _hiveResult), 0, 1);

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

        SetPending(_plcResult);
        SetPending(_hiveResult);

        SiteConfig config;
        try
        {
            config = ConfigStore.Load();
        }
        catch (Exception ex)
        {
            SetResult(_plcResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            SetResult(_hiveResult, false, "שגיאה בטעינת ההגדרות: " + ex.Message);
            _checkAgain.Enabled = true;
            return;
        }

        // כל בדיקה מעדכנת את התווית שלה ברגע שהיא מסתיימת — עצמאית מהשנייה.
        Task plc = ShowWhenDone(ConnectionTester.TestPlcAsync(config.Plc), _plcResult);
        Task hive = ShowWhenDone(ConnectionTester.TestHiveMqAsync(config.Mqtt), _hiveResult);

        try { await Task.WhenAll(plc, hive); }
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
