import { App, Notice, TFile } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { ReadingDatabase, ReadingActivity } from './ReadingDatabase';
import { ReadingStats, DashboardStats, BookWithProgress } from './ReadingStats';
import { PocketbookCloudBook } from '../apiclient';

/**
 * Core tracking logic that integrates with the sync process
 */
export class ReadingTracker {
    private database: ReadingDatabase;
    private stats: ReadingStats;
    private cachedBooks: PocketbookCloudBook[] = [];

    constructor(
        private app: App,
        private plugin: PocketbookCloudHighlightsImporterPlugin
    ) {
        this.database = new ReadingDatabase(app, plugin);
        this.stats = new ReadingStats(
            this.database,
            plugin.settings.estimatedPagesPerBook || 300
        );
    }

    /**
     * Initialize the tracker (load data)
     */
    async initialize(): Promise<void> {
        await this.database.load();
    }

    /**
     * Called after API fetch to record progress snapshots
     */
    async onSync(books: PocketbookCloudBook[]): Promise<void> {
        if (!this.plugin.settings.enableTracking) {
            return;
        }

        console.log('[ReadingTracker] Processing sync with', books.length, 'books');

        // Cache books for dashboard use
        this.cachedBooks = books;

        const activities: ReadingActivity[] = [];

        for (const book of books) {
            try {
                // Use mtime from book as the timestamp of the activity if available
                const occurredAt = book.mtime;

                const activity = await this.database.addSnapshot({
                    fast_hash: book.fast_hash,
                    title: book.title,
                    metadata: book.metadata,
                    read_percent: (book as any).read_percent,
                    percent: (book as any).percent,
                    read_status: book.read_status,
                }, occurredAt); // Pass occurredAt here

                if (activity) {
                    activities.push(activity);
                }
            } catch (e) {
                console.error('[ReadingTracker] Error recording snapshot for', book.title, e);
            }
        }

        // Update streaks based on today's activity
        const hasReadToday = activities.length > 0 ||
            (await this.database.getTodayActivity()).length > 0;
        await this.database.updateStreaks(hasReadToday);

        // Update last sync timestamp
        await this.database.updateLastSync();

        // Save all changes
        await this.database.save();

        // Show notification for significant activities
        this.notifyActivities(activities);

        console.log('[ReadingTracker] Sync complete. Activities:', activities.length);
    }

    /**
     * Show notifications for reading activities
     */
    private async notifyActivities(activities: ReadingActivity[]): Promise<void> {
        const finished = activities.filter(a => a.type === 'finished');
        const progress = activities.filter(a => a.type === 'progress');

        if (finished.length > 0) {
            new Notice(`🎉 Congratulations! You finished "${finished[0].title}"!`);
        }

        if (progress.length > 0) {
            // Calculate pages using actual page counts when available
            const bookPageCounts = await this.database.getAllBookPageCounts();
            const defaultPages = this.plugin.settings.estimatedPagesPerBook || 300;

            let totalEstimatedPages = 0;
            for (const activity of progress) {
                const pageCount = bookPageCounts[activity.bookId] || defaultPages;
                totalEstimatedPages += Math.round(((activity.progressDelta || 0) / 100) * pageCount);
            }

            if (totalEstimatedPages > 0) {
                new Notice(`📚 You read ~${totalEstimatedPages} pages since last sync!`);
            }
        }
    }

    /**
     * Get dashboard statistics
     */
    async getDashboardStats(): Promise<DashboardStats> {
        return this.stats.getDashboardStats(this.cachedBooks);
    }

    /**
     * Get currently reading books with progress
     */
    async getCurrentlyReading(): Promise<BookWithProgress[]> {
        return this.stats.getCurrentlyReadingWithProgress(this.cachedBooks);
    }

    /**
     * Get recent activity feed for display
     */
    async getRecentActivityFeed(limit: number = 10): Promise<string[]> {
        return this.stats.getRecentActivityFeed(limit);
    }

    /**
     * Get today's reading summary
     */
    async getTodaySummary(): Promise<string> {
        return this.stats.getTodaySummary();
    }

    /**
     * Get status bar text for streak display
     */
    async getStatusBarText(): Promise<string> {
        const streaks = await this.database.getStreaks();
        const todayActivity = await this.database.getTodayActivity();

        if (streaks.current > 0) {
            const todayRead = todayActivity.length > 0 ? '✓' : '○';
            return `📚 ${streaks.current} day streak ${todayRead}`;
        }

        return todayActivity.length > 0 ? '📚 Read today ✓' : '📚 Start reading!';
    }

    /**
     * Check if streak is at risk (hasn't read today and it's getting late)
     */
    async isStreakAtRisk(): Promise<boolean> {
        const streaks = await this.database.getStreaks();
        const todayActivity = await this.database.getTodayActivity();

        if (streaks.current === 0) return false;
        if (todayActivity.length > 0) return false;

        // Streak is at risk if it's after 8 PM and haven't read today
        const hour = new Date().getHours();
        return hour >= 20;
    }

    /**
     * Get the last sync timestamp
     */
    async getLastSync(): Promise<string> {
        return this.database.getLastSync();
    }

