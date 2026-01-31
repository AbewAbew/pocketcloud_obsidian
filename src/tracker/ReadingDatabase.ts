import { App, TFile } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';

/**
 * Represents a single snapshot of reading progress for a book
 */
export interface ReadingSnapshot {
    date: string;           // ISO date "2026-01-24"
    bookId: string;         // fast_hash from Pocketbook
    title: string;
    authors: string;
    progress: number;       // read_percent (0-100)
    status: string;         // read_status (reading, read, etc.)
    timestamp: number;      // Unix timestamp for precise ordering
}

/**
 * Activity entry for the activity feed
 */
export interface ReadingActivity {
    date: string;
    bookId: string;
    title: string;
    type: 'progress' | 'finished' | 'started';
    progressDelta?: number; // Percentage points gained
    newProgress?: number;
    timestamp?: number; // Unix timestamp for time display
}

/**
 * Streak tracking data
 */
export interface StreakData {
    current: number;
    longest: number;
    lastReadDate: string;   // ISO date of last reading activity
}

/**
 * Complete reading tracker data structure
 */
export interface ReadingData {
    version: number;        // Schema version for migrations
    snapshots: ReadingSnapshot[];
    activities: ReadingActivity[];
    streaks: StreakData;
    lastSync: string;       // ISO datetime
    bookPageCounts: Record<string, number>;  // bookId -> actual page count
}

const DEFAULT_DATA: ReadingData = {
    version: 1,
    snapshots: [],
    activities: [],
    streaks: {
        current: 0,
        longest: 0,
        lastReadDate: '',
    },
    lastSync: '',
    bookPageCounts: {},
};

const DATA_FILE_NAME = 'reading-tracker-data.json';

/**
 * Local JSON-based storage for reading progress snapshots
 */
export class ReadingDatabase {
    private data: ReadingData = DEFAULT_DATA;
    private loaded = false;

    constructor(
        private app: App,
        private plugin: PocketbookCloudHighlightsImporterPlugin
    ) { }

    /**
     * Load data from the JSON file in vault root
     */
    async load(): Promise<void> {
        try {
            let content = '';
            const file = this.app.vault.getAbstractFileByPath(DATA_FILE_NAME);

            if (file instanceof TFile) {
                content = await this.app.vault.read(file);
            } else if (await this.app.vault.adapter.exists(DATA_FILE_NAME)) {
                console.log('[ReadingTracker] File not in cache, reading directly from adapter');
                content = await this.app.vault.adapter.read(DATA_FILE_NAME);
            }

            if (content) {
                const parsed = JSON.parse(content);
                // Deep merge or specific property merge to avoid reference issues
                this.data = {
                    ...DEFAULT_DATA,
                    ...parsed,
                    // Ensure bookPageCounts is merged correctly if it exists in parsed, or new object if not
                    bookPageCounts: parsed.bookPageCounts || {}
                };
                console.log(`[ReadingTracker] Loaded data. Books with page counts: ${Object.keys(this.data.bookPageCounts).length}`);
            } else {
                // If we get here, neither cache nor adapter found the file
                throw new Error('No data found');
            }
            this.loaded = true;
        } catch (e) {
            console.log('[ReadingTracker] Load failed or no data, starting fresh:', e);
            this.data = JSON.parse(JSON.stringify(DEFAULT_DATA)); // Deep clone defaults
            this.loaded = true;
        }
    }

    /**
     * Save data to the JSON file
     */
    async save(): Promise<void> {
        try {
            const content = JSON.stringify(this.data, null, 2);
            const file = this.app.vault.getAbstractFileByPath(DATA_FILE_NAME);

            if (file instanceof TFile) {
                await this.app.vault.modify(file, content);
            } else {
                await this.app.vault.create(DATA_FILE_NAME, content);
            }
            console.log('[ReadingTracker] Data saved successfully.');
        } catch (e) {
            console.error('[ReadingTracker] Failed to save data:', e);
        }
    }

    /**
     * Ensure data is loaded before operations
     */
    private async ensureLoaded(): Promise<void> {
        if (!this.loaded) {
            await this.load();
        }
    }

