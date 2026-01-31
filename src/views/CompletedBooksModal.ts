import { Modal, App, TFile } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { BookWithProgress } from '../tracker/ReadingStats';

/**
 * Modal displaying completed books with covers
 */
export class CompletedBooksModal extends Modal {
    private plugin: PocketbookCloudHighlightsImporterPlugin;
    private books: BookWithProgress[];

    constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin, books: BookWithProgress[]) {
        super(app);
        this.plugin = plugin;
        this.books = books;
    }

    async onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('completed-books-modal');

        // Add styles
        this.addStyles();

        // Header
        contentEl.createEl('h2', { text: '📚 Books Completed' });
        contentEl.createEl('p', {
            text: `You've completed ${this.books.length} book${this.books.length !== 1 ? 's' : ''}!`,
            cls: 'modal-subtitle'
        });

        if (this.books.length === 0) {
            contentEl.createEl('p', {
                text: 'No completed books yet. Keep reading!',
                cls: 'modal-empty'
            });
            return;
        }

        // Books grid
        const booksGrid = contentEl.createDiv({ cls: 'books-grid' });

        for (const book of this.books) {
            await this.renderBookCard(booksGrid, book);
        }
    }

    private async renderBookCard(container: HTMLElement, book: BookWithProgress): Promise<void> {
        const card = container.createDiv({ cls: 'book-card-modal' });

        // Cover image
        const coverContainer = card.createDiv({ cls: 'book-cover-container' });

        if (book.localCoverPath) {
            // Use local cover
            const file = this.app.vault.getAbstractFileByPath(book.localCoverPath);
            if (file instanceof TFile) {
                const coverImg = coverContainer.createEl('img', { cls: 'book-cover' });
                coverImg.src = this.app.vault.getResourcePath(file);
                coverImg.alt = book.title;
            } else {
                this.renderPlaceholderCover(coverContainer, book.title);
            }
        } else if (book.coverUrl) {
            // Use remote cover
            const coverImg = coverContainer.createEl('img', { cls: 'book-cover' });
            coverImg.src = book.coverUrl;
            coverImg.alt = book.title;
            coverImg.onerror = () => {
                coverImg.remove();
                this.renderPlaceholderCover(coverContainer, book.title);
            };
        } else {
            this.renderPlaceholderCover(coverContainer, book.title);
        }

        // Completed badge
        coverContainer.createDiv({ cls: 'completed-badge', text: '✓' });

        // Book info
        const infoContainer = card.createDiv({ cls: 'book-info-modal' });
        infoContainer.createEl('div', { text: book.title, cls: 'book-title-modal' });
        if (book.authors) {
            infoContainer.createEl('div', { text: `by ${book.authors}`, cls: 'book-author-modal' });
        }
        infoContainer.createEl('div', { text: '100% Complete', cls: 'book-status-modal' });
    }

    private renderPlaceholderCover(container: HTMLElement, title: string): void {
        const placeholder = container.createDiv({ cls: 'book-cover-placeholder' });
        placeholder.createEl('span', { text: '📖' });
        placeholder.createEl('div', { text: title.substring(0, 20) + (title.length > 20 ? '...' : ''), cls: 'placeholder-title' });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    private addStyles(): void {
        const styleId = 'completed-books-modal-styles';
        if (document.getElementById(styleId)) return;

        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            .completed-books-modal {
                padding: 20px;
                max-height: 80vh;
                overflow-y: auto;
            }

            .completed-books-modal h2 {
                margin: 0 0 8px 0;
                font-size: 1.5em;
            }

            .modal-subtitle {
                color: var(--text-muted);
                margin: 0 0 20px 0;
            }

            .modal-empty {
                color: var(--text-muted);
                font-style: italic;
                text-align: center;
                padding: 40px;
            }

            .books-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
                gap: 20px;
            }

            .book-card-modal {
                display: flex;
                flex-direction: column;
                align-items: center;
                text-align: center;
            }

            .book-cover-container {
                position: relative;
                width: 120px;
                height: 180px;
                margin-bottom: 10px;
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }

            .book-cover {
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            .book-cover-placeholder {
                width: 100%;
                height: 100%;
                background: linear-gradient(135deg, var(--background-secondary), var(--background-modifier-border));
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                padding: 10px;
            }

            .book-cover-placeholder span {
                font-size: 2em;
            }

            .placeholder-title {
                font-size: 0.7em;
                color: var(--text-muted);
                line-height: 1.2;
            }

            .completed-badge {
                position: absolute;
                top: 8px;
                right: 8px;
                width: 24px;
                height: 24px;
                background: var(--interactive-success);
                color: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 14px;
                font-weight: bold;
            }

            .book-info-modal {
                width: 100%;
            }

            .book-title-modal {
                font-weight: 600;
                font-size: 0.9em;
                margin-bottom: 4px;
                line-height: 1.2;
            }

            .book-author-modal {
                font-size: 0.8em;
                color: var(--text-muted);
                margin-bottom: 4px;
            }

            .book-status-modal {
                font-size: 0.75em;
                color: var(--interactive-success);
                font-weight: 500;
            }
        `;
        document.head.appendChild(style);
    }
}
