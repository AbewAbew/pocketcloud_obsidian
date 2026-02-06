import { App, Modal, Notice } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { GoodreadsSearchResult } from '../goodreads';
import { BookDetailModal } from './BookDetailModal';
import { WishlistBook } from '../tracker/WishlistManager';

/**
 * Modal for searching and adding books to wishlist
 */
export class AddBookModal extends Modal {
    private plugin: PocketbookCloudHighlightsImporterPlugin;
    private searchResults: GoodreadsSearchResult[] = [];
    private isSearching = false;
    private resultsContainer: HTMLElement;
    private hasSearched = false;

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl, modalEl } = this;
        modalEl.addClass('add-book-modal');
        contentEl.addClass('add-book-content');

        contentEl.createEl('h2', { text: 'Add Book to Wishlist' });

        const searchContainer = contentEl.createDiv({ cls: 'add-book-search' });

        // Search Input
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search by title or author...',
            cls: 'add-book-search-input'
        });
        searchInput.focus();

        // Search Button
        const searchBtn = searchContainer.createEl('button', {
            text: 'Search',
            cls: 'mod-cta add-book-search-btn'
        });

        // Trigger search on Enter or Click
        const performSearch = async () => {
            const query = searchInput.value.trim();
            if (!query) return;

            this.isSearching = true;
            this.hasSearched = true;
            this.renderResults(); // Show loading

            try {
                this.searchResults = await this.plugin.goodreads.searchBooks(query);
            } catch (e) {
                new Notice('Search failed: ' + e.message);
                this.searchResults = [];
            } finally {
                this.isSearching = false;
                this.renderResults();
            }
        };

        searchBtn.addEventListener('click', performSearch);
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') performSearch();
        });

        // Results Container
        this.resultsContainer = contentEl.createDiv({ cls: 'add-book-results' });
    }

    private renderResults() {
        this.resultsContainer.empty();

        if (this.isSearching) {
            this.resultsContainer.createDiv({ cls: 'search-loading', text: 'Searching Goodreads...' });
            return;
        }

        if (this.searchResults.length === 0) {
            if (this.hasSearched) {
                this.resultsContainer.createDiv({ cls: 'search-no-results', text: 'No books found.' });
            }
            return;
        }

        this.searchResults.forEach(result => {
            const card = this.resultsContainer.createDiv({ cls: 'search-result-card' });

            // Cover
            const coverUrl = result.coverUrl;
            if (coverUrl) {
                const img = card.createEl('img', { cls: 'search-result-cover' });
                img.src = coverUrl;
            } else {
                card.createDiv({ cls: 'search-result-cover placeholder', text: '?' });
            }

            // Info
            const info = card.createDiv({ cls: 'search-result-info' });
            info.createEl('div', { cls: 'search-result-title', text: result.title });
            info.createEl('div', { cls: 'search-result-author', text: result.author });
            info.createEl('div', { cls: 'search-result-meta', text: `⭐ ${result.ratingsCount.toLocaleString()} ratings` });

            // Check if already in wishlist
            card.addEventListener('click', () => {
                this.openPreview(result);
            });
        });
    }

    private openPreview(result: GoodreadsSearchResult) {
        const wishlistBook: WishlistBook = {
            id: `goodreads-${result.id}`,
            goodreadsId: result.id,
            title: result.title,
            authors: result.author,
            coverUrl: result.coverUrl,
            addedAt: new Date().toISOString()
        };

        const mockBook = this.plugin.tracker.getWishlistManager().toPocketbookBook(wishlistBook);

        // Open Detail Modal in Preview Mode
        // Note: BookDetailModal constructor change will be required next
        new BookDetailModal(this.app, this.plugin, mockBook, true, wishlistBook).open();

        // Optional: Close this modal? 
        // Usually better to keep it open in background? 
        // Obsidian modals stack, so keeping it open works.
    }

    onClose() {
        this.contentEl.empty();
    }
}
