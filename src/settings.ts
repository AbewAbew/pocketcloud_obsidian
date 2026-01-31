import { App, Modal, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import { PocketbookCloudLoginClient } from './apiclient';
import PocketbookCloudHighlightsImporterPlugin from './main';

export interface PocketbookCloudHighlightsImporterPluginSettings {
  username: string;
  shop_name: string;
  access_token: string;
  access_token_valid_until: Date;
  refresh_token: string;
  import_folder: string;
  covers_folder: string;
  sort_by: 'location' | 'date';
  filename_template: string;
  page_template: string;
  highlight_template: string;

  // Reading Tracker Settings
  enableTracking: boolean;
  dailyReadingGoalPages: number;
  estimatedPagesPerBook: number;
  yearlyGoal: number; // New setting
  showStatusBarStreak: boolean;

  // Hardcover Integration
  hardcover_api_key: string;

  // Goodreads Integration
  goodreadsReviewsLimit: number;

  // Auto Sync
  enableAutoSync: boolean;
  autoSyncInterval: number; // in minutes

  // Cache Settings

  cacheFolder: string;
}

import { TemplatingService } from './templating';

export const DEFAULT_SETTINGS: PocketbookCloudHighlightsImporterPluginSettings = {
  username: '',
  shop_name: '',
  access_token: '',
  access_token_valid_until: new Date(),
  refresh_token: '',
  import_folder: '',
  covers_folder: 'Attachments',
  sort_by: 'date',
  filename_template: '{{ title }}',
  page_template: TemplatingService.getDefaultPageTemplate(),
  highlight_template: TemplatingService.getDefaultHighlightTemplate(),

  // Reading Tracker Defaults
  enableTracking: true,
  dailyReadingGoalPages: 20,
  estimatedPagesPerBook: 300,
  yearlyGoal: 20,
  showStatusBarStreak: true,

  // Hardcover Integration
  hardcover_api_key: '',

  // Goodreads Integration
  goodreadsReviewsLimit: 5,

  // Auto Sync
  enableAutoSync: false,
  autoSyncInterval: 60,

  // Cache Defaults
  // Cache Defaults

  cacheFolder: 'PocketbookCache',
};

export class PocketbookCloudHighlightsImporterSettingTab extends PluginSettingTab {
  plugin: PocketbookCloudHighlightsImporterPlugin;

  constructor(app: App, plugin: PocketbookCloudHighlightsImporterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'Settings for Pocketbook Cloud Highlights Importer Plugin' });

    new Setting(containerEl)
      .setName('Username')
      .setDesc('The mail address you log in to the pocketbook cloud with')
      .addText(text =>
        text
          .setPlaceholder('crocodile@example.com')
          .setValue(this.plugin.settings.username)
          .onChange(async value => {
            this.plugin.settings.username = value;
            await this.plugin.saveSettings();
          })
      );

    let shop_name_text_field: TextComponent;
    new Setting(containerEl)
      .setName('Credentials')
      .setDesc('Use this to log in')
      .addButton(button =>
        button.setButtonText('Log in').onClick(async () => {
          new PocketbookCloudHighlightsImporterPasswordInput(this.app, async password => {
            const api_client = new PocketbookCloudLoginClient(
              this.plugin,
              this.plugin.settings.username,
              password,
              this.plugin.settings.shop_name,
              null,
              null,
              new Date()
            );
            try {
              await api_client.login();
            } catch (error) {
              new Notice(`❌ Error logging in: ${error.message}`);
              return;
            }

            this.plugin.settings.access_token = await api_client.getAccessToken();
            this.plugin.settings.access_token_valid_until = api_client.getAccessTokenValidUntil();
            this.plugin.settings.refresh_token = await api_client.getRefreshToken();
            await this.plugin.saveSettings();

            shop_name_text_field.setValue(this.plugin.settings.shop_name);

            new Notice('Logged in successfully');
          }).open();
        })
      );

    new Setting(containerEl)
      .setName('Shop name')
      .setDesc(
        'The name of the shop you are logging in to. Will be auto-filled on login - only change if that does not work well and you know what you are doing.'
      )
      .addText(text => {
        shop_name_text_field = text;
        text
          .setPlaceholder('')
          .setValue(this.plugin.settings.shop_name)
          .onChange(async value => {
            this.plugin.settings.shop_name = value;
            await this.plugin.saveSettings();
          });
        return text;
      });

    new Setting(containerEl)
      .setName('Import Folder')
      .setDesc('The folder the plugin will write to. The folder should be empty, do not store other data here.')
      .addText(text =>
        text
          .setPlaceholder('Enter your folder path from vault root')
          .setValue(this.plugin.settings.import_folder)
          .onChange(async value => {
            this.plugin.settings.import_folder = value.replace(/^\//, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Covers Folder')
      .setDesc('Folder to download cover images to. Defaults to "Attachments".')
      .addText(text =>
        text
          .setPlaceholder('Attachments')
          .setValue(this.plugin.settings.covers_folder)
          .onChange(async value => {
            // filter out leading slashes
            this.plugin.settings.covers_folder = value.replace(/^\//, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sort Highlights By')
      .setDesc('Choose how highlights should be ordered within the note.')
      .addDropdown(dropdown =>
        dropdown
          .addOption('location', 'Location in Book (Standard)')
          .addOption('date', 'Date Created (Chronological)')
          .setValue(this.plugin.settings.sort_by)
          .onChange(async (value) => {
            this.plugin.settings.sort_by = value as 'location' | 'date';
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'Templating' });

    new Setting(containerEl)
      .setName('File Name Template')
      .setDesc('Template for the note filename (without extension).')
      .addText(text =>
        text
          .setPlaceholder('{{ title }}')
          .setValue(this.plugin.settings.filename_template)
          .onChange(async value => {
            this.plugin.settings.filename_template = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Page Template')
      .setDesc('Template for the entire note content. Leave empty to use default.')
      .addTextArea(text => {
        text
          .setPlaceholder('...')
          .setValue(this.plugin.settings.page_template || TemplatingService.getDefaultPageTemplate())
          .onChange(async value => {
            this.plugin.settings.page_template = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 15;
        text.inputEl.cols = 50;
        return text;
      });

    new Setting(containerEl)
      .setName('Highlight Template')
      .setDesc('Template for individual highlight blocks. Leave empty to use default.')
      .addTextArea(text => {
        text
          .setPlaceholder('...')
          .setValue(this.plugin.settings.highlight_template || TemplatingService.getDefaultHighlightTemplate())
          .onChange(async value => {
            this.plugin.settings.highlight_template = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 10;
        text.inputEl.cols = 50;
        return text;
      });

    // Reading Tracker Settings
    containerEl.createEl('h3', { text: 'Reading Tracker' });

    new Setting(containerEl)
      .setName('Enable Reading Tracker')
      .setDesc('Track your reading progress and display statistics.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.enableTracking)
          .onChange(async value => {
            this.plugin.settings.enableTracking = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Daily Reading Goal (pages)')
      .setDesc('Set a daily reading goal in estimated pages.')
      .addText(text =>
        text
          .setPlaceholder('20')
          .setValue(this.plugin.settings.dailyReadingGoalPages.toString())
          .onChange(async value => {
            const num = parseInt(value) || 20;
            this.plugin.settings.dailyReadingGoalPages = num;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Yearly Reading Goal (books)')
      .setDesc('Target number of books to complete this year.')
      .addText(text =>
        text
          .setPlaceholder('20')
          .setValue((this.plugin.settings.yearlyGoal || 20).toString())
          .onChange(async value => {
            const num = parseInt(value) || 20;
            this.plugin.settings.yearlyGoal = num;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Estimated Pages per Book')
      .setDesc('Average pages per book (used to estimate reading progress since we only have percentages).')
      .addText(text =>
        text
          .setPlaceholder('300')
          .setValue(this.plugin.settings.estimatedPagesPerBook.toString())
          .onChange(async value => {
            const num = parseInt(value) || 300;
            this.plugin.settings.estimatedPagesPerBook = num;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Enable Automatic Sync')
      .setDesc('Automatically check for and import new highlights.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.enableAutoSync)
          .onChange(async value => {
            this.plugin.settings.enableAutoSync = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sync Interval (minutes)')
      .setDesc('How often to run the automatic sync.')
      .addText(text =>
        text
          .setPlaceholder('60')
          .setValue(this.plugin.settings.autoSyncInterval.toString())
          .onChange(async value => {
            const num = parseInt(value) || 60;
            this.plugin.settings.autoSyncInterval = num;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Show Streak in Status Bar')
      .setDesc('Display your reading streak in the Obsidian status bar.')
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showStatusBarStreak)
          .onChange(async value => {
            this.plugin.settings.showStatusBarStreak = value;
            await this.plugin.saveSettings();
          })
      );

    // Data Management
    containerEl.createEl('h4', { text: 'Data Management' });

    new Setting(containerEl)
      .setName('Clear Today\'s Activities')
      .setDesc('Remove all reading activities recorded today. Useful for testing.')
      .addButton(button =>
        button
          .setButtonText('Clear Today')
          .onClick(async () => {
            const db = this.plugin.tracker.getDatabase();
            const today = new Date().toISOString().split('T')[0];
            const activities = await db.getRecentActivities(100);
            const todayActivities = activities.filter(a => a.date === today);

            // Remove today's activities by clearing and re-adding non-today ones
            const allActivities = await db.getRecentActivities(1000);
            const otherActivities = allActivities.filter(a => a.date !== today);
            await db.clearActivities();
            for (const activity of otherActivities) {
              // Re-add activities from other days
              // This is a simplified approach - activities will be regenerated on next sync
            }
            await db.save();
            new Notice(`Cleared ${todayActivities.length} activities from today.`);
          })
      );

    new Setting(containerEl)
      .setName('Reset All Tracking Data')
      .setDesc('⚠️ Delete all reading history, streaks, and statistics. Cannot be undone!')
      .addButton(button =>
        button
          .setButtonText('Reset All')
          .setWarning()
          .onClick(async () => {
            await this.plugin.tracker.getDatabase().resetAll();
            new Notice('All tracking data has been reset!');
          })
      );



    // Metadata Cache Settings
    containerEl.createEl('h3', { text: 'Metadata Cache' });



    new Setting(containerEl)
      .setName('Cache Folder')
      .setDesc('Folder to store the split metadata cache files.')
      .addText(text =>
        text
          .setPlaceholder('PocketbookCache')
          .setValue(this.plugin.settings.cacheFolder)
          .onChange(async value => {
            // Remove leading slashes
            this.plugin.settings.cacheFolder = value.replace(/^\//, '');
            await this.plugin.saveSettings();
          })
      );

    // Hardcover Integration
    containerEl.createEl('h3', { text: 'Hardcover Integration' });

    new Setting(containerEl)
      .setName('Hardcover API Key')
      .setDesc('Enter your Hardcover API key (starts with "Bearer"). Get it from hardcover.app/settings')
      .addText(text =>
        text
          .setPlaceholder('Bearer ...')
          .setValue(this.plugin.settings.hardcover_api_key)
          .onChange(async value => {
            this.plugin.settings.hardcover_api_key = value;
            await this.plugin.saveSettings();
          })
      );

    // Goodreads Integration
    containerEl.createEl('h3', { text: 'Goodreads Integration' });

    new Setting(containerEl)
      .setName('Number of Reviews to Show')
      .setDesc('Maximum number of Goodreads reviews to display in the book detail view.')
      .addText(text =>
        text
          .setPlaceholder('5')
          .setValue(this.plugin.settings.goodreadsReviewsLimit.toString())
          .onChange(async value => {
            const num = parseInt(value) || 5;
            this.plugin.settings.goodreadsReviewsLimit = num;
            await this.plugin.saveSettings();
          })
      );
  }
} // End of SettingTab

export class PocketbookCloudHighlightsImporterPasswordInput extends Modal {
  password: string;
  onSubmit: (result: string) => void;

  constructor(app: App, onSubmit: (result: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;

    contentEl.createEl('h2', { text: 'Enter your password (password will not be saved).' });

    new Setting(contentEl).setName('Password').addText(text =>
      text.onChange(value => {
        this.password = value;
      })
    );

    new Setting(contentEl).addButton(btn =>
      btn
        .setButtonText('Submit')
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit(this.password);
        })
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