    /**
     * Get estimated pages read today
     */
    async getEstimatedPagesToday(): Promise<number> {
        return this.stats.getEstimatedPagesToday();
    }

    /**
     * Get weekly statistics
     */
    async getWeeklyStats(): Promise<{
        daysRead: number;
        totalProgressPercent: number;
        estimatedPages: number;
        booksFinished: number;
    }> {
        return this.stats.getWeeklyStats();
    }

    /**
     * Get books from cache (for dashboard to use without re-fetching)
     */
    getCachedBooks(): PocketbookCloudBook[] {
        return this.cachedBooks;
    }

    /**
     * Set cached books (used when dashboard fetches fresh data)
     */
    setCachedBooks(books: PocketbookCloudBook[]): void {
        this.cachedBooks = books;
    }

    /**
     * Force refresh statistics (re-calculate from database)
     */
    async refresh(): Promise<void> {
        await this.database.load();
    }

    /**
     * Get the database instance (for advanced operations)
     */
    getDatabase(): ReadingDatabase {
        return this.database;
    }

    /**
     * Get the stats calculator instance
     */
    getStatsCalculator(): ReadingStats {
        return this.stats;
    }

    /**
     * Get completed books with their details
     */
    async getCompletedBooks(): Promise<BookWithProgress[]> {
        const completedBooks = this.stats.getBooksCompleted(this.cachedBooks);
        return this.enrichBooksWithCovers(completedBooks);
    }

    /**
     * Get currently reading books with covers
     */
    async getCurrentlyReadingWithCovers(): Promise<BookWithProgress[]> {
        const readingBooks = this.stats.getBooksCurrentlyReading(this.cachedBooks);
        return this.enrichBooksWithCovers(readingBooks);
    }

    /**
     * Enrich books with local cover paths
     */
    private async enrichBooksWithCovers(books: PocketbookCloudBook[]): Promise<BookWithProgress[]> {
        const coversFolder = this.plugin.settings.covers_folder || 'Attachments';

        return books.map(book => {
            const progress = (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0;
            const sanitizedTitle = book.title.replace(/[\\/:*?"<>|]/g, "");
            const localCoverPath = `${coversFolder}/${sanitizedTitle}.jpg`;

            // Check if local cover exists
            const coverFile = this.app.vault.getAbstractFileByPath(localCoverPath);

            return {
                bookId: book.fast_hash,
                title: book.title,
                authors: book.metadata?.authors || '',
                progress,
                status: book.read_status,
                coverUrl: book.metadata?.cover?.[0]?.path,
                localCoverPath: coverFile ? localCoverPath : undefined,
            };
        });
    }

    /**
     * Get a random highlight from the import folder
     */
    async getRandomHighlight(): Promise<{ text: string; title: string; path: string } | null> {
        const importFolder = this.plugin.settings.import_folder.replace(/^\//, ''); // Normalized path
        const folder = this.app.vault.getAbstractFileByPath(importFolder);

        if (!folder || !(folder as any).children) {
            return null;
        }

        // Get all markdown files in the folder
        // We use a simple recursive approach or just list children if flat
        // Let's assume flat for now based on settings "Import Folder"
        // But better to use `getMarkdownFiles()` which covers subfolders if the API allows or just iterate children
        let files: TFile[] = [];

        // Helper to collect files recursively
        const collectFiles = (folder: any) => {
            if (folder.children) {
                for (const child of folder.children) {
                    if (child instanceof TFile && child.extension === 'md') {
                        files.push(child);
                    } else if (child.children) { // is folder
                        collectFiles(child);
                    }
                }
            }
        };

        collectFiles(folder);

        if (files.length === 0) return null;

        // Try up to 5 random files to find a highlight
        for (let i = 0; i < 5; i++) {
            const randomFile = files[Math.floor(Math.random() * files.length)];
            const content = await this.app.vault.read(randomFile);

            // Regex to find blockquotes: > [!quote] ... or just > ...
            // The template uses > [!quote] usually.
            // Let's look for callouts or standard quotes
            const highlightRegex = />\s*\[!quote\]\s*\n(>.*(\n|$))+/g;
            // Simplified regex: Look for lines starting with > that are NOT frontmatter
            // Actually, let's just find "any quote block"
            // The user's template might vary. Assuming Callouts from standard template.

            const matches = content.match(/>\s*\[!quote\][\s\S]*?(?=\n\n|$)/g);

            if (matches && matches.length > 0) {
                const randomBlock = matches[Math.floor(Math.random() * matches.length)];
                // Clean up the text
                const text = randomBlock
                    .replace(/>\s*\[!quote\]\s*/, '') // remove header
                    .replace(/^>\s*/gm, '') // remove > from lines
                    .trim();

                if (text.length > 10 && text.length < 500) { // Filter snippet size
                    return {
                        text,
                        title: randomFile.basename,
                        path: randomFile.path
                    };
                }
            }
        }

        return null;
    }

    /**
     * Get the covers folder from settings
     */
    getCoversFolder(): string {
        return this.plugin.settings.covers_folder || 'Attachments';
    }
}
