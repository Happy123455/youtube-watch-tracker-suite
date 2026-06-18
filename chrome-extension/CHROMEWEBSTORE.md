# Chrome Web Store Listing - WatchTree

This file compiles all metadata, store listings, and review disclosures required for publishing the **WatchTree: YouTube Watch Tracker & Obsidian Linker** extension on the Chrome Web Store.

---

## 1. Store Listing Details

* **Product Name**: WatchTree: YouTube Watch Tracker & Obsidian Linker
* **Summary (Max 150 chars)**: Automatically track YouTube videos you watch with gorgeous 1-year calendars, search, and instant Markdown copy logs for Obsidian daily notes.
* **Detailed Description**:
  Have you ever stumbled upon a YouTube video and wondered, "When did I watch this?" Or do you manually copy-paste YouTube links into your Obsidian daily journal, which gets tiring and tedious?
  
  WatchTree solves these problems by automatically and privately tracking your YouTube watch history and integrating visually directly into YouTube.
  
  ### Key Features:
  * **In-Page Watch Heatmap**: Adds a native "Watch History" button directly on YouTube video pages. Clicking it reveals a gorgeous 1-year contribution-style calendar highlighting precisely which days you watched that specific video in the past.
  * **Centralized Dashboard**: Open the extension popup to see your overall annual watch activity heatmap, representing the volume of videos watched daily (just like GitHub contribution blocks!).
  * **Obsidian Integration**: Quick-copy buttons let you copy the current video or all videos watched "Today" or "Yesterday" as beautifully pre-formatted Markdown bullet points (e.g. `- [ ] [Title](URL) - Channel (watched at HH:MM)`), ready to paste straight into your Obsidian daily notes.
  * **Private Search Engine**: Instantly search through your complete watched video database by title or channel name.
  * **Full History Export**: Download your entire structured watch log as a clean chronological Markdown file (`.md`) at any time.
  * **100% Private & Local**: Your history never leaves your device. No cloud storage, no analytics trackers, no accounts needed.

* **Category**: Productivity / Developer Tools
* **Languages**: English (United States)

---

## 2. Permissions Justifications

WatchTree requests only the minimum required set of permissions to function. All data is managed locally.

| Permission | Technical Requirement | Plain-English Review Justification |
|------------|-----------------------|-----------------------------------|
| `storage` | Stores watch logs and video metadata. | Needed to save watch history logs (video IDs, titles, channels, and watch timestamps) locally on the user's browser. |
| `tabs` | Reads current URL, tab title, and page state. | Needed to fetch the title, channel name, and duration of the YouTube video currently open in the active tab. |
| `webNavigation` | Triggers on history state updates. | Needed to detect dynamic, single-page navigation transitions on youtube.com, ensuring new videos are tracked accurately without requiring a page reload. |

---

## 3. Privacy & Data Use Disclosure

* **Data Collected**:
  * **History & Activity**: Specifically, YouTube video IDs, titles, channel names, duration, and timestamps of when the video was watched.
* **Data Transmission**:
  * **Zero Transmission**: The extension does **not** transmit any collected data to external servers. All data is stored purely in the local browser profile using the standard `chrome.storage.local` API.
* **Security & Usage**:
  * The collected data is used exclusively to display watch heatmaps, power the search function, and format logs for Obsidian copy actions. It is never sold, shared, or analyzed by third parties.

---

## 4. Screenshot Specs

To submit to the Chrome Web Store, prepare at least two screenshots at the following dimensions:
1. **YouTube Video Page Overlay**: Displaying the injected calendar modal next to the video description (1280x800px).
2. **Extension Dashboard Popup**: Showing the overall contribution calendar, quick copy tools, and search engine (1280x800px).

---

## 5. Version History

### Version 1.0.0
* **Date**: May 31, 2026
* **Changes**:
  * Initial Release.
  * Implemented watch logging with a 10-second active watch confirmation filter.
  * Injected watch calendar widget directly onto YouTube video page actions row.
  * Developed extension popup with overall watch heatmap, search filter, and Obsidian quick-copy capabilities.
  * Created markdown file history exporter.
