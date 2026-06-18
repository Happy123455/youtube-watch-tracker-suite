# YouTube Watch Tracker Web App

This is a visually stunning, premium client-side web application version of the YouTube Watch Tracker Dashboard. It allows you to import and visualize your watch histories, analyze repeated watch patterns, view search queries, track serviced ads, and view a visual calendar activity heatmap.

## Privacy & Security Posture
* **100% Client-Side**: All parsing, filtering, and data visualizations happen directly inside your web browser.
* **No Database/Backend**: Your watch history is stored locally in your browser's `localStorage` and never leaves your computer, guaranteeing total privacy.

---

## Free Hosting Guide

Since this is a client-side static site (built with pure HTML/CSS/JS), it can be hosted completely for free. Here are three ways to deploy it in minutes:

### Option 1: Netlify Drag-and-Drop (Easiest, No Git or CLI Required!)
1. Open [Netlify Drop](https://app.netlify.com/drop) in your browser.
2. Drag and drop the complete `yt-tracker-web` folder containing `index.html`, `styles.css`, `index.js`, and `demo-data.js` into the upload zone.
3. Within 5 seconds, Netlify will generate a live URL for your website!
4. (Optional) Register a free Netlify account to customize the subdomain name.

### Option 2: Vercel CLI (For developers)
1. Open your terminal in the `yt-tracker-web` directory.
2. Run the deployment command (requires a free Vercel account):
   ```bash
   npx vercel --prod
   ```
3. Follow the quick terminal prompts to deploy. Vercel will build and output your production URL.

### Option 3: GitHub Pages
1. Push the contents of the `yt-tracker-web` directory to a new public GitHub repository.
2. Go to repository **Settings** -> **Pages**.
3. Under **Build and deployment**, set Source to **Deploy from a branch** and select your main/master branch, then click Save.
4. Your website will be live at `https://your-username.github.io/your-repository-name/` in a minute.

---

## Running Locally

To run the application locally on your computer without hosting:
1. Double-click the `index.html` file inside the `yt-tracker-web` directory.
2. It will open in your default web browser and run instantly!
3. Click the **Load Demo Data** button at the top right to view a fully populated sample dashboard.
