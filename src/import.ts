import { requestUrl, App, Notice, TFile, stringifyYaml } from 'obsidian';
import { PocketbookCloudApiClient, PocketbookCloudLoginClient } from './apiclient';
import { TemplatingService } from './templating';
import PocketbookCloudHighlightsImporterPlugin from './main';
import { PocketbookCloudHighlightsImporterPluginSettings } from './settings';
import { OpenLibraryClient } from './openlibrary';

const CFI = require('epub-cfi-resolver');

export class PocketbookCloudHighlightsImporter {
  login_client: PocketbookCloudLoginClient;
  api_client: PocketbookCloudApiClient;
  ol_client: OpenLibraryClient;

  templating_service: TemplatingService;

  constructor(private app: App, private plugin: PocketbookCloudHighlightsImporterPlugin, private settings: PocketbookCloudHighlightsImporterPluginSettings) {
    this.login_client = new PocketbookCloudLoginClient(
      plugin,
      settings.username,
      null,
      settings.shop_name,
      settings.access_token,
      settings.refresh_token,
      settings.access_token_valid_until
    );
    this.api_client = new PocketbookCloudApiClient(this.login_client);
    this.ol_client = new OpenLibraryClient();
    this.templating_service = new TemplatingService();
  }

  async importHighlights() {
    new Notice('Importing highlights...');
    const books = await this.api_client.getBooks();

    // Record reading progress snapshots if tracking is enabled
    if (this.settings.enableTracking && this.plugin.tracker) {
      try {
        await this.plugin.tracker.onSync(books);
      } catch (e) {
        console.error('[Pocketbook] Tracker sync failed:', e);
      }
    }

    for (const book of books) {
      new Notice(`Importing ${book.title}`);
      const highlightIds = await this.api_client.getHighlightIdsForBook(book.fast_hash);

      const rawHighlights = await Promise.all(highlightIds.map(highlightInfo => this.api_client.getHighlight(highlightInfo.uuid, book.fast_hash)));

      // Filter out empty highlights
      const highlights = rawHighlights.filter(h => (h.quotation?.text && h.quotation.text.trim().length > 0) || (h.note?.text && h.note.text.trim().length > 0));

      if (highlights.length > 0) {
        await this.createOrUpdateBookFile(book, highlights);
      }
    }

    // Update status bar after sync
    if (this.plugin.updateStatusBar) {
      await this.plugin.updateStatusBar();
    }

    // Prune Cache (Garbage Collection)
    try {
      if (this.plugin.goodreads) {
        this.plugin.goodreads.prune(books);
        if (this.plugin.saveCache) await this.plugin.saveCache();
      }
    } catch (e) {
      console.warn('[Pocketbook] Pruning failed:', e);
    }

    new Notice('Import done');
  }

