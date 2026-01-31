import { requestUrl, Notice } from 'obsidian';

export interface OpenLibraryBook {
    key: string;
    title: string;
    ratings_average?: number;
    cover_i?: number;
    first_publish_year?: number;
    subject?: string[];
    number_of_pages_median?: number;  // Page count from Open Library
}

export interface OpenLibraryWork {
    description?: string | { type: string, value: string };
    title: string;
    subjects?: string[];
}

export class OpenLibraryClient {

    // Rate limiting or politeness
    // Using a generic user agent for this plugin integration
    private userAgent = 'ObsidianPocketbookImporter/0.1.0';
    private lastRequestTime = 0;
    private minRequestInterval = 500; // ms between requests

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

    async searchBook(title: string, author: string, retries = 2): Promise<OpenLibraryBook | null> {
        // Simple cleanup of title/author to improve search chances
        const safeTitle = title.replace(/\(.*\)/, '').trim();

        // Quote title if it contains spaces to force phrase search
        const qTitle = safeTitle.includes(' ') ? `"${safeTitle}"` : safeTitle;

        const params = new URLSearchParams({
            title: qTitle,
            author: author,
            limit: '1'
        });

        const url = `https://openlibrary.org/search.json?${params.toString()}`;

        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await this.throttle();
                console.log(`[Pocketbook OL] Attempt ${attempt + 1}: Searching for "${title}" by "${author}"`);

                const response = await requestUrl({
                    url: url,
                    method: 'GET',
                    headers: { 'User-Agent': this.userAgent }
                });

                if (response.status === 200) {
                    const data = response.json;
                    if (data.docs && data.docs.length > 0) {
                        console.log(`[Pocketbook OL] Found: ${data.docs[0].title}`);
                        return data.docs[0] as OpenLibraryBook;
                    } else {
                        console.log(`[Pocketbook OL] No results found for "${title}"`);
                        return null;
                    }
                } else if (response.status === 429 || response.status >= 500) {
                    // Rate limited or server error - retry
                    console.warn(`[Pocketbook OL] Rate limited (${response.status}), retrying...`);
                    await this.delay(1000 * (attempt + 1)); // Exponential backoff
                    continue;
                }
            } catch (error) {
                console.warn(`[Pocketbook OL] Search failed (attempt ${attempt + 1}):`, error);
                if (attempt < retries) {
                    await this.delay(1000 * (attempt + 1));
                    continue;
                }
            }
        }
        return null;
    }

    async getWorkDetails(key: string): Promise<OpenLibraryWork | null> {
        try {
            const response = await requestUrl({
                url: `https://openlibrary.org${key}.json`,
                method: 'GET',
                headers: { 'User-Agent': this.userAgent }
            });

            if (response.status === 200) {
                return response.json as OpenLibraryWork;
            }
        } catch (error) {
            console.warn("OpenLibrary detail fetch failed:", error);
        }
        return null;
    }
}