    /**
     * Get the current date as ISO string (YYYY-MM-DD)
     */
    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    /**
     * Add or update a snapshot for a book
     */
    async addSnapshot(book: {
        fast_hash: string;
        title: string;
        metadata?: { authors?: string };
        read_percent?: number;
        percent?: string;
        read_status?: string;
    }, occurredAt?: string): Promise<ReadingActivity | null> {
        await this.ensureLoaded();

        // Use occurredAt date if provided, otherwise today
        const today = occurredAt ? new Date(occurredAt).toISOString().split('T')[0] : this.getTodayDate();
        const timestamp = occurredAt ? new Date(occurredAt).getTime() : Date.now();

        const bookId = book.fast_hash;
        const progress = book.read_percent ?? parseFloat(book.percent || '0') ?? 0;
        const status = book.read_status || 'unknown';
        const authors = book.metadata?.authors || '';

        // Find the most recent snapshot for this book
        const previousSnapshots = this.data.snapshots
            .filter(s => s.bookId === bookId)
            .sort((a, b) => b.timestamp - a.timestamp);

        const previousSnapshot = previousSnapshots[0];

        // Create new snapshot
        const newSnapshot: ReadingSnapshot = {
            date: today,
            bookId,
            title: book.title,
            authors,
            progress,
            status,
            timestamp: timestamp,
        };

        // Check if we already have a snapshot for this book on this date
        const todaySnapshotIndex = this.data.snapshots.findIndex(
            s => s.bookId === bookId && s.date === today
        );

        if (todaySnapshotIndex >= 0) {
            // Update existing snapshot for this date
            // Only update if new snapshot is "newer" or has more progress?
            // Actually, if we are processing a sync for "Yesterday", and we already have a snapshot for "Yesterday",
            // we should probably just take the latest data from the server for that day.
            this.data.snapshots[todaySnapshotIndex] = newSnapshot;
        } else {
            // Add new snapshot
            this.data.snapshots.push(newSnapshot);
        }

        // Determine activity type and create activity entry
        let activity: ReadingActivity | null = null;

        if (!previousSnapshot) {
            // First time seeing this book
            if (progress > 0) {
                activity = {
                    date: today,
                    bookId,
                    title: book.title,
                    type: 'started',
                    newProgress: progress,
                    timestamp: timestamp,
                };
            }
        } else if (progress > previousSnapshot.progress) {
            // Progress increased
            const delta = progress - previousSnapshot.progress;

            if (status === 'read' && previousSnapshot.status !== 'read') {
                // Book was finished
                activity = {
                    date: today,
                    bookId,
                    title: book.title,
                    type: 'finished',
                    progressDelta: delta,
                    newProgress: progress,
                    timestamp: timestamp,
                };
            } else {
                // Regular progress
                activity = {
                    date: today,
                    bookId,
                    title: book.title,
                    type: 'progress',
                    progressDelta: delta,
                    newProgress: progress,
                    timestamp: timestamp,
                };
            }
        } else if (progress === previousSnapshot.progress && todaySnapshotIndex === -1) {
            // Progress didn't change, but it's a new day/entry?
            // If progress is same as "latest known snapshot", no activity.
            // But we might still want to record a snapshot for "Today" just to have a record?
            // The code above already added the snapshot. So we just don't create an activity.
        }

        // Add activity if there was change
        if (activity) {
            // Always add new progress activities (don't accumulate - each sync is a separate log entry)
            // Only dedupe for 'started' and 'finished' types
            if (activity.type !== 'progress') {
                // Remove duplicate 'started' or 'finished' for same book today
                this.data.activities = this.data.activities.filter(
                    a => !(a.bookId === bookId && a.date === today && a.type === activity!.type)
                );
            }
            this.data.activities.push(activity);

            // Keep only last 100 activities
            if (this.data.activities.length > 100) {
                this.data.activities = this.data.activities.slice(-100);
            }
        }

        return activity;
    }

    /**
     * Get progress delta for a book since a specific date
     */
    async getProgressDelta(bookId: string, sinceDate: string): Promise<number> {
        await this.ensureLoaded();

        const relevantSnapshots = this.data.snapshots
            .filter(s => s.bookId === bookId && s.date >= sinceDate)
            .sort((a, b) => a.timestamp - b.timestamp);

        if (relevantSnapshots.length < 2) return 0;

        const first = relevantSnapshots[0];
        const last = relevantSnapshots[relevantSnapshots.length - 1];

        return last.progress - first.progress;
    }

    /**
     * Get all reading activity for today
     */
    async getTodayActivity(): Promise<ReadingActivity[]> {
        await this.ensureLoaded();
        const today = this.getTodayDate();
        return this.data.activities.filter(a => a.date === today);
    }

    /**
     * Get recent activities for the activity feed
     */
    async getRecentActivities(limit: number = 20): Promise<ReadingActivity[]> {
        await this.ensureLoaded();
        return [...this.data.activities]
            .sort((a, b) => {
                // Sort by timestamp if available, otherwise by date
                if (a.timestamp && b.timestamp) {
                    return b.timestamp - a.timestamp;
                }
                return b.date.localeCompare(a.date);
            })
            .slice(0, limit);
    }

    /**
     * Get all activities (for analytics)
     */
    getAllActivities(): ReadingActivity[] {
        return this.data.activities;
    }

    /**
     * Get the latest snapshot for each book
     */
    async getLatestSnapshots(): Promise<Map<string, ReadingSnapshot>> {
        await this.ensureLoaded();

        const latestByBook = new Map<string, ReadingSnapshot>();

        for (const snapshot of this.data.snapshots) {
            const existing = latestByBook.get(snapshot.bookId);
            if (!existing || snapshot.timestamp > existing.timestamp) {
                latestByBook.set(snapshot.bookId, snapshot);
            }
        }

        return latestByBook;
    }

