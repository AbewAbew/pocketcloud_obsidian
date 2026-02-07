import { Plugin, Notice, TFile } from 'obsidian';
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

    // Apply theme (bookshelf texture)
    await this.applyTheme();
  }

  async onunload() {
    await this.saveCache();

    // Clean up reading tracker (stop file watcher)
    if (this.tracker) {
      this.tracker.destroy();
    }

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

    // Re-apply theme
    await this.applyTheme();
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
   * Apply theme settings (bookshelf texture)
   * Loads custom texture from vault or uses the default CSS texture
   */
  async applyTheme() {
    const root = document.documentElement;

    if (this.settings.useDefaultBookshelfTexture) {
      // Remove custom texture, let CSS use the default from :root
      root.style.removeProperty('--wood-texture');
      console.log('[Pocketbook] Using default bookshelf texture');
    } else if (this.settings.bookshelfTexture) {
      // Load custom texture from vault
      try {
        const texturePath = this.settings.bookshelfTexture;
        const file = this.app.vault.getAbstractFileByPath(texturePath);

        if (file instanceof TFile) {
          const arrayBuffer = await this.app.vault.readBinary(file);
          const base64 = this.arrayBufferToBase64(arrayBuffer);
          const mimeType = this.getMimeType(file.extension);
          const dataUri = `url('data:${mimeType};base64,${base64}')`;

          root.style.setProperty('--wood-texture', dataUri);
          console.log('[Pocketbook] Applied custom bookshelf texture:', texturePath);
        } else {
          console.warn('[Pocketbook] Texture file not found:', texturePath);
          // Fall back to default
          root.style.removeProperty('--wood-texture');
        }
      } catch (e) {
        console.error('[Pocketbook] Failed to load custom texture:', e);
        root.style.removeProperty('--wood-texture');
      }
    } else {
      // No texture selected - use solid color (remove the texture)
      root.style.setProperty('--wood-texture', 'none');
      console.log('[Pocketbook] Bookshelf texture disabled (solid color)');
    }

    // Load leather texture
    await this.loadTextureAsVariable(root, this.settings.leatherTexture, '--leather-texture');

    // Load parchment texture
    await this.loadTextureAsVariable(root, this.settings.parchmentTexture, '--parchment-texture');
  }

  /**
   * Load a vault image as a CSS custom property (data URI)
   */
  private async loadTextureAsVariable(root: HTMLElement, vaultPath: string, cssVar: string): Promise<void> {
    if (!vaultPath) {
      root.style.setProperty(cssVar, 'none');
      return;
    }
    try {
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (file instanceof TFile) {
        const arrayBuffer = await this.app.vault.readBinary(file);
        const base64 = this.arrayBufferToBase64(arrayBuffer);
        const mimeType = this.getMimeType(file.extension);
        const dataUri = `url('data:${mimeType};base64,${base64}')`;
        root.style.setProperty(cssVar, dataUri);
        console.log(`[Pocketbook] Applied texture ${cssVar}:`, vaultPath);
      } else {
        console.warn(`[Pocketbook] Texture file not found for ${cssVar}:`, vaultPath);
        root.style.setProperty(cssVar, 'none');
      }
    } catch (e) {
      console.error(`[Pocketbook] Failed to load texture for ${cssVar}:`, e);
      root.style.setProperty(cssVar, 'none');
    }
  }

  /**
   * Convert ArrayBuffer to base64 string
   */
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(extension: string): string {
    const mimeTypes: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
    };
    return mimeTypes[extension.toLowerCase()] || 'image/jpeg';
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
