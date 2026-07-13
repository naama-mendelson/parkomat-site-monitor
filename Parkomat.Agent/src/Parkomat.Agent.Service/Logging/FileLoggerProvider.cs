using System.Text;
using Microsoft.Extensions.Logging;
using Parkomat.Agent.Core.Configuration;

namespace Parkomat.Agent.Service.Logging;

/// <summary>
/// ספק לוגים פשוט שכותב לקובץ יומי תחת ...\Parkomat\Agent\logs\agent-YYYY-MM-DD.log.
/// נבנה בכוונה מינימלי — בלי תלות חיצונית (Serilog וכו') — כדי לשמור על תלויות דלות.
///
/// - קובץ חדש בכל יום (rolling יומי).
/// - שומר עד <see cref="_retentionDays"/> ימים ומוחק ישנים יותר, כך שהתיקייה
///   לא גדלה בלי הגבלה.
/// - רושם רק מרמה <see cref="_minLevel"/> ומעלה (ברירת מחדל: Information), כדי
///   שקריאות ה-PLC השגרתיות (Debug) לא יציפו את הקובץ.
/// - כתיבה נכשלת לעולם לא מפילה את השירות (הכול עטוף ב-try).
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly LogLevel _minLevel;
    private readonly int _retentionDays;

    // נעילה משותפת — כמה מקורות יכולים לרשום במקביל; הכתיבה לקובץ מסונכרנת.
    private readonly object _gate = new();

    // היום שכבר ניקינו עבורו קבצים ישנים, כדי לא לנקות בכל שורה.
    private DateOnly _lastCleanupDay = DateOnly.MinValue;

    public FileLoggerProvider(LogLevel minLevel = LogLevel.Information, int retentionDays = 14)
    {
        _minLevel = minLevel;
        _retentionDays = retentionDays;

        // מוודאים שתיקיית הלוגים קיימת (נוצרת בלי הרשאות מנהל — למתקין
        // כבר יש users-modify על תיקיית Parkomat\Agent).
        try { AgentPaths.EnsureLogsFolderExists(); } catch { /* לא קריטי */ }
    }

    internal LogLevel MinLevel => _minLevel;

    public ILogger CreateLogger(string categoryName) => new FileLogger(this, categoryName);

    /// <summary>כותב שורת לוג אחת לקובץ היומי. בטוח לחלוטין — לא זורק.</summary>
    internal void Write(LogLevel level, string category, string message, Exception? exception)
    {
        if (level < _minLevel)
            return;

        try
        {
            DateTime now = DateTime.Now;
            string line = Format(now, level, category, message, exception);
            string path = Path.Combine(AgentPaths.LogsFolder, $"agent-{now:yyyy-MM-dd}.log");

            lock (_gate)
            {
                // ניקוי קבצים ישנים — פעם ביום בלבד.
                DateOnly today = DateOnly.FromDateTime(now);
                if (today != _lastCleanupDay)
                {
                    _lastCleanupDay = today;
                    CleanupOldFiles(today);
                }

                File.AppendAllText(path, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch
        {
            // רישום לוג לעולם לא יפיל את השירות.
        }
    }

    // בונה שורת לוג קריאה לטכנאי: זמן מקומי, רמה, שם הרכיב, וההודעה.
    private static string Format(DateTime now, LogLevel level, string category, string message, Exception? ex)
    {
        var sb = new StringBuilder();
        sb.Append(now.ToString("yyyy-MM-dd HH:mm:ss.fff"));
        sb.Append(" [").Append(ShortLevel(level)).Append("] ");
        sb.Append(ShortCategory(category)).Append(": ");
        sb.Append(message);

        if (ex is not null)
        {
            sb.Append(Environment.NewLine);
            sb.Append(ex);
        }

        return sb.ToString();
    }

    private static string ShortLevel(LogLevel level) => level switch
    {
        LogLevel.Trace => "TRC",
        LogLevel.Debug => "DBG",
        LogLevel.Information => "INF",
        LogLevel.Warning => "WRN",
        LogLevel.Error => "ERR",
        LogLevel.Critical => "CRT",
        _ => "???"
    };

    // "Parkomat.Agent.Service.Worker" -> "Worker".
    private static string ShortCategory(string category)
    {
        if (string.IsNullOrEmpty(category))
            return "";
        int dot = category.LastIndexOf('.');
        return dot >= 0 && dot < category.Length - 1 ? category[(dot + 1)..] : category;
    }

    // מוחק קבצי agent-*.log ישנים מ-_retentionDays ימים.
    private void CleanupOldFiles(DateOnly today)
    {
        try
        {
            DateOnly cutoff = today.AddDays(-_retentionDays);
            foreach (string file in Directory.EnumerateFiles(AgentPaths.LogsFolder, "agent-*.log"))
            {
                string name = Path.GetFileNameWithoutExtension(file); // agent-YYYY-MM-DD
                string datePart = name.Length > 6 ? name[6..] : "";    // אחרי "agent-"
                if (DateOnly.TryParse(datePart, out DateOnly fileDay) && fileDay < cutoff)
                {
                    try { File.Delete(file); } catch { /* קובץ נעול — נתעלם */ }
                }
            }
        }
        catch
        {
            // ניקוי הוא best-effort; כשל בו לא משפיע על הרישום.
        }
    }

    public void Dispose()
    {
        // אין משאבים מתמשכים — כותבים open/append/close בכל שורה.
    }
}

/// <summary>ה-ILogger שמחזיר ה-provider; מעביר כל רשומה ל-<see cref="FileLoggerProvider.Write"/>.</summary>
internal sealed class FileLogger : ILogger
{
    private readonly FileLoggerProvider _provider;
    private readonly string _category;

    public FileLogger(FileLoggerProvider provider, string category)
    {
        _provider = provider;
        _category = category;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) =>
        logLevel != LogLevel.None && logLevel >= _provider.MinLevel;

    public void Log<TState>(
        LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        if (!IsEnabled(logLevel))
            return;

        string message = formatter(state, exception);
        _provider.Write(logLevel, _category, message, exception);
    }
}

/// <summary>נוחות רישום ה-provider ב-Program.cs.</summary>
public static class FileLoggerExtensions
{
    public static ILoggingBuilder AddFileLogger(
        this ILoggingBuilder builder, LogLevel minLevel = LogLevel.Information, int retentionDays = 14)
    {
        builder.AddProvider(new FileLoggerProvider(minLevel, retentionDays));
        return builder;
    }
}
