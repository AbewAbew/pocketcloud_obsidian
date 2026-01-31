import { App, Modal, TFile, Notice, Setting } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { PocketbookCloudBook } from '../apiclient';
import { BookDetailModal } from './BookDetailModal';

/**
 * Simple modal for entering page count
 */
class PageCountModal extends Modal {
    private result: number | null = null;
    private onSubmit: (result: number | null) => void;
    private bookTitle: string;
    private currentValue: string;

    constructor(app: App, bookTitle: string, currentValue: string, onSubmit: (result: number | null) => void) {
        super(app);
        this.bookTitle = bookTitle;
        this.currentValue = currentValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: `Set Page Count` });
        contentEl.createEl('p', { text: this.bookTitle, cls: 'page-count-book-title' });

        const inputContainer = contentEl.createDiv({ cls: 'page-count-input-container' });
        const input = inputContainer.createEl('input', {
            type: 'number',
            placeholder: 'Enter page count...',
            value: this.currentValue,
            cls: 'page-count-modal-input'
        });
        input.focus();
        input.select();

        const buttonContainer = contentEl.createDiv({ cls: 'page-count-buttons' });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });

        const saveBtn = buttonContainer.createEl('button', { text: 'Save', cls: 'mod-cta' });
        saveBtn.addEventListener('click', () => {
            const value = parseInt(input.value);
            if (value > 0) {
                this.result = value;
            }
            this.close();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const value = parseInt(input.value);
                if (value > 0) {
                    this.result = value;
                }
                this.close();
            } else if (e.key === 'Escape') {
                this.close();
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.onSubmit(this.result);
    }
}

/**
 * Modal displaying all books in the library
 */
