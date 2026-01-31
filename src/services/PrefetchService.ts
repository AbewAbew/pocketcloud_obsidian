import { App, Notice } from 'obsidian';
import { GoodreadsClient } from '../goodreads';
import PocketbookCloudHighlightsImporterPlugin from '../main';

interface QueueItem {
    title: string;
    author: string;
    priority: number; // Higher is better (e.g. 10 = user clicked, 1 = background)
}

export class PrefetchService {
    private app: App;
    private plugin: PocketbookCloudHighlightsImporterPlugin;
    private goodreads: GoodreadsClient;
    private queue: QueueItem[] = [];
    private isProcessing = false;
    private processedCache = new Set<string>();

    // Config
    private delayMs = 4000; // 4 seconds between requests to be safe
    private maxQueueSize = 200;

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin) {
        this.app = app;
        this.plugin = plugin;
        this.goodreads = plugin.goodreads; // Use shared instance
    }

    /**
     * Add a book to the prefetch queue
     */
    addToQueue(title: string, author: string, priority = 1) {
        const key = `${title}-${author}`;
        if (this.processedCache.has(key)) return;

        // Avoid duplicates in queue
        const existing = this.queue.find(i => `${i.title}-${i.author}` === key);
        if (existing) {
            // Upgrade priority if requested
            if (priority > existing.priority) {
                existing.priority = priority;
                this.sortQueue();
            }
            return;
        }

        // Add to queue
        this.queue.push({ title, author, priority });
        this.sortQueue();

        // Start processing if not running
        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    private sortQueue() {
        this.queue.sort((a, b) => b.priority - a.priority);
        if (this.queue.length > this.maxQueueSize) {
            this.queue = this.queue.slice(0, this.maxQueueSize);
        }
    }

    /**
     * Process the queue one by one
     */
    private async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        console.log(`[Prefetch] Starting queue processing. ${this.queue.length} items pending.`);

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) break;

            const key = `${item.title}-${item.author}`;
            if (this.processedCache.has(key)) continue;

            try {
                // We use findBook with cache busting FALSE, so if it's already there we're good.
                // But specifically we want to fetch it if MISSING.
                // GoodreadsClient.findBook() caches in memory? 
                // We need to verify where GoodreadsClient stores data. 
                // Looking at goodreads.ts, it doesn't seem to have a persistent cache unless requestUrl caches (it doesn't by default across restart).
                // However, we are "warming up" for the current session.

                await this.goodreads.findBook(item.title, item.author, false);
                console.log(`[Prefetch] Warmed up: ${item.title}`);
                this.processedCache.add(key);
            } catch (e) {
                console.warn(`[Prefetch] Failed to prefetch ${item.title}:`, e);
            }

            // Waiting delay
            await new Promise(r => setTimeout(r, this.delayMs));
        }

        this.isProcessing = false;
        console.log('[Prefetch] Queue finished.');
    }
}
