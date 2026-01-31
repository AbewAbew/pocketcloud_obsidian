import { requestUrl, App, Plugin } from 'obsidian';
import { ApiLeagueClient } from './apileague';

/**
 * Goodreads data types
 */
export interface GoodreadsReview {
    reviewerName: string;
    rating: number;
    body: string;
    date: string;
    spoiler: boolean;
}


export interface SimilarBook {
    title: string;
    author: string;
    coverUrl: string;
    goodreadsUrl: string;
    rating?: number;
}

export interface GoodreadsBookData {
    goodreadsId: string;
    title: string;
    author: string;
    averageRating: number;
    ratingsCount: number;
    description: string;
    pageCount: number | null;
    genres: string[];
    reviews: GoodreadsReview[];
    goodreadsUrl: string;
    similarBooks: SimilarBook[];
}

// Simplified Cache Data for Index (only Search)
interface SearchIndexData {
    search: { [query: string]: string };
}

/**
 * Goodreads Scraper with Persistent Caching
 */
export class GoodreadsClient {
    private baseSearchUrl = 'https://www.goodreads.com/search?q=';
    private baseBookUrl = 'https://www.goodreads.com/book/show/';
    private lastRequestTime = 0;
    private minRequestInterval = 2000; // 2 seconds between requests

    // Instance Cache
    private searchCache = new Map<string, string>(); // Query -> ID
    private bookCache = new Map<string, GoodreadsBookData>(); // ID -> Data (Memory only)
    private cacheDir: string = 'PocketbookCache';

    constructor(private app?: App, private plugin?: Plugin) {
        if (plugin) {
            this.cacheDir = (plugin as any).settings?.cacheFolder || 'PocketbookCache';
        }
    }

    /**
     * Load Search Cache Index from disk
     */
    async loadSearchIndex() {
        if (!this.app) return;
        try {
            const indexPath = `${this.cacheDir}/search-index.json`;
            if (await this.app.vault.adapter.exists(indexPath)) {
                const raw = await this.app.vault.adapter.read(indexPath);
                const data: SearchIndexData = JSON.parse(raw);
                if (data.search) {
                    for (const [key, value] of Object.entries(data.search)) {
                        this.searchCache.set(key, value);
                    }
                }
                console.log(`[Goodreads] Search index loaded: ${this.searchCache.size} entries.`);
            }
        } catch (e) {
            console.warn('[Goodreads] Failed to load search index:', e);
        }
    }