export class LibraryModal extends Modal {
    private plugin: PocketbookCloudHighlightsImporterPlugin;
    private books: PocketbookCloudBook[];
    private filteredBooks: PocketbookCloudBook[];
    private currentFilter: 'all' | 'reading' | 'completed' | 'not-started' = 'all';
    private searchQuery = '';

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin, books: PocketbookCloudBook[]) {
        super(app);
        this.plugin = plugin;
        this.books = books;
        this.filteredBooks = books;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.addClass('library-modal');
        this.render();
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();

        // Header
        const header = contentEl.createDiv({ cls: 'library-header' });
        header.createEl('h2', { text: '📚 My Library' });
        header.createEl('p', { cls: 'library-subtitle', text: `${this.books.length} books` });

        // Search bar
        const searchContainer = contentEl.createDiv({ cls: 'library-search' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search by title or author...',
            cls: 'library-search-input'
        });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.applyFilters();
            this.renderBooks(contentEl.querySelector('.library-grid') as HTMLElement);
        });

        // Filter tabs
        const filterTabs = contentEl.createDiv({ cls: 'library-filters' });
        const filters: { key: typeof this.currentFilter; label: string }[] = [
            { key: 'all', label: 'All' },
            { key: 'reading', label: 'Reading' },
            { key: 'completed', label: 'Completed' },
            { key: 'not-started', label: 'Not Started' }
        ];

        filters.forEach(filter => {
            const tab = filterTabs.createEl('button', {
                text: filter.label,
                cls: `filter-tab ${this.currentFilter === filter.key ? 'active' : ''}`
            });
            tab.addEventListener('click', () => {
                this.currentFilter = filter.key;
                this.applyFilters();
                this.render();
            });
        });

        // Books grid
        const grid = contentEl.createDiv({ cls: 'library-grid' });
        this.renderBooks(grid);


        this.addStyles();
    }

    private applyFilters() {
        let filtered = [...this.books];

        // Apply status filter
        if (this.currentFilter !== 'all') {
            filtered = filtered.filter(book => {
                const progress = (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0;
                switch (this.currentFilter) {
                    case 'reading':
                        return progress > 0 && progress < 100;
                    case 'completed':
                        return progress === 100 || book.read_status === 'read';
                    case 'not-started':
                        return progress === 0;
                    default:
                        return true;
                }
            });
        }

        // Apply search filter
        if (this.searchQuery.trim()) {
            const query = this.searchQuery.toLowerCase();
            filtered = filtered.filter(book => {
                const title = book.metadata?.title?.toLowerCase() || '';
                // Authors can be string or array
                const rawAuthors = book.metadata?.authors;
                const author = Array.isArray(rawAuthors)
                    ? rawAuthors[0]?.toLowerCase() || ''
                    : (rawAuthors?.toLowerCase() || '');
                return title.includes(query) || author.includes(query);
            });
        }

        this.filteredBooks = filtered;
    }

    private async renderBooks(grid: HTMLElement) {
        grid.empty();

        if (this.filteredBooks.length === 0) {
            grid.createEl('p', { text: 'No books found', cls: 'library-empty' });
            return;
        }

        // Fetch all page counts for efficient lookup
        const pageCounts = await this.plugin.tracker.getDatabase().getAllBookPageCounts();

        this.filteredBooks.forEach(book => {
            const card = grid.createDiv({ cls: 'library-book-card' });
            card.addEventListener('click', () => {
                new BookDetailModal(this.app, this.plugin, book).open();
            });

            // Cover
            const coverContainer = card.createDiv({ cls: 'library-cover' });
            const coverUrl = book.metadata?.cover?.[0]?.path;

            if (coverUrl) {
                const img = coverContainer.createEl('img');
                img.src = coverUrl;
                img.alt = book.metadata?.title || 'Book cover';
                img.loading = 'lazy';
                img.onerror = () => {
                    img.remove();
                    coverContainer.createEl('span', { text: '📖', cls: 'cover-placeholder-icon' });
                };
            } else {
                coverContainer.createEl('span', { text: '📖', cls: 'cover-placeholder-icon' });
            }

            // Progress indicator
            const progress = (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? 0;
            if (progress > 0) {
                const progressBadge = card.createDiv({ cls: 'library-progress-badge' });
                progressBadge.setText(`${progress}%`);
                if (progress === 100) progressBadge.addClass('completed');
            }

            // For books at 0% progress, show "Set Pages" button
            // Also update it if we already have a page count saved
            const savedPages = pageCounts[book.fast_hash];
            if (progress === 0 || savedPages) {
                const setPagesBtn = card.createEl('button', { cls: 'library-set-pages-btn' });

                if (savedPages) {
                    setPagesBtn.setText(`📄 ${savedPages}p`);
                    setPagesBtn.addClass('has-pages');
                } else {
                    setPagesBtn.setText('📄 Set Pages');
                }

                setPagesBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation(); // Don't open book detail modal
                    e.stopImmediatePropagation();

                    const currentPageCount = await this.plugin.tracker.getDatabase().getBookPageCount(book.fast_hash);
                    const bookTitle = book.metadata?.title || book.title;

                    new PageCountModal(
                        this.app,
                        bookTitle,
                        currentPageCount?.toString() || '',
                        async (newPageCount) => {
                            if (newPageCount && newPageCount > 0) {
                                await this.plugin.tracker.getDatabase().setBookPageCount(book.fast_hash, newPageCount);
                                // No manual save needed, setBookPageCount saves now. But to be safe vs race conditions:
                                // await this.plugin.tracker.getDatabase().save(); 

                                // Update button to show page count
                                setPagesBtn.setText(`📄 ${newPageCount}p`);
                                setPagesBtn.addClass('has-pages');
                                new Notice(`Set ${bookTitle} to ${newPageCount} pages`);
                            }
                        }
                    ).open();
                });
            }

            // Info
            const info = card.createDiv({ cls: 'library-book-info' });
            info.createEl('div', {
                text: book.metadata?.title || 'Unknown Title',
                cls: 'library-book-title'
            });
            // Authors can be string or array
            const rawAuthors = book.metadata?.authors;
            const authorDisplay = Array.isArray(rawAuthors)
                ? rawAuthors[0]
                : (rawAuthors || 'Unknown Author');
            info.createEl('div', {
                text: authorDisplay,
                cls: 'library-book-author'
            });
        });
    }

    private addStyles() {
        const styleId = 'library-modal-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .library-modal {
                padding: 20px;
                max-height: 80vh;
                overflow-y: auto;
            }

            .library-header {
                margin-bottom: 16px;
            }

            .library-header h2 {
                margin: 0 0 4px 0;
            }

            .library-subtitle {
                color: var(--text-muted);
                margin: 0;
            }

            .library-search {
                margin-bottom: 16px;
            }

            .library-search-input {
                width: 100%;
                padding: 10px 14px;
                border-radius: 8px;
                border: 1px solid var(--background-modifier-border);
                background: var(--background-primary);
                font-size: 0.95em;
            }

            .library-filters {
                display: flex;
                gap: 8px;
                margin-bottom: 20px;
                flex-wrap: wrap;
            }

            .filter-tab {
                padding: 6px 14px;
                border-radius: 20px;
                border: 1px solid var(--background-modifier-border);
                background: var(--background-secondary);
                cursor: pointer;
                font-size: 0.85em;
                transition: all 0.2s;
            }

            .filter-tab:hover {
                border-color: var(--interactive-accent);
            }

            .filter-tab.active {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                border-color: var(--interactive-accent);
            }

            .library-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
                gap: 16px;
            }

            .library-book-card {
                cursor: pointer;
                transition: transform 0.2s;
                position: relative;
            }

            .library-book-card:hover {
                transform: translateY(-4px);
            }

            .library-cover {
                width: 100%;
                aspect-ratio: 2/3;
                border-radius: 6px;
                overflow: hidden;
                background: var(--background-secondary);
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            }

            .library-cover img {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .cover-placeholder-icon {
                font-size: 2.5em;
            }

            .library-progress-badge {
                position: absolute;
                top: 6px;
                right: 6px;
                background: rgba(0, 0, 0, 0.7);
                color: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 0.7em;
                font-weight: bold;
            }

            .library-progress-badge.completed {
                background: #22c55e;
            }

            .library-book-info {
                padding: 8px 0;
            }

            .library-book-title {
                font-weight: 600;
                font-size: 0.85em;
                line-height: 1.3;
                overflow: hidden;
                text-overflow: ellipsis;
                display: -webkit-box;
                -webkit-line-clamp: 2;
                -webkit-box-orient: vertical;
            }

            .library-book-author {
                font-size: 0.75em;
                color: var(--text-muted);
                margin-top: 2px;
            }

            .library-empty {
                grid-column: 1 / -1;
                text-align: center;
                color: var(--text-muted);
                padding: 40px;
            }

            .library-set-pages-btn {
                position: absolute;
                top: 6px;
                right: 6px;
                background: rgba(0, 0, 0, 0.8);
                color: white;
                padding: 4px 8px;
                border-radius: 4px;
                font-size: 0.65em;
                cursor: pointer;
                transition: all 0.2s;
                z-index: 10;
            }

            .library-set-pages-btn:hover {
                background: var(--interactive-accent);
            }

            .library-set-pages-btn.has-pages {
                background: rgba(34, 197, 94, 0.9);
            }
        `;
        document.head.appendChild(style);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
