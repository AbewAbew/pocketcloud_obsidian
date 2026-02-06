import { ReadingDatabase, ReadingActivity } from './ReadingDatabase';

/**
 * A single book entry for a calendar day
 */
export interface CalendarBookEntry {
    bookId: string;
    title: string;
    coverPath?: string;   // local vault path: "Attachments/Title.jpg"
    coverUrl?: string;     // remote fallback
    progressDelta?: number;
    type: 'progress' | 'finished' | 'started';
}

/**
 * Data for a single calendar day
 */
export interface CalendarDayData {
    date: string;
    books: CalendarBookEntry[];
    totalPages: number;
}

/**
 * Analytics data for reading statistics
 */
export interface ReadingAnalytics {
    // Daily data for heatmap (date string -> pages read)
    dailyPages: Record<string, number>;

    // Daily books for calendar view (date string -> book entries)
    dailyBooks: Record<string, CalendarBookEntry[]>;

    // Period stats
    totalPagesMonth: number;
    totalPagesYear: number;
    totalPages30Days: number;

    // Best day
    bestDayPages: number;
    bestDayDate: string;

    // Trend (comparing last 30 days to previous 30 days)
    trendPercent: number;

    // Reading days count
    readingDaysMonth: number;
    readingDaysYear: number;
    possibleDaysMonth: number;
    possibleDaysYear: number;

    // Current streak (already in database, but we compute for analytics)
    currentStreak: number;
    longestStreak: number;
}

/**
 * Get local YYYY-MM-DD string from date
 */
function toLocalDateString(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Generate reading analytics from activities
 */
export async function generateReadingAnalytics(
    database: ReadingDatabase,
    estimatedPagesPerBook: number = 300,
    coversFolder: string = 'Attachments',
    coverUrlLookup?: (bookId: string) => string | undefined
): Promise<ReadingAnalytics> {
    const activities = database.getAllActivities();
    const bookPageCounts = await database.getAllBookPageCounts();
    const streaks = await database.getStreaks();

    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth();

    // Calculate date boundaries
    const startOfMonth = new Date(currentYear, currentMonth, 1);
    const startOfYear = new Date(currentYear, 0, 1);
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setDate(today.getDate() - 30);
    const sixtyDaysAgo = new Date(today);
    sixtyDaysAgo.setDate(today.getDate() - 60);

    // Aggregate pages by date
    const dailyPages: Record<string, number> = {};

    // Aggregate books by date for calendar view
    const dailyBooks: Record<string, CalendarBookEntry[]> = {};

    activities.forEach(activity => {
        const date = activity.date;

        // Aggregate pages (existing logic)
        if (activity.type === 'progress' && activity.progressDelta) {
            const pageCount = bookPageCounts[activity.bookId] || estimatedPagesPerBook;
            const pagesRead = Math.round((activity.progressDelta / 100) * pageCount);
            dailyPages[date] = (dailyPages[date] || 0) + pagesRead;
        }

        // Aggregate books per day for calendar
        if (!dailyBooks[date]) {
            dailyBooks[date] = [];
        }

        // Check if this book is already in today's entries
        const existingEntry = dailyBooks[date].find(e => e.bookId === activity.bookId);
        if (existingEntry) {
            // Accumulate progressDelta for same book on same day
            existingEntry.progressDelta = (existingEntry.progressDelta || 0) + (activity.progressDelta || 0);
            // Upgrade type: finished > progress > started
            if (activity.type === 'finished') existingEntry.type = 'finished';
        } else {
            const sanitizedTitle = activity.title.replace(/[\\/:*?"<>|]/g, "");
            const entry: CalendarBookEntry = {
                bookId: activity.bookId,
                title: activity.title,
                coverPath: `${coversFolder}/${sanitizedTitle}.jpg`,
                coverUrl: coverUrlLookup ? coverUrlLookup(activity.bookId) : undefined,
                progressDelta: activity.progressDelta,
                type: activity.type,
            };
            dailyBooks[date].push(entry);
        }
    });

    // Calculate totals for different periods
    let totalPagesMonth = 0;
    let totalPagesYear = 0;
    let totalPages30Days = 0;
    let totalPagesPrev30Days = 0;
    let readingDaysMonth = 0;
    let readingDaysYear = 0;
    let bestDayPages = 0;
    let bestDayDate = '';

    Object.entries(dailyPages).forEach(([dateStr, pages]) => {
        const date = new Date(dateStr);

        // Best day
        if (pages > bestDayPages) {
            bestDayPages = pages;
            bestDayDate = dateStr;
        }

        // Year total
        if (date >= startOfYear && date <= today) {
            totalPagesYear += pages;
            readingDaysYear++;
        }

        // Month total
        if (date >= startOfMonth && date <= today) {
            totalPagesMonth += pages;
            readingDaysMonth++;
        }

        // Last 30 days
        if (date >= thirtyDaysAgo && date <= today) {
            totalPages30Days += pages;
        }

        // Previous 30 days (for trend)
        if (date >= sixtyDaysAgo && date < thirtyDaysAgo) {
            totalPagesPrev30Days += pages;
        }
    });

    // Calculate trend percentage
    let trendPercent = 0;
    if (totalPagesPrev30Days > 0) {
        trendPercent = ((totalPages30Days - totalPagesPrev30Days) / totalPagesPrev30Days) * 100;
    } else if (totalPages30Days > 0) {
        trendPercent = 100; // New reader, 100% improvement
    }

    // Calculate possible days (days elapsed in period)
    const dayOfMonth = today.getDate();
    const dayOfYear = Math.floor((today.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    return {
        dailyPages,
        dailyBooks,
        totalPagesMonth,
        totalPagesYear,
        totalPages30Days,
        bestDayPages,
        bestDayDate,
        trendPercent,
        readingDaysMonth,
        readingDaysYear,
        possibleDaysMonth: dayOfMonth,
        possibleDaysYear: dayOfYear,
        currentStreak: streaks.current,
        longestStreak: streaks.longest,
    };
}

/**
 * Get days data for heatmap (full year)
 */
export function getHeatmapData(dailyPages: Record<string, number>): { date: string; pages: number }[] {
    const year = new Date().getFullYear();
    const result: { date: string; pages: number }[] = [];

    // Generate all days of the year
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    const current = new Date(startDate);

    while (current <= endDate) {
        const dateStr = toLocalDateString(current);
        result.push({
            date: dateStr,
            pages: dailyPages[dateStr] || 0
        });
        current.setDate(current.getDate() + 1);
    }

    return result;
}

/**
 * Get calendar data for a specific month
 * @param dailyBooks - Record of date -> book entries
 * @param dailyPages - Record of date -> pages read
 * @param year - Full year (e.g. 2026)
 * @param month - 0-indexed month (0 = January)
 * @returns CalendarDayData[] for all days in that month
 */
export function getCalendarData(
    dailyBooks: Record<string, CalendarBookEntry[]>,
    dailyPages: Record<string, number>,
    year: number,
    month: number
): CalendarDayData[] {
    const result: CalendarDayData[] = [];
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        result.push({
            date: dateStr,
            books: dailyBooks[dateStr] || [],
            totalPages: dailyPages[dateStr] || 0,
        });
    }

    return result;
}
