import { App, Modal, Notice } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { PocketbookCloudBook } from '../apiclient';
import { HardcoverClient, HardcoverBook } from '../hardcover';
import { GoodreadsClient, GoodreadsBookData } from '../goodreads';

/**
 * Modal displaying detailed book information
 */
export class BookDetailModal extends Modal {
    private plugin: PocketbookCloudHighlightsImporterPlugin;
    private book: PocketbookCloudBook;
    private hardcoverData: HardcoverBook | null = null;
    private goodreadsData: GoodreadsBookData | null = null;
    private isLoading = false;
    private isLoadingGoodreads = false;

    private displayedReviewsCount = 5;

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin, book: PocketbookCloudBook) {
        super(app);
        this.plugin = plugin;
        this.book = book;
        this.displayedReviewsCount = this.plugin.settings.goodreadsReviewsLimit || 5;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('pocketbook-book-detail-modal');
        contentEl.addClass('book-detail-modal-content');

        // Initial render with Pocketbook data
        this.render();

        // Get book info for searches
        const title = this.book.metadata?.title || '';
        const rawAuthors = this.book.metadata?.authors;
        const author = Array.isArray(rawAuthors) ? rawAuthors[0] : (rawAuthors || '');

        // Fetch data from both sources in parallel
        const fetchPromises: Promise<void>[] = [];

        if (this.plugin.settings.hardcover_api_key) {
            fetchPromises.push(this.fetchHardcoverData(title, author));
        }

        // Always try Goodreads for ratings/reviews
        fetchPromises.push(this.fetchGoodreadsData(title, author));

        await Promise.all(fetchPromises);
    }

    private async fetchHardcoverData(title: string, author: string) {
        const { contentEl } = this;
        this.isLoading = true;

        const loadingEl = contentEl.querySelector('.hardcover-loading');
        if (loadingEl) loadingEl.setText('Loading from Hardcover...');

        try {
            const client = new HardcoverClient(this.plugin.settings.hardcover_api_key);
            console.log('[BookDetail] Searching Hardcover for:', title, 'by', author);
            this.hardcoverData = await client.findBook(title, author);

            if (this.hardcoverData) {
                this.render();
            } else {
                if (loadingEl) loadingEl.setText('Book not found on Hardcover');
            }
        } catch (error) {
            console.error('[BookDetail] Failed to fetch Hardcover data:', error);
            if (loadingEl) loadingEl.setText('Failed to load Hardcover data');
        }

        this.isLoading = false;
    }

    private async fetchGoodreadsData(title: string, author: string, bustCache = false) {
        this.isLoadingGoodreads = true;

        try {
            const client = this.plugin.goodreads;
            // Fetch all available reviews (scraper caps at 50)
            console.log('[BookDetail] Searching Goodreads for:', title, 'by', author, bustCache ? '(Cache Busted)' : '');
            this.goodreadsData = await client.findBook(title, author, bustCache);

            if (this.goodreadsData) {
                console.log('[BookDetail] Goodreads rating:', this.goodreadsData.averageRating);
            }
        } catch (error) {
            console.error('[BookDetail] Failed to fetch Goodreads data:', error);
        } finally {
            this.isLoadingGoodreads = false;
            this.render();
        }
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();

        // Container
        const container = contentEl.createDiv({ cls: 'book-detail-container' });

        // Cover Section
        const coverContainer = container.createDiv({ cls: 'book-detail-cover' });
        // Try Hardcover image first, then Pocketbook fallback
        const coverUrl = this.hardcoverData?.image?.url;

        if (coverUrl) {
            const img = coverContainer.createEl('img');
            img.src = coverUrl;
            img.alt = this.book.metadata?.title || 'Book cover';
        } else {
            // Fallback to placeholder/pocketbook cover logic if we had it
            // For now just partial placeholder
            coverContainer.createEl('div', { text: 'No Cover', cls: 'cover-placeholder' });
        }

        // Progress bar
        const progress = (this.book as any).read_percent ?? parseFloat((this.book as any).percent || '0') ?? 0;
        if (progress > 0) {
            const progressContainer = coverContainer.createDiv({ cls: 'detail-progress' });
            const progressBar = progressContainer.createDiv({ cls: 'detail-progress-bar' });
            const progressFill = progressBar.createDiv({ cls: 'detail-progress-fill' });
            progressFill.style.width = `${progress}%`;
            progressContainer.createDiv({ cls: 'detail-progress-text', text: `${progress}% complete` });
        }

        // Info Section
        const infoSection = container.createDiv({ cls: 'book-detail-info' });

        // Metadata
        const titleContainer = infoSection.createDiv({ cls: 'book-detail-title-container' });
        titleContainer.createEl('h2', {
            text: this.book.metadata?.title || 'Unknown Title',
            cls: 'book-detail-title'
        });

        // Add Refresh Button for metadata
        const refreshBtn = titleContainer.createEl('button', { cls: 'metadata-refresh-btn', title: 'Start fresh fetch from Goodreads' });
        refreshBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path><path d="M16 16h5v5"></path></svg>`;
        refreshBtn.onclick = async (e) => {
            e.stopPropagation();
            refreshBtn.addClass('spinning');
            this.goodreadsData = null; // Clear current data
            // Show loading state
            this.isLoadingGoodreads = true;
            this.render();

            const title = this.book.metadata?.title || '';
            const rawAuthors = this.book.metadata?.authors;
            const author = Array.isArray(rawAuthors) ? rawAuthors[0] : (rawAuthors || '');

            await this.fetchGoodreadsData(title, author, true); // Force bust cache
            refreshBtn.removeClass('spinning');
        };

        // Author - handle string or array
        const rawAuthors = this.book.metadata?.authors;
        const authorDisplay = Array.isArray(rawAuthors)
            ? rawAuthors[0]
            : (rawAuthors || 'Unknown Author');
        infoSection.createEl('p', {
            text: `by ${authorDisplay}`,
            cls: 'book-detail-author'
        });

        // Ratings Section (Goodreads)
        if (this.goodreadsData) {
            const ratingSection = infoSection.createDiv({ cls: 'book-detail-ratings' });
            const ratingScore = this.goodreadsData.averageRating.toFixed(2);
            const startRating = "⭐".repeat(Math.round(this.goodreadsData.averageRating));

            ratingSection.createEl('span', {
                text: `${startRating} ${ratingScore}`,
                cls: 'rating-score'
            });
            ratingSection.createEl('span', {
                text: ` (${this.goodreadsData.ratingsCount.toLocaleString()} ratings)`,
                cls: 'rating-count'
            });
        } else if (this.isLoadingGoodreads) {
            infoSection.createDiv({ cls: 'rating-loading', text: 'Loading Goodreads rating...' });
        }

        // Hardcover data section
        if (this.hardcoverData) {
            const hcClient = new HardcoverClient(this.plugin.settings.hardcover_api_key);

            // Genres
            const genres = hcClient.getGenres(this.hardcoverData);
            if (genres.length > 0) {
                const genresContainer = infoSection.createDiv({ cls: 'book-detail-genres' });
                genres.forEach(genre => {
                    genresContainer.createEl('span', { text: genre, cls: 'genre-tag' });
                });
            }

            // Description
            if (this.hardcoverData.description) {
                const descSection = infoSection.createDiv({ cls: 'book-detail-description' });
                descSection.createEl('h4', { text: 'Description' });
                descSection.createEl('p', {
                    text: this.hardcoverData.description
                });
            }

            // Metadata grid
            const metaGrid = infoSection.createDiv({ cls: 'book-detail-meta' });

            if (this.hardcoverData.release_date) {
                const year = new Date(this.hardcoverData.release_date).getFullYear();
                this.addMetaItem(metaGrid, 'Published', String(year));
            }

            if (this.hardcoverData.pages) {
                this.addMetaItem(metaGrid, 'Pages', String(this.hardcoverData.pages));
            }

            if (this.hardcoverData.users_read_count) {
                this.addMetaItem(metaGrid, 'Readers', String(this.hardcoverData.users_read_count));
            }

            // Hardcover link
            if (this.hardcoverData.slug) {
                const linkSection = infoSection.createDiv({ cls: 'book-detail-link' });
                const link = linkSection.createEl('a', {
                    text: '📖 View on Hardcover',
                    href: hcClient.getBookUrl(this.hardcoverData.slug),
                    cls: 'hardcover-link'
                });
                link.setAttr('target', '_blank');
            }
        } else if (!this.isLoading && this.plugin.settings.hardcover_api_key) {
            infoSection.createDiv({ cls: 'hardcover-loading', text: 'Loading from Hardcover...' });
        }

        // Goodreads Reviews Section
        if (this.goodreadsData && this.goodreadsData.reviews.length > 0) {
            const reviewsSection = contentEl.createDiv({ cls: 'book-detail-reviews-section' });
            reviewsSection.createEl('h3', { text: 'Community Reviews (Goodreads)' });

            // Show only the number of reviews specified by displayedReviewsCount
            const reviewsToShow = this.goodreadsData.reviews.slice(0, this.displayedReviewsCount);

            reviewsToShow.forEach(review => {
                const reviewCard = reviewsSection.createDiv({ cls: 'review-card' });

                const header = reviewCard.createDiv({ cls: 'review-header' });
                header.createEl('span', { text: review.reviewerName, cls: 'reviewer-name' });
                header.createEl('span', { text: `⭐ ${review.rating}`, cls: 'review-rating' });
                header.createEl('span', { text: review.date, cls: 'review-date' });

                if (review.spoiler) {
                    const spoiler = reviewCard.createDiv({ cls: 'review-spoiler' });
                    spoiler.createEl('button', { text: 'Show Spoiler Review' }).onclick = () => {
                        spoiler.empty();
                        spoiler.createEl('p', { text: review.body, cls: 'review-body' });
                    };
                } else {
                    reviewCard.createEl('p', { text: review.body, cls: 'review-body' });
                }
            });

            // "Load More" Button or "See on Goodreads" Link
            if (this.displayedReviewsCount < this.goodreadsData.reviews.length) {
                const loadMoreBtn = reviewsSection.createEl('button', {
                    text: 'Load More',
                    cls: 'goodreads-load-more-btn'
                });
                loadMoreBtn.onclick = () => {
                    this.displayedReviewsCount += 5;
                    this.render(); // Re-render to show more
                };
            } else {
                // All loaded, show link to Goodreads
                const glink = reviewsSection.createEl('a', {
                    text: 'See more on Goodreads',
                    href: this.goodreadsData.goodreadsUrl,
                    cls: 'goodreads-link'
                });
                glink.setAttr('target', '_blank');
            }
        } else if (this.isLoadingGoodreads) {
            contentEl.createDiv({ cls: 'reviews-loading', text: 'Loading reviews from Goodreads...' });
        }

        // Similar Books Section (Always show if we have Goodreads data)
        if (this.goodreadsData) {
            const similarSection = contentEl.createDiv({ cls: 'similar-books-section' });
            similarSection.createEl('h3', { text: 'Similar Books', cls: 'similar-books-header' });

            const container = similarSection.createDiv({ cls: 'similar-books-container' });

            if (this.goodreadsData.similarBooks && this.goodreadsData.similarBooks.length > 0) {
                this.goodreadsData.similarBooks.forEach(book => {
                    const card = container.createEl('a', {
                        href: book.goodreadsUrl,
                        cls: 'similar-book-card'
                    });
                    card.setAttr('target', '_blank');

                    if (book.coverUrl) {
                        card.createEl('img', {
                            attr: { src: book.coverUrl },
                            cls: 'similar-book-cover'
                        });
                    } else {
                        card.createDiv({ cls: 'similar-book-cover cover-placeholder', text: '?' });
                    }

                    card.createDiv({ text: book.title, cls: 'similar-book-title', title: book.title });
                    card.createDiv({ text: book.author, cls: 'similar-book-author' });
                });
            } else {
                container.createDiv({ cls: 'no-similar-books', text: 'No similar books found.' });
            }
        }



    }

    private addMetaItem(container: HTMLElement, label: string, value: string) {
        const item = container.createDiv({ cls: 'meta-item' });
        item.createEl('span', { text: label, cls: 'meta-label' });
        item.createEl('span', { text: value, cls: 'meta-value' });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
