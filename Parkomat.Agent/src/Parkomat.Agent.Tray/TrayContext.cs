using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Parkomat.Agent.Tray.Services;

namespace Parkomat.Agent.Tray;

/// <summary>
/// הלב של אפליקציית ה-Tray: מחזיק את האייקון ליד השעון,
/// את התפריט הימני, ואת ההיגיון של הלחיצות.
/// אין חלון ראשי — האפליקציה חיה כאייקון בלבד.
/// </summary>
public class TrayContext : ApplicationContext
{
    private readonly NotifyIcon _notifyIcon;
    private readonly ServiceManager _service = new();

    // האייקונים — נטענים פעם אחת מתוך תיקיית Assets.
    private readonly Icon _iconColor;
    private readonly Icon _iconGray;

    // פריטי התפריט שצריך לעדכן לפי המצב.
    private readonly ToolStripMenuItem _toggleItem;
    private readonly ToolStripMenuItem _statusItem;

    // watchdog: דואג שה-Agent ו-Mosquitto ימשיכו לרוץ (מפעיל מחדש אם מתו).
    private readonly System.Windows.Forms.Timer _watchdog;
    private SynchronizationContext? _ui;   // לחזרה ל-thread של ה-UI מרקע
    private volatile bool _userStopped;    // המשתמש כיבה ידנית → לא להפעיל מחדש
    private volatile bool _busy;           // מונע ריצות חופפות של פעולות תהליך

    public TrayContext()
    {
        // --- טעינת האייקונים מתיקיית Assets ---
        string baseDir = AppContext.BaseDirectory;
        _iconColor = new Icon(Path.Combine(baseDir, "Assets", "logo-color.ico"));
        _iconGray = new Icon(Path.Combine(baseDir, "Assets", "logo-gray.ico"));

        // --- בניית התפריט הימני ---
        var menu = new ContextMenuStrip();

        // שורת סטטוס בראש התפריט — לא לחיצה, רק מציגה את המצב.
        _statusItem = new ToolStripMenuItem("...") { Enabled = false };
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());

        var checkItem = new ToolStripMenuItem("בדוק חיבור");
        checkItem.Click += (s, e) => OnCheckConnection();

        var settingsItem = new ToolStripMenuItem("Settings");
        settingsItem.Click += (s, e) => OnSettings();

        _toggleItem = new ToolStripMenuItem("Start");   // הטקסט יתעדכן לפי המצב
        _toggleItem.Click += (s, e) => OnToggle();

        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (s, e) => OnExit();

        menu.Items.Add(checkItem);
        menu.Items.Add(settingsItem);
        menu.Items.Add(_toggleItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);

        // --- יצירת האייקון ליד השעון ---
        _notifyIcon = new NotifyIcon
        {
            ContextMenuStrip = menu,
            Visible = true,
            Text = "Parkomat Agent"
        };

        // רענון המצב לפני שהתפריט נפתח, כדי שיציג נתונים עדכניים.
        menu.Opening += (s, e) => RefreshState();

        // שומרים הפניה ל-thread של ה-UI כדי לחזור אליו מפעולות רקע.
        _ui = SynchronizationContext.Current;

        // מפעילים את ה-Agent ו-Mosquitto מיד (ברקע, שלא לתקוע את ה-UI בעליית ה-Tray).
        KickEnsureRunning();

        // watchdog: כל 5 שניות בודק שהתהליכים חיים ומפעיל מחדש אם צריך.
        _watchdog = new System.Windows.Forms.Timer { Interval = 5000 };
        _watchdog.Tick += (s, e) => OnWatchdogTick();
        _watchdog.Start();

