import { requestUrl } from 'obsidian';
import { SimilarBook } from './goodreads';

/**
 * Client for interacting with API League
 */
export class ApiLeagueClient {
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    /**
     * Fetch similar books by Title (+ Author)
     */
    async fetchSimilarBooks(title: string, author: string): Promise<SimilarBook[]> {
        if (!this.apiKey) {
            console.log('[ApiLeague] No API Key configured');
            return [];
        }

        try {
            // 1. Search for book ID
            const query = `${title} ${author}`;
            const bookId = await this.searchBookId(query);

            if (!bookId) {
                console.log('[ApiLeague] Could not find book ID for:', query);
                return [];
            }

            // 2. Fetch similar books
            return await this.getSimilarBooksById(bookId);

        } catch (e) {
            console.error('[ApiLeague] Error fetching similar books:', e);
            return [];
        }
    }

    /**
     * Search for a book to get its internal ID
     */
    private async searchBookId(query: string): Promise<number | null> {
        // Try /search-books endpoint first
        let id = await this.searchEndpoint(`https://api.apileague.com/search-books?query=${encodeURIComponent(query)}&number=1`);

        if (!id) {
            // Try /books/search endpoint fallback
            id = await this.searchEndpoint(`https://api.apileague.com/books/search?query=${encodeURIComponent(query)}&number=1`);
        }

        return id;
    }

    private async searchEndpoint(url: string): Promise<number | null> {
        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 200) {
                const data = response.json;
                // Handle nested array anomaly: { books: [[{ id: ... }]] } or { books: [{ id: ... }] }
                if (data && data.books && data.books.length > 0) {
                    const firstGroup = data.books[0];
                    if (Array.isArray(firstGroup) && firstGroup.length > 0) {
                        return firstGroup[0].id;
                    } else if (firstGroup.id) {
                        return firstGroup.id;
                    }
                }
            }
        } catch (e) {
            // Ignore (will try next endpoint or fail gracefully)
        }
        return null;
    }

    /**
     * Get similar books list by ID
     */
    private async getSimilarBooksById(bookId: number): Promise<SimilarBook[]> {
        const url = `https://api.apileague.com/list-similar-books?id=${bookId}&number=15`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'GET',
                headers: {
                    'x-api-key': this.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (response.status === 200) {
                const data = response.json;
                // Expected format: { similar_books: [{ id, title, image, ... }] }
                if (data && data.similar_books && Array.isArray(data.similar_books)) {
                    return data.similar_books.map((book: any) => ({
                        title: book.title,
                        author: '', // API doesn't seem to return author in similar list?
                        coverUrl: book.image || '',
                        goodreadsUrl: '', // No external link provided
                        rating: undefined
                    }));
                }
            }
        } catch (e) {
            console.error('[ApiLeague] Error calling list-similar-books:', e);
        }

        return [];
    }
}
