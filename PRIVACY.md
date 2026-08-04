# Privacy Policy — GitHub Git Notes Viewer

**Last updated:** August 4, 2026

## What this extension does

GitHub Git Notes Viewer displays git notes inline on GitHub commit pages, both on github.com and on any GitHub Enterprise Server (GHES) host you explicitly enable. It fetches note content directly from the host you're viewing and renders it on the page.

## Data collected

This extension stores the following data locally on your device using the browser's `storage.local` API:

- **GitHub Personal Access Tokens (PATs)** -- optionally provided by you to access notes on private repositories. Tokens are stored **per host**: a token you enter for `github.com` is used only for `github.com`, and a token you enter for an enterprise host is used only for that host. Tokens are never sent cross-host.
- **Configured enterprise hosts** -- the list of GHES hostnames you have explicitly enabled.
- **Git notes ref configuration** -- your preferred notes ref names (e.g., `refs/notes/commits`).

Nothing is ever synced across devices; nothing is written outside your local browser profile.

## Data not collected

This extension does **not**:

- Collect personally identifiable information
- Track browsing activity or page visits
- Use analytics, telemetry, or tracking of any kind
- Send data to any server other than the GitHub hosts you have configured
- Store or process any data outside of your local browser

## Enterprise host permissions

Because GHES hostnames are unique per installation and unknowable at publish time, the extension declares `https://*/*` only as an *optional* host permission. **The extension never requests that wildcard itself.** Instead, when you add an enterprise host, the browser prompts you to grant permission for exactly that one origin. Granted origins are listed in the options page and can be revoked there (which also unregisters the content script and deletes the stored token for that host).

## Third-party services

The extension communicates only with:

- `api.github.com` and `raw.githubusercontent.com` (for github.com repos)
- Any GitHub Enterprise Server host you have explicitly configured

No other third-party services are contacted. No analytics, no telemetry, no crash reporting: nothing leaves your browser except HTTP(S) requests to the configured hosts.

## Data sharing

No user data is sold, transferred, or shared with any third party for any purpose.

## Changes to this policy

Updates to this privacy policy will be posted in this repository. The "last updated" date at the top will be revised accordingly.

## Contact

If you have questions about this privacy policy, please open an issue at https://github.com/Trailblaze-work/github-git-notes-viewer/issues.