    /**
     * Save Search Cache Index to disk
     */
    async saveSearchIndex() {
        if (!this.app) return;
        try {
            await this.ensureCacheDir();
            const searchObj: { [query: string]: string } = {};
            for (const [key, value] of this.searchCache) {
                searchObj[key] = value;
            }
            const data: SearchIndexData = { search: searchObj };
            const indexPath = `${this.cacheDir}/search-index.json`;
            await this.app.vault.adapter.write(indexPath, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error('[Goodreads] Failed to save search index:', e);
        }
    }

    private async ensureCacheDir() {
        if (!this.app) return;
        if (!(await this.app.vault.adapter.exists(this.cacheDir))) {
            await this.app.vault.createFolder(this.cacheDir);
        }
    }

    private getBookPath(goodreadsId: string): string {
        return `${this.cacheDir}/${goodreadsId}.json`;
    }

    /**
     * Save individual book to disk
     */
    private async saveBookToDisk(data: GoodreadsBookData) {
        if (!this.app) return;
        try {
            await this.ensureCacheDir();
            const path = this.getBookPath(data.goodreadsId);
            await this.app.vault.adapter.write(path, JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(`[Goodreads] Failed to save book ${data.goodreadsId}:`, e);
        }
    }

    /**
     * Load individual book from disk
     */
    private async loadBookFromDisk(goodreadsId: string): Promise<GoodreadsBookData | null> {
        if (!this.app) return null;
        try {
            const path = this.getBookPath(goodreadsId);
            if (await this.app.vault.adapter.exists(path)) {
                const raw = await this.app.vault.adapter.read(path);
                return JSON.parse(raw);
            }
        } catch (e) { /* Ignore read errors */ }
        return null;
    }



    /**
     * Prune cache: Remove entries for books that are no longer in the active library.
     * @param activeBooks List of currently active Pocketbook books
     */
    prune(activeBooks: any[]) {
        if (!activeBooks || activeBooks.length === 0) return;

        console.log(`[Goodreads] Pruning cache. Current cache size: ${this.bookCache.size} books, ${this.searchCache.size} searches.`);

        const validBookIds = new Set<string>();
        const validSearchKeys = new Set<string>();

        // 1. Identify all valid Goodreads IDs from Active Books based on current Search Cache
        // We have to iterate the search cache to see which queries "match" our active books
        // This is fuzzy because search keys are "Title Author".

        // Create a set of "Expected" search keys from active books
        for (const book of activeBooks) {
            const title = book.title || '';
            const rawAuthor = book.metadata?.authors;
            const author = Array.isArray(rawAuthor) ? rawAuthor[0] : (rawAuthor || '');

            const cleanTitle = this.sanitizeQuery(title);
            const cleanAuthor = author ? this.sanitizeQuery(author) : '';

            const query1 = cleanAuthor ? `${cleanTitle} ${cleanAuthor}` : cleanTitle;
            // Also keep "Title" only queries just in case
            const query2 = cleanTitle;

            validSearchKeys.add(query1);
            validSearchKeys.add(query2);

            // If we have a cached ID for this query, mark that ID as valid
            if (this.searchCache.has(query1)) validBookIds.add(this.searchCache.get(query1)!);
            if (this.searchCache.has(query2)) validBookIds.add(this.searchCache.get(query2)!);
        }

        // 2. Prune Book Cache
        // Retain books that are in our valid ID list
        for (const [id, _] of this.bookCache) {
            if (!validBookIds.has(id)) {
                // Keep it if it's referenced by ANY valid search key (double check)
                // Actually validBookIds already covers this.
                // One edge case: Explicit book fetches via ID? We rarely do that without search.
                this.bookCache.delete(id);
            }
        }

        // 3. Prune Search Cache
        // Retain searches that "match" our active books
        // This is aggressive. It might delete "Similar Book" lookups.
        // Similar books are often looked up by Title/Author too if we use Google Fallback.
        // For safety, let's ONLY prune the bookCache for now, as that's the heavy one.
        // Re-populating search strings is cheap. Storing 1000s of book JSONs is heavy.

        console.log(`[Goodreads] Pruned cache. New size: ${this.bookCache.size} books.`);
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
     * Fetch a page and return raw HTML
     */
    private async fetchPage(url: string, bustCache = false): Promise<string | null> {
        await this.throttle();

        try {
            // Append timestamp to prevent caching if requested
            const finalUrl = bustCache
                ? (url.includes('?') ? `${url}& t=${Date.now()} ` : `${url}?t = ${Date.now()} `)
                : url;

            const response = await requestUrl({
                url: finalUrl,
                method: 'GET',
                headers: {
                    'accept': 'text/html,application/xhtml+xml',
                    'accept-language': 'en-US,en;q=0.9',
                    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'cache-control': 'no-cache', // Hint to server/proxy
                }
            });

            if (response.status === 200) {
                return response.text;
            } else {
                console.error(`[Goodreads] HTTP error: ${response.status} `);
                return null;
            }
        } catch (error) {
            console.error('[Goodreads] Fetch error:', error);
            return null;
        }
    }

    /**
     * Extract __NEXT_DATA__ JSON from HTML
     */
    private extractNextData(html: string): any | null {
        try {
            const scriptMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
            if (scriptMatch && scriptMatch[1]) {
                return JSON.parse(scriptMatch[1]);
            }
        } catch (e) {
            console.error('[Goodreads] Failed to parse __NEXT_DATA__:', e);
        }
        return null;
    }

    /**
     * Search for a book and get its Goodreads ID
     */
    /**
     * Search for a book and get its Goodreads ID
     */
    async searchBook(title: string, author?: string, bustCache = false): Promise<string | null> {
        // Sanitize inputs to improve search reliability
        const cleanTitleLower = this.sanitizeQuery(title).toLowerCase();
        const cleanAuthorLower = author ? this.sanitizeQuery(author).toLowerCase() : '';

        // Query construction: Keep original case for URL, but use clean versions for matching
        const cleanTitle = this.sanitizeQuery(title);
        const cleanAuthor = author ? this.sanitizeQuery(author) : '';
        const query = cleanAuthor ? `${cleanTitle} ${cleanAuthor}` : cleanTitle;
        const encodedQuery = encodeURIComponent(query);
        const searchUrl = this.baseSearchUrl + encodedQuery;

        // Check Cache
        if (!bustCache && this.searchCache.has(query)) {
            const cachedId = this.searchCache.get(query);
            console.log(`[Goodreads] Cache hit for search: ${query} -> ${cachedId}`);
            return cachedId || null;
        }

        console.log('[Goodreads] Searching:', searchUrl);
        const html = await this.fetchPage(searchUrl, bustCache);
        if (!html) return null;

        // 1. Parse Search Results safely
        const candidates = this.parseSearchResults(html);
        let bestId: string | null = null;

        if (candidates.length > 0) {
            console.log(`[Goodreads] Parsed ${candidates.length} candidates.`);

            // Filter and Sort Candidates
            const scored = candidates.map(c => {
                let score = 0;
                const cTitleLower = c.title.toLowerCase();
                const cAuthorLower = c.author.toLowerCase();

                // Title Match (Fuzzy inclusion)
                if (cTitleLower.includes(cleanTitleLower)) score += 10;

                // Author Match (Heavy weight)
                // Check if candidate author contains our search author or vice versa
                if (cleanAuthorLower && (cAuthorLower.includes(cleanAuthorLower) || cleanAuthorLower.includes(cAuthorLower))) {
                    score += 20;
                }

                // Penalties for "junk"
                // Penalties for "junk"
                if (cTitleLower.includes('summary') || cTitleLower.includes('study guide') || cTitleLower.includes('analysis')) {
                    score -= 50;
                }

                // Boost for popularity (Rating Count)
                // This helps avoid obscure editions with 1 rating vs the main one with 10k ratings
                if (c.ratingsCount > 1000) score += 30;
                else if (c.ratingsCount > 100) score += 20;
                else if (c.ratingsCount > 10) score += 10;

                return { candidate: c, score };
            });

            // Sort descending
            scored.sort((a, b) => b.score - a.score);

            const best = scored[0];
            console.log(`[Goodreads] Selected best match: "${best.candidate.title}" by ${best.candidate.author} (Ratings: ${best.candidate.ratingsCount}, Score: ${best.score})`);
            bestId = best.candidate.id;
        }

        // 2. Fallback to naive Regex if parsing failed or no ID found
        if (!bestId) {
            console.log('[Goodreads] Falling back to global regex match...');
            // Look for /book/show/{id} pattern
            const bookIdMatch = html.match(/\/book\/show\/(\d+)/);
            if (bookIdMatch && bookIdMatch[1]) {
                console.log('[Goodreads] Found book ID (Fallback):', bookIdMatch[1]);
                bestId = bookIdMatch[1];
            }
        }

        if (bestId) {
            this.searchCache.set(query, bestId);
            await this.saveSearchIndex();
            return bestId;
        }

        return null;
    }

    /**
     * Parse Goodreads search results table to extract candidates
     */
    private parseSearchResults(html: string): { id: string, title: string, author: string, ratingsCount: number }[] {
        const results: { id: string, title: string, author: string, ratingsCount: number }[] = [];
        // Regex to find rows in the search results table
        const rowRegex = /<tr[^>]*itemtype="http:\/\/schema\.org\/Book"[\s\S]*?<\/tr>/g;
        let match;

        while ((match = rowRegex.exec(html)) !== null) {
            const rowHtml = match[0];

            // Extract URL/ID (href="/book/show/12345.Title")
            const urlMatch = /href="([^"]*\/book\/show\/(\d+)[^"]*)"/.exec(rowHtml);
            if (!urlMatch) continue;
            const id = urlMatch[2];

            // Extract Title (itemprop="name">Title</span>)
            const titleMatch = /class="bookTitle"[\s\S]*?itemprop="name">([^<]+)<\/span>/.exec(rowHtml);
            const title = titleMatch ? this.decodeHtml(titleMatch[1]) : '';

            // Extract Author (class="authorName" ... itemprop="name">Author</span>)
            const authorMatch = /class="authorName"[\s\S]*?itemprop="name">([^<]+)<\/span>/.exec(rowHtml);
            const author = authorMatch ? this.decodeHtml(authorMatch[1]) : '';

            // Extract Ratings Count (minirating matches)
            let ratingsCount = 0;
            const ratingMatch = /class="minirating"[^>]*>[\s\S]*?(\d[\d,\.]*)\s+ratings/.exec(rowHtml);
            if (ratingMatch) {
                const cleanNum = ratingMatch[1].replace(/,/g, '').replace(/\./g, '');
                ratingsCount = parseInt(cleanNum) || 0;
            }

            results.push({ id, title, author, ratingsCount });
        }

        return results;
    }

    /**
     * Sanitize search query by replacing punctuation with spaces
     */
    private sanitizeQuery(text: string): string {
        return text
            .replace(/[.:,;]/g, ' ') // Replace common punctuation with space
            .replace(/\s+/g, ' ')    // Collapse multiple spaces
            .trim();
    }

    /**
     * Get book data by Goodreads ID
     */
    async getBookById(goodreadsId: string, bustCache = false): Promise<GoodreadsBookData | null> {
        // Check Cache
        if (!bustCache) {
            // 1. Memory Cache
            if (this.bookCache.has(goodreadsId)) {
                console.log(`[Goodreads] Cache hit (Memory) for book: ${goodreadsId}`);
                return this.bookCache.get(goodreadsId) || null;
            }
            // 2. Disk Cache
            const cachedFromDisk = await this.loadBookFromDisk(goodreadsId);
            if (cachedFromDisk) {
                console.log(`[Goodreads] Cache hit (Disk) for book: ${goodreadsId}`);
                this.bookCache.set(goodreadsId, cachedFromDisk);
                return cachedFromDisk;
            }
        }

        const bookUrl = this.baseBookUrl + goodreadsId;
        console.log('[Goodreads] Fetching book:', bookUrl);

        const html = await this.fetchPage(bookUrl, bustCache);
        if (!html) return null;

        const nextData = this.extractNextData(html);
        if (!nextData) {
            console.error('[Goodreads] No __NEXT_DATA__ found');
            return null;
        }

        try {
            const apolloState = nextData?.props?.pageProps?.apolloState;
            if (!apolloState) {
                console.error('[Goodreads] No apolloState found');
                return null;
            }

            const bookData = this.parseApolloState(apolloState, goodreadsId, html);

            // 1. Try Proxy if Apollo returned few/no similar books (Common with lazy loading)
            if (bookData && bookData.similarBooks.length < 5) {
                console.log('[Goodreads] Few similar books found in Apollo. Attempting PROXY fetch...');
                const proxyBooks = await this.fetchViaProxy(goodreadsId);
                if (proxyBooks.length > 0) {
                    // Merge proxy results
                    const existingTitles = new Set(bookData.similarBooks.map(b => b.title.toLowerCase()));
                    for (const pb of proxyBooks) {
                        if (!existingTitles.has(pb.title.toLowerCase())) {
                            bookData.similarBooks.push(pb);
                            existingTitles.add(pb.title.toLowerCase());
                        }
                    }
                    console.log(`[Goodreads] Merged ${proxyBooks.length} books from Proxy. Total: ${bookData.similarBooks.length}`);
                }
            }

            // 2. Google Books Fallback if STILL no similar books found
            if (bookData && bookData.similarBooks.length === 0) {
                console.log('[Goodreads] No similar books found via scraping/proxy. Attempting Google Books fallback...');
                const googleBooks = await this.fetchGoogleRecommended(bookData.title, bookData.author, bookData.genres);
                if (googleBooks.length > 0) {
                    bookData.similarBooks = googleBooks;
                }
            }

            // Cache the result
            if (bookData) {
                this.bookCache.set(goodreadsId, bookData);
                await this.saveBookToDisk(bookData);
            }

            return bookData;
        } catch (e) {
            console.error('[Goodreads] Error parsing book data:', e);
            return null;
        }
    }

    /**
     * Fetch similar books via our Vercel Proxy (Puppeteer)
     */
    async fetchViaProxy(bookId: string): Promise<SimilarBook[]> {
        const proxyUrl = `https://goodreads-proxy.vercel.app/api/similar?id=${bookId}`;
        try {
            console.log(`[Goodreads] Calling Proxy: ${proxyUrl}`);
            const response = await requestUrl({
                url: proxyUrl,
                method: 'GET',
                headers: { 'accept': 'application/json' }
            });

            if (response.status === 200) {
                const json = JSON.parse(response.text);
                if (json.success && Array.isArray(json.data)) {
                    // Map proxy data to SimilarBook interface
                    return json.data.map((b: any) => ({
                        title: b.title,
                        author: b.author,
                        coverUrl: b.coverUrl,
                        goodreadsUrl: b.goodreadsUrl
                    }));
                }
            }
        } catch (e) {
            console.warn('[Goodreads] Proxy fetch failed:', e);
        }
        return [];
    }

    /**
     * Fetch recommendations from Google Books API (Fallback)
     */
    async fetchGoogleRecommended(title: string, author: string, genres: string[]): Promise<SimilarBook[]> {
        const books: SimilarBook[] = [];
        try {
            // Strategy: 
            // 1. Search for other books by same author usually yields good "similar" results

            let query = '';
            if (author) {
                query += `inauthor:"${author}"`;
            }

            if (!query) return [];

            const encodedQuery = encodeURIComponent(query);
            const url = `https://www.googleapis.com/books/v1/volumes?q=${encodedQuery}&maxResults=20&printType=books&orderBy=relevance`;

            console.log('[GoogleBooks] Fetching fallback:', url);

            // We can use requestUrl without auth for public data
            const response = await requestUrl({
                url: url,
                method: 'GET'
            });

            if (response.status === 200) {
                const data = JSON.parse(response.text);
                if (data.items) {
                    const currentTitleLower = title.toLowerCase();

                    for (const item of data.items) {
                        const info = item.volumeInfo;
                        if (!info || !info.title) continue;

                        // Skip if it's the same book
                        if (info.title.toLowerCase().includes(currentTitleLower)) continue;

                        const infoAuthors = info.authors ? info.authors.join(', ') : 'Unknown';
                        const cover = info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || '';

                        books.push({
                            title: info.title,
                            author: infoAuthors,
                            coverUrl: cover.replace('http:', 'https:'), // Ensure limit mixed content issues
                            goodreadsUrl: info.infoLink || item.selfLink,
                            rating: info.averageRating
                        });
                    }
                }
            }
        } catch (e) {
            console.error('[GoogleBooks] Fallback error:', e);
        }

        console.log(`[GoogleBooks] Found ${books.length} fallback books`);
        return books.slice(0, 15);
    }


    /**
     * Parse Apollo state to extract book data
     */
    private parseApolloState(apolloState: any, goodreadsId: string, html: string): GoodreadsBookData | null {
        const keys = Object.keys(apolloState);

        // Find book data
        const bookKey = keys.find(k => k.startsWith('Book:kca:'));
        const workKey = keys.find(k => k.startsWith('Work:kca:'));
        const contributorKey = keys.find(k => k.startsWith('Contributor:kca'));

        if (!bookKey) {
            console.error('[Goodreads] No book key found');
            return null;
        }

        const bookData = apolloState[bookKey];
        const workData = workKey ? apolloState[workKey] : null;
        const contributorData = contributorKey ? apolloState[contributorKey] : null;

        // Extract rating from work stats
        let averageRating = 0;
        let ratingsCount = 0;
        if (workData?.stats) {
            averageRating = parseFloat(workData.stats.averageRating) || 0;
            ratingsCount = parseInt(workData.stats.ratingsCount) || 0;
        }

        // Extract genres
        const genres: string[] = [];
        if (bookData?.bookGenres) {
            for (const genreItem of bookData.bookGenres) {
                if (genreItem?.genre?.name) {
                    genres.push(genreItem.genre.name);
                }
            }
        }

        // Extract reviews
        const reviews: GoodreadsReview[] = [];
        const reviewKeys = keys.filter(k => k.startsWith('Review:kca'));

        let reviewCount = 0;
        const limit = 50; // Hard limit for safety, but typically the page has ~30

        for (const reviewKey of reviewKeys) {
            if (reviewCount >= limit) break;

            try {
                const reviewData = apolloState[reviewKey];
                if (!reviewData?.text) continue;

                // Get reviewer name
                let reviewerName = 'Anonymous';
                if (reviewData.creator?.__ref) {
                    const userRef = reviewData.creator.__ref;
                    const userData = apolloState[userRef];
                    if (userData?.name) {
                        reviewerName = userData.name;
                    }
                }

                // Clean HTML from review text
                const bodyText = this.stripHtml(reviewData.text || '');
                if (!bodyText.trim()) continue;

                reviews.push({
                    reviewerName,
                    rating: parseFloat(reviewData.rating) || 0,
                    body: bodyText,
                    date: this.formatDate(reviewData.updatedAt),
                    spoiler: reviewData.spoilerStatus || false
                });
                reviewCount++;
            } catch (e) {
                console.warn('[Goodreads] Error parsing review:', e);
            }
        }

        // Extract similar books
        const similarBooks: SimilarBook[] = [];
        const seenTitles = new Set<string>();
        // Add current title to seen to avoid self-reference
        if (bookData?.title) seenTitles.add(bookData.title);

        // Debug logging
        const bookKeys = keys.filter(k => k.startsWith('Book:'));
        console.log(`[Goodreads] Found ${bookKeys.length} 'Book:' keys in Apollo State`);

        for (const key of keys) {
            // Find other books
            if (key.startsWith('Book:') && key !== bookKey) {
                const obj = apolloState[key];

                // Debug log (limit spam)
                if (similarBooks.length === 0 && Math.random() < 0.1) {
                    // Log occasionally to debug structure
                    console.log('[Goodreads] Checking candidate:', key, obj.title);
                }

                if (obj.title && (obj.imageUrl || obj.coverImage?.url) && !seenTitles.has(obj.title)) {
                    // Try to find author
                    let authorName = 'Unknown';
                    if (obj.primaryContributor?.__ref) {
                        const auth = apolloState[obj.primaryContributor.__ref];
                        if (auth?.name) authorName = auth.name;
                    }

                    const cover = obj.imageUrl || obj.coverImage?.url || '';

                    similarBooks.push({
                        title: obj.title,
                        author: authorName,
                        coverUrl: cover,
                        goodreadsUrl: obj.webUrl || (obj.legacyId ? `https://www.goodreads.com/book/show/${obj.legacyId}` : ''),
                        rating: obj.averageRating ? parseFloat(obj.averageRating) : undefined
                    });
                    seenTitles.add(obj.title);
                }
            }
        }

        console.log(`[Goodreads] Extracted ${similarBooks.length} similar books`);

        // Merge and deduplicate
        const uniqueBooks = new Map<string, SimilarBook>();

        // 1. Apollo results
        similarBooks.forEach(b => uniqueBooks.set(b.title.toLowerCase(), b));

        // 2. HTML RegEx Fallback (if Apollo yielded few results)
        if (uniqueBooks.size < 5) {
            const htmlBooks = this.extractFromHtml(html, bookData?.title || '');
            htmlBooks.forEach(b => {
                if (!uniqueBooks.has(b.title.toLowerCase())) {
                    uniqueBooks.set(b.title.toLowerCase(), b);
                }
            });
        }

        // Convert back to array and filter strict duplicates (fuzzy match main title)
        const finalSimilarBooks: SimilarBook[] = [];
        const mainTitleNorm = (bookData?.title || '').toLowerCase().replace(/[^\w]/g, '');

        for (const book of uniqueBooks.values()) {
            const similarTitleNorm = book.title.toLowerCase().replace(/[^\w]/g, '');

            // Skip if titles are too similar (e.g. editions)
            if (mainTitleNorm.includes(similarTitleNorm) || similarTitleNorm.includes(mainTitleNorm)) {
                continue;
            }
            finalSimilarBooks.push(book);
        }

        // Populate similarBooks in bookData
        const resultSimilarBooks = finalSimilarBooks.slice(0, 15);
        console.log(`[Goodreads] Final similar books count: ${resultSimilarBooks.length}`);

        // Extract page count
        let pageCount: number | null = null;
        if (bookData?.details?.numPages) {
            pageCount = parseInt(bookData.details.numPages) || null;
        }

        return {
            goodreadsId,
            title: bookData?.title || '',
            author: contributorData?.name || '',
            averageRating,
            ratingsCount,
            description: this.stripHtml(bookData?.description || ''),
            pageCount,
            genres: genres.slice(0, 5),
            reviews,
            goodreadsUrl: this.baseBookUrl + goodreadsId,
            similarBooks: resultSimilarBooks
        };
    }

    /**
     * Fallback: Scrape "Readers also enjoyed" from raw HTML using Regex
     */
    /**
     * Fallback: Scrape "Readers also enjoyed" from raw HTML using Regex
     * Updated to handle data-testid and robust structure found in user's HTML
     */
    private extractFromHtml(html: string, mainTitle: string): SimilarBook[] {
        const books: SimilarBook[] = [];
        try {
            console.log(`[Goodreads] Scraper: Scanning HTML (${html.length} chars)...`);
            // Dump partial HTML to verify structure matches expectations
            console.log(`[Goodreads] HTML Snippet: ${html.substring(0, 300).replace(/\n/g, '\\n')}...`);

            // Robust scraping: Split by Book Cards (CarouselGroup__item or BookCard)
            // Fix: Match exact class name or Carousel item to avoid splitting on "BookCard__title"
            const chunks = html.split(/class=["']CarouselGroup__item|class=["']BookCard["']/);

            console.log(`[Goodreads] Split into ${chunks.length} chunks`);
            if (chunks.length <= 1) {
                console.log('[Goodreads] WARNING: No split occurred. Regex separator not found in HTML.');
            }

            const decodedMainTitle = mainTitle.toLowerCase().trim();

            // Skip first chunk which is usually before the first item
            for (let i = 1; i < chunks.length; i++) {
                const chunk = chunks[i];
                if (chunk.length < 50) {
                    // Check if it's noise
                    if (i < 3) console.log(`[Goodreads] Chunk ${i}: Skipped (short: ${chunk.length} chars)`);
                    continue;
                }

                // Extract URL (href)
                const hrefMatch = /href="([^"]*\/book\/show\/[^"]+)"/.exec(chunk);
                if (!hrefMatch) {
                    console.log(`[Goodreads] Chunk ${i}: No href found`);
                    continue;
                }

                // Extract Title 
                // Supports: <div data-testid="title" class="BookCard__title">Title</div>
                // OR: class="BookCard__title">Title</div>
                // Relaxed to [\s\S]*? to match content traversing newlines if necessary
                const titleMatch = /(?:data-testid="title"|class="BookCard__title")[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
                if (!titleMatch) {
                    console.log(`[Goodreads] Chunk ${i}: No title found`);
                    continue;
                }

                // Extract Author
                // Supports: <div data-testid="author" class="BookCard__authorName" ...>Author</div>
                const authorMatch = /(?:data-testid="author"|class="BookCard__authorName")[^>]*>([\s\S]*?)<\/div>/.exec(chunk);
                const author = authorMatch ? this.decodeHtml(authorMatch[1]).trim() : 'Unknown';

                // Extract Cover (src)
                // Finds the first src="http...", usually the cover image in this block
                const srcMatch = /src="([^"]+)"/i.exec(chunk);
                if (!srcMatch) {
                    console.log(`[Goodreads] Chunk ${i}: No cover found`);
                    continue;
                }

                const fullUrl = hrefMatch[1].startsWith('http') ? hrefMatch[1] : `https://www.goodreads.com${hrefMatch[1]}`;
                const title = this.decodeHtml(titleMatch[1]).trim();
                const coverUrl = srcMatch[1];

                // Dedup against main book
                if (title && coverUrl) {
                    if (decodedMainTitle && title.toLowerCase().includes(decodedMainTitle)) {
                        console.log(`[Goodreads] Chunk ${i}: Skipped (Duplicate of main: ${title})`);
                        continue;
                    }

                    console.log(`[Goodreads] Scraped book: "${title}" by ${author}`);
                    books.push({
                        title: title,
                        author: author,
                        coverUrl: coverUrl,
                        goodreadsUrl: fullUrl,
                    });
                }
            }
        } catch (e) {
            console.error('[Goodreads] HTML scraping error', e);
        }
        console.log(`[Goodreads] Scraped ${books.length} books from HTML.`);
        return books;
    }

    private decodeHtml(html: string): string {
        const txt = document.createElement('textarea');
        txt.innerHTML = html;
        return txt.value;
    }

    /**
     * Search and get full book data
     */
    async findBook(title: string, author?: string, bustCache = false): Promise<GoodreadsBookData | null> {
        const goodreadsId = await this.searchBook(title, author, bustCache);
        if (!goodreadsId) {
            console.log('[Goodreads] Book not found in search');
            return null;
        }

        return await this.getBookById(goodreadsId, bustCache);
    }

    /**
     * Strip HTML tags from text
     */
    private stripHtml(html: string): string {
        return html.replace(/<[^>]*>/g, '').trim();
    }

    /**
     * Format epoch timestamp to readable date
     */
    private formatDate(epochMs: number | string | undefined): string {
        if (!epochMs) return '';
        try {
            const date = new Date(typeof epochMs === 'string' ? parseInt(epochMs) : epochMs);
            return date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        } catch {
            return '';
        }
    }
}
