import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import PocketbookCloudHighlightsImporterPlugin from '../main';
import { DashboardStats, BookWithProgress } from '../tracker/ReadingStats';
import { LibraryModal } from './LibraryModal';
import { generateReadingAnalytics, ReadingAnalytics, getHeatmapData } from '../tracker/ReadingAnalytics';

export const DASHBOARD_VIEW_TYPE = 'pocketbook-reading-dashboard';

/**
 * Reading Dashboard - ItemView showing reading statistics and progress
 */
export class DashboardView extends ItemView {
  private plugin: PocketbookCloudHighlightsImporterPlugin;
  private refreshInterval: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PocketbookCloudHighlightsImporterPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DASHBOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Reading Dashboard';
  }

  getIcon(): string {
    return 'book-open';
  }

  async onOpen(): Promise<void> {
    await this.render();

    // Auto-refresh every 5 minutes
    this.refreshInterval = window.setInterval(() => {
      this.render();
    }, 5 * 60 * 1000);
  }

  async onClose(): Promise<void> {
    if (this.refreshInterval) {
      window.clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * Render the dashboard
   */
  async render(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass('reading-dashboard');

    // Add styles
    this.addStyles();

    // Header
    const header = container.createDiv({ cls: 'dashboard-header' });
    header.createEl('h2', { text: 'Reading Dashboard' });

    const refreshBtn = header.createEl('button', {
      text: '↻ Refresh',
      cls: 'dashboard-refresh-btn'
    });
    refreshBtn.addEventListener('click', async () => {
      new Notice('Refreshing dashboard...');
      await this.refreshData();
    });

    // Loading state
    const loadingEl = container.createDiv({ cls: 'dashboard-loading' });
    loadingEl.createEl('p', { text: 'Loading reading data...' });

    try {
      // Auto-sync if no cached books (happens after Obsidian restart)
      if (this.plugin.tracker.getCachedBooks().length === 0) {
        loadingEl.createEl('p', { text: 'Fetching books from Pocketbook Cloud...' });
        try {
          await this.plugin.importer.importHighlights();
        } catch (syncError) {
          console.warn('[Dashboard] Auto-sync failed, using database only:', syncError);
        }
      }

      // Get data
      const stats = await this.plugin.tracker.getDashboardStats();
      const currentlyReading = await this.plugin.tracker.getCurrentlyReadingWithCovers();
      const recentActivity = await this.plugin.tracker.getRecentActivityFeed(5);

      // Get analytics data
      const analytics = await generateReadingAnalytics(
        this.plugin.tracker.getDatabase(),
        this.plugin.settings.estimatedPagesPerBook || 300
      );

      // Remove loading
      loadingEl.remove();

      // Stats Section
      this.renderStatsSection(container, stats);

      // Currently Reading Section
      this.renderCurrentlyReadingSection(container, currentlyReading);

      // Recent Activity Section
      this.renderActivitySection(container, recentActivity);

      // Heatmap Section (GitHub-style contribution graph)
      this.renderHeatmapSection(container, analytics);

      // Reading Statistics Section
      await this.renderReadingStatsSection(container, analytics, stats);

      // Last Sync Info
      const lastSync = await this.plugin.tracker.getLastSync();
      if (lastSync) {
        const syncInfo = container.createDiv({ cls: 'dashboard-sync-info' });
        const syncDate = new Date(lastSync);
        syncInfo.createEl('small', {
          text: `Last synced: ${syncDate.toLocaleString()}`
        });
      }

    } catch (e) {
      loadingEl.empty();
      loadingEl.createEl('p', {
        text: 'Error loading data. Try syncing your highlights first.',
        cls: 'dashboard-error'
      });
      console.error('[Dashboard] Error:', e);
    }
  }

  /**
   * Refresh data by triggering a sync
   */
  private async refreshData(): Promise<void> {
    try {
      await this.plugin.importer.importHighlights();
      await this.render();
    } catch (e) {
      new Notice('Failed to refresh: ' + (e as Error).message);
    }
  }

  /**
   * Render the stats cards section
   */
  private renderStatsSection(container: HTMLElement, stats: DashboardStats): void {
    const section = container.createDiv({ cls: 'dashboard-section' });
    section.createEl('h3', { text: 'Reading Stats' });

    const cardsContainer = section.createDiv({ cls: 'stats-cards' });

    // Library - CLICKABLE (all books)
    const allBooks = this.plugin.tracker.getCachedBooks();
    const libraryCard = this.createStatCard(cardsContainer, {
      value: allBooks.length.toString(),
      label: 'My Library',
      icon: '📚',
      iconType: 'library',
      clickable: true,
    });
    libraryCard.addEventListener('click', () => {
      new LibraryModal(this.app, this.plugin, allBooks).open();
    });

    // Currently Reading
    this.createStatCard(cardsContainer, {
      value: stats.currentlyReading.toString(),
      label: 'Reading Now',
      icon: '📕',
      iconType: 'reading',
    });

    // Pages Today
    this.createStatCard(cardsContainer, {
      value: `~${stats.estimatedPagesToday}`,
      label: 'Pages Today',
      icon: '📄',
      iconType: 'pages',
    });

    // Current Streak
    if (stats.currentStreak > 0) {
      this.createStatCard(cardsContainer, {
        value: `${stats.currentStreak}`,
        label: 'Day Streak',
        icon: '🏆',
        iconType: 'streak',
      });
    }
  }

  /**
   * Create a single stat card
   */
  private createStatCard(
    container: HTMLElement,
    data: { value: string; label: string; icon: string; iconType?: 'library' | 'reading' | 'pages' | 'streak'; clickable?: boolean }
  ): HTMLElement {
    const card = container.createDiv({ cls: 'stat-card' + (data.clickable ? ' stat-card-clickable' : '') });

    // Create icon container
    const iconContainer = card.createDiv({ cls: 'stat-icon-btn' + (data.iconType ? ` stat-icon-${data.iconType}` : '') });

    // Load SVG from vault or fallback to emoji
    if (data.iconType) {
      this.loadStatIconFromVault(iconContainer, data.iconType, data.icon);
    } else {
      iconContainer.textContent = data.icon;
    }

    card.createDiv({ cls: 'stat-value', text: data.value });
    card.createDiv({ cls: 'stat-label', text: data.label });
    return card;
  }

  /**
   * Load SVG icon from vault using path from settings
   */
  private loadStatIconFromVault(container: HTMLElement, type: 'library' | 'reading' | 'pages' | 'streak', fallbackEmoji: string): void {
    const settings = this.plugin.settings;
    const iconPaths: Record<string, string> = {
      library: settings.statIconLibrary || 'Attachments/library.svg',
      reading: settings.statIconReading || 'Attachments/reading_now.svg',
      pages: settings.statIconPages || 'Attachments/pages_today.svg',
      streak: settings.statIconStreak || 'Attachments/streak.svg',
    };

    const filePath = iconPaths[type];

    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file instanceof TFile) {
      const img = container.createEl('img');
      img.src = this.app.vault.getResourcePath(file);
      img.alt = type;
      img.addClass('stat-icon-img');
    } else {
      // Fallback to emoji if file not found
      container.textContent = fallbackEmoji;
    }
  }

  /**
   * Render the currently reading section
   */
  private renderCurrentlyReadingSection(
    container: HTMLElement,
    books: BookWithProgress[]
  ): void {
    const section = container.createDiv({ cls: 'dashboard-section' });
    section.createEl('h3', { text: 'Currently Reading' });

    if (books.length === 0) {
      section.createEl('p', {
        text: 'No books currently being read.',
        cls: 'dashboard-empty'
      });
      return;
    }

    const booksContainer = section.createDiv({ cls: 'books-list-with-covers' });

    for (const book of books) {
      const bookCard = booksContainer.createDiv({ cls: 'book-card-with-cover' });

      // Cover image
      const coverContainer = bookCard.createDiv({ cls: 'book-cover-small' });

      if (book.localCoverPath) {
        const file = this.app.vault.getAbstractFileByPath(book.localCoverPath);
        if (file instanceof TFile) {
          const coverImg = coverContainer.createEl('img');
          coverImg.src = this.app.vault.getResourcePath(file);
          coverImg.alt = book.title;
        } else {
          coverContainer.createEl('span', { text: '📖', cls: 'cover-placeholder' });
        }
      } else if (book.coverUrl) {
        // Download cover on-demand and save to local vault
        this.downloadAndDisplayCover(coverContainer, book.coverUrl, book.title);
      } else {
        coverContainer.createEl('span', { text: '📖', cls: 'cover-placeholder' });
      }

      // Book content (title, author, progress)
      const bookContent = bookCard.createDiv({ cls: 'book-content' });

      // Book info with page count
      const bookInfo = bookContent.createDiv({ cls: 'book-info' });
      const titleRow = bookInfo.createDiv({ cls: 'book-title-row' });
      titleRow.createEl('span', { text: book.title, cls: 'book-title' });

      // Page count editor (subtle)
      const pageCountContainer = titleRow.createDiv({ cls: 'page-count-editor' });
      this.renderPageCountEditor(pageCountContainer, book.bookId, book.title);

      if (book.authors) {
        bookInfo.createEl('div', { text: `by ${book.authors}`, cls: 'book-author' });
      }

      // Progress bar - apply inline styles to override theme
      const progressContainer = bookContent.createDiv({ cls: 'progress-container' });
      // Progress bar - styles moved to class or adjusted here for theme
      const progressBar = progressContainer.createDiv({ cls: 'pocketbook-progress-bar' });
      progressBar.style.cssText = 'flex: 1; height: 12px; background: #3e2b1f !important; border-radius: 6px; overflow: hidden; border: 1px solid #5d4037; position: relative;';

      const progressFill = progressBar.createDiv({ cls: 'pocketbook-progress-fill' });
      // Gold gradient fill
      progressFill.style.cssText = `width: ${book.progress}%; height: 100%; background: linear-gradient(90deg, #b8860b, #d4af37) !important; position: absolute; top: 0; left: 0; border-radius: 5px;`;



      const progressText = progressContainer.createDiv({ cls: 'progress-text' });
      // Show 1 decimal place if it's not a whole number
      const displayProgress = Number.isInteger(book.progress) ? book.progress : book.progress.toFixed(1);

      // Show page info if page count is available (Option A: compact format)
      if (book.pageCount && book.currentPage !== undefined) {
        progressText.setText(`Page ${book.currentPage} of ${book.pageCount} • ${displayProgress}%`);
      } else {
        progressText.setText(`${displayProgress}%`);
      }
    }
  }

  /**
   * Render page count editor (subtle icon that expands to input)
   */
  private async renderPageCountEditor(container: HTMLElement, bookId: string, title: string): Promise<void> {
    const currentPageCount = await this.plugin.tracker.getDatabase().getBookPageCount(bookId);

    // Display current page count or "set pages" hint
    const display = container.createEl('span', {
      cls: 'page-count-display',
      attr: { title: 'Click to set page count' }
    });

    if (currentPageCount) {
      display.setText(`${currentPageCount}p`);
      display.addClass('has-pages');
    } else {
      display.setText('📄');
      display.addClass('no-pages');
    }

    // Click to edit
    display.addEventListener('click', async (e) => {
      e.stopPropagation();

      // Create input
      container.empty();
      const input = container.createEl('input', {
        type: 'number',
        cls: 'page-count-input',
        attr: {
          placeholder: 'pages',
          value: currentPageCount?.toString() || ''
        }
      });
      input.focus();
      input.select();

      const savePageCount = async () => {
        const value = parseInt(input.value);
        if (value && value > 0) {
          await this.plugin.tracker.getDatabase().setBookPageCount(bookId, value);
          await this.plugin.tracker.getDatabase().save();
          new Notice(`Set ${title} to ${value} pages`);
        }
        // Refresh display
        container.empty();
        this.renderPageCountEditor(container, bookId, title);
      };

      input.addEventListener('blur', savePageCount);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          savePageCount();
        } else if (e.key === 'Escape') {
          container.empty();
          this.renderPageCountEditor(container, bookId, title);
        }
      });
    });
  }

  /**
   * Download cover image and display it, saving to local vault
   */
  private async downloadAndDisplayCover(container: HTMLElement, coverUrl: string, title: string): Promise<void> {
    const coversFolder = this.plugin.settings.covers_folder || 'Attachments';
    const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, "");
    const localPath = `${coversFolder}/${sanitizedTitle}.jpg`;

    // Check if already exists locally
    const existingFile = this.app.vault.getAbstractFileByPath(localPath);
    if (existingFile instanceof TFile) {
      const coverImg = container.createEl('img');
      coverImg.src = this.app.vault.getResourcePath(existingFile);
      coverImg.alt = title;
      return;
    }

    // Show loading placeholder while downloading
    const placeholder = container.createEl('span', { text: '⏳', cls: 'cover-placeholder' });

    try {
      // Download the cover
      const response = await fetch(coverUrl);
      if (!response.ok) throw new Error('Failed to download cover');

      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();

      // Ensure folder exists
      const folderExists = this.app.vault.getAbstractFileByPath(coversFolder);
      if (!folderExists) {
        await this.app.vault.createFolder(coversFolder);
      }

      // Save to vault
      await this.app.vault.createBinary(localPath, arrayBuffer);

      // Display the local cover
      const file = this.app.vault.getAbstractFileByPath(localPath);
      if (file instanceof TFile) {
        placeholder.remove();
        const coverImg = container.createEl('img');
        coverImg.src = this.app.vault.getResourcePath(file);
        coverImg.alt = title;
      }
    } catch (error) {
      console.error(`Failed to download cover for ${title}:`, error);
      placeholder.setText('📖');
    }
  }

  /**
   * Render the recent activity section
   */
  private renderActivitySection(container: HTMLElement, activities: string[]): void {
    const section = container.createDiv({ cls: 'dashboard-section' });
    section.createEl('h3', { text: 'Recent Activity' });

    if (activities.length === 0) {
      section.createEl('p', {
        text: 'No recent activity. Start reading!',
        cls: 'dashboard-empty'
      });
      return;
    }

    const activityList = section.createEl('ul', { cls: 'activity-list' });

    for (const activity of activities) {
      activityList.createEl('li', { text: activity });
    }
  }

  /**
   * Render GitHub-style contribution heatmap
   */
  private renderHeatmapSection(container: HTMLElement, analytics: ReadingAnalytics): void {
    const section = container.createDiv({ cls: 'dashboard-section heatmap-section' });
    section.createEl('h3', { text: 'READING HEATMAP', cls: 'dashboard-section-title' });

    // Just render it directly, letting CSS handle scrolling
    this.drawHeatmap(section, analytics);
  }

  private drawHeatmap(container: HTMLElement, analytics: ReadingAnalytics): void {
    const heatmapContainer = container.createDiv({ cls: 'heatmap-container' });

    const today = new Date();
    const year = today.getFullYear();

    heatmapContainer.createDiv({ cls: 'heatmap-year', text: String(year) });

    // Calculate data
    const heatmapData = getHeatmapData(analytics.dailyPages);

    // Always show full year (53 weeks)
    const weeksToShow = 53;

    // Determine displayed month range for labels
    // We just want unique months from the data to list them
    const uniqueMonths: string[] = [];
    if (heatmapData.length > 0) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let lastMonth = -1;

      heatmapData.forEach(d => {
        const date = new Date(d.date);
        const m = date.getMonth();
        if (m !== lastMonth) {
          uniqueMonths.push(monthNames[m]);
          lastMonth = m;
        }
      });
    }

    // Months header
    const monthsRow = heatmapContainer.createDiv({ cls: 'heatmap-months' });
    uniqueMonths.forEach(m => monthsRow.createEl('span', { text: m }));

    // Days of week column
    const daysCol = heatmapContainer.createDiv({ cls: 'heatmap-days' });
    ['', 'Mon', '', 'Wed', '', 'Fri', ''].forEach(d => daysCol.createEl('span', { text: d }));

    // Boxes grid
    const boxesContainer = heatmapContainer.createDiv({ cls: 'heatmap-boxes' });

    // Grid columns
    boxesContainer.style.gridTemplateColumns = `repeat(${weeksToShow}, 10px)`;
    // Always 7 rows
    boxesContainer.style.gridTemplateRows = 'repeat(7, 10px)';

    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Calculate offset based on the first day in data
    const firstDayDate = new Date(heatmapData[0].date);
    const dayOfWeek = firstDayDate.getDay(); // 0 = Sunday

    // Add empty boxes if the start doesn't align with top row (Sunday)
    for (let i = 0; i < dayOfWeek; i++) {
      const emptyBox = boxesContainer.createDiv({ cls: 'heatmap-box empty' });
      emptyBox.style.backgroundColor = 'transparent';
    }

    heatmapData.forEach(day => {
      const box = boxesContainer.createDiv({ cls: 'heatmap-box' });
      const isToday = day.date === todayStr;

      let color = 'var(--background-modifier-border)';
      if (day.pages > 0) {
        if (day.pages >= 50) color = '#22c55e';
        else if (day.pages >= 30) color = '#4ade80';
        else if (day.pages >= 15) color = '#86efac';
        else color = '#bbf7d0';
      }

      box.style.backgroundColor = color;
      if (isToday) box.classList.add('today');
      box.title = `${day.date}: ${day.pages} pages`;
    });
  }

  /**
   * Render reading statistics section
   */
  private async renderReadingStatsSection(container: HTMLElement, analytics: ReadingAnalytics, stats: DashboardStats): Promise<void> {
    const section = container.createDiv({ cls: 'dashboard-section reading-stats-section' });
    section.createEl('h3', { text: 'READING STATISTICS', cls: 'dashboard-section-title' });
    section.createEl('div', { text: 'Last 30 Days', cls: 'stats-subtitle' });

    const statsGrid = section.createDiv({ cls: 'reading-stats-grid' });

    // Total Pages (30 days)
    const totalPagesCard = statsGrid.createDiv({ cls: 'stat-card' });
    totalPagesCard.createDiv({ cls: 'stat-label', text: 'Total Pages' });
    totalPagesCard.createDiv({ cls: 'stat-value', text: String(analytics.totalPages30Days) });

    // Best Day
    const bestDayCard = statsGrid.createDiv({ cls: 'stat-card' });
    bestDayCard.createDiv({ cls: 'stat-label', text: 'Best Day' });
    const bestDayValue = bestDayCard.createDiv({ cls: 'stat-value' });
    bestDayValue.createEl('span', { text: String(analytics.bestDayPages) });
    bestDayValue.createEl('span', { cls: 'stat-unit', text: ' pages' });

    // Trend
    const trendCard = statsGrid.createDiv({ cls: 'stat-card' });
    trendCard.createDiv({ cls: 'stat-label', text: 'Trend' });
    const trendValue = trendCard.createDiv({ cls: 'stat-value trend' });
    const trendPercent = analytics.trendPercent;
    const trendIcon = trendPercent >= 0 ? '↗' : '↘';
    const trendClass = trendPercent >= 0 ? 'positive' : 'negative';
    trendValue.classList.add(trendClass);
    trendValue.createEl('span', { text: `${trendIcon} ${Math.abs(trendPercent).toFixed(1)}%` });
    trendValue.createEl('span', { cls: 'trend-label', text: ' vs last 30d' });

    // Monthly Goal Progress -> Changed to Year Goal
    const goalCard = statsGrid.createDiv({ cls: 'stat-card goal-card' });
    const yearlyGoal = this.plugin.settings.yearlyGoal || 20;

    // Fetch count strictly for the current year from the database
    // This ensures that next year it will reset to 0.
    const yearBooksCount = await this.plugin.tracker.getDatabase().getBooksFinishedInYear(new Date().getFullYear());

    goalCard.createDiv({ cls: 'stat-label', text: `${new Date().getFullYear()} Reading Goal` });

    const goalProgress = goalCard.createDiv({ cls: 'goal-progress' });
    const goalPercent = Math.min((yearBooksCount / yearlyGoal) * 100, 100);

    goalProgress.createDiv({ cls: 'goal-text', text: `${yearBooksCount} / ${yearlyGoal} books` });

    const goalBar = goalProgress.createDiv({ cls: 'goal-bar' });
    // Override standard style just in case
    goalBar.style.cssText = 'width: 100%; height: 8px; background: #3e2b1f; border-radius: 4px; overflow: hidden; border: 1px solid #5d4037;';

    const goalFill = goalBar.createDiv({ cls: 'goal-fill' });
    goalFill.style.cssText = `width: ${goalPercent}%; height: 100%; background: linear-gradient(90deg, #b8860b, #d4af37); border-radius: 4px;`;

    // Random Highlight Card (Full width below stats)
    const highlight = await this.plugin.tracker.getRandomHighlight();
    if (highlight) {
      const highlightSection = container.createDiv({ cls: 'dashboard-section highlight-section' });
      highlightSection.createEl('h3', { text: 'Spark of Memory' });

      // Clean implementation without inline styles - mostly handled by CSS
      const highlightCard = highlightSection.createDiv({ cls: 'stat-card highlight-card' });

      // Navigate to book on click
      highlightCard.addClass('stat-card-clickable');
      highlightCard.addEventListener('click', () => {
        // Find the book helper to open it
        // We might not have the book object here easily, but we have the ISBN/Title from highlight maybe?
        // Actually highlight object structure depends on tracker.
        // For now just keep simple display
      });

      const quoteEl = highlightCard.createEl('blockquote');
      quoteEl.setText(`"${highlight.text}"`);

      const sourceEl = highlightCard.createDiv({ cls: 'highlight-source' });
      const citation = highlight.title ? `— ${highlight.title}` : '— Unknown Source';
      sourceEl.createEl('em', { text: citation });
      sourceEl.style.marginTop = '10px';
      sourceEl.style.textAlign = 'right';
      sourceEl.style.color = '#a89f91'; // Muted gold/tan
      sourceEl.style.display = 'flex';
      sourceEl.style.justifyContent = 'flex-end';
      sourceEl.style.fontSize = '0.85em';

      const link = sourceEl.createEl('a', {
        text: `— ${highlight.title}`,
        href: highlight.path
      });
      link.style.color = 'var(--text-muted)';

      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.app.workspace.openLinkText(highlight.path, '', true);
      });
    }
  }

  /**
   * Add dashboard styles
   */
  private addStyles(): void {
    // Styles are now managed in styles.css for the "Librarish" theme
  }
}

