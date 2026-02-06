import { App, Notice } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { PocketbookCloudBook } from '../apiclient';

export interface WishlistBook {
    id: string; // e.g. "goodreads-12345"
    title: string;
    authors: string;
    coverUrl?: string;
    description?: string;
    isbn?: string;
    pageCount?: number;
    addedAt: string; // ISO Date
    goodreadsId?: string;
    genres?: string[];
    rating?: number;
    hardcoverSlug?: string;
}

/**
 * Manages the "Wishlist" or "To Be Read" pile.
 * Stores books as individual JSON files in the cache folder.
 */
export class WishlistManager {
    private folderPath: string;

    constructor(
        private app: App,
        private plugin: PocketbookCloudHighlightsImporterPlugin
    ) {
        this.folderPath = `${this.plugin.settings.cacheFolder || 'PocketbookCache'}/wishlist`;
    }

    /**
     * Ensure storage directory exists
     */
    async initialize() {
        // Ensure cache folder exists first
        const cacheDir = this.plugin.settings.cacheFolder || 'PocketbookCache';
        if (!(await this.app.vault.adapter.exists(cacheDir))) {
            await this.app.vault.createFolder(cacheDir);
        }

        // Ensure wishlist subfolder exists
        this.folderPath = `${cacheDir}/wishlist`;
        if (!(await this.app.vault.adapter.exists(this.folderPath))) {
            await this.app.vault.createFolder(this.folderPath);
        }
    }

    /**
     * Convert WishlistBook to PocketbookCloudBook (mock) for UI compatibility
     */
    toPocketbookBook(wb: WishlistBook): PocketbookCloudBook {
        return {
            id: wb.id,
            fast_hash: wb.id, // Use ID as hash for keying
            title: wb.title,
            path: '',
            link: '',
            created_at: new Date(wb.addedAt),
            read_status: 'wishlist', // Custom status
            collections: 'Wishlist',
            metadata: {
                title: wb.title,
                authors: wb.authors,
                year: '',
                isbn: wb.isbn || '',
                cover: wb.coverUrl ? [{ width: 0, height: 0, path: wb.coverUrl }] : []
            },
            mtime: new Date(wb.addedAt).toISOString()
        };
    }

    /**
     * Get all items in the wishlist
     */
    async getWishlistBooks(): Promise<WishlistBook[]> {
        await this.initialize();

        try {
            const result = await this.app.vault.adapter.list(this.folderPath);
            const books: WishlistBook[] = [];

            for (const filePath of result.files) {
                if (filePath.endsWith('.json')) {
                    try {
                        const content = await this.app.vault.adapter.read(filePath);
                        const book = JSON.parse(content) as WishlistBook;
                        books.push(book);
                    } catch (e) {
                        console.error(`[Wishlist] Failed to read ${filePath}`, e);
                    }
                }
            }
            // Sort by Added Date (Newest first)
            return books.sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
        } catch (e) {
            console.error('[Wishlist] Error listing books:', e);
            return [];
        }
    }

    /**
     * Add a book to the wishlist
     */
    async addToWishlist(book: WishlistBook): Promise<void> {
        await this.initialize();
        const sanitizedId = book.id.replace(/[^a-zA-Z0-9-]/g, '_');
        const path = `${this.folderPath}/${sanitizedId}.json`;

        await this.app.vault.adapter.write(path, JSON.stringify(book, null, 2));
        new Notice(`Added "${book.title}" to Wishlist!`);
    }

    /**
     * Remove a book from the wishlist
     */
    async removeFromWishlist(id: string, silent = false): Promise<void> {
        await this.initialize();
        const sanitizedId = id.replace(/[^a-zA-Z0-9-]/g, '_');
        const path = `${this.folderPath}/${sanitizedId}.json`;

        if (await this.app.vault.adapter.exists(path)) {
            await this.app.vault.adapter.remove(path);
            if (!silent) {
                new Notice('Removed from Wishlist');
            }
        } else {
            if (!silent) {
                new Notice('Could not find book to remove');
            }
        }
    }

    /**
     * Check if a book is already in the wishlist (by ID or Title)
     */
    async isInWishlist(goodreadsId: string, title?: string): Promise<boolean> {
        // This is inefficient (reads all files), but wishlist is expected to be small (<1000 items)
        // If it grows, we should maintain an index file.
        const books = await this.getWishlistBooks();

        return books.some(b =>
            (b.goodreadsId && b.goodreadsId === goodreadsId) ||
            (title && b.title.toLowerCase() === title.toLowerCase())
        );
    }
}
