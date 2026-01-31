import { ReadingDatabase, ReadingActivity, ReadingSnapshot } from './ReadingDatabase';
import { PocketbookCloudBook } from '../apiclient';

/**
 * Statistics summary for the dashboard
 */
export interface DashboardStats {
    booksReadThisYear: number;
    booksReadThisMonth: number;
    currentlyReading: number;
    estimatedPagesToday: number;
    totalProgressToday: number; // Percentage points
    currentStreak: number;
    longestStreak: number;
}

/**
 * Book with reading progress for display
 */
export interface BookWithProgress {
    bookId: string;
    title: string;
    authors: string;
    progress: number;
    status: string;
    coverUrl?: string;       // Remote URL from Pocketbook
    localCoverPath?: string; // Local path in vault (Attachments folder)
}

/**
 * Statistics calculations from reading data
 */
export class ReadingStats {
    constructor(
        private database: ReadingDatabase,
        private estimatedPagesPerBook: number = 300
    ) { }

    /**
     * Filter books that are currently being read (progress > 0 and < 100)
     * Excludes books at 0% (not started) and 100% (completed)
     */
    getBooksCurrentlyReading(books: PocketbookCloudBook[]): PocketbookCloudBook[] {
        return books.filter(book => {
            const progress = (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0;
            // Only show books that have actual reading progress (between 1-99%)
            return progress > 0 && progress < 100;
        });
    }

    /**
     * Filter books that have been completed (100% or status 'read')
     */
    getBooksCompleted(books: PocketbookCloudBook[]): PocketbookCloudBook[] {
        return books.filter(book => {
            const progress = (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0;
            return book.read_status === 'read' || progress === 100;
        });
    }

    /**
     * Estimate pages read from progress percentage
     */
    estimatePagesFromProgress(progressPercent: number, totalPages?: number): number {
        const pages = totalPages || this.estimatedPagesPerBook;
        return Math.round((progressPercent / 100) * pages);
    }

    /**
     * Estimate pages read today based on progress deltas
     * Uses actual page counts when available
     */
    async getEstimatedPagesToday(): Promise<number> {
        const activities = await this.database.getTodayActivity();
        const bookPageCounts = await this.database.getAllBookPageCounts();

        let totalEstimatedPages = 0;
        for (const activity of activities) {
            // Use actual page count if available, otherwise use default estimate
            const actualPageCount = bookPageCounts[activity.bookId] || this.estimatedPagesPerBook;

            if (activity.progressDelta) {
                // Regular progress activity
                const pagesRead = Math.round((activity.progressDelta / 100) * actualPageCount);
                totalEstimatedPages += pagesRead;
            } else if (activity.type === 'started' && activity.newProgress && activity.newProgress < 100) {
                // "Started" activity - only count if NOT already at 100%
                // Books at 100% are pre-completed books being synced for the first time
                const pagesRead = Math.round((activity.newProgress / 100) * actualPageCount);
                totalEstimatedPages += pagesRead;
            }
        }

        return totalEstimatedPages;
    }

    /**
     * Generate today's reading summary text
     */
    async getTodaySummary(): Promise<string> {
        const activities = await this.database.getTodayActivity();

        if (activities.length === 0) {
            return "No reading activity today yet.";
        }

        const pagesEstimate = await this.getEstimatedPagesToday();
        const bookCount = new Set(activities.map(a => a.bookId)).size;
        const finishedBooks = activities.filter(a => a.type === 'finished');

        let summary = `You read ~${pagesEstimate} pages across ${bookCount} book${bookCount > 1 ? 's' : ''} today`;

        if (finishedBooks.length > 0) {
            summary += ` and finished "${finishedBooks[0].title}"`;
            if (finishedBooks.length > 1) {
                summary += ` and ${finishedBooks.length - 1} more`;
            }
        }

        return summary + '.';
    }

    /**
     * Get weekly statistics summary
     */
    async getWeeklyStats(): Promise<{
        daysRead: number;
        totalProgressPercent: number;
        estimatedPages: number;
        booksFinished: number;
    }> {
        const history = await this.database.getReadingHistory(7);

        let daysRead = 0;
        let totalProgress = 0;
        let estimatedPages = 0;
        let booksFinished = 0;

        const bookPageCounts = await this.database.getAllBookPageCounts();

        for (const [date, activities] of history) {
            if (activities.length > 0) {
                daysRead++;
            }

            for (const activity of activities) {
                if (activity.progressDelta) {
                    totalProgress += activity.progressDelta;
                    // Calculate exact pages for this activity
                    const pageCount = bookPageCounts[activity.bookId] || this.estimatedPagesPerBook;
                    // Use float precision for accumulation
                    const pages = (activity.progressDelta / 100) * pageCount;
                    estimatedPages += pages;
                }
                if (activity.type === 'finished') {
                    booksFinished++;
                }
            }
        }

        return {
            daysRead,
            totalProgressPercent: totalProgress,
            estimatedPages: Math.round(estimatedPages),
            booksFinished,
        };
    }

    /**
     * Get full dashboard statistics
     */
    async getDashboardStats(books: PocketbookCloudBook[]): Promise<DashboardStats> {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;

        // Count completed books directly from the current book list
        // This ensures books completed before tracking started are counted
        const completedBooks = this.getBooksCompleted(books);
        const booksReadThisYear = completedBooks.length; // For now, count all completed books
        const booksReadThisMonth = completedBooks.length; // TODO: Filter by completion date when available

        const currentlyReading = this.getBooksCurrentlyReading(books).length;
        const estimatedPagesToday = await this.getEstimatedPagesToday();
        const totalProgressToday = await this.database.getTodayTotalProgressDelta();
        const streaks = await this.database.getStreaks();

        return {
            booksReadThisYear,
            booksReadThisMonth,
            currentlyReading,
            estimatedPagesToday,
            totalProgressToday,
            currentStreak: streaks.current,
            longestStreak: streaks.longest,
        };
    }

    /**
     * Get currently reading books with their progress for display
     */
    async getCurrentlyReadingWithProgress(books: PocketbookCloudBook[]): Promise<BookWithProgress[]> {
        const reading = this.getBooksCurrentlyReading(books);

        return reading.map(book => ({
            bookId: book.fast_hash,
            title: book.title,
            authors: book.metadata?.authors || '',
            progress: (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0,
            status: book.read_status,
            coverUrl: book.metadata?.cover?.[0]?.path,
        }));
    }

    /**
     * Format activity for display in the feed (uses actual page counts)
     */
    async formatActivityForDisplay(activity: ReadingActivity): Promise<string> {
        // Format date and time
        let dateTimeStr: string;
        if (activity.timestamp) {
            const dt = new Date(activity.timestamp);
            dateTimeStr = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
                ' ' + dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        } else {
            const date = new Date(activity.date);
            dateTimeStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        switch (activity.type) {
            case 'finished':
                return `${dateTimeStr}: Finished "${activity.title}" 🎉`;
            case 'started':
                return `${dateTimeStr}: Started reading "${activity.title}"`;
            case 'progress':
                // Use actual page count if available
                const bookPageCount = await this.database.getBookPageCount(activity.bookId);
                const pageCount = bookPageCount || this.estimatedPagesPerBook;
                const pages = Math.round((activity.progressDelta || 0) / 100 * pageCount);
                return `${dateTimeStr}: Read ~${pages} pages of "${activity.title}"`;
            default:
                return `${dateTimeStr}: Activity on "${activity.title}"`;
        }
    }

    /**
     * Get formatted recent activity feed
     */
    async getRecentActivityFeed(limit: number = 5): Promise<string[]> {
        const activities = await this.database.getRecentActivities(limit * 2); // Fetch extra to account for filtering

        // Filter out "started" activities at 100% - these are pre-completed books being synced
        const filteredActivities = activities.filter(a => {
            if (a.type === 'started' && a.newProgress === 100) {
                return false; // Skip pre-completed books
            }
            return true;
        }).slice(0, limit);

        return Promise.all(filteredActivities.map(a => this.formatActivityForDisplay(a)));
    }

    /**
     * Calculate reading velocity (pages per day over last N days)
     */
    async getReadingVelocity(days: number = 7): Promise<number> {
        const history = await this.database.getReadingHistory(days);
        const bookPageCounts = await this.database.getAllBookPageCounts();

        let totalEstimatedPages = 0;
        for (const [, activities] of history) {
            for (const activity of activities) {
                if (activity.progressDelta) {
                    const pageCount = bookPageCounts[activity.bookId] || this.estimatedPagesPerBook;
                    totalEstimatedPages += (activity.progressDelta / 100) * pageCount;
                }
            }
        }

        return Math.round(totalEstimatedPages / days);
    }

    /**
     * Calculate estimated time to finish a book based on velocity
     */
    async getEstimatedDaysToFinish(bookId: string, currentProgress: number): Promise<number | null> {
        const velocity = await this.getReadingVelocity();

        if (velocity <= 0) return null;

        const remainingProgress = 100 - currentProgress;
        const remainingPages = (remainingProgress / 100) * this.estimatedPagesPerBook;

        return Math.ceil(remainingPages / velocity);
    }
}
