# YouTube Watch Tracker Dashboard - Obsidian Plugin

This plugin displays a premium glassmorphic dashboard of your YouTube watch history and annual watch activity heatmap natively inside Obsidian.

## Installation

Since this is a custom plugin, follow these steps to install it in your vault:

1. Locate your Obsidian vault directory on your computer.
2. Ensure hidden folders are visible, and navigate to `.obsidian/plugins/`.
3. Create a new directory named `yt-watch-tracker` inside the `plugins` folder.
4. Copy the following three files from this folder into `.obsidian/plugins/yt-watch-tracker/`:
   - `manifest.json`
   - `main.js`
   - `styles.css`
5. Open Obsidian, go to **Settings** > **Community plugins**, and click the refresh reload icon.
6. Enable **YouTube Watch Tracker Dashboard** from the list of installed plugins.

## How to Setup and Import Data

1. Click the **YouTube Play Ribbon Icon** on the left side of Obsidian to open the Dashboard.
2. In the **Import History** section on the left column, click **Import JSON File**.
3. Choose the watch history JSON file exported from your Chrome extension (or Google Takeout) to sync your watch logs directly into your vault file (saved as `yt-history.json` by default).
4. The dashboard will instantly update, showing your calendar heatmap, rewatch statistics, and history items!

## Daily Note Integration

- Use the **Obsidian Daily Log Copy** buttons to copy today's / yesterday's activity directly into markdown logs.
- Click **Append Today to Active File** to instantly insert today's watch activity at the bottom of your currently active Obsidian note.
