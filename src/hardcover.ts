import { requestUrl } from 'obsidian';

/**
 * Hardcover API response types
 */
export interface HardcoverContributor {
    author: {
        name: string;
        id: number;
    };
}

export interface HardcoverBook {
    id: number;
    title: string;
    slug: string;
    cached_contributors?: HardcoverContributor[];
    cached_tags?: Record<string, string[]>;
    users_read_count?: number;
    image?: { url: string };
    description?: string;
    release_date?: string;
    pages?: number;
    ratings_average?: number;
    ratings_count?: number;
}

export interface HardcoverSearchResult {
    id: number;
    title: string;
    slug: string;
    author_names?: string[];
    image?: { url: string };
    release_year?: number;
    pages?: number;
}

/**
 * Hardcover GraphQL API Client
 */
export class HardcoverClient {
    private apiKey: string;
    private apiUrl = 'https://api.hardcover.app/v1/graphql';
    private lastRequestTime = 0;
    private minRequestInterval = 1000; // 1 second between requests

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    private async throttle(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minRequestInterval) {
            await this.delay(this.minRequestInterval - elapsed);
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Execute a GraphQL query
     */
    private async query<T>(graphqlQuery: string, variables?: Record<string, unknown>): Promise<T | null> {
        if (!this.apiKey) {
            console.warn('[Hardcover] No API key configured');
            return null;
        }

        await this.throttle();

        try {
            const response = await requestUrl({
                url: this.apiUrl,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'authorization': this.apiKey,
                },
                body: JSON.stringify({
                    query: graphqlQuery,
                    variables: variables || {}
                })
            });

            if (response.status === 200) {
                const data = response.json;
                if (data.errors) {
                    console.error('[Hardcover] GraphQL errors:', data.errors);
                    return null;
                }
                return data.data as T;
            } else {
                console.error(`[Hardcover] API error: ${response.status}`);
                return null;
            }
        } catch (error) {
            console.error('[Hardcover] Request failed:', error);
            return null;
        }
    }

    /**
     * Search for a book by title
     */
    async searchBook(title: string): Promise<HardcoverSearchResult[]> {
        const graphqlQuery = `
            query Search($title: String!) {
                search(query: $title, query_type: "books", per_page: 5, page: 1, sort: "activities_count:desc") {
                    results
                }
            }
        `;

        console.log('[Hardcover] Searching for:', title);
        const result = await this.query<{ search: { results: any } }>(graphqlQuery, { title });
        console.log('[Hardcover] Raw result:', JSON.stringify(result).slice(0, 500));

        if (result?.search?.results) {
            try {
                // Results come as a JSON string or object
                let parsed = result.search.results;
                if (typeof parsed === 'string') {
                    parsed = JSON.parse(parsed);
                }

                console.log('[Hardcover] Parsed results type:', typeof parsed, Array.isArray(parsed) ? 'isArray' : 'notArray');

                // Handle different result structures
                let hits: any[] = [];
                if (Array.isArray(parsed)) {
                    hits = parsed;
                } else if (parsed?.hits) {
                    hits = parsed.hits;
                } else if (parsed?.results) {
                    hits = parsed.results;
                }

                console.log('[Hardcover] Found', hits.length, 'hits');

                if (hits.length > 0) {
                    return hits.map((hit: any) => ({
                        id: hit.id || hit.document?.id,
                        title: hit.title || hit.document?.title,
                        slug: hit.slug || hit.document?.slug,
                        author_names: hit.author_names || hit.document?.author_names,
                        image: hit.image || hit.document?.image,
                        release_year: hit.release_year || hit.document?.release_year,
                        pages: hit.pages || hit.document?.pages
                    }));
                }
            } catch (e) {
                console.error('[Hardcover] Failed to parse search results:', e);
            }
        }

        return [];
    }