        // רענון ראשוני עכשיו.
        RefreshState();
    }

    // טיק ה-watchdog: מרענן אייקון (מהיר, על ה-UI) ומוודא ריצה ברקע.
    private void OnWatchdogTick()
    {
        RefreshState();
        if (_userStopped)
            return;
        KickEnsureRunning();
    }

    // מריץ EnsureRunning ברקע, בלי לחפוף לריצה קודמת ובלי לתקוע את ה-UI.
    private void KickEnsureRunning()
    {
        if (_busy)
            return;
        _busy = true;
        Task.Run(() =>
        {
            try { _service.EnsureRunning(); }
            catch { /* watchdog — לא מפילים את ה-Tray */ }
            finally { _busy = false; }
        });
    }

    /// <summary>
    /// בודק את מצב השירות ומעדכן את האייקון (צבעוני/אפור) ואת טקסט התפריט.
    /// </summary>
    private void RefreshState()
    {
        AgentServiceState state = _service.GetState();
        bool processRunning = _service.IsProcessRunning();

        // מחוברים לבקר = פעימת לב טרייה; מחוברים לענן = סטטוס HiveMQ טרי.
        bool plcConnected = state == AgentServiceState.Running;
        bool hiveConnected = plcConnected && _service.IsHiveMqConnected();

        // הסמל צבעוני *רק* כשהחיבור מושלם — גם ל-PLC וגם ל-HiveMQ.
        bool fullyConnected = plcConnected && hiveConnected;
        _notifyIcon.Icon = fullyConnected ? _iconColor : _iconGray;

        // טקסט מצב מפורט — מבדיל בין "אין בקר", "אין ענן", ו"מחובר מלא".
        string statusText;
        if (state == AgentServiceState.NotInstalled)
            statusText = "לא מותקן";
        else if (fullyConnected)
            statusText = "פועל — מחובר לבקר ולענן";
        else if (plcConnected)
            statusText = "פועל — מחובר לבקר, אין קשר לענן (HiveMQ)";
        else if (processRunning)
            statusText = "פועל — אין קשר לבקר";
        else
            statusText = "מכובה";

        // שורת הסטטוס בראש התפריט.
        _statusItem.Text = statusText;

        // ה-tooltip (מה שרואים בריחוף על האייקון).
        _notifyIcon.Text = "Parkomat Agent\n" + statusText;

        // כפתור ההפעלה/כיבוי: לפי האם התהליך חי.
        if (state == AgentServiceState.NotInstalled)
        {
            _toggleItem.Text = "הפעל את השירות";
            _toggleItem.Enabled = false;   // אין מה להפעיל אם לא מותקן
        }
        else
        {
            _toggleItem.Text = processRunning ? "כבה את השירות" : "הפעל את השירות";
            _toggleItem.Enabled = true;
        }
    }
    // --- מה קורה בלחיצות ---

    private void OnCheckConnection()
    {
        using var form = new Forms.StatusForm();
        form.ShowDialog();
    }

    private void OnSettings()
    {
        using var form = new Forms.SettingsForm();
        form.ShowDialog();

        // אחרי שמירת הגדרות (שמפעילה מחדש את התהליכים) — המשתמש רוצה ריצה,
        // אז מבטלים דגל "כובה ידנית" ונותנים ל-watchdog לשמור עליהם.
        _userStopped = false;
        RefreshState();
    }

    // כפתור הפעלה/כיבוי. הפעולות רצות ברקע כדי לא לתקוע את ה-UI.
    private void OnToggle()
    {
        bool running = _service.IsProcessRunning();

        // עדכון הכוונה מיד: אם מכבים — לא להפעיל מחדש ב-watchdog, ולהיפך.
        _userStopped = running;
        _toggleItem.Enabled = false;

        Task.Run(() => running ? _service.Stop() : _service.Start())
            .ContinueWith(t =>
            {
                string? error = t.IsFaulted ? t.Exception?.GetBaseException().Message : t.Result;
                PostToUi(() =>
                {
                    _toggleItem.Enabled = true;
                    if (error != null)
                        MessageBox.Show(error, "Parkomat Agent");
                    RefreshState();
                });
            });
    }

    // מריץ פעולה על thread ה-UI (מרקע), אם קיים; אחרת ישירות.
    private void PostToUi(Action action)
    {
        if (_ui != null)
            _ui.Post(_ => action(), null);
        else
            action();
    }

    private void OnExit()
    {
        // עוצרים את התהליכים לפני יציאה — אחרת ה-Agent ו-Mosquitto יישארו רצים ברקע.
        _watchdog.Stop();
        try { _service.Stop(); } catch { /* יציאה — לא מפילים */ }

        // מסתירים את האייקון לפני יציאה, אחרת הוא נשאר "תקוע" ליד השעון.
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        Application.Exit();
    }
}