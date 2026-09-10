using Parkomat.Agent.Core.Protocol;

namespace Parkomat.Agent.Service.Tests;

/// <summary>
/// ⚠️ <b>הכלל נקבע על ידי בעלת המוצר, והוא לא "הגרוע מביניהם".</b>
///
/// <para>הכיוון האינטואיטיבי במערכת ניטור הוא שהרע גובר — אם משהו שבור,
/// תראה אותו. כאן ההחלטה הפוכה ומנומקת: אתר שאחת ממערכותיו עובדת עדיין
/// משרת רכבים, ולכן הוא <b>זמין</b>.</para>
///
/// <para>⚠️ הבדיקות האלה הן <b>ההגדרה</b> של הזמינות באתר דו-מערכתי. מי
/// שישנה אותן משנה מספר שמופיע לבעלת המוצר על המסך.</para>
/// </summary>
public class SiteStateAggregatorTests
{
    // ===== שני החריגים שנאמרו במפורש =====

    [Fact]
    public void OnlyWhenBothSystemsAreDownIsTheSiteDown()
    {
        Assert.Equal(SiteState.Error,
            SiteStateAggregator.Combine(SiteState.Error, SiteState.Error));
    }

    [Fact]
    public void OnlyWhenBothAreInMaintenanceIsTheSiteInMaintenance()
    {
        Assert.Equal(SiteState.Maintenance,
            SiteStateAggregator.Combine(SiteState.Maintenance, SiteState.Maintenance));
    }

    // ===== והכלל הכללי: הטוב מביניהן =====

    // ⚠️ **זו הבדיקה החשובה ביותר כאן.** מערכת אחת בתקלה והשנייה עובדת —
    // האתר **זמין**. זה בדיוק ההפך ממה שמערכת ניטור עושה כברירת מחדל,
    // ולכן זו גם הטעות שמישהו "יתקן" בעתיד בלי לדעת.
    [Theory]
    [InlineData(SiteState.Error, SiteState.Ready, SiteState.Ready)]
    [InlineData(SiteState.Ready, SiteState.Error, SiteState.Ready)]
    [InlineData(SiteState.Error, SiteState.Operating, SiteState.Operating)]
    [InlineData(SiteState.Maintenance, SiteState.Ready, SiteState.Ready)]
    [InlineData(SiteState.Ready, SiteState.Maintenance, SiteState.Ready)]
    public void OneWorkingSystemMakesTheSiteAvailable(SiteState a, SiteState b, SiteState expected)
    {
        Assert.Equal(expected, SiteStateAggregator.Combine(a, b));
    }

    // ⚠️ תקלה + תחזוקה = תחזוקה, כלומר האתר **יוצא מחישוב הזמינות**
    // לגמרי ולא נספר ככשל. זה נובע ישירות מ"הטוב מביניהן", ונבדק כאן
    // במפורש כי אף אחד לא אמר אותו בקול — הוא הוסק.
    [Fact]
    public void AFaultBesideMaintenanceLeavesTheSiteExcludedRatherThanFailed()
    {
        Assert.Equal(SiteState.Maintenance,
            SiteStateAggregator.Combine(SiteState.Error, SiteState.Maintenance));
    }

    // ⚠️ **המתנה מול פעולה — הסדר לא היה מקובע, ומוטציה חשפה זאת.**
    // שתיהן "המערכת עובדת", ולכן לזמינות אין הבדל. לתצוגה יש: רכב שעובר
    // באחת המערכות הוא מה שקורה באתר באותו רגע, וזו גם ההתנהגות בכל 21
    // האתרים החד-מערכתיים. לכן פעולה גוברת.
    [Fact]
    public void ACarPassingOnEitherSystemShowsAsOperating()
    {
        Assert.Equal(SiteState.Operating,
            SiteStateAggregator.Combine(SiteState.Ready, SiteState.Operating));

        Assert.Equal(SiteState.Operating,
            SiteStateAggregator.Combine(SiteState.Operating, SiteState.Ready));
    }

    // ===== מצב לא ידוע =====

    // ⚠️ MODE 4 (init) אינו מתורגם למצב, והוא חולף בעליית הבקר. מערכת
    // שמצבה אינו ידוע **אינה מורידה** את האתר — אחרת כל אתחול בקר היה
    // מהבהב תקלה, ומקטע שנפתח ונסגר הוא נתון שנשמר לתמיד.
    [Fact]
    public void AnUnknownSystemDoesNotDragTheSiteDown()
    {
        Assert.Equal(SiteState.Ready, SiteStateAggregator.Combine(null, SiteState.Ready));
        Assert.Equal(SiteState.Ready, SiteStateAggregator.Combine(SiteState.Ready, null));
        Assert.Equal(SiteState.Error, SiteStateAggregator.Combine(null, SiteState.Error));
    }

    [Fact]
    public void TwoUnknownSystemsStayUnknown()
    {
        Assert.Null(SiteStateAggregator.Combine(null, null));
    }

    // ⚠️ ואתר עם מערכת אחת בלבד — 21 האתרים האחרים — חייב לעבור דרך
    // הפונקציה הזו בלי שינוי התנהגות כלל.
    [Theory]
    [InlineData(SiteState.Ready)]
    [InlineData(SiteState.Error)]
    [InlineData(SiteState.Maintenance)]
    [InlineData(SiteState.Operating)]
    public void ASingleSystemSiteIsUnaffected(SiteState only)
    {
        Assert.Equal(only, SiteStateAggregator.Combine(only, null));
    }
}