    /**
     * Get book details by ID
     */
    async getBookDetails(bookId: number): Promise<HardcoverBook | null> {
        const graphqlQuery = `
            query GetBook($id: Int!) {
                books(where: {id: {_eq: $id}}, limit: 1) {
                    id
                    title
                    slug
                    description
                    release_date
                    pages
                    cached_contributors
                    cached_tags
                    users_read_count
                    image {
                        url
                    }
                }
            }
        `;

        const result = await this.query<{ books: HardcoverBook[] }>(graphqlQuery, { id: bookId });

        if (result?.books && result.books.length > 0) {
            return result.books[0];
        }

        return null;
    }

    /**
     * Search and get first matching book details
     * Uses both title and author for more accurate matching
     */
    async findBook(title: string, author?: string): Promise<HardcoverBook | null> {
        // Use both title and author for better search accuracy
        const searchQuery = author && author.length > 1 ? `${title} ${author}` : title;
        console.log('[Hardcover] findBook searching with:', searchQuery);

        const results = await this.searchBook(searchQuery);

        if (results.length > 0) {
            // Find the best match using Levenshtein distance on the title
            const targetTitle = title.toLowerCase();
            let bestMatch = results[0];
            let bestScore = -1; // Higher is better (0-1 similarity)

            for (const result of results) {
                // Determine similarity
                const resultTitle = (result.title || '').toLowerCase();
                const distance = this.levenshtein(targetTitle, resultTitle);
                const maxLength = Math.max(targetTitle.length, resultTitle.length);
                const similarity = 1 - (distance / maxLength);

                console.log(`[Hardcover] Candidate: "${result.title}" Similarity: ${similarity.toFixed(2)}`);

                // Bonus for author match if available
                let authorBonus = 0;
                if (author && result.author_names?.some(n => n.toLowerCase().includes(author.toLowerCase()))) {
                    authorBonus = 0.2;
                }

                const finalScore = similarity + authorBonus;

                if (finalScore > bestScore) {
                    bestScore = finalScore;
                    bestMatch = result;
                }
            }

            // Threshold: If the best match is terrible (< 0.4), maybe don't return anything or fallback?
            // For now, return best match found among top 5
            console.log(`[Hardcover] Selected: "${bestMatch.title}" (Score: ${bestScore.toFixed(2)})`);
            return await this.getBookDetails(bestMatch.id);
        }

        return null;
    }

    /**
     * Simple Levenshtein distance for string similarity
     */
    private levenshtein(a: string, b: string): number {
        if (a.length === 0) return b.length;
        if (b.length === 0) return a.length;

        const matrix = [];

        // increment along the first column of each row
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        // increment each column in the first row
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        // Fill in the rest of the matrix
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        Math.min(
                            matrix[i][j - 1] + 1, // insertion
                            matrix[i - 1][j] + 1 // deletion
                        )
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    /**
     * Get the Hardcover URL for a book
     */
    getBookUrl(slug: string): string {
        return `https://hardcover.app/books/${slug}`;
    }

    /**
     * Extract author name from cached_contributors
     */
    getAuthor(book: HardcoverBook): string {
        if (book.cached_contributors && book.cached_contributors.length > 0) {
            return book.cached_contributors[0].author.name;
        }
        return 'Unknown Author';
    }

    /**
     * Extract genres from cached_tags
     * cached_tags can be an object with Genre as array of strings or objects
     */
    getGenres(book: HardcoverBook): string[] {
        try {
            if (!book.cached_tags) return [];

            const genreTags = book.cached_tags['Genre'];
            if (!genreTags) return [];

            // Handle if genres are strings or objects
            const genres = genreTags.slice(0, 5).map((g: any) => {
                if (typeof g === 'string') return g;
                if (typeof g === 'object' && g !== null) {
                    return g.name || g.tag || g.label || String(g);
                }
                return String(g);
            });

            return genres.filter((g: string) => g && !g.includes('[object'));
        } catch (e) {
            console.error('[Hardcover] Error parsing genres:', e);
            return [];
        }
    }
}