    /**
     * Get reading history for a specific number of days
     */
    async getReadingHistory(days: number): Promise<Map<string, ReadingActivity[]>> {
        await this.ensureLoaded();

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffStr = cutoffDate.toISOString().split('T')[0];

        const historyByDate = new Map<string, ReadingActivity[]>();

        for (const activity of this.data.activities) {
            if (activity.date >= cutoffStr) {
                const existing = historyByDate.get(activity.date) || [];
                existing.push(activity);
                historyByDate.set(activity.date, existing);
            }
        }

        return historyByDate;
    }

    /**
     * Get streak data
     */
    async getStreaks(): Promise<StreakData> {
        await this.ensureLoaded();
        return { ...this.data.streaks };
    }

    /**
     * Update streak data
     */
    async updateStreaks(hasReadToday: boolean): Promise<void> {
        await this.ensureLoaded();

        const today = this.getTodayDate();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];

        if (hasReadToday) {
            if (this.data.streaks.lastReadDate === yesterdayStr) {
                // Continuing streak
                this.data.streaks.current += 1;
            } else if (this.data.streaks.lastReadDate !== today) {
                // Starting new streak (or first read of today after break)
                this.data.streaks.current = 1;
            }
            // If lastReadDate === today, don't increment (already counted today)

            this.data.streaks.lastReadDate = today;

            // Update longest streak
            if (this.data.streaks.current > this.data.streaks.longest) {
                this.data.streaks.longest = this.data.streaks.current;
            }
        } else if (this.data.streaks.lastReadDate !== today &&
            this.data.streaks.lastReadDate !== yesterdayStr) {
            // Streak broken (last read was more than 1 day ago)
            this.data.streaks.current = 0;
        }
    }

    /**
     * Update last sync timestamp
     */
    async updateLastSync(): Promise<void> {
        await this.ensureLoaded();
        this.data.lastSync = new Date().toISOString();
    }

    /**
     * Get last sync timestamp
     */
    async getLastSync(): Promise<string> {
        await this.ensureLoaded();
        return this.data.lastSync;
    }

    /**
     * Get total progress delta for today across all books
     */
    async getTodayTotalProgressDelta(): Promise<number> {
        const activities = await this.getTodayActivity();
        return activities.reduce((sum, a) => sum + (a.progressDelta || 0), 0);
    }

    /**
     * Get count of books read (finished) in a given year
     */
    async getBooksFinishedInYear(year: number): Promise<number> {
        await this.ensureLoaded();

        const yearStr = year.toString();
        const finishedBooks = new Set<string>();

        for (const activity of this.data.activities) {
            if (activity.type === 'finished' && activity.date.startsWith(yearStr)) {
                finishedBooks.add(activity.bookId);
            }
        }

        return finishedBooks.size;
    }

    /**
     * Get count of books read (finished) in a given month
     */
    async getBooksFinishedInMonth(year: number, month: number): Promise<number> {
        await this.ensureLoaded();

        const monthStr = `${year}-${month.toString().padStart(2, '0')}`;
        const finishedBooks = new Set<string>();

        for (const activity of this.data.activities) {
            if (activity.type === 'finished' && activity.date.startsWith(monthStr)) {
                finishedBooks.add(activity.bookId);
            }
        }

        return finishedBooks.size;
    }

    /**
     * Clear all activities (recent activity log)
     */
    async clearActivities(): Promise<void> {
        await this.ensureLoaded();
        this.data.activities = [];
        await this.save();
    }

    /**
     * Clear all snapshots (progress history)
     */
    async clearSnapshots(): Promise<void> {
        await this.ensureLoaded();
        this.data.snapshots = [];
        await this.save();
    }

    /**
     * Reset streaks to zero
     */
    async resetStreaks(): Promise<void> {
        await this.ensureLoaded();
        this.data.streaks = {
            current: 0,
            longest: 0,
            lastReadDate: '',
        };
        await this.save();
    }

    /**
     * Reset all tracking data (full reset)
     */
    async resetAll(): Promise<void> {
        this.data = {
            version: 1,
            snapshots: [],
            activities: [],
            streaks: {
                current: 0,
                longest: 0,
                lastReadDate: '',
            },
            lastSync: '',
            bookPageCounts: {},
        };
        await this.save();
    }

    /**
     * Set page count for a book
     */
    async setBookPageCount(bookId: string, pageCount: number): Promise<void> {
        await this.ensureLoaded();
        console.log(`[ReadingTracker] Setting page count for ${bookId} to ${pageCount}`);
        if (!this.data.bookPageCounts) {
            this.data.bookPageCounts = {};
        }
        this.data.bookPageCounts[bookId] = pageCount;
        await this.save();
    }

    /**
     * Get page count for a book (returns undefined if not set)
     */
    async getBookPageCount(bookId: string): Promise<number | undefined> {
        await this.ensureLoaded();
        return this.data.bookPageCounts?.[bookId];
    }

    /**
     * Get all book page counts
     */
    async getAllBookPageCounts(): Promise<Record<string, number>> {
        await this.ensureLoaded();
        return this.data.bookPageCounts || {};
    }
}
