import { App, Modal, TFile, Notice, Setting } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { PocketbookCloudBook } from '../apiclient';
import { BookDetailModal } from './BookDetailModal';
import { AddBookModal } from './AddBookModal';

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
    private wishlistBooks: PocketbookCloudBook[] = [];
    private currentFilter: 'all' | 'reading' | 'completed' | 'not-started' | 'wishlist' = 'all';
    private searchQuery = '';
    private resizeHandler: () => void;

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin, books: PocketbookCloudBook[]) {
        super(app);
        this.plugin = plugin;
        this.books = books;
        this.filteredBooks = books;
    }

    async onOpen() {
        const { contentEl, modalEl } = this;
        // Add class to modal shell for wider styling
        modalEl.addClass('pocketbook-library-modal');
        contentEl.addClass('library-modal');

        // Reconcile wishlist with owned books to remove duplicates
        await this.plugin.tracker.reconcileWishlist(this.books);

        // Load wishlist
        this.wishlistBooks = await this.plugin.tracker.getWishlistAsBooks();

        this.render();

        // Add resize listener to update layout dynamically
        this.resizeHandler = () => {
            const bookshelf = contentEl.querySelector('.library-bookshelf') as HTMLElement;
            if (bookshelf) {
                this.renderBooks(bookshelf);
            }
        };
        window.addEventListener('resize', this.resizeHandler);
    }

    private render() {
        const { contentEl } = this;
        contentEl.empty();



        // Crown Molding (Top of the Cabinet) - Contains Search and Filters
        const crownMolding = contentEl.createDiv({ cls: 'library-crown-molding' });

        // Search bar (embedded in molding)
        const searchContainer = crownMolding.createDiv({ cls: 'library-search' });
        const searchInput = searchContainer.createEl('input', {
            type: 'text',
            placeholder: 'Search library...',
            cls: 'library-search-input'
        });
        searchInput.value = this.searchQuery;
        searchInput.addEventListener('input', (e) => {
            this.searchQuery = (e.target as HTMLInputElement).value;
            this.applyFilters();
            const bookshelf = contentEl.querySelector('.library-bookshelf') as HTMLElement;
            if (bookshelf) this.renderBooks(bookshelf);
        });

        // Filter tabs (embedded in molding)
        const filterTabs = crownMolding.createDiv({ cls: 'library-filters' });
        const filters: { key: typeof this.currentFilter; label: string }[] = [
            { key: 'all', label: 'All' },
            { key: 'reading', label: 'Reading' },
            { key: 'completed', label: 'Completed' },
            { key: 'not-started', label: 'Not Started' },
            { key: 'wishlist', label: 'Wishlist' }
        ];

        // Add Book Button (Right aligned)
        const addBtn = crownMolding.createEl('button', {
            text: '+',
            cls: 'library-add-btn',
            title: 'Add to Wishlist'
        });
        addBtn.addEventListener('click', () => {
            new AddBookModal(this.app, this.plugin).open();
            // We might want to refresh the library after adding?
            // But the modal stays open. When AddBookModal closes or adds, we don't know easily.
            // We can refresh on tab switch.
        });

        filters.forEach(filter => {
            const tab = filterTabs.createEl('button', {
                text: filter.label,
                cls: `filter-tab ${this.currentFilter === filter.key ? 'active' : ''}`
            });
            tab.addEventListener('click', async () => {
                this.currentFilter = filter.key;
                if (filter.key === 'wishlist') {
                    // Refresh wishlist to ensure we see newly added books
                    this.wishlistBooks = await this.plugin.tracker.getWishlistAsBooks();
                }
                this.applyFilters();
                this.render();
            });
        });

        // Bookshelf container (replaces grid)
        const bookshelf = contentEl.createDiv({ cls: 'library-bookshelf' });
        this.renderBooks(bookshelf);

        this.addStyles();
    }

    private applyFilters() {
        let filtered: PocketbookCloudBook[] = [];

        if (this.currentFilter === 'wishlist') {
            filtered = [...this.wishlistBooks];
        } else {
            filtered = [...this.books];
        }

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

    private async renderBooks(bookshelf: HTMLElement) {
        bookshelf.empty();

        if (this.filteredBooks.length === 0) {
            const emptyShelf = bookshelf.createDiv({ cls: 'library-shelf-row empty-shelf' });
            emptyShelf.createEl('p', { text: 'No books found', cls: 'library-empty' });
            return;
        }

        // Fetch all page counts for efficient lookup
        const pageCounts = await this.plugin.tracker.getDatabase().getAllBookPageCounts();

        // Calculate books per row dynamically based on window width
        const BOOKS_PER_ROW = this.calculateBooksPerRow();

        const chunks: PocketbookCloudBook[][] = [];
        for (let i = 0; i < this.filteredBooks.length; i += BOOKS_PER_ROW) {
            chunks.push(this.filteredBooks.slice(i, i + BOOKS_PER_ROW));
        }

        // Render each shelf row
        chunks.forEach(rowBooks => {
            const shelfRow = bookshelf.createDiv({ cls: 'library-shelf-row' });
            const booksContainer = shelfRow.createDiv({ cls: 'library-shelf-books' });

            rowBooks.forEach(book => {
                const card = booksContainer.createDiv({ cls: 'library-book-card' });
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

                // 3D Book pages (stacked behind cover)
                for (let i = 1; i <= 5; i++) {
                    card.createDiv({ cls: `library-book-page page-${i}` });
                }
                // Back cover
                card.createDiv({ cls: 'library-book-back' });

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
                // Only show Set Pages for books in library (not wishlist)
                if (book.read_status !== 'wishlist' && (progress === 0 || savedPages)) {
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

                                    // Update button to show page count
                                    setPagesBtn.setText(`📄 ${newPageCount}p`);
                                    setPagesBtn.addClass('has-pages');
                                    new Notice(`Set ${bookTitle} to ${newPageCount} pages`);
                                }
                            }
                        ).open();
                    });
                }

                // Calculate and set dynamic book thickness
                // User requested that we ONLY use dynamic size if the user has manually set the pages.
                // If savedPages is undefined/0, we use a fixed default size (350 pages equivalent)
                // so all unset books look uniform until interacted with.
                const estimatedPages = savedPages ? savedPages : 350;
                const thickness = this.calculateBookThickness(estimatedPages);
                card.style.setProperty('--book-thickness', thickness);

                // Book title tooltip (since we're removing the visible text)
                card.setAttribute('title', `${book.metadata?.title || 'Unknown Title'} (${estimatedPages} p)`);
            });

            // Add the shelf surface (the wooden edge)
            shelfRow.createDiv({ cls: 'library-shelf-surface' });
        });
    }

    private calculateBooksPerRow(): number {
        const width = window.innerWidth;
        if (width < 600) {
            return 2; // Mobile phones
        } else if (width < 900) {
            return 3; // Tablets / Small modals
        } else {
            return 4; // Desktop
        }
    }

    private addStyles() {
        // Styles are now defined in styles.css
        // This function is kept for backwards compatibility but does nothing
    }

    /**
     * Calculate book thickness based on page count.
     * Maps 200-1200 pages to a pixel range (e.g. 20px - 60px)
     */
    private calculateBookThickness(pageCount: number): string {
        const minPages = 50;
        const maxPages = 1200;
        const minThickness = 12; // px
        const midThickness = 40; // px at 350 pages
        const maxThickness = 100; // px

        let thickness: number;
        // Clamp page count
        const pages = Math.max(minPages, Math.min(pageCount, maxPages));

        if (pages <= 350) {
            // Steeper curve for common book sizes (50-350 pages)
            // Maps 50->12px, 350->40px
            thickness = minThickness + ((pages - minPages) / (350 - minPages)) * (midThickness - minThickness);
        } else {
            // Flatter curve for larger books (350-1200 pages)
            // Maps 350->40px, 1200->100px
            thickness = midThickness + ((pages - 350) / (maxPages - 350)) * (maxThickness - midThickness);
        }

        return `${Math.round(thickness)}px`;
    }


    onClose() {
        const { contentEl } = this;
        // Clean up event listener
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
        }
        contentEl.empty();
    }
}