  private async createOrUpdateBookFile(book: any, highlights: any[]) {
    // 1. Prepare Metadata Context
    // Extract embedded IDs
    let calibreId = '';
    let hardcoverId = '';
    let hardcoverSlug = '';
    let bookUuid = '';

    if (book.metadata?.book_id && Array.isArray(book.metadata.book_id)) {
      for (const idStr of book.metadata.book_id) {
        if (idStr.startsWith('calibre:')) calibreId = idStr.replace('calibre:', '');
        else if (idStr.startsWith('hardcover-id:')) hardcoverId = idStr.replace('hardcover-id:', '');
        else if (idStr.startsWith('hardcover-slug:')) hardcoverSlug = idStr.replace('hardcover-slug:', '');
        else if (idStr.startsWith('uuid:')) bookUuid = idStr.replace('uuid:', '');
      }
    }

    // Prepare metadata extraction
    const authors = book.metadata.authors;

    // Covers
    const coverUrl = (book.metadata?.cover && book.metadata.cover.length > 0) ? book.metadata.cover[0].path : '';
    let coverImagePath = '';
    if (coverUrl && this.settings.covers_folder) {
      try {
        coverImagePath = await this.downloadCoverImage(coverUrl, book.title, this.settings.covers_folder);
      } catch (e) { console.error("Cover download failed", e); }
    }

    const finalCoverUrl = coverImagePath ? coverImagePath : (coverUrl || '');
    console.log(`[Pocketbook] Title: "${book.title}", CoverPath: "${finalCoverUrl}"`);

    // Tags
    const collectionTags = (book.collections ?? '').split(',').filter((t: string) => t.length > 0);
    console.log(`[Pocketbook] Collection Tags: ${collectionTags}`);

    // --- Open Library Integration ---
    // Fetch if description is missing OR to get rating/tags
    let description = this.cleanDescription(
      (book.metadata as any)?.description || (book.metadata as any)?.annotation || (book.metadata as any)?.summary ||
      (book as any).description || (book as any).annotation || (book as any).summary || ''
    );
    let rating = null;
    const additionalTags: string[] = [];

    try {
      if (book.title && authors) {
        // Normalize author: Handle "Last, First" -> "First Last" and arrays
        let authorSearch = '';
        if (Array.isArray(authors)) {
          authorSearch = authors.length > 0 ? authors[0] : '';
        } else {
          authorSearch = authors;
        }

        if (authorSearch.includes(',')) {
          const parts = authorSearch.split(',');
          if (parts.length === 2) {
            authorSearch = `${parts[1].trim()} ${parts[0].trim()}`;
          }
        }

        console.log(`[Pocketbook] Searching OL for Title: "${book.title}", Author: "${authorSearch}"`);
        const olBook = await this.ol_client.searchBook(book.title, authorSearch);
        console.log(`[Pocketbook] OL Search Result for "${book.title}":`, olBook ? 'Found' : 'Not Found');
        if (olBook) {
          if (olBook.ratings_average) rating = olBook.ratings_average;
          if (olBook.subject && Array.isArray(olBook.subject)) {
            console.log(`[Pocketbook] OL Subjects found: ${olBook.subject.length}`);
            additionalTags.push(...olBook.subject.slice(0, 5));
          }

          // Capture page count from Open Library for accurate tracking
          if (olBook.number_of_pages_median && this.plugin.tracker && this.settings.enableTracking) {
            const existingPageCount = await this.plugin.tracker.getDatabase().getBookPageCount(book.fast_hash);
            if (!existingPageCount) {
              console.log(`[Pocketbook] OL Pages for "${book.title}": ${olBook.number_of_pages_median}`);
              await this.plugin.tracker.getDatabase().setBookPageCount(book.fast_hash, olBook.number_of_pages_median);
              await this.plugin.tracker.getDatabase().save();
            } else {
              console.log(`[Pocketbook] Keeping existing page count for "${book.title}": ${existingPageCount} (Ignoring OL: ${olBook.number_of_pages_median})`);
            }
          }

          if (!description || additionalTags.length === 0) {
            const olWork = await this.ol_client.getWorkDetails(olBook.key);
            if (olWork) {
              if (olWork.description && !description) description = typeof olWork.description === 'string' ? olWork.description : olWork.description.value;
              if (olWork.subjects && Array.isArray(olWork.subjects) && additionalTags.length === 0) additionalTags.push(...olWork.subjects.slice(0, 5));
            }
          }
        }
      }
    } catch (e) {
      console.warn('Open Library enrichment failed', e);
    }

    const sanitizeTag = (tag: string) => tag.trim().replace(/\s+/g, '-').replace(/[^\w\-]/g, '');
    const allTags = [...new Set([...collectionTags, ...additionalTags])].map(sanitizeTag).filter(t => t.length > 0);
    console.log(`[Pocketbook] Final Tags: ${JSON.stringify(allTags)}`);

    // Context Object for Liquid
    const context = {
      title: book.title,
      authors: Array.isArray(book.metadata.authors) ? book.metadata.authors : [book.metadata.authors],
      isbn: book.metadata.isbn,
      year: book.metadata.year,
      id: book.id,
      fast_hash: book.fast_hash,
      calibre_id: calibreId,
      hardcover_id: hardcoverId,
      hardcover_slug: hardcoverSlug,
      book_uuid: bookUuid,
      tags: allTags,
      description: this.cleanDescription(description),
      rating: rating,
      read_url: `https://cloud.pocketbook.digital/reader_new/?${book.fast_hash}`,
      cover_url: finalCoverUrl.replace(/["']/g, '').replace(/ /g, '%20'), // Encode spaces for standard markdown links
      uploaded_at: this.formatDate(book.created_at),
      progress: (book as any).read_percent ?? parseFloat((book as any).percent || '0') ?? (book.read_status === 'read' ? 100 : 0),
      status: book.read_status
    };

    // 2. Render Filename
    let filenameTemplate = this.settings.filename_template;
    if (!filenameTemplate || filenameTemplate.trim().length === 0) filenameTemplate = '{{ title }}';

    let renderedFilename = await this.templating_service.render(filenameTemplate, context);
    // Sanitize filename
    renderedFilename = renderedFilename.replace(/[\\/:*?"<>|]/g, '').trim();
    if (renderedFilename.length === 0) renderedFilename = 'Untitled Book';

    const folder = this.settings.import_folder;
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);

    const filePath = `${folder}/${renderedFilename}.md`;
    const file = this.app.vault.getAbstractFileByPath(filePath);

    // 3. Render Page Content
    let pageContent = '';
    const pageTemplate = this.settings.page_template.trim().length > 0 ? this.settings.page_template : TemplatingService.getDefaultPageTemplate();

    if (file instanceof TFile) {
      // Merge logic: Read existing content
      const existingContent = await this.app.vault.read(file);

      // Re-render the page template to get fresh frontmatter
      const freshRendered = await this.templating_service.render(pageTemplate, context);

      // Extract frontmatter from fresh render
      const freshFmMatch = freshRendered.match(/^---\n([\s\S]*?)\n---/);
      const existingFmMatch = existingContent.match(/^---\n([\s\S]*?)\n---/);

      if (freshFmMatch && existingFmMatch) {
        // Replace old frontmatter with new frontmatter, keep rest of content
        pageContent = existingContent.replace(/^---\n[\s\S]*?\n---/, freshFmMatch[0]);
      } else {
        // Fallback: keep existing
        pageContent = existingContent;
      }
    } else {
      // New File
      pageContent = await this.templating_service.render(pageTemplate, context);
    }

    // 4. Render Highlights
    try {
      if (this.settings.sort_by === 'date') {
        highlights.sort((a, b) => (new Date(a.mark?.created || 0).getTime()) - (new Date(b.mark?.created || 0).getTime()));
      } else {
        highlights.sort((a, b) => CFI.compare(this.cfi(a.quotation.begin), this.cfi(b.quotation.begin)));
      }
    } catch (e) { highlights.sort((a, b) => +a.quotation?.updated - +b.quotation?.updated); }

    const highlightTemplate = this.settings.highlight_template.trim().length > 0 ? this.settings.highlight_template : TemplatingService.getDefaultHighlightTemplate();
    const renderedHighlights: string[] = [];

    for (const h of highlights) {
      const hContext = {
        uuid: h.uuid,
        quote: (h.quotation?.text ?? ''),
        note: (h.note?.text ?? ''),
        color: h.color?.value,
        created_at: (window as any).moment ? (window as any).moment(h.mark.created * 1000).utc().format('YYYY-MM-DD HH:mm:ss [UTC]') : new Date(h.mark.created * 1000).toISOString(),
        view_url: `https://cloud.pocketbook.digital/reader_new/?${book.fast_hash}`
      };
      renderedHighlights.push(await this.templating_service.render(highlightTemplate, hContext));
    }

    // 5. Merge and Write
    const cleanPageContent = pageContent.endsWith('\n') ? pageContent : pageContent + '\n';

    // Identify existing highlights to avoid duplicates
    const existingHighlightIds = new Set<string>();
    const regex = /%%begin-highlight-(.+?)%%/g;
    let match;
    while ((match = regex.exec(cleanPageContent)) !== null) {
      if (match[1]) existingHighlightIds.add(match[1]);
    }

    let highlightsToAppend = '';
    for (let i = 0; i < highlights.length; i++) {
      if (!existingHighlightIds.has(highlights[i].uuid)) {
        highlightsToAppend += renderedHighlights[i] + '\n\n---\n\n';
      }
    }

    const finalContent = cleanPageContent + highlightsToAppend;

    if (file instanceof TFile) {
      if (finalContent !== cleanPageContent) { // Only modify if added highlights
        await this.app.vault.modify(file, finalContent);
      }
    } else {
      await this.app.vault.create(filePath, finalContent);
    }
  }

  private cfi(cfi: string) {
    return new CFI(cfi.substring(cfi.indexOf('epubcfi')));
  }

  private async downloadCoverImage(url: string, title: string, folder: string): Promise<string> {
    const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, "");
    const fileName = `${sanitizedTitle}.jpg`;
    const filePath = folder ? `${folder}/${fileName}` : fileName;
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    if (existingFile instanceof TFile) return filePath;

    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.createFolder(folder);

    try {
      const response = await requestUrl({ url: url });
      if (response.status === 200) {
        await this.app.vault.createBinary(filePath, response.arrayBuffer);
        return filePath;
      }
    } catch (e) { }
    return '';
  }

  private async createFolder(folder: string) {
    await this.app.vault.createFolder(folder);
  }

  private cleanDescription(desc: string): string {
    if (!desc) return '';
    let cleaned = desc.replace(/\(\[source\]\[\d+\]\)/gi, '').replace(/\[\d+\]:\s*https?:\/\/\S+/gi, '');
    cleaned = cleaned.replace(/----------\s*Contains:[\s\S]*?$/i, '').replace(/Contains:\s*$/im, '');
    return cleaned.trim();
  }

  private formatDate(timestamp: any): string {
    if (!timestamp) return '';
    try {
      console.log(`[Pocketbook] Parsing Date: ${timestamp} (${typeof timestamp})`);
      let dateObj: Date;
      if (typeof timestamp === 'number') {
        if (timestamp < 9466848000000) {
          dateObj = new Date(timestamp * 1000);
        } else {
          dateObj = new Date(timestamp);
        }
      } else {
        // Try parsing string
        dateObj = new Date(timestamp);
      }

      if (isNaN(dateObj.getTime())) {
        console.warn(`[Pocketbook] Invalid Date parsed from: ${timestamp}`);
        return 'Invalid Date';
      }

      return (window as any).moment ? (window as any).moment(dateObj).format('YYYY-MM-DD HH:mm:ss') : dateObj.toISOString();
    } catch (e) {
      console.error("Date parsing error", e);
      return 'Error Date';
    }
  }
}
