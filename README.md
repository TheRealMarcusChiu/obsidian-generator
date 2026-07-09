# ZIM → Obsidian Vault Converter

Convert any Kiwix `.zim` archive (Wikipedia, Stack Exchange, wikis…) into an Obsidian vault of Markdown notes — entirely in your browser. No uploads, no servers, no API calls.

## Features

- **100% local** — the ZIM file is read straight off your disk; nothing leaves your machine
- **Full ZIM parsing** — directory entries, redirects, and clusters (uncompressed, zstd, and xz)
- **Markdown with wikilinks** — articles become notes; internal links become `[[wikilinks]]` (aliases and redirects resolved); images become vault attachments
- **In-browser vault browser** — searchable note list, rendered Markdown reader, clickable wikilinks with back navigation
- **Download** — grab the whole vault as a `.zip`, ready to open in Obsidian

## Usage

1. Open `index.html` in a browser (serve the folder with any static file server)
2. Drop a `.zim` file onto the page (or click to browse)
3. Review the archive info, optionally toggle images or set an article limit
4. Convert, browse the vault, then **Download vault · .zip**

## Files

- `index.html` — the app (UI + conversion flow)
- `zim.js` — ZIM binary parser and Markdown/vault converter

## Notes

- Very large archives (multi-GB dumps) are memory-bound — use the article limit
- Legacy zlib/bzip2 ZIM clusters (rare, pre-2012) are not supported
