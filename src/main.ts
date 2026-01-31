import { Plugin, Notice } from 'obsidian';
import { PocketbookCloudHighlightsImporter } from './import';
import { DEFAULT_SETTINGS, PocketbookCloudHighlightsImporterPluginSettings, PocketbookCloudHighlightsImporterSettingTab } from './settings';
import { ReadingTracker } from './tracker/ReadingTracker';
import { DashboardView, DASHBOARD_VIEW_TYPE } from './views/DashboardView';
import { PrefetchService } from './services/PrefetchService';
import { GoodreadsClient } from './goodreads';

export default class PocketbookCloudHighlightsImporterPlugin extends Plugin {
  settings: PocketbookCloudHighlightsImporterPluginSettings;
  importer: PocketbookCloudHighlightsImporter;
  tracker: ReadingTracker;
  goodreads: GoodreadsClient; // Shared Instance
  prefetchService: PrefetchService;
  private statusBarItem: HTMLElement | null = null;

  private syncIntervalId: number | null = null;





  async onload() {
    await this.loadSettings();

    // Initialize Goodreads Client (Shared)
    this.goodreads = new GoodreadsClient(this.app, this);

    // Load Cache (Search Index)
    await this.goodreads.loadSearchIndex();



    this.importer = new PocketbookCloudHighlightsImporter(this.app, this, this.settings);
    this.tracker = new ReadingTracker(this.app, this);
    this.prefetchService = new PrefetchService(this.app, this);

    // Initialize tracker
    await this.tracker.initialize();

    // Trigger prefetch after a short startup delay
    this.app.workspace.onLayoutReady(async () => {
      // Wait 5s for Obsidian to settle
      await new Promise(r => setTimeout(r, 5000));
      this.triggerLibraryPrefetch();
    });

    // Configure Auto Sync
    this.configureAutoSync();

    // Register dashboard view
    this.registerView(
      DASHBOARD_VIEW_TYPE,
      (leaf) => new DashboardView(leaf, this)
    );

    // Command: Import highlights & notes
    this.addCommand({
      id: 'perform-import',
      name: 'Import highlights & notes',
      callback: () => {
        this.importer.importHighlights();
      },
    });

    // Command: Open Reading Dashboard
    this.addCommand({
      id: 'open-reading-dashboard',
      name: 'Open Reading Dashboard',
      callback: () => {
        this.activateDashboardView();
      },
    });

    // Command: Clear Recent Activity
    this.addCommand({
      id: 'clear-reading-activity',
      name: 'Clear Recent Activity Log',
      callback: async () => {
        await this.tracker.getDatabase().clearActivities();
        new Notice('Recent activity cleared!');
      },
    });

    // Command: Reset All Tracking Data
    this.addCommand({
      id: 'reset-tracking-data',
      name: 'Reset All Tracking Data',
      callback: async () => {
        await this.tracker.getDatabase().resetAll();
        new Notice('All tracking data has been reset!');
      },
    });

    // Add ribbon icon for dashboard
    this.addRibbonIcon('book-open', 'Reading Dashboard', () => {
      this.activateDashboardView();
    });

    // Add status bar item for streak (if enabled)
    if (this.settings.showStatusBarStreak) {
      this.statusBarItem = this.addStatusBarItem();
      this.updateStatusBar();
    }

    // This adds a settings tab so the user can configure various aspects of the plugin
    this.addSettingTab(new PocketbookCloudHighlightsImporterSettingTab(this.app, this));
  }

  async onunload() {
    await this.saveCache();

    // Clean up dashboard view
    this.app.workspace.detachLeavesOfType(DASHBOARD_VIEW_TYPE);
  }

  async saveCache() {
    if (this.goodreads) {
      // Only need to save the index periodically or on close
      // Book data is saved immediately when fetched
      await this.goodreads.saveSearchIndex();
    }
  }

  /**
   * Activate the dashboard view in the right sidebar
   */
  async activateDashboardView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE)[0];

    if (!leaf) {
      // Create new leaf in right sidebar
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Update the status bar with current streak info
   */
  async updateStatusBar() {
    if (!this.statusBarItem) return;

    try {
      const text = await this.tracker.getStatusBarText();
      this.statusBarItem.setText(text);
    } catch (e) {
      this.statusBarItem.setText('📚');
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // this gets serialized as a string under the hood - this is to restore it to a Date object
    this.settings.access_token_valid_until = new Date(this.settings.access_token_valid_until);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.importer = new PocketbookCloudHighlightsImporter(this.app, this, this.settings);
    this.tracker = new ReadingTracker(this.app, this);
    await this.tracker.initialize();

    // Update status bar visibility
    if (this.settings.showStatusBarStreak && !this.statusBarItem) {
      this.statusBarItem = this.addStatusBarItem();
      this.updateStatusBar();
    } else if (!this.settings.showStatusBarStreak && this.statusBarItem) {
      this.statusBarItem.remove();
      this.statusBarItem = null;
    }

    // Reconfigure Auto Sync
    this.configureAutoSync();


  }

  /**
   * Configure automatic sync based on settings
   */
  configureAutoSync() {
    // Clear existing interval
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    if (this.settings.enableAutoSync) {
      const minutes = this.settings.autoSyncInterval || 60;
      const intervalMs = Math.max(minutes, 1) * 60 * 1000; // Minimum 1 minute

      console.log(`[Pocketbook] Auto-sync enabled. Interval: ${minutes} minutes (${intervalMs}ms)`);

      this.syncIntervalId = window.setInterval(() => {
        console.log('[Pocketbook] Running auto-sync...');
        this.importer.importHighlights().catch(err => {
          console.error('[Pocketbook] Auto-sync failed:', err);
        });
      }, intervalMs);

      // Register interval so it's cleared on plugin unload
      this.registerInterval(this.syncIntervalId);
    } else {
      console.log('[Pocketbook] Auto-sync disabled');
    }
  }



  /**
   * Fetch library books and queue them for metadata pre-fetching
   */
  async triggerLibraryPrefetch() {
    try {
      console.log('[Pocketbook] Triggering library prefetch...');
      // We use the API client directly to get the list
      const books = await this.importer.api_client.getBooks();
      console.log(`[Pocketbook] Found ${books.length} books for prefetch.`);

      // Add random subset or first N books to queue
      // Usually getBooks returns them in some order (often created_at desc or asc).
      // Let's take the top 100 easiest to reach.
      const limit = Math.min(books.length, 100);

      for (let i = 0; i < limit; i++) {
        const book = books[i];
        let author = 'Unknown';
        if (book.metadata?.authors) {
          author = Array.isArray(book.metadata.authors) ? book.metadata.authors[0] : book.metadata.authors;
        }

        // Priority 1 for background
        this.prefetchService.addToQueue(book.title, author, 1);
      }
    } catch (e) {
      console.warn('[Pocketbook] Prefetch failed to get library:', e);
    }
  }
}
